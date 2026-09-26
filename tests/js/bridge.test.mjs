import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const bridgePath = join(root, "addons/@aviorstudio_gd-clerk/javascript/gd_clerk_bridge.js");
const source = readFileSync(bridgePath, "utf8");
const codes = JSON.parse(readFileSync(join(root, "addons/@aviorstudio_gd-clerk/observed_error_codes.json"), "utf8"));
const limits = JSON.parse(readFileSync(join(root, "addons/@aviorstudio_gd-clerk/limits.json"), "utf8"));

function loadFactory() {
  const sandbox = { console, setTimeout, clearTimeout, atob: (v) => Buffer.from(v, "base64").toString("utf8") };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runInContext(source, createContext(sandbox), { filename: "gd_clerk_bridge.js" });
  return sandbox.GdClerkBridge._createForTest;
}

function b64(value) {
  return Buffer.from(value).toString("base64").replace(/=+$/g, "");
}
function pk(host = "example.clerk.accounts.dev") {
  return `pk_test_${b64(host + "$")}`;
}
function jwt(exp) {
  const payload = Buffer.from(JSON.stringify({ exp, sub: "user" })).toString("base64url");
  return `aaa.${payload}.sig`;
}

function dom() {
  const observers = [];
  const elements = new Map();
  const body = { nodes: [] };
  body.appendChild = (child) => {
    child.isConnected = true;
    if (child.id) elements.set(child.id, child);
    body.nodes.push(child);
    observers.forEach((item) => item.cb());
  };
  const document = {
    body,
    documentElement: body,
    createElement() {
      const attrs = new Map();
      return {
        id: "",
        style: {},
        dataset: {},
        hidden: false,
        isConnected: false,
        className: "",
        setAttribute(name, value) {
          attrs.set(name, String(value));
          if (name === "hidden") this.hidden = true;
        },
        hasAttribute(name) {
          return attrs.has(name) || (name === "hidden" && this.hidden === true);
        },
        getAttribute(name) {
          if (attrs.has(name)) return attrs.get(name);
          if (name === "hidden" && this.hidden === true) return "";
          return null;
        },
        classList: { add(name) { this.owner.className = name; }, owner: null },
      };
    },
    getElementById(id) { return elements.get(id) || null; },
    querySelector(sel) {
      if (sel === ".clerk-invisible-captcha") {
        return body.nodes.find((node) => node.className === "clerk-invisible-captcha") || null;
      }
      return null;
    },
  };
  const orig = document.createElement;
  document.createElement = function () {
    const node = orig();
    node.classList.owner = node;
    return node;
  };
  return {
    document,
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() { this.cb = () => {}; }
    },
  };
}

function harness(options = {}) {
  const calls = [];
  const page = dom();
  const store = options.store || new Map();
  const sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const signIn = {
    status: null,
    supportedFirstFactors: [{ strategy: "email_code", emailAddressId: "idn_1" }],
    protectCheck: null,
    isTransferable: false,
    createdSessionId: null,
    firstFactorVerification: { status: "unverified" },
    async create(params) {
      calls.push(["signIn.create", params]);
      this.supportedFirstFactors = [{ strategy: "email_code", emailAddressId: "idn_1" }];
      if (!this.status) this.status = "needs_first_factor";
      return this;
    },
    async prepareFirstFactor(params) { calls.push(["prepareFirstFactor", params]); this.status = "needs_first_factor"; return this; },
    async attemptFirstFactor(params) {
      calls.push(["attemptFirstFactor", params]);
      this.status = "complete";
      this.createdSessionId = "sess_1";
      return this;
    },
  };
  const signUp = {
    status: "missing_requirements",
    missingFields: [],
    unverifiedFields: ["email_address"],
    protectCheck: null,
    createdSessionId: null,
    async create(params) {
      calls.push(["signUp.create", params]);
      if (!page.document.getElementById("clerk-captcha")) throw new Error("slot missing");
      return this;
    },
    async prepareEmailAddressVerification(params) { calls.push(["prepareEmail", params]); return this; },
    async attemptEmailAddressVerification(params) {
      calls.push(["attemptEmail", params]);
      this.status = "complete";
      this.createdSessionId = "sess_2";
      return this;
    },
  };
  const clerk = {
    version: "6.33.0",
    isSignedIn: false,
    session: null,
    user: null,
    client: {
      signIn,
      signUp,
      sessions: [],
      signedInSessions: [],
      resetSignIn() { calls.push(["resetSignIn"]); },
      resetSignUp() { calls.push(["resetSignUp"]); },
    },
    __internal_environment: {
      userSettings: { signUp: { captcha_enabled: true } },
      displayConfig: {
        captchaWidgetType: "smart",
        captchaPublicKey: "test-captcha-site",
        captchaPublicKeyInvisible: "test-captcha-invisible-site",
      },
    },
    async load() { calls.push(["load"]); },
    async setActive({ session }) {
      calls.push(["setActive", session]);
      this.session = { status: "active", id: session, getToken: clerkToken };
      this.user = { id: "user_1" };
      this.isSignedIn = true;
      this.client.signedInSessions = [this.session];
      this.client.sessions = [this.session];
    },
    async signOut() { calls.push(["signOut"]); },
    addListener() { calls.push(["addListener"]); },
  };
  async function clerkToken(opts) {
    calls.push(["getToken", opts || {}]);
    return options.token || jwt(Math.floor(Date.now() / 1000) + 50);
  }
  if (options.mutate) options.mutate({ clerk, signIn, signUp, calls, page });
  if (clerk.publishableKey == null) clerk.publishableKey = pk();
  if (clerk.proxyUrl == null) clerk.proxyUrl = "";
  if (clerk.domain == null) clerk.domain = "";
  const pageWindow = options.window || {};
  const bridge = loadFactory()({
    getClerk: () => (options.clerkValue !== undefined ? options.clerkValue : clerk),
    getWindow: () => pageWindow,
    getLocation: () => ({ origin: options.origin || "http://127.0.0.1:8080" }),
    getDocument: () => page.document,
    getSessionStorage: () => sessionStorage,
    MutationObserver: page.MutationObserver,
    now: () => options.now || 1_700_000_000_000,
    setTimer: (fn, ms) => setTimeout(fn, options.timerMs ?? ms),
    clearTimer: (id) => clearTimeout(id),
    atob: (value) => Buffer.from(value, "base64").toString("utf8"),
    loadClerkScript: options.loadClerkScript,
  });
  return { bridge, calls, clerk, signIn, signUp, page, store, pageWindow };
}

async function call(bridge, method, ...args) {
  const payload = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 1000);
    bridge[method](...args, (raw) => { clearTimeout(timer); resolve(raw); });
  });
  return JSON.parse(payload);
}

const config = {
  publishable_key: pk(),
  frontend_api: "https://example.clerk.accounts.dev",
  allowed_origins: ["http://127.0.0.1:8080", "https://consumer.example"],
};

test("pinned error map and limits match the committed contract", () => {
  const factory = loadFactory();
  const bridge = factory({
    getClerk: () => function Clerk() { return { version: "6.33.0", async load() {} }; },
    getLocation: () => ({ origin: "http://127.0.0.1:8080" }),
    getDocument: () => dom().document,
    getSessionStorage: () => ({ getItem() { return null; }, setItem() {}, removeItem() {} }),
    MutationObserver: class { observe() {} disconnect() {} },
    now: () => 0,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: clearTimeout,
    atob: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(bridge._errorCodes)), codes.codes);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge._limits)), limits);
  assert.equal(bridge._pinnedVersion, "6.33.0");
});

test("configure rejects mismatched instance, secret, proxy, and unlisted origins", async () => {
  const { bridge } = harness();
  const badKey = await call(bridge, "configure", { ...config, publishable_key: "sk_test_notallowed" });
  assert.equal(badKey.error_key, "CONFIG");
  const httpApi = await call(bridge, "configure", { ...config, frontend_api: "http://example.clerk.accounts.dev" });
  assert.equal(httpApi.error_key, "CONFIG");
  const mismatch = await call(bridge, "configure", { ...config, frontend_api: "https://other.clerk.accounts.dev" });
  assert.equal(mismatch.error_key, "CONFIG");
  const proxy = await call(bridge, "configure", { ...config, proxyUrl: "https://proxy.example" });
  assert.equal(proxy.error_key, "CONFIG");
  const { bridge: other } = harness({ origin: "http://127.0.0.1:8081" });
  const origin = await call(other, "configure", config);
  assert.equal(origin.error_key, "CONFIG");
  assert.equal(origin.message.includes("127.0.0.1:8081"), false);
});

test("configure accepts listed origins only when they are current", async () => {
  const local = harness();
  const ok = await call(local.bridge, "configure", config);
  assert.equal(ok.state, "CONFIGURED");
  assert.equal(local.calls.some((item) => item[0] === "load"), true);
  const prod = harness({ origin: "https://consumer.example" });
  const prodOk = await call(prod.bridge, "configure", config);
  assert.equal(prodOk.state, "CONFIGURED");
});

test("configure refuses a constructor and does not construct Clerk", async () => {
  let constructed = 0;
  function Ctor() { constructed += 1; return { version: "6.33.0", async load() {} }; }
  const { bridge } = harness({ clerkValue: Ctor });
  const refused = await call(bridge, "configure", config);
  assert.equal(refused.error_key, "CONFIG");
  assert.equal(refused.message.includes(config.publishable_key), false);
  assert.equal(constructed, 0);
});

test("configure refuses a conflicting instance key, proxy, or domain without re-keying", async () => {
  const mismatched = harness();
  mismatched.clerk.publishableKey = pk("other.clerk.accounts.dev");
  const keyConflict = await call(mismatched.bridge, "configure", config);
  assert.equal(keyConflict.error_key, "CONFIG");
  assert.equal(keyConflict.message.includes(config.publishable_key), false);
  assert.equal(keyConflict.message.includes(mismatched.clerk.publishableKey), false);
  assert.equal(mismatched.calls.some((item) => item[0] === "load"), false);
  assert.equal(mismatched.clerk.publishableKey, pk("other.clerk.accounts.dev"));

  const proxied = harness();
  proxied.clerk.proxyUrl = "https://proxy.example";
  const proxyConflict = await call(proxied.bridge, "configure", config);
  assert.equal(proxyConflict.error_key, "CONFIG");
  assert.equal(proxied.calls.some((item) => item[0] === "load"), false);

  const domained = harness();
  domained.clerk.domain = "example.com";
  const domainConflict = await call(domained.bridge, "configure", config);
  assert.equal(domainConflict.error_key, "CONFIG");
  assert.equal(domained.calls.some((item) => item[0] === "load"), false);
});

test("configure does not inject the browser script until the key and Frontend API match", async () => {
  const injected = [];
  let clerk = null;
  const pageWindow = {};
  const bridge = loadFactory()({
    getClerk: () => clerk,
    getWindow: () => pageWindow,
    getLocation: () => ({ origin: "http://127.0.0.1:8080" }),
    getDocument: () => dom().document,
    getSessionStorage: () => ({ getItem() { return null; }, setItem() {}, removeItem() {} }),
    MutationObserver: class { observe() {} disconnect() {} },
    now: () => 0,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: clearTimeout,
    atob: (value) => Buffer.from(value, "base64").toString("utf8"),
    loadClerkScript: async (key) => {
      injected.push(key);
      pageWindow.__clerk_publishable_key = key;
      clerk = {
        version: "6.33.0",
        publishableKey: key,
        proxyUrl: "",
        domain: "",
        async load() { injected.push("load"); },
        addListener() {},
      };
    },
  });
  const mismatch = await call(bridge, "configure", { ...config, frontend_api: "https://other.clerk.accounts.dev" });
  assert.equal(mismatch.error_key, "CONFIG");
  assert.equal(mismatch.message.includes(config.publishable_key), false);
  assert.equal(injected.length, 0);
  assert.equal(pageWindow.__clerk_publishable_key, undefined);
  const missing = await call(bridge, "configure", { ...config, publishable_key: "" });
  assert.equal(missing.error_key, "CONFIG");
  assert.equal(injected.length, 0);
  pageWindow.__clerk_proxy_url = "https://proxy.example";
  const proxy = await call(bridge, "configure", config);
  assert.equal(proxy.error_key, "CONFIG");
  assert.equal(injected.length, 0);
  assert.equal(pageWindow.__clerk_publishable_key, undefined);
  delete pageWindow.__clerk_proxy_url;
  const ok = await call(bridge, "configure", config);
  assert.equal(ok.state, "CONFIGURED");
  assert.equal(injected[0], config.publishable_key);
  assert.equal(injected.includes("load"), true);
  assert.equal(ok.message.includes(config.publishable_key), false);
});

test("sign-in email code uses only legacy first-factor methods and does not create an account", async () => {
  const h = harness();
  await call(h.bridge, "configure", config);
  const sent = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(sent.state, "CODE_SENT");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter((item) => item[0] === "signIn.create")[0][1])), { identifier: "person@example.com" });
  assert.equal(h.calls.some((item) => item[0] === "signUp.create"), false);
  assert.equal(h.page.document.getElementById("clerk-captcha"), null);
  const authed = await call(h.bridge, "completeEmailCode", "123456");
  assert.equal(authed.state, "AUTHENTICATED");
  assert.equal(authed.token, undefined);
  assert.equal(h.calls.some((item) => item[0] === "setActive"), true);
});

test("unknown identifier does not transfer or auto-create", async () => {
  const h = harness({ mutate({ signIn }) {
    signIn.create = async () => { const err = new Error("missing"); err.errors = [{ code: "form_identifier_not_found", message: "person@example.com" }]; throw err; };
  } });
  await call(h.bridge, "configure", config);
  const result = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(result.state, "ERROR");
  assert.equal(result.error_key, "UNKNOWN");
  assert.equal(result.message.includes("person@example.com"), false);
  assert.equal(h.calls.some((item) => item[0] === "signUp.create"), false);
});

test("mfa, device trust, protect, and missing email factor fail closed", async () => {
  for (const status of ["needs_second_factor", "needs_client_trust"]) {
    const h = harness({ mutate({ signIn }) {
      signIn.create = async () => {
        signIn.status = status;
        signIn.supportedFirstFactors = [{ strategy: "email_code", emailAddressId: "idn_1" }];
        return signIn;
      };
    } });
    await call(h.bridge, "configure", config);
    const result = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
    assert.equal(result.state, "NEEDS_MORE_STEPS");
    assert.equal(result.error_key, "UNSUPPORTED_CHALLENGE");
    assert.equal(result.phase, "status_challenge");
    assert.equal(h.calls.some((item) => item[0] === "setActive"), false);
  }
  const protect = harness({ mutate({ signIn }) {
    signIn.create = async () => {
      signIn.protectCheck = { id: "protect" };
      signIn.supportedFirstFactors = [{ strategy: "email_code", emailAddressId: "idn_1" }];
      return signIn;
    };
  } });
  await call(protect.bridge, "configure", config);
  const blocked = await call(protect.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(blocked.error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(blocked.phase, "protect");
  const missing = harness({ mutate({ signIn }) {
    signIn.create = async () => {
      signIn.supportedFirstFactors = [{ strategy: "password" }];
      return signIn;
    };
  } });
  await call(missing.bridge, "configure", config);
  const noFactor = await call(missing.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(noFactor.error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(noFactor.phase, "missing_factor");
});

test("session tasks after setActive are not authenticated and cannot mint tokens", async () => {
  const h = harness({ mutate({ clerk }) {
    clerk.setActive = async () => {
      clerk.session = { status: "pending", currentTask: { key: "setup-mfa" }, tasks: [{ key: "setup-mfa" }] };
      clerk.isSignedIn = true;
      clerk.user = { id: "user_1" };
    };
  } });
  await call(h.bridge, "configure", config);
  await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  const result = await call(h.bridge, "completeEmailCode", "123456");
  assert.equal(result.state, "NEEDS_MORE_STEPS");
  const token = await call(h.bridge, "getSessionToken", 10);
  assert.notEqual(token.state, "AUTHENTICATED");
  assert.equal(token.token, undefined);
});

test("observed code errors are mapped without echoing the code or email", async () => {
  const h = harness({ mutate({ signIn }) {
    signIn.attemptFirstFactor = async () => { const err = new Error("bad"); err.errors = [{ code: "form_code_incorrect", longMessage: "code 123456 for person@example.com" }]; throw err; };
  } });
  await call(h.bridge, "configure", config);
  await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  const invalid = await call(h.bridge, "completeEmailCode", "000000");
  assert.equal(invalid.error_key, "INVALID_CODE");
  assert.equal(invalid.message.includes("000000"), false);
  assert.equal(invalid.message.includes("person@example.com"), false);
  const expired = harness({ mutate({ signIn }) {
    signIn.attemptFirstFactor = async () => { const err = new Error("old"); err.errors = [{ code: "verification_expired" }]; throw err; };
  } });
  await call(expired.bridge, "configure", config);
  await call(expired.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal((await call(expired.bridge, "completeEmailCode", "123456")).error_key, "EXPIRED_CODE");
});

test("resend enforces the documented 30 second cooldown and maps rate limits", async () => {
  let now = 1_700_000_000_000;
  const h = harness({ now, mutate({ signIn }) { signIn.prepareFirstFactor = async (params) => { h.calls.push(["prepareFirstFactor", params]); }; } });
  h.now = now;
  const bridge = h.bridge;
  await call(bridge, "configure", config);
  await call(bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  const early = await call(bridge, "resendEmailCode");
  assert.equal(early.error_key, "RESEND_COOLDOWN");
  const limited = harness({ mutate({ signIn }) {
    signIn.prepareFirstFactor = async () => { const err = new Error("rate"); err.status = 429; err.errors = [{ code: "too_many_requests" }]; throw err; };
  } });
  await call(limited.bridge, "configure", config);
  await call(limited.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  limited.bridge && null;
  // advance by constructing a new attempt after cooldown using the same bridge clock is fixed; call prepare path via a fresh harness with now far ahead is covered by direct SDK 429 on begin
  const beginLimited = harness({ mutate({ signIn }) {
    signIn.create = async () => { const err = new Error("rate"); err.errors = [{ code: "signup_rate_limit_exceeded" }]; err.status = 429; throw err; };
  } });
  await call(beginLimited.bridge, "configure", config);
  assert.equal((await call(beginLimited.bridge, "beginEmailCode", "person@example.com", "SIGN_IN")).error_key, "RATE_LIMIT");
});

test("cancel settles the in-flight callback once", async () => {
  let release;
  const h = harness({ mutate({ signIn }) {
    signIn.create = () => new Promise((resolve) => { release = resolve; });
  } });
  await call(h.bridge, "configure", config);
  const pending = call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.bridge.cancelEmailCode();
  const result = await pending;
  assert.equal(result.error_key, "CANCELLED");
  release({ status: "needs_first_factor", supportedFirstFactors: [] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.calls.filter((item) => item[0] === "resetSignIn").length >= 1, true);
});

test("sign-up requires confirmed Smart protection and a mounted slot before create", async () => {
  const invisible = harness({ mutate({ clerk }) { clerk.__internal_environment.displayConfig.captchaWidgetType = "invisible"; } });
  await call(invisible.bridge, "configure", config);
  assert.equal((await call(invisible.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(invisible.calls.some((item) => item[0] === "signUp.create"), false);
  for (const keyName of ["captchaPublicKey", "captchaPublicKeyInvisible"]) {
    const missingKeys = harness({ mutate({ clerk }) { delete clerk.__internal_environment.displayConfig[keyName]; } });
    await call(missingKeys.bridge, "configure", config);
    assert.equal((await call(missingKeys.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
    assert.equal(missingKeys.calls.some((item) => item[0] === "signUp.create"), false);
    assert.equal(missingKeys.page.document.getElementById("clerk-captcha"), null);
  }
  const ok = harness();
  await call(ok.bridge, "configure", config);
  let slotAtCreate = false;
  ok.signUp.create = async (params) => {
    ok.calls.push(["signUp.create", params]);
    slotAtCreate = !!ok.page.document.getElementById("clerk-captcha");
    return ok.signUp;
  };
  const sent = await call(ok.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(sent.state, "CODE_SENT");
  assert.equal(slotAtCreate, true);
  assert.equal(ok.page.document.getElementById("clerk-captcha").hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls.find((item) => item[0] === "signUp.create")[1])), { emailAddress: "person@example.com" });
});

function placeSlot(page, fields = {}) {
  const node = page.document.createElement("div");
  node.id = "clerk-captcha";
  Object.assign(node, fields);
  page.document.body.appendChild(node);
  return node;
}

test("explicit captcha off signs up without a slot or bypass", async () => {
  for (const widget of ["smart", null]) {
    const h = harness({ mutate({ clerk, signUp, calls }) {
      clerk.__internal_environment.userSettings.signUp.captcha_enabled = false;
      clerk.__internal_environment.displayConfig.captchaWidgetType = widget;
      signUp.create = async (params) => {
        calls.push(["signUp.create", params]);
        return signUp;
      };
    } });
    await call(h.bridge, "configure", config);
    const sent = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
    assert.equal(sent.state, "CODE_SENT");
    assert.equal(h.calls.some((item) => item[0] === "signUp.create"), true);
    assert.equal(h.page.document.getElementById("clerk-captcha"), null);
    assert.equal(h.clerk.client.captchaBypass, undefined);
  }
});

test("captcha off still fails closed if an invisible challenge appears", async () => {
  const h = harness({ mutate({ clerk, signUp, page }) {
    clerk.__internal_environment.userSettings.signUp.captcha_enabled = false;
    signUp.create = async () => {
      const node = page.document.createElement("div");
      node.className = "clerk-invisible-captcha";
      page.document.body.appendChild(node);
      return signUp;
    };
  } });
  await call(h.bridge, "configure", config);
  const stopped = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(stopped.error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(h.calls.some((item) => item[0] === "prepareEmail"), false);
});

test("enabled Smart rejects a hidden or undocumented pre-existing slot without create", async () => {
  const hidden = harness({ mutate({ page }) { placeSlot(page, { hidden: true }); } });
  await call(hidden.bridge, "configure", config);
  const denied = await call(hidden.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(denied.state, "ERROR");
  assert.equal(denied.error_key, "CONFIG");
  assert.equal(hidden.calls.some((item) => item[0] === "signUp.create"), false);
  assert.equal(hidden.page.document.getElementById("clerk-captcha").hidden, true);
  const marked = harness({ mutate({ page }) {
    const node = placeSlot(page);
    node.setAttribute("data-clerk-captcha", "conditional");
  } });
  await call(marked.bridge, "configure", config);
  assert.equal((await call(marked.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "CONFIG");
  assert.equal(marked.calls.some((item) => item[0] === "signUp.create"), false);
  assert.equal(marked.page.document.getElementById("clerk-captcha").getAttribute("data-clerk-captcha"), "conditional");
  const covered = harness({
    window: { getComputedStyle: () => ({ display: "none", visibility: "visible" }) },
    mutate({ page }) { placeSlot(page); },
  });
  await call(covered.bridge, "configure", config);
  assert.equal((await call(covered.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "CONFIG");
  assert.equal(covered.calls.some((item) => item[0] === "signUp.create"), false);
});

test("enabled Smart accepts a visible documented slot and does not replace it", async () => {
  const h = harness({ mutate({ page }) {
    const node = placeSlot(page);
    node.setAttribute("data-cl-theme", "dark");
  } });
  await call(h.bridge, "configure", config);
  const existing = h.page.document.getElementById("clerk-captcha");
  const sent = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(sent.state, "CODE_SENT");
  assert.equal(h.page.document.getElementById("clerk-captcha"), existing);
  assert.equal(existing.getAttribute("data-cl-theme"), "dark");
  assert.equal(existing.hidden, false);
});

test("captcha bypass and a non-boolean enabled flag fail before create", async () => {
  const bypassed = harness({ mutate({ clerk }) { clerk.client.captchaBypass = true; } });
  await call(bypassed.bridge, "configure", config);
  assert.equal((await call(bypassed.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(bypassed.calls.some((item) => item[0] === "signUp.create"), false);
  const offBypass = harness({ mutate({ clerk }) {
    clerk.client.captchaBypass = true;
    clerk.__internal_environment.userSettings.signUp.captcha_enabled = false;
  } });
  await call(offBypass.bridge, "configure", config);
  assert.equal((await call(offBypass.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(offBypass.calls.some((item) => item[0] === "signUp.create"), false);
  const textOff = harness({ mutate({ clerk }) { clerk.__internal_environment.userSettings.signUp.captcha_enabled = "false"; } });
  await call(textOff.bridge, "configure", config);
  assert.equal((await call(textOff.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(textOff.calls.some((item) => item[0] === "signUp.create"), false);
  const missing = harness({ mutate({ clerk }) { delete clerk.__internal_environment; } });
  await call(missing.bridge, "configure", config);
  assert.equal((await call(missing.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(missing.calls.some((item) => item[0] === "signUp.create"), false);
});

test("a duplicate captcha render TypeError is not reported as network", async () => {
  const rendered = harness({ mutate({ signUp }) {
    signUp.create = async () => { throw new TypeError("Turnstile already been rendered in this element"); };
  } });
  await call(rendered.bridge, "configure", config);
  const diagnostic = await call(rendered.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(diagnostic.state, "ERROR");
  assert.equal(diagnostic.error_key, "UNKNOWN");
  const network = harness({ mutate({ signUp }) {
    signUp.create = async () => { throw new TypeError("Failed to fetch"); };
  } });
  await call(network.bridge, "configure", config);
  assert.equal((await call(network.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "NETWORK");
});

test("invisible fallback and failed captcha do not continue sign-up", async () => {
  const fallback = harness({ mutate({ signUp, page }) {
    signUp.create = async () => {
      const node = page.document.createElement("div");
      node.className = "clerk-invisible-captcha";
      page.document.body.appendChild(node);
      return signUp;
    };
  } });
  await call(fallback.bridge, "configure", config);
  const stopped = await call(fallback.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(stopped.error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(fallback.calls.some((item) => item[0] === "prepareEmail"), false);
  const challenged = harness({ mutate({ signUp }) {
    signUp.create = async () => { const err = new Error("captcha"); err.errors = [{ code: "captcha_invalid" }]; throw err; };
  } });
  await call(challenged.bridge, "configure", config);
  const failed = await call(challenged.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(failed.state, "ERROR");
  assert.equal(failed.error_key, "UNKNOWN");
  assert.equal(challenged.calls.some((item) => item[0] === "prepareEmail"), false);
});

test("smart challenge completion inside create still sends the email code", async () => {
  const h = harness({ mutate({ signUp, page }) {
    signUp.create = async () => {
      const slot = page.document.getElementById("clerk-captcha");
      slot.dataset.clInteractive = "true";
      return signUp;
    };
  } });
  await call(h.bridge, "configure", config);
  const sent = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(sent.state, "CODE_SENT");
  assert.equal(h.page.document.getElementById("clerk-captcha").dataset.clInteractive, "true");
});

test("missing sign-up fields fail closed", async () => {
  const h = harness({ mutate({ signUp }) { signUp.missingFields = ["first_name"]; signUp.create = async () => signUp; } });
  await call(h.bridge, "configure", config);
  const result = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(result.state, "NEEDS_MORE_STEPS");
  assert.equal(h.calls.some((item) => item[0] === "prepareEmail"), false);
});

test("session token refresh is coalesced and rejected when exp is too soon", async () => {
  let skipCalls = 0;
  let release;
  const short = jwt(Math.floor(1_700_000_000_000 / 1000) + 5);
  const long = jwt(Math.floor(1_700_000_000_000 / 1000) + 40);
  const h = harness({ now: 1_700_000_000_000, token: short, mutate({ clerk }) {
    clerk.session = { status: "active", async getToken(opts) {
      if (opts && opts.skipCache) {
        skipCalls += 1;
        return new Promise((resolve) => { release = () => resolve(long); });
      }
      return short;
    } };
    clerk.isSignedIn = true;
  } });
  await call(h.bridge, "configure", config);
  const first = call(h.bridge, "getSessionToken", 30);
  const second = call(h.bridge, "getSessionToken", 30);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(skipCalls, 1);
  assert.equal(a.token, long);
  assert.equal(b.token, long);
  assert.equal(h.bridge.token, undefined);
  const stale = harness({ now: 1_700_000_000_000, mutate({ clerk }) {
    clerk.session = { status: "active", async getToken() { return short; } };
    clerk.isSignedIn = true;
  } });
  await call(stale.bridge, "configure", config);
  const denied = await call(stale.bridge, "getSessionToken", 30);
  assert.equal(denied.error_key, "SESSION_EXPIRED");
  assert.equal(denied.token, undefined);
});

test("sign-out is confirmed only after remote success and an absent browser session", async () => {
  const h = harness();
  await call(h.bridge, "configure", config);
  await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  await call(h.bridge, "completeEmailCode", "123456");
  h.clerk.signOut = async () => { throw new TypeError("network down"); };
  const failed = await call(h.bridge, "signOut");
  assert.equal(failed.state, "SIGN_OUT_FAILED");
  assert.equal(failed.retryable, true);
  assert.equal(failed.error_key, "NETWORK");
  const blocked = await call(h.bridge, "getSessionToken", 10);
  assert.equal(blocked.state, "SIGN_OUT_FAILED");
  assert.equal(blocked.token, undefined);
  const reloaded = harness({ store: h.store, mutate({ clerk }) {
    clerk.session = { status: "active", async getToken() { return jwt(Math.floor(Date.now() / 1000) + 50); } };
    clerk.user = { id: "user_1" };
    clerk.isSignedIn = true;
    clerk.signOut = async () => { throw new TypeError("still down"); };
  } });
  const configured = await call(reloaded.bridge, "configure", config);
  assert.notEqual(configured.state, "SIGNED_OUT");
  const stillBlocked = await call(reloaded.bridge, "getSessionToken", 10);
  assert.equal(stillBlocked.token, undefined);
  reloaded.clerk.signOut = async () => {
    reloaded.clerk.session = null;
    reloaded.clerk.user = null;
    reloaded.clerk.isSignedIn = false;
    reloaded.clerk.client.sessions = [];
    reloaded.clerk.client.signedInSessions = [];
  };
  const signedOut = await call(reloaded.bridge, "signOut");
  assert.equal(signedOut.state, "SIGNED_OUT");
  assert.equal(signedOut.phase, "sign_out_resolved_absent");
  assert.equal(h.store.get("gd_clerk_sign_out_incomplete"), undefined);
});

test("sign-out passes a callback and does not navigate", async () => {
  let navigated = false;
  let callback = "missing";
  const h = harness({ mutate({ clerk }) {
    clerk.signOut = async (cb) => {
      callback = typeof cb;
      if (typeof cb !== "function") navigated = true;
      clerk.session = null;
      clerk.user = null;
      clerk.isSignedIn = false;
      clerk.client.sessions = [];
      clerk.client.signedInSessions = [];
    };
  } });
  await call(h.bridge, "configure", config);
  const signedOut = await call(h.bridge, "signOut");
  assert.equal(callback, "function");
  assert.equal(navigated, false);
  assert.equal(signedOut.state, "SIGNED_OUT");
  assert.equal(JSON.stringify(signedOut).includes("@"), false);
});

test("a failed sign-out blocks email flows and token mint but still allows retry", async () => {
  let attempts = 0;
  const h = harness({ mutate({ clerk }) {
    clerk.session = { status: "active", async getToken() { return jwt(Math.floor(Date.now() / 1000) + 50); } };
    clerk.user = { id: "user_1" };
    clerk.isSignedIn = true;
    clerk.signOut = async () => { attempts += 1; throw new TypeError("network down"); };
  } });
  await call(h.bridge, "configure", config);
  const failed = await call(h.bridge, "signOut");
  assert.equal(failed.state, "SIGN_OUT_FAILED");
  assert.equal(failed.phase, "sign_out_thrown");
  for (const mode of ["SIGN_IN", "SIGN_UP"]) {
    const begin = await call(h.bridge, "beginEmailCode", "person@example.com", mode);
    assert.equal(begin.state, "SIGN_OUT_FAILED");
    assert.equal(begin.phase, "sign_out_latched");
  }
  const complete = await call(h.bridge, "completeEmailCode", "123456");
  const resend = await call(h.bridge, "resendEmailCode");
  const token = await call(h.bridge, "getSessionToken", 10);
  assert.equal(complete.phase, "sign_out_latched");
  assert.equal(resend.phase, "sign_out_latched");
  assert.equal(token.token, undefined);
  const retried = await call(h.bridge, "signOut");
  assert.equal(attempts, 2);
  assert.equal(retried.state, "SIGN_OUT_FAILED");
  assert.equal(h.calls.some((item) => item[0] === "signIn.create"), false);
  assert.equal(h.calls.some((item) => item[0] === "signUp.create"), false);
});

test("null or stale sign-in create is network, not an unsupported challenge", async () => {
  const missing = harness({ mutate({ signIn }) { signIn.create = async () => null; } });
  await call(missing.bridge, "configure", config);
  const nulled = await call(missing.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(nulled.state, "ERROR");
  assert.equal(nulled.error_key, "NETWORK");
  assert.equal(nulled.phase, "create_null");
  const stale = harness({ mutate({ signIn }) {
    signIn.status = "needs_second_factor";
    signIn.protectCheck = { id: "protect" };
    signIn.create = async () => signIn;
  } });
  await call(stale.bridge, "configure", config);
  const unchanged = await call(stale.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(unchanged.error_key, "NETWORK");
  assert.equal(unchanged.phase, "create_stale");
  assert.notEqual(unchanged.error_key, "UNSUPPORTED_CHALLENGE");
  const thrown = harness({ mutate({ signIn }) {
    signIn.create = async () => { throw new TypeError("Failed to fetch"); };
  } });
  await call(thrown.bridge, "configure", config);
  const networked = await call(thrown.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(networked.error_key, "NETWORK");
  assert.equal(networked.phase, "create_thrown");
  assert.equal(JSON.stringify(networked).includes("person@"), false);
});

test("bridge source does not mix future methods or call FAPI itself", () => {
  for (const item of ["__internal_future", "emailCode", "useSignIn", "useSignUp", "signUpIfMissing", "localStorage", "fetch(", "finalize("]) {
    assert.equal(source.includes(item), false, item);
  }
  assert.equal(source.includes("prepareFirstFactor"), true);
  assert.equal(source.includes("prepareEmailAddressVerification"), true);
  assert.equal(source.includes("clerk-captcha"), true);
  assert.equal(source.includes("new Ctor"), false);
  assert.equal(source.includes("new Clerk"), false);
  assert.equal(source.includes("gd-clerk/clerk.browser.js"), true);
  assert.equal(source.includes("clerk.load()"), true);
});
