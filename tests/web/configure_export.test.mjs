import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HOST = "synthetic.clerk.accounts.dev";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function godotBin() {
  return process.env.GODOT_BIN || "/tmp/godot-dl/extract/Godot_v4.7.2-stable_linux.x86_64";
}

function syntheticKey(host = HOST) {
  return `pk_test_${Buffer.from(`${host}$`).toString("base64").replace(/=+$/g, "")}`;
}

function exportWeb(project) {
  const out = join(project, "build");
  mkdirSync(out, { recursive: true });
  const env = {
    ...process.env,
    TMPDIR: process.env.TMPDIR || "/tmp",
    GODOT_SILENCE_ROOT_WARNING: "1",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "/tmp/godot-config",
  };
  const imported = spawnSync(godotBin(), ["--headless", "--import", "--path", project, "--quit"], {
    cwd: project,
    env,
    encoding: "utf8",
  });
  if (imported.status !== 0) {
    throw new Error(imported.stderr || imported.stdout || "godot import failed");
  }
  const exported = spawnSync(godotBin(), ["--headless", "--path", project, "--export-debug", "Web", join(out, "index.html")], {
    cwd: project,
    env,
    encoding: "utf8",
  });
  if (exported.status !== 0) {
    throw new Error(exported.stderr || exported.stdout || "godot web export failed");
  }
  return out;
}

function serve(dir) {
  const server = createServer((req, res) => {
    const raw = req.url || "/";
    if (raw.includes("..") || raw.toLowerCase().includes("%2e")) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(raw, "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    if (rel.split("/").includes("..")) {
      res.writeHead(403);
      res.end();
      return;
    }
    const path = join(dir, rel);
    if (!path.startsWith(dir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(path);
      res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test("web export configures the pinned Clerk instance only after validation", async () => {
  const key = syntheticKey();
  const otherKey = syntheticKey("other.clerk.accounts.dev");
  const project = mkdtempSync("/tmp/gd-clerk-configure-XXXXXX");
  try {
    cpSync(join(root, "tests/web/configure-harness"), project, { recursive: true });
    cpSync(join(root, "addons"), join(project, "addons"), { recursive: true });
    const out = exportWeb(project);
    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.equal(html.includes("gd-clerk/gd_clerk_bridge.js"), true);
    assert.equal(html.includes("clerk.browser.js"), false);
    assert.equal(html.includes(key), false);
    assert.equal(html.includes("__clerk_publishable_key"), false);
    assert.equal(existsSync(join(out, "gd-clerk/clerk.browser.js")), true);
    assert.equal(existsSync(join(out, "gd-clerk/gd_clerk_bridge.js")), true);

    const { server, port } = await serve(out);
    assert.notEqual(port, 3100);
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({
      headless: true,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      const external = [];
      const completed = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      page.on("response", (response) => {
        if (!response.url().startsWith(`${origin}/`)) completed.push(response.status());
      });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`)) return route.continue();
        external.push(1);
        return route.abort();
      });
      await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => globalThis.gdClerkReady === true && globalThis.GdClerkBridge, null, { timeout: 60000 });
      assert.equal(pageErrors.some((item) => item.includes("publishableKey")), false);
      assert.equal(pageErrors.length, 0);

      const before = await page.evaluate(() => ({
        scripts: [...document.scripts].map((node) => node.getAttribute("src") || ""),
        clerkType: typeof window.Clerk,
        usedTestFactory: false,
      }));
      assert.equal(before.scripts.some((src) => src && src.includes("clerk.browser.js")), false);
      assert.equal(before.scripts.some((src) => src && src.includes("gd_clerk_bridge.js")), true);
      assert.equal(before.clerkType, "undefined");

      const failed = await page.evaluate(async ({ key: publicKey, otherKey: conflictKey, fapi }) => {
        const bridge = window.GdClerkBridge;
        async function configure(body) {
          const raw = await new Promise((resolve) => bridge.configure(JSON.stringify(body), resolve));
          const parsed = JSON.parse(raw);
          return {
            state: parsed.state,
            error_key: parsed.error_key,
            leaked: JSON.stringify(parsed).includes(publicKey) || JSON.stringify(parsed).includes(conflictKey),
            script: [...document.scripts].some((node) => (node.getAttribute("src") || "").includes("clerk.browser.js")),
            provisioned: typeof window.__clerk_publishable_key === "string" && window.__clerk_publishable_key.length > 0,
          };
        }
        const base = {
          publishable_key: publicKey,
          frontend_api: fapi,
          allowed_origins: [window.location.origin],
        };
        const missing = await configure({ ...base, publishable_key: "" });
        const invalid = await configure({ ...base, publishable_key: "pk_test_notavalidkeyvalue" });
        const mismatch = await configure({ ...base, frontend_api: "https://other.clerk.accounts.dev" });
        window.__clerk_proxy_url = "https://proxy.example";
        const proxy = await configure(base);
        delete window.__clerk_proxy_url;
        const marker = document.createElement("script");
        marker.setAttribute("data-clerk-domain", "example.com");
        document.head.appendChild(marker);
        const domain = await configure(base);
        marker.remove();
        let constructed = 0;
        window.Clerk = function Clerk() { constructed += 1; };
        const ctor = await configure(base);
        const ctorCalled = constructed;
        delete window.Clerk;
        let loaded = 0;
        window.Clerk = {
          publishableKey: conflictKey,
          proxyUrl: "",
          domain: "",
          version: "6.33.0",
          async load() { loaded += 1; },
        };
        const conflict = await configure(base);
        const conflictLoaded = loaded;
        const stillConflictKey = window.Clerk && window.Clerk.publishableKey === conflictKey;
        delete window.Clerk;
        return { missing, invalid, mismatch, proxy, domain, ctor, ctorCalled, conflict, conflictLoaded, stillConflictKey };
      }, { key, otherKey, fapi: `https://${HOST}` });

      for (const item of [failed.missing, failed.invalid, failed.mismatch, failed.proxy, failed.domain, failed.ctor, failed.conflict]) {
        assert.equal(item.error_key, "CONFIG");
        assert.equal(item.leaked, false);
        assert.equal(item.script, false);
        assert.equal(item.provisioned, false);
      }
      assert.equal(failed.ctorCalled, 0);
      assert.equal(failed.conflictLoaded, 0);
      assert.equal(failed.stillConflictKey, true);
      assert.equal(external.length, 0);
      assert.equal(completed.length, 0);
      assert.equal(pageErrors.some((item) => item.includes("publishableKey")), false);

      const loaded = await page.evaluate(async ({ key: publicKey, fapi }) => {
        const raw = await new Promise((resolve) => {
          window.GdClerkBridge.configure(JSON.stringify({
            publishable_key: publicKey,
            frontend_api: fapi,
            allowed_origins: [window.location.origin],
          }), resolve);
        });
        const parsed = JSON.parse(raw);
        const script = [...document.scripts].find((node) => (node.getAttribute("src") || "").includes("clerk.browser.js"));
        return {
          state: parsed.state,
          error_key: parsed.error_key,
          leaked: JSON.stringify(parsed).includes(publicKey),
          src: script ? script.src : "",
          sameOrigin: script ? script.src.startsWith(window.location.origin) : false,
          clerkType: typeof window.Clerk,
          hasLoad: !!(window.Clerk && typeof window.Clerk.load === "function"),
          version: window.Clerk && window.Clerk.version,
          keyMatches: !!(window.Clerk && window.Clerk.publishableKey === publicKey),
        };
      }, { key, fapi: `https://${HOST}` });

      assert.equal(loaded.leaked, false);
      assert.equal(loaded.sameOrigin, true);
      assert.equal(loaded.src.includes("gd-clerk/clerk.browser.js"), true);
      assert.equal(loaded.clerkType, "object");
      assert.equal(loaded.hasLoad, true);
      assert.equal(loaded.version, "6.33.0");
      assert.equal(loaded.keyMatches, true);
      assert.equal(loaded.error_key === "NETWORK" || loaded.state === "CONFIGURED", true);
      if (loaded.state !== "CONFIGURED") assert.equal(loaded.error_key, "NETWORK");
      assert.equal(external.length > 0, true);
      assert.equal(completed.length, 0);
      assert.equal(pageErrors.some((item) => item.includes("publishableKey") || item.includes(key)), false);
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
