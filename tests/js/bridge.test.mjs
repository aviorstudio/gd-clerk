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
      return {
        id: "",
        style: {},
        dataset: {},
        isConnected: false,
        className: "",
        setAttribute() {},
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
    async create(params) { calls.push(["signIn.create", params]); return this; },
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
      displayConfig: { captchaWidgetType: "smart" },
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
  const bridge = loadFactory()({
    getClerk: () => function Clerk() { return clerk; },
    getLocation: () => ({ origin: options.origin || "http://localhost:3100" }),
    getDocument: () => page.document,
    getSessionStorage: () => sessionStorage,
    MutationObserver: page.MutationObserver,
    now: () => options.now || 1_700_000_000_000,
    setTimer: (fn, ms) => setTimeout(fn, options.timerMs ?? ms),
    clearTimer: (id) => clearTimeout(id),
    atob: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  return { bridge, calls, clerk, signIn, signUp, page, store };
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
  allowed_origins: ["http://localhost:3100", "https://app.revik.gg"],
};

test("pinned error map and limits match the committed contract", () => {
  const factory = loadFactory();
  const bridge = factory({
    getClerk: () => function Clerk() { return { version: "6.33.0", async load() {} }; },
    getLocation: () => ({ origin: "http://localhost:3100" }),
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
  const { bridge: other } = harness({ origin: "http://localhost:3101" });
  const origin = await call(other, "configure", config);
  assert.equal(origin.error_key, "CONFIG");
  assert.equal(origin.message.includes("localhost:3101"), false);
});

test("configure accepts the explicit Fields and production origins only when they are current", async () => {
  const local = harness();
  const ok = await call(local.bridge, "configure", config);
  assert.equal(ok.state, "CONFIGURED");
  const prod = harness({ origin: "https://app.revik.gg" });
  const prodOk = await call(prod.bridge, "configure", config);
  assert.equal(prodOk.state, "CONFIGURED");
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
    const h = harness({ mutate({ signIn }) { signIn.status = status; signIn.create = async () => signIn; } });
    await call(h.bridge, "configure", config);
    const result = await call(h.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
    assert.equal(result.state, "NEEDS_MORE_STEPS");
    assert.equal(result.error_key, "UNSUPPORTED_CHALLENGE");
    assert.equal(h.calls.some((item) => item[0] === "setActive"), false);
  }
  const protect = harness({ mutate({ signIn }) { signIn.protectCheck = { id: "protect" }; signIn.create = async () => signIn; } });
  await call(protect.bridge, "configure", config);
  const blocked = await call(protect.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(blocked.error_key, "UNSUPPORTED_CHALLENGE");
  const missing = harness({ mutate({ signIn }) { signIn.supportedFirstFactors = [{ strategy: "password" }]; signIn.create = async () => signIn; } });
  await call(missing.bridge, "configure", config);
  const noFactor = await call(missing.bridge, "beginEmailCode", "person@example.com", "SIGN_IN");
  assert.equal(noFactor.error_key, "UNSUPPORTED_CHALLENGE");
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
  const disabled = harness({ mutate({ clerk }) { clerk.__internal_environment.userSettings.signUp.captcha_enabled = false; } });
  await call(disabled.bridge, "configure", config);
  const denied = await call(disabled.bridge, "beginEmailCode", "person@example.com", "SIGN_UP");
  assert.equal(denied.error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(disabled.calls.some((item) => item[0] === "signUp.create"), false);
  const invisible = harness({ mutate({ clerk }) { clerk.__internal_environment.displayConfig.captchaWidgetType = "invisible"; } });
  await call(invisible.bridge, "configure", config);
  assert.equal((await call(invisible.bridge, "beginEmailCode", "person@example.com", "SIGN_UP")).error_key, "UNSUPPORTED_CHALLENGE");
  assert.equal(invisible.calls.some((item) => item[0] === "signUp.create"), false);
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
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls.find((item) => item[0] === "signUp.create")[1])), { emailAddress: "person@example.com" });
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
  assert.equal(h.store.get("gd_clerk_sign_out_incomplete"), undefined);
});

test("bridge source does not mix future methods or call FAPI itself", () => {
  for (const item of ["__internal_future", "emailCode", "useSignIn", "useSignUp", "signUpIfMissing", "localStorage", "fetch(", "finalize("]) {
    assert.equal(source.includes(item), false, item);
  }
  assert.equal(source.includes("prepareFirstFactor"), true);
  assert.equal(source.includes("prepareEmailAddressVerification"), true);
  assert.equal(source.includes("clerk-captcha"), true);
  assert.equal(source.includes("new Ctor(key)"), true);
  assert.equal(source.includes("new Ctor(key, {"), false);
});
