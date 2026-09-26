import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
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
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

test("web export reads location.origin and the old method call still fails", async () => {
  const source = readFileSync(join(root, "addons/@aviorstudio_gd-clerk/gd_clerk.gd"), "utf8");
  assert.equal(source.includes('.get("origin")'), false);
  assert.equal(source.includes(".get('origin')"), false);
  assert.match(source, /\(location as Object\)\.origin/);
  const project = mkdtempSync("/tmp/gd-clerk-origin-XXXXXX");
  try {
    cpSync(join(root, "tests/web/origin-harness"), project, { recursive: true });
    cpSync(join(root, "addons"), join(project, "addons"), { recursive: true });
    const out = exportWeb(project);
    const { server, port } = await serve(out);
    assert.notEqual(port, 3100);
    const browser = await chromium.launch({
      headless: true,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    try {
      const fixed = await browser.newPage();
      const fixedErrors = [];
      fixed.on("console", (msg) => fixedErrors.push(`${msg.type()}: ${msg.text()}`));
      fixed.on("pageerror", (err) => fixedErrors.push(`pageerror: ${err}`));
      await fixed.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await fixed.waitForFunction(() => globalThis.gdClerkOriginReady === true, null, { timeout: 60000 });
      } catch (err) {
        const notice = await fixed.locator("#status-notice").textContent().catch(() => "");
        throw new Error(`${err.message}\n${notice}\n${fixedErrors.join("\n")}`);
      }
      const compared = await fixed.evaluate(() => ({
        reported: globalThis.gdClerkPageOrigin,
        actual: location.origin,
        rejectsEmpty: globalThis.gdClerkRejectsEmpty,
        rejectsFile: globalThis.gdClerkRejectsFile,
        rejectsOpaque: globalThis.gdClerkRejectsOpaque,
        acceptsPage: globalThis.gdClerkAcceptsPage,
      }));
      assert.equal(compared.reported, compared.actual);
      assert.equal(compared.actual.startsWith("http://127.0.0.1:"), true);
      assert.equal(compared.rejectsEmpty, true);
      assert.equal(compared.rejectsFile, true);
      assert.equal(compared.rejectsOpaque, true);
      assert.equal(compared.acceptsPage, true);
      assert.equal(fixedErrors.some((item) => item.includes("is not a function")), false, fixedErrors.join("\n"));
      await fixed.close();

      const old = await browser.newPage();
      const oldErrors = [];
      old.on("console", (msg) => oldErrors.push(`${msg.type()}: ${msg.text()}`));
      old.on("pageerror", (err) => oldErrors.push(`pageerror: ${err}`));
      await old.goto(`http://127.0.0.1:${port}/index.html?probe=old`, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await old.waitForFunction(() => globalThis.gdClerkOldReady === true, null, { timeout: 60000 });
      } catch (err) {
        const notice = await old.locator("#status-notice").textContent().catch(() => "");
        const flags = await old.evaluate(() => ({
          oldReady: globalThis.gdClerkOldReady,
          originReady: globalThis.gdClerkOriginReady,
          search: location.search,
        })).catch(() => ({}));
        throw new Error(`${err.message}\n${notice}\n${JSON.stringify(flags)}\n${oldErrors.join("\n")}`);
      }
      const oldCompared = await old.evaluate(() => ({
        reported: globalThis.gdClerkOldOrigin,
        actual: location.origin,
      }));
      assert.notEqual(oldCompared.reported, oldCompared.actual);
      assert.equal(oldErrors.some((item) => item.includes("is not a function")), true, oldErrors.join("\n"));
    } finally {
      await browser.close();
      server.close();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
