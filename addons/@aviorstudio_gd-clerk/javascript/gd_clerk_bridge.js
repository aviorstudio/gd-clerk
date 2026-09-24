(function (root) {
  "use strict";

  var PINNED_CLERK_VERSION = "6.33.0";
  var CAPTCHA_ELEMENT_ID = "clerk-captcha";
  var INVISIBLE_CAPTCHA_CLASS = "clerk-invisible-captcha";
  var LATCH_KEY = "gd_clerk_sign_out_incomplete";
  var LIMITS = {
    max_email_length: 254,
    min_code_length: 4,
    max_code_length: 12,
    max_validity_seconds: 120,
    resend_cooldown_ms: 30000,
    network_timeout_ms: 30000,
    sign_up_timeout_ms: 120000,
    max_origins: 32,
    max_origin_length: 200,
    max_key_length: 512,
    max_fapi_length: 256,
    max_message_length: 180
  };
  // Codes observed in Clerk Frontend API error docs and pinned @clerk/clerk-js@6.33.0.
  // Unlisted codes stay UNKNOWN. Do not add a code that was not observed.
  var ERROR_CODE_MAP = {
    form_code_incorrect: "INVALID_CODE",
    verification_expired: "EXPIRED_CODE",
    too_many_requests: "RATE_LIMIT",
    signup_rate_limit_exceeded: "RATE_LIMIT",
    strategy_for_user_invalid: "UNSUPPORTED_CHALLENGE",
    signed_out: "SESSION_EXPIRED",
    captcha_invalid: "UNKNOWN",
    captcha_unavailable: "CONFIG",
    captcha_script_failed_to_load: "CONFIG"
  };
  var MESSAGES = {
    CODE_SENT: "Verification code sent.",
    AUTHENTICATED: "Signed in.",
    NEEDS_MORE_STEPS: "Additional verification is required and is not supported.",
    INVALID_CODE: "The verification code is invalid.",
    EXPIRED_CODE: "The verification code has expired.",
    RESEND_COOLDOWN: "Wait before requesting another code.",
    RATE_LIMIT: "Too many requests. Try again later.",
    NETWORK: "Network error. Try again.",
    CONFIG: "Configuration is invalid.",
    UNSUPPORTED_CHALLENGE: "This verification step is not supported.",
    SESSION_EXPIRED: "Session is not available.",
    CANCELLED: "The request was cancelled.",
    UNKNOWN: "The request failed.",
    UNAVAILABLE: "Sign-in is unavailable on this platform.",
    SIGNED_OUT: "Signed out.",
    SIGN_OUT_FAILED: "Sign-out could not be confirmed. Protected actions are blocked.",
    CONFIGURED: "Configured.",
    SIGN_UP_POLICY: "Sign-up requires Smart bot protection, which is not confirmed.",
    CAPTCHA_SLOT: "The Smart CAPTCHA slot could not be mounted. Sign-up was not started.",
    INVISIBLE_FALLBACK: "Invisible CAPTCHA fallback is not supported. Sign-up was stopped.",
    SESSION_PRESENT: "A session is already present.",
    FLOW_BUSY: "An email code request is already in progress.",
    NO_FLOW: "No email code request is in progress.",
    EMAIL: "The email address is not valid.",
    VALIDITY: "min_validity_seconds is out of range.",
    SDK_MISSING: "Clerk SDK is not loaded.",
    SDK_VERSION: "Clerk SDK version does not match the pinned build.",
    PROTECTED_BLOCKED: "Protected actions are blocked until sign-out is confirmed."
  };

  function createBridge(deps) {
    var clerk = null;
    var flow = null;
    var cancelGen = 0;
    var inflightFinish = null;
    var protectedBlocked = false;
    var refreshInflight = null;
    var signOutInflight = null;
    var sessionListener = null;
    var configured = false;

    function now() {
      return deps.now();
    }

    function storage() {
      try {
        return deps.getSessionStorage();
      } catch (e) {
        return null;
      }
    }

    function readLatch() {
      var store = storage();
      if (!store) return false;
      try {
        return store.getItem(LATCH_KEY) === "1";
      } catch (e) {
        return false;
      }
    }

    function setLatch() {
      protectedBlocked = true;
      var store = storage();
      if (!store) return;
      try {
        store.setItem(LATCH_KEY, "1");
      } catch (e) {
        // In-memory block still applies for this page.
      }
    }

    function clearLatch() {
      protectedBlocked = false;
      var store = storage();
      if (!store) return;
      try {
        store.removeItem(LATCH_KEY);
      } catch (e) {}
    }

    function sanitizeMessage(message) {
      var text = typeof message === "string" ? message : "";
      text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");
      text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
      text = text.replace(/\b\d{4,}\b/g, "[redacted]");
      if (text.length > LIMITS.max_message_length) text = text.slice(0, LIMITS.max_message_length);
      return text;
    }

    function result(state, errorKey, message, extra) {
      var out = {
        state: state,
        error_key: errorKey || "",
        message: sanitizeMessage(message || MESSAGES[errorKey] || MESSAGES[state] || "")
      };
      if (extra) {
        if (extra.token && state === "TOKEN") out.token = extra.token;
        if (extra.retryable === true) out.retryable = true;
      }
      return out;
    }

    function once(cb) {
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (inflightFinish === finish) inflightFinish = null;
        var safe = {
          state: value.state,
          error_key: value.error_key || "",
          message: sanitizeMessage(value.message || "")
        };
        if (value.retryable === true) safe.retryable = true;
        if (value.state === "TOKEN" && typeof value.token === "string") {
          safe.state = "AUTHENTICATED";
          safe.token = value.token;
        }
        var payload = JSON.stringify(safe);
        try {
          if (typeof cb === "function") cb(payload);
        } catch (e) {}
      }
      return finish;
    }

    function withTimeout(promise, ms) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = deps.setTimer(function () {
          if (done) return;
          done = true;
          var err = new Error("timeout");
          err.gdClerkTimeout = true;
          reject(err);
        }, ms);
        Promise.resolve(promise).then(function (value) {
          if (done) return;
          done = true;
          deps.clearTimer(timer);
          resolve(value);
        }, function (err) {
          if (done) return;
          done = true;
          deps.clearTimer(timer);
          reject(err);
        });
      });
    }

    function codesOf(err) {
      var codes = [];
      if (!err) return codes;
      if (typeof err.code === "string") codes.push(err.code);
      if (Array.isArray(err.errors)) {
        for (var i = 0; i < err.errors.length; i++) {
          if (err.errors[i] && typeof err.errors[i].code === "string") codes.push(err.errors[i].code);
        }
      }
      return codes;
    }

    function isNetwork(err) {
      if (!err) return false;
      if (err.gdClerkTimeout) return true;
      if (err.name === "ClerkOfflineError" || err.name === "TypeError") return true;
      var codes = codesOf(err);
      return codes.indexOf("clerk_offline") !== -1 || codes.indexOf("network_error") !== -1;
    }

    function mapError(err) {
      if (isNetwork(err)) return result("ERROR", "NETWORK", MESSAGES.NETWORK);
      if (err && err.status === 429) return result("ERROR", "RATE_LIMIT", MESSAGES.RATE_LIMIT);
      var codes = codesOf(err);
      for (var i = 0; i < codes.length; i++) {
        var mapped = ERROR_CODE_MAP[codes[i]];
        if (mapped === "INVALID_CODE") return result("ERROR", "INVALID_CODE", MESSAGES.INVALID_CODE);
        if (mapped === "EXPIRED_CODE") return result("ERROR", "EXPIRED_CODE", MESSAGES.EXPIRED_CODE);
        if (mapped === "RATE_LIMIT") return result("ERROR", "RATE_LIMIT", MESSAGES.RATE_LIMIT);
        if (mapped === "UNSUPPORTED_CHALLENGE") return result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS);
        if (mapped === "SESSION_EXPIRED") return result("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED);
        if (mapped === "CONFIG") return result("ERROR", "CONFIG", MESSAGES.CONFIG);
        if (mapped === "UNKNOWN") return result("ERROR", "UNKNOWN", MESSAGES.UNKNOWN);
      }
      if (err && err.verificationStatus === "expired") return result("ERROR", "EXPIRED_CODE", MESSAGES.EXPIRED_CODE);
      return result("ERROR", "UNKNOWN", MESSAGES.UNKNOWN);
    }

    function decodeKeyHost(key) {
      if (typeof key !== "string") return "";
      if (key.indexOf("sk_") === 0) return "";
      var parts = key.split("_");
      if (parts.length !== 3 || parts[0] !== "pk" || (parts[1] !== "test" && parts[1] !== "live")) return "";
      var decoded = "";
      try {
        decoded = deps.atob(parts[2]);
      } catch (e) {
        return "";
      }
      if (!decoded || decoded.charAt(decoded.length - 1) !== "$") return "";
      var host = decoded.slice(0, -1);
      if (!host || host.indexOf("$") !== -1 || host.indexOf("/") !== -1 || host.indexOf(".") === -1) return "";
      return host.toLowerCase();
    }

    function validateConfig(config, origin) {
      if (!config || typeof config !== "object") return MESSAGES.CONFIG;
      var forbidden = ["secret_key", "secretKey", "proxy_url", "proxyUrl", "token", "password", "tokenCache", "token_cache"];
      for (var i = 0; i < forbidden.length; i++) {
        if (Object.prototype.hasOwnProperty.call(config, forbidden[i]) && config[forbidden[i]]) return MESSAGES.CONFIG;
      }
      var key = config.publishable_key || config.publishableKey;
      var fapi = config.frontend_api || config.frontendApi;
      var origins = config.allowed_origins || config.allowedOrigins;
      if (typeof key !== "string" || key.length < 20 || key.length > LIMITS.max_key_length) return MESSAGES.CONFIG;
      if (key.indexOf("sk_") === 0) return MESSAGES.CONFIG;
      var host = decodeKeyHost(key);
      if (!host) return MESSAGES.CONFIG;
      if (typeof fapi !== "string" || fapi.length > LIMITS.max_fapi_length) return MESSAGES.CONFIG;
      var match = /^https:\/\/([^\/?#]+)$/.exec(fapi);
      if (!match) return MESSAGES.CONFIG;
      if (match[1].toLowerCase() !== host) return MESSAGES.CONFIG;
      if (!Array.isArray(origins) || origins.length < 1 || origins.length > LIMITS.max_origins) return MESSAGES.CONFIG;
      var allowed = false;
      for (var j = 0; j < origins.length; j++) {
        var item = origins[j];
        if (typeof item !== "string" || item.length < 1 || item.length > LIMITS.max_origin_length) return MESSAGES.CONFIG;
        if (!/^https?:\/\/[^\/?#]+$/.test(item)) return MESSAGES.CONFIG;
        if (item === origin) allowed = true;
      }
      if (!origin || !allowed) return MESSAGES.CONFIG;
      return "";
    }

    function currentSessionState() {
      var blocked = protectedBlocked || readLatch();
      var session = clerk && clerk.session;
      var pending = !!(session && (session.status === "pending" || session.currentTask || (session.tasks && session.tasks.length)));
      var active = !!(session && session.status === "active" && !pending && !blocked && clerk.isSignedIn);
      var status = "signed_out";
      if (!clerk) status = "unavailable";
      else if (pending) status = "pending";
      else if (active) status = "signed_in";
      else if (blocked && session) status = "sign_out_unconfirmed";
      return {
        signed_in: active,
        status: status,
        protected_actions_blocked: !!(blocked || pending)
      };
    }

    function emitSession() {
      if (typeof sessionListener !== "function") return;
      try {
        sessionListener(JSON.stringify(currentSessionState()));
      } catch (e) {}
    }

    function sessionAbsent() {
      if (!clerk) return false;
      if (clerk.session) return false;
      if (clerk.user) return false;
      if (clerk.isSignedIn) return false;
      var client = clerk.client;
      if (client && Array.isArray(client.signedInSessions) && client.signedInSessions.length > 0) return false;
      if (client && Array.isArray(client.sessions)) {
        for (var i = 0; i < client.sessions.length; i++) {
          var item = client.sessions[i];
          if (item && (item.status === "active" || item.status === "pending")) return false;
        }
      }
      return clerk.session === null && clerk.isSignedIn === false;
    }

    function safeReset(mode) {
      try {
        if (!clerk || !clerk.client) return;
        if (mode === "SIGN_UP" && typeof clerk.client.resetSignUp === "function") clerk.client.resetSignUp();
        else if (typeof clerk.client.resetSignIn === "function") clerk.client.resetSignIn();
      } catch (e) {}
    }

    function unsupportedSignInStatus(status) {
      return status === "needs_second_factor" || status === "needs_client_trust" || status === "needs_new_password";
    }

    function hasTasks(session) {
      if (!session) return false;
      if (session.currentTask) return true;
      if (session.tasks && session.tasks.length) return true;
      return session.status === "pending";
    }

    function readCaptchaPolicy() {
      var env = clerk && clerk.__internal_environment;
      if (!env || !env.userSettings || !env.userSettings.signUp || !env.displayConfig) return "unknown";
      if (env.userSettings.signUp.captcha_enabled !== true) return "disabled";
      if (env.displayConfig.captchaWidgetType === "invisible") return "invisible";
      if (env.displayConfig.captchaWidgetType !== "smart") return "widget";
      return "ok";
    }

    function mountCaptchaSlot() {
      var doc = deps.getDocument();
      if (!doc || !doc.body || typeof doc.createElement !== "function" || typeof doc.getElementById !== "function") return false;
      var el = doc.getElementById(CAPTCHA_ELEMENT_ID);
      if (!el) {
        el = doc.createElement("div");
        el.id = CAPTCHA_ELEMENT_ID;
        el.setAttribute("data-cl-theme", "auto");
        el.setAttribute("data-cl-size", "flexible");
        el.style.position = "fixed";
        el.style.zIndex = "2147483646";
        el.style.left = "50%";
        el.style.bottom = "16px";
        el.style.transform = "translateX(-50%)";
        doc.body.appendChild(el);
      }
      if (!el || el.id !== CAPTCHA_ELEMENT_ID) return false;
      if (el.isConnected === false) return false;
      return doc.getElementById(CAPTCHA_ELEMENT_ID) === el;
    }

    function watchInvisible(doc) {
      var saw = false;
      var observer = null;
      if (doc && doc.documentElement && typeof deps.MutationObserver === "function") {
        observer = new deps.MutationObserver(function () {
          if (doc.querySelector && doc.querySelector("." + INVISIBLE_CAPTCHA_CLASS)) saw = true;
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true });
      }
      return {
        saw: function () {
          return saw || !!(doc && doc.querySelector && doc.querySelector("." + INVISIBLE_CAPTCHA_CLASS));
        },
        stop: function () {
          if (observer) observer.disconnect();
        }
      };
    }

    function parseConfig(configOrJson) {
      if (typeof configOrJson === "string") return JSON.parse(configOrJson);
      return configOrJson;
    }

    async function recoverSignOut() {
      if (!readLatch()) return;
      protectedBlocked = true;
      try {
        await withTimeout(clerk.signOut(), LIMITS.network_timeout_ms);
      } catch (e) {
        return;
      }
      if (sessionAbsent()) clearLatch();
    }

    async function configure(configOrJson, cb) {
      var finish = once(cb);
      var config;
      try {
        config = parseConfig(configOrJson);
      } catch (e) {
        finish(result("ERROR", "CONFIG", MESSAGES.CONFIG));
        return;
      }
      var origin = "";
      try {
        origin = deps.getLocation().origin;
      } catch (e) {
        origin = "";
      }
      var problem = validateConfig(config, origin);
      if (problem) {
        finish(result("ERROR", "CONFIG", problem));
        return;
      }
      var Ctor = deps.getClerk();
      if (typeof Ctor !== "function") {
        finish(result("ERROR", "CONFIG", MESSAGES.SDK_MISSING));
        return;
      }
      try {
        var key = config.publishable_key || config.publishableKey;
        clerk = new Ctor(key);
        await withTimeout(clerk.load(), LIMITS.network_timeout_ms);
      } catch (e) {
        clerk = null;
        finish(isNetwork(e) ? result("ERROR", "NETWORK", MESSAGES.NETWORK) : result("ERROR", "CONFIG", MESSAGES.CONFIG));
        return;
      }
      if (!clerk || clerk.version !== PINNED_CLERK_VERSION) {
        clerk = null;
        finish(result("ERROR", "CONFIG", MESSAGES.SDK_VERSION));
        return;
      }
      configured = true;
      if (readLatch()) {
        await recoverSignOut();
      }
      if (typeof clerk.addListener === "function") {
        try {
          clerk.addListener(function () { emitSession(); });
        } catch (e) {}
      }
      emitSession();
      finish(result("CONFIGURED", "", MESSAGES.CONFIGURED));
    }

    function requireReady(finish) {
      if (!configured || !clerk) {
        finish(result("ERROR", "CONFIG", MESSAGES.CONFIG));
        return false;
      }
      return true;
    }

    async function finishAuthenticated(createdSessionId, finish, gen) {
      if (!createdSessionId || typeof clerk.setActive !== "function") {
        finish(result("ERROR", "UNKNOWN", MESSAGES.UNKNOWN));
        return;
      }
      try {
        await withTimeout(clerk.setActive({ session: createdSessionId }), LIMITS.network_timeout_ms);
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
        return;
      }
      if (gen !== cancelGen) return;
      if (hasTasks(clerk.session) || !clerk.session || clerk.session.status !== "active") {
        protectedBlocked = protectedBlocked || hasTasks(clerk.session);
        emitSession();
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      flow = null;
      emitSession();
      finish(result("AUTHENTICATED", "", MESSAGES.AUTHENTICATED));
    }

    async function beginSignIn(email, finish, gen) {
      if (clerk.session && clerk.isSignedIn) {
        finish(result("ERROR", "UNKNOWN", MESSAGES.SESSION_PRESENT));
        return;
      }
      var signIn = clerk.client && clerk.client.signIn;
      if (!signIn || typeof signIn.create !== "function") {
        finish(result("ERROR", "CONFIG", MESSAGES.CONFIG));
        return;
      }
      var created;
      try {
        created = await withTimeout(signIn.create({ identifier: email }), LIMITS.network_timeout_ms);
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
        return;
      }
      if (gen !== cancelGen) return;
      var resource = created || signIn;
      if (resource.isTransferable || resource.protectCheck || unsupportedSignInStatus(resource.status)) {
        safeReset("SIGN_IN");
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      var factors = resource.supportedFirstFactors || [];
      var factor = null;
      for (var i = 0; i < factors.length; i++) {
        if (factors[i] && factors[i].strategy === "email_code" && factors[i].emailAddressId) {
          factor = factors[i];
          break;
        }
      }
      if (!factor) {
        safeReset("SIGN_IN");
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      try {
        await withTimeout(signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId }), LIMITS.network_timeout_ms);
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
        return;
      }
      if (gen !== cancelGen) return;
      if (unsupportedSignInStatus(signIn.status) || signIn.protectCheck) {
        safeReset("SIGN_IN");
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      flow = { mode: "SIGN_IN", emailAddressId: factor.emailAddressId, sentAt: now() };
      finish(result("CODE_SENT", "", MESSAGES.CODE_SENT));
    }

    function signUpNeedsMore(signUp) {
      if (!signUp) return true;
      if (signUp.protectCheck) return true;
      var missing = signUp.missingFields || [];
      if (missing.length > 0) return true;
      var unverified = signUp.unverifiedFields || [];
      for (var i = 0; i < unverified.length; i++) {
        if (unverified[i] !== "email_address") return true;
      }
      if (signUp.status && signUp.status !== "missing_requirements" && signUp.status !== "complete") return true;
      return false;
    }

    async function beginSignUp(email, finish, gen) {
      if (readCaptchaPolicy() !== "ok") {
        finish(result("ERROR", "UNSUPPORTED_CHALLENGE", MESSAGES.SIGN_UP_POLICY));
        return;
      }
      if (!mountCaptchaSlot()) {
        finish(result("ERROR", "CONFIG", MESSAGES.CAPTCHA_SLOT));
        return;
      }
      var doc = deps.getDocument();
      if (!doc.getElementById(CAPTCHA_ELEMENT_ID)) {
        finish(result("ERROR", "CONFIG", MESSAGES.CAPTCHA_SLOT));
        return;
      }
      var signUp = clerk.client && clerk.client.signUp;
      if (!signUp || typeof signUp.create !== "function" || typeof signUp.prepareEmailAddressVerification !== "function") {
        finish(result("ERROR", "CONFIG", MESSAGES.CONFIG));
        return;
      }
      var watch = watchInvisible(doc);
      try {
        await withTimeout(signUp.create({ emailAddress: email }), LIMITS.sign_up_timeout_ms);
      } catch (e) {
        watch.stop();
        if (gen !== cancelGen) return;
        safeReset("SIGN_UP");
        finish(mapError(e));
        return;
      }
      watch.stop();
      if (gen !== cancelGen) return;
      if (watch.saw()) {
        safeReset("SIGN_UP");
        finish(result("ERROR", "UNSUPPORTED_CHALLENGE", MESSAGES.INVISIBLE_FALLBACK));
        return;
      }
      if (signUp.status === "complete") {
        safeReset("SIGN_UP");
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      if (signUpNeedsMore(signUp)) {
        safeReset("SIGN_UP");
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      try {
        await withTimeout(signUp.prepareEmailAddressVerification({ strategy: "email_code" }), LIMITS.network_timeout_ms);
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
        return;
      }
      if (gen !== cancelGen) return;
      flow = { mode: "SIGN_UP", sentAt: now() };
      finish(result("CODE_SENT", "", MESSAGES.CODE_SENT));
    }

    async function beginEmailCode(email, mode, cb) {
      var finish = once(cb);
      if (!requireReady(finish)) return;
      if (inflightFinish) {
        finish(result("ERROR", "UNKNOWN", MESSAGES.FLOW_BUSY));
        return;
      }
      if (typeof email !== "string") {
        finish(result("ERROR", "UNKNOWN", MESSAGES.EMAIL));
        return;
      }
      var trimmed = email.trim();
      if (trimmed.length < 3 || trimmed.length > LIMITS.max_email_length || /[\s\u0000-\u001f]/.test(trimmed) || trimmed.indexOf("@") <= 0 || trimmed.indexOf("@") !== trimmed.lastIndexOf("@")) {
        finish(result("ERROR", "UNKNOWN", MESSAGES.EMAIL));
        return;
      }
      var domain = trimmed.slice(trimmed.indexOf("@") + 1);
      if (domain.indexOf(".") <= 0 || domain.charAt(domain.length - 1) === ".") {
        finish(result("ERROR", "UNKNOWN", MESSAGES.EMAIL));
        return;
      }
      if (mode !== "SIGN_IN" && mode !== "SIGN_UP") {
        finish(result("ERROR", "CONFIG", MESSAGES.CONFIG));
        return;
      }
      if (flow) {
        finish(result("ERROR", "UNKNOWN", MESSAGES.FLOW_BUSY));
        return;
      }
      var gen = cancelGen;
      inflightFinish = finish;
      try {
        if (mode === "SIGN_UP") await beginSignUp(trimmed, finish, gen);
        else await beginSignIn(trimmed, finish, gen);
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
      }
    }

    async function completeEmailCode(code, cb) {
      var finish = once(cb);
      if (!requireReady(finish)) return;
      if (inflightFinish) {
        finish(result("ERROR", "UNKNOWN", MESSAGES.FLOW_BUSY));
        return;
      }
      if (!flow) {
        finish(result("ERROR", "CANCELLED", MESSAGES.NO_FLOW));
        return;
      }
      if (typeof code !== "string" || !/^[0-9]{4,12}$/.test(code.trim())) {
        finish(result("ERROR", "INVALID_CODE", MESSAGES.INVALID_CODE));
        return;
      }
      var gen = cancelGen;
      var active = flow;
      inflightFinish = finish;
      var attempt;
      try {
        if (active.mode === "SIGN_IN") {
          attempt = await withTimeout(clerk.client.signIn.attemptFirstFactor({ strategy: "email_code", code: code.trim() }), LIMITS.network_timeout_ms);
        } else {
          attempt = await withTimeout(clerk.client.signUp.attemptEmailAddressVerification({ code: code.trim() }), LIMITS.network_timeout_ms);
        }
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
        return;
      }
      if (gen !== cancelGen) return;
      var resource = attempt || (active.mode === "SIGN_IN" ? clerk.client.signIn : clerk.client.signUp);
      if (active.mode === "SIGN_IN" && (unsupportedSignInStatus(resource.status) || resource.protectCheck)) {
        safeReset("SIGN_IN");
        flow = null;
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      if (active.mode === "SIGN_UP" && (resource.protectCheck || (resource.missingFields && resource.missingFields.length) || (signUpNeedsMore(resource) && resource.status !== "complete"))) {
        safeReset("SIGN_UP");
        flow = null;
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      var verification = resource.firstFactorVerification;
      if (verification && verification.status === "expired") {
        finish(result("ERROR", "EXPIRED_CODE", MESSAGES.EXPIRED_CODE));
        return;
      }
      if (resource.status !== "complete" || !resource.createdSessionId) {
        finish(result("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS));
        return;
      }
      await finishAuthenticated(resource.createdSessionId, finish, gen);
    }

    async function resendEmailCode(cb) {
      var finish = once(cb);
      if (!requireReady(finish)) return;
      if (!flow) {
        finish(result("ERROR", "CANCELLED", MESSAGES.NO_FLOW));
        return;
      }
      if (now() - flow.sentAt < LIMITS.resend_cooldown_ms) {
        finish(result("ERROR", "RESEND_COOLDOWN", MESSAGES.RESEND_COOLDOWN));
        return;
      }
      var gen = cancelGen;
      inflightFinish = finish;
      try {
        if (flow.mode === "SIGN_IN") {
          await withTimeout(clerk.client.signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: flow.emailAddressId }), LIMITS.network_timeout_ms);
        } else {
          if (!mountCaptchaSlot()) {
            finish(result("ERROR", "CONFIG", MESSAGES.CAPTCHA_SLOT));
            return;
          }
          await withTimeout(clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" }), LIMITS.network_timeout_ms);
        }
      } catch (e) {
        if (gen !== cancelGen) return;
        finish(mapError(e));
        return;
      }
      if (gen !== cancelGen) return;
      flow.sentAt = now();
      finish(result("CODE_SENT", "", MESSAGES.CODE_SENT));
    }

    function cancelEmailCode() {
      cancelGen += 1;
      var mode = flow && flow.mode;
      flow = null;
      var finish = inflightFinish;
      inflightFinish = null;
      safeReset(mode || "SIGN_IN");
      if (finish) finish(result("ERROR", "CANCELLED", MESSAGES.CANCELLED));
    }

    function base64UrlDecode(input) {
      var text = input.replace(/-/g, "+").replace(/_/g, "/");
      while (text.length % 4) text += "=";
      return deps.atob(text);
    }

    function remainingSeconds(token) {
      if (typeof token !== "string") return null;
      var parts = token.split(".");
      if (parts.length !== 3) return null;
      try {
        var json = JSON.parse(base64UrlDecode(parts[1]));
        if (!json || typeof json.exp !== "number" || !isFinite(json.exp)) return null;
        return json.exp - Math.floor(now() / 1000);
      } catch (e) {
        return null;
      }
    }

    function meets(token, minValidity) {
      var remaining = remainingSeconds(token);
      return remaining !== null && remaining >= minValidity;
    }

    async function getSessionToken(minValidity, cb) {
      var finish = once(cb);
      if (!requireReady(finish)) return;
      var min = minValidity;
      if (typeof min === "string" && /^[0-9]+$/.test(min)) min = parseInt(min, 10);
      if (typeof min !== "number" || !isFinite(min) || min < 0 || min > LIMITS.max_validity_seconds) {
        finish(result("ERROR", "CONFIG", MESSAGES.VALIDITY));
        return;
      }
      if (protectedBlocked || readLatch()) {
        finish(result("SIGN_OUT_FAILED", "UNKNOWN", MESSAGES.PROTECTED_BLOCKED, { retryable: true }));
        return;
      }
      var session = clerk.session;
      if (!session || typeof session.getToken !== "function" || session.status !== "active" || hasTasks(session)) {
        if (hasTasks(session)) finish(result("ERROR", "UNSUPPORTED_CHALLENGE", MESSAGES.UNSUPPORTED_CHALLENGE));
        else finish(result("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED));
        return;
      }
      var first;
      try {
        first = await session.getToken();
      } catch (e) {
        finish(mapError(e));
        return;
      }
      if (meets(first, min)) {
        finish(result("TOKEN", "", "", { token: first }));
        return;
      }
      if (!refreshInflight) {
        var current = session;
        refreshInflight = Promise.resolve().then(function () {
          return current.getToken({ skipCache: true });
        }).finally(function () {
          refreshInflight = null;
        });
      }
      var shared = refreshInflight;
      var refreshed;
      try {
        refreshed = await shared;
      } catch (e) {
        finish(mapError(e));
        return;
      }
      if (meets(refreshed, min)) finish(result("TOKEN", "", "", { token: refreshed }));
      else finish(result("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED));
    }

    async function doSignOut() {
      setLatch();
      emitSession();
      try {
        await withTimeout(clerk.signOut(), LIMITS.network_timeout_ms);
      } catch (e) {
        return result("SIGN_OUT_FAILED", isNetwork(e) ? "NETWORK" : "UNKNOWN", MESSAGES.SIGN_OUT_FAILED, { retryable: true });
      }
      if (!sessionAbsent()) {
        return result("SIGN_OUT_FAILED", "UNKNOWN", MESSAGES.SIGN_OUT_FAILED, { retryable: true });
      }
      clearLatch();
      flow = null;
      emitSession();
      return result("SIGNED_OUT", "", MESSAGES.SIGNED_OUT);
    }

    function signOut(cb) {
      var finish = once(cb);
      if (!requireReady(finish)) return;
      if (!signOutInflight) {
        signOutInflight = doSignOut().finally(function () {
          signOutInflight = null;
        });
      }
      signOutInflight.then(function (value) {
        finish(value);
      }, function () {
        finish(result("SIGN_OUT_FAILED", "UNKNOWN", MESSAGES.SIGN_OUT_FAILED, { retryable: true }));
      });
    }

    return {
      configure: configure,
      beginEmailCode: beginEmailCode,
      completeEmailCode: completeEmailCode,
      resendEmailCode: resendEmailCode,
      cancelEmailCode: cancelEmailCode,
      getSessionToken: getSessionToken,
      signOut: signOut,
      setSessionListener: function (cb) {
        sessionListener = cb;
        emitSession();
      },
      _limits: LIMITS,
      _errorCodes: ERROR_CODE_MAP,
      _pinnedVersion: PINNED_CLERK_VERSION
    };
  }

  var bridge = createBridge({
    getClerk: function () { return root.Clerk; },
    getLocation: function () { return root.location; },
    getDocument: function () { return root.document; },
    getSessionStorage: function () { return root.sessionStorage; },
    MutationObserver: root.MutationObserver,
    now: function () { return Date.now(); },
    setTimer: function (fn, ms) { return root.setTimeout(fn, ms); },
    clearTimer: function (id) { root.clearTimeout(id); },
    atob: function (value) { return root.atob(value); }
  });
  bridge._createForTest = createBridge;
  root.GdClerkBridge = bridge;
})(typeof window !== "undefined" ? window : globalThis);
