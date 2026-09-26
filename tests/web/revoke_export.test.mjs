import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HOST = "synthetic.clerk.accounts.dev";
const TOKEN = "aaa.export-token.sig";
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
      server.unref();
      resolve({ server, port: server.address().port });
    });
  });
}

function installMock({ key, token }) {
  const listeners = [];
  const clerk = {
    publishableKey: key,
    proxyUrl: "",
    domain: "",
    version: "6.33.0",
    isSignedIn: false,
    session: null,
    user: null,
    client: { sessions: [], signedInSessions: [] },
    async load() {},
    addListener(cb) {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async setActive(params) {
      window.gdClerkSetActive += 1;
      window.gdClerkLastSetActive = params && Object.keys(params).join(",") === "session" && params.session === null ? "null" : "other";
      if (!window.gdClerkKeepSession) {
        this.session = null;
        this.user = null;
        this.isSignedIn = false;
        listeners.forEach((cb) => cb({ session: null, user: null }));
      }
      publish();
    },
    async signOut() {
      window.gdClerkSignOutCalls += 1;
    },
  };
  function emit(session) {
    listeners.forEach((cb) => cb({ session }));
  }
  function publish() {
    const signed = clerk.client.signedInSessions;
    window.gdClerkSessionNull = clerk.session === null;
    window.gdClerkOtherRemains = signed.some((item) => item.id === "sess_other");
    window.gdClerkCurrentRemains = signed.some((item) => item.id === "sess_current");
  }
  function prime() {
    clerk.session = {
      id: "sess_current",
      status: "active",
      user: { id: "user_current" },
      async getToken() { return token; },
    };
    clerk.user = { id: "user_current" };
    clerk.isSignedIn = true;
    const sessions = [
      { id: "sess_current", status: "active" },
      { id: "sess_other", status: "active" },
    ];
    clerk.client.sessions = sessions;
    clerk.client.signedInSessions = sessions.slice();
    publish();
  }
  window.gdClerkSetActive = 0;
  window.gdClerkSignOutCalls = 0;
  window.gdClerkKeepSession = false;
  window.gdClerkPublish = publish;
  window.gdClerkPrime = prime;
  window.gdClerkNoteIntermediate = () => {
    const away = { id: "sess_other", status: "active" };
    clerk.session = away;
    emit(away);
    const back = clerk.session = {
      id: "sess_current",
      status: "active",
      user: { id: "user_current" },
      async getToken() { return token; },
    };
    emit(back);
    publish();
  };
  prime();
  window.Clerk = clerk;
}

test("web export drives revoke through the Godot callback boundary", async () => {
  const key = syntheticKey();
  const project = mkdtempSync("/tmp/gd-clerk-revoke-XXXXXX");
  try {
    cpSync(join(root, "tests/web/revoke-harness"), project, { recursive: true });
    cpSync(join(root, "addons"), join(project, "addons"), { recursive: true });
    const out = exportWeb(project);
    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.equal(html.includes(key), false);
    assert.equal(html.includes(TOKEN), false);
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
      const consoleText = [];
      const external = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      page.on("console", (msg) => consoleText.push(msg.text()));
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`)) return route.continue();
        external.push(url);
        return route.abort();
      });
      await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => globalThis.gdClerkReady === true && globalThis.GdClerkBridge, null, { timeout: 60000 });
      await page.evaluate(installMock, { key, token: TOKEN });
      await page.evaluate((fapi) => {
        window.gdClerkFrontendApi = fapi;
        window.gdClerkPublicKey = window.Clerk.publishableKey;
        window.gdClerkStart = true;
      }, `https://${HOST}`);
      try {
        await page.waitForFunction(() => globalThis.gdClerkDone === true, null, { timeout: 120000 });
      } catch (err) {
        const partial = await page.evaluate(() => ({
          done: window.gdClerkDone,
          start: window.gdClerkStart,
          phase: window.gdClerkPhase,
          report: window.gdClerkReport || "",
          ready: window.gdClerkReady,
        }));
        throw new Error(`${err}\n${JSON.stringify(partial)}\n${consoleText.slice(-40).join("\n")}`);
      }
      const observed = await page.evaluate((token) => ({
        report: window.gdClerkReport,
        sessionNull: window.Clerk.session === null,
        other: window.Clerk.client.signedInSessions.some((item) => item.id === "sess_other"),
        signOutCalls: window.gdClerkSignOutCalls,
        lastSetActive: window.gdClerkLastSetActive,
        leaked: JSON.stringify(window.gdClerkReport || "").includes(token)
          || (window.Clerk && JSON.stringify(window.Clerk.session || {}).includes(token)),
      }), TOKEN);
      const report = JSON.parse(observed.report);
      const step = (name) => report.steps.find((item) => item.name === name);
      const missing = step("missing");
      const latched = step("missing_latch");
      const malformed = step("malformed");
      const late = step("late");
      const ignored = step("late_ignored");
      const failure = step("failure");
      const intermediate = step("intermediate");
      const success = step("success");
      const opened = step("success_open");
      assert.equal(missing.state, "SIGN_OUT_FAILED");
      assert.equal(missing.phase, "revoke_missing");
      assert.equal(missing.invocations, 0);
      assert.equal(missing.set_active, 0);
      assert.equal(latched.phase, "sign_out_latched");
      assert.equal(malformed.phase, "revoke_rejected");
      assert.equal(malformed.invocations, 1);
      assert.equal(malformed.set_active, 0);
      assert.equal(late.phase, "revoke_timeout");
      assert.equal(late.invocations, 2);
      assert.equal(late.set_active, 0);
      assert.equal(ignored.unchanged, true);
      assert.equal(failure.phase, "deactivate_failed");
      assert.equal(failure.invocations, 3);
      assert.equal(failure.session_null, false);
      assert.equal(failure.set_active, 1);
      assert.equal(intermediate.phase, "revoke_stale");
      assert.equal(intermediate.invocations, 4);
      assert.equal(intermediate.set_active, 1);
      assert.equal(success.state, "SIGNED_OUT");
      assert.equal(success.phase, "tab_deactivated");
      assert.equal(success.invocations, 5);
      assert.equal(success.saw_token, true);
      assert.equal(success.session_null, true);
      assert.equal(success.other_remains, true);
      assert.equal(success.current_remains, true);
      assert.equal(success.sign_out_calls, 0);
      assert.notEqual(opened.phase, "sign_out_latched");
      assert.equal(opened.state, "ERROR");
      assert.equal(observed.sessionNull, true);
      assert.equal(observed.other, true);
      assert.equal(observed.signOutCalls, 0);
      assert.equal(observed.lastSetActive, "null");
      assert.equal(observed.leaked, false);
      assert.equal(observed.report.includes(TOKEN), false);
      assert.equal(observed.report.includes(key), false);
      assert.equal(report.signals.some((item) => String(item).includes(TOKEN)), false);
      assert.equal(consoleText.some((item) => item.includes(TOKEN)), false);
      assert.equal(pageErrors.some((item) => item.includes(TOKEN)), false);
      assert.equal(external.length, 0);
    } finally {
      await browser.close();
    }
    server.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
