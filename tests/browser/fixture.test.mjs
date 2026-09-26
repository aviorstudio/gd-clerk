import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
};

function start() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel.split("/").includes("..")) {
      res.writeHead(403);
      res.end();
      return;
    }
    const path = join(root, rel);
    if (!path.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(path);
      statSync(path);
      res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("real browser loads the pinned clerk bundle and refuses invisible signup fallback", async () => {
  const server = await start();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
      return route.abort();
    });
    await page.goto(`http://127.0.0.1:${port}/tests/browser/fixture.html`, { timeout: 15000 });
    await page.waitForFunction(() => window.GdClerkBridge && window.Clerk && window.Clerk.version, null, { timeout: 15000 });
    const version = await page.evaluate(() => window.Clerk.version);
    assert.equal(version, "6.33.0");
    const result = await page.evaluate(async () => {
      const bridge = window.GdClerkBridge._createForTest({
        getClerk: () => ({
            version: "6.33.0",
            publishableKey: "pk_test_" + btoa("example.clerk.accounts.dev$").replace(/=+$/g, ""),
            proxyUrl: "",
            domain: "",
            isSignedIn: false,
            session: null,
            user: null,
            client: {
              signIn: {},
              signUp: {
                status: "missing_requirements",
                missingFields: [],
                unverifiedFields: ["email_address"],
                async create() {
                  const node = document.createElement("div");
                  node.className = "clerk-invisible-captcha";
                  document.body.appendChild(node);
                  return this;
                },
                async prepareEmailAddressVerification() { return this; },
              },
              resetSignIn() {},
              resetSignUp() {},
              sessions: [],
              signedInSessions: [],
            },
            __internal_environment: {
              userSettings: { signUp: { captcha_enabled: true } },
              displayConfig: {
                captchaWidgetType: "smart",
                captchaPublicKey: "test-captcha-site",
                captchaPublicKeyInvisible: "test-captcha-invisible-site",
              },
            },
            async load() {},
            async setActive() {},
            async signOut() {},
            addListener() {},
        }),
        getWindow: () => window,
        getLocation: () => window.location,
        getDocument: () => document,
        getSessionStorage: () => window.sessionStorage,
        MutationObserver: window.MutationObserver,
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (id) => window.clearTimeout(id),
        atob: (value) => window.atob(value),
      });
      const host = "example.clerk.accounts.dev";
      const key = "pk_test_" + btoa(host + "$").replace(/=+$/g, "");
      await new Promise((resolve) => bridge.configure(JSON.stringify({
        publishable_key: key,
        frontend_api: "https://" + host,
        allowed_origins: [window.location.origin],
      }), resolve));
      const raw = await new Promise((resolve) => bridge.beginEmailCode("person@example.com", "SIGN_UP", resolve));
      return {
        body: JSON.parse(raw),
        slot: !!document.getElementById("clerk-captcha"),
        invisible: !!document.querySelector(".clerk-invisible-captcha"),
      };
    });
    assert.equal(result.body.error_key, "UNSUPPORTED_CHALLENGE");
    assert.equal(result.slot, true);
    assert.equal(errors.length, 0);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("real browser sign-out deactivates the current tab without navigation or signOut", async () => {
  const server = await start();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
      return route.abort();
    });
    await page.goto(`http://127.0.0.1:${port}/tests/browser/fixture.html`, { timeout: 15000 });
    await page.waitForFunction(() => window.GdClerkBridge, null, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const bridge = window.GdClerkBridge._createForTest({
        getClerk: () => ({
          version: "6.33.0",
          publishableKey: "pk_test_" + btoa("example.clerk.accounts.dev$").replace(/=+$/g, ""),
          proxyUrl: "",
          domain: "",
          isSignedIn: true,
          session: {
            id: "sess_current",
            status: "active",
            async getToken() { return "aaa.browser-token.sig"; },
          },
          user: { id: "user_current" },
          client: {
            signIn: {},
            signUp: {},
            sessions: [{ id: "sess_current", status: "active" }, { id: "sess_other", status: "active" }],
            signedInSessions: [{ id: "sess_current", status: "active" }, { id: "sess_other", status: "active" }],
            resetSignIn() {},
            resetSignUp() {},
          },
          async load() {},
          async setActive(params) {
            this.session = null;
            this.user = null;
            window.__setActive = params;
          },
          async signOut() { window.__signOutCalled = true; },
          addListener() {},
        }),
        getWindow: () => window,
        getLocation: () => window.location,
        getDocument: () => document,
        getSessionStorage: () => window.sessionStorage,
        MutationObserver: window.MutationObserver,
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (id) => window.clearTimeout(id),
        atob: (value) => window.atob(value),
      });
      const host = "example.clerk.accounts.dev";
      const key = "pk_test_" + btoa(host + "$").replace(/=+$/g, "");
      await new Promise((resolve) => bridge.configure(JSON.stringify({
        publishable_key: key,
        frontend_api: "https://" + host,
        allowed_origins: [window.location.origin],
      }), resolve));
      bridge.setRevokeSession((token) => {
        window.__revokeToken = token;
        bridge.submitRevokeAck(JSON.stringify({
          schema: "gd-clerk.revoke.v1",
          remote_confirmed: true,
          session_id: "sess_current",
          subject: "user_current",
        }));
      });
      const raw = await new Promise((resolve) => bridge.signOut(resolve));
      return {
        body: JSON.parse(raw),
        href: window.location.href,
        setActive: window.__setActive,
        signOutCalled: window.__signOutCalled === true,
        leaked: raw.includes("browser-token"),
      };
    });
    assert.equal(result.href.includes("accounts"), false);
    assert.equal(result.body.state, "SIGNED_OUT");
    assert.equal(result.body.phase, "tab_deactivated");
    assert.deepEqual(result.setActive, { session: null });
    assert.equal(result.signOutCalled, false);
    assert.equal(result.leaked, false);
    assert.equal(errors.length, 0);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
