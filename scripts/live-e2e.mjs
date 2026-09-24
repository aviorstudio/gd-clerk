import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForOtp, plusAddress, parseInbox, recipientOnInbox, DEFAULT_OTP_PATTERN, assertOtpPattern } from "./agentmail-otp.mjs";
import { buildEvidence, CAPTCHA_CONSTRAINT } from "./e2e-evidence.mjs";
import { assertWebExport, createExportServer, exerciseBrowser, exportWebProject, prepareProject } from "./e2e-web.mjs";
import { installRedactingConsole, redact } from "./redact.mjs";
import { CLERK_BROWSER_ENTRY, zipEntrySha256 } from "./zip-entry-sha.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_ORIGIN = "http://localhost:3100";
export const REQUIRED_ENV = [
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_FRONTEND_API",
  "CLERK_ALLOWED_ORIGIN",
  "AGENTMAIL_INBOX",
  "AGENTMAIL_API_KEY",
  "CLERK_OTP_FROM",
];

export function missingLiveEnv(env) {
  return REQUIRED_ENV.filter((name) => !env[name]);
}

export function assertOrigin(origin) {
  if (origin !== E2E_ORIGIN) throw new Error("this runner serves only http://localhost:3100");
}

export function assertPublishableBinding(key, fapi) {
  if (typeof key !== "string" || key.startsWith("sk_") || !/^pk_(test|live)_/.test(key)) {
    throw new Error("publishable key prefix is invalid");
  }
  let host = "";
  try {
    const url = new URL(fapi);
    if (url.protocol !== "https:" || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new Error("frontend API is not an https origin");
    }
    host = url.host.toLowerCase();
  } catch (err) {
    if (err.message === "frontend API is not an https origin") throw err;
    throw new Error("frontend API is not an https origin");
  }
  const parts = key.split("_");
  if (parts.length !== 3) throw new Error("publishable key prefix is invalid");
  const decoded = Buffer.from(parts[2], "base64").toString("utf8");
  if (!decoded.endsWith("$") || decoded.slice(0, -1).toLowerCase() !== host) {
    throw new Error("publishable key does not match frontend API");
  }
}

export function classifySignUpAttempt({ state, errorKey, captcha }) {
  if (captcha?.testingToken) return { fail: "captcha bypass detected; challenge was not marked accepted" };
  if (captcha?.invisible) return { fail: "invisible captcha fallback; sign-up was not accepted" };
  if (!captcha?.slotMounted) return { fail: "Smart bot protection was not confirmed" };
  if (captcha.challengeVisible) {
    return {
      email_code_sign_up: "blocked_by_challenge",
      captcha_challenge: "presented_unsolved",
      captcha_constraint: CAPTCHA_CONSTRAINT,
    };
  }
  if (state === "CODE_SENT") {
    return {
      email_code_sign_up: "delivered",
      captcha_challenge: "not_presented",
      captcha_constraint: "",
    };
  }
  return { fail: `sign-up failed: ${state}/${errorKey}` };
}

function packageZip() {
  const packed = spawnSync(process.execPath, ["scripts/package-addon.mjs"], { cwd: root, encoding: "utf8" });
  if (packed.status !== 0) throw new Error("addon package failed");
  return join(root, "dist/@aviorstudio_gd-clerk.zip");
}

export async function runLive(env, deps = {}) {
  const missing = missingLiveEnv(env);
  if (missing.length) throw new Error(`live acceptance missing: ${missing.join(", ")}`);
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || "") || !/^[0-9]+$/.test(env.GITHUB_RUN_ID || "")) {
    throw new Error("live evidence binding missing: GITHUB_SHA, GITHUB_RUN_ID");
  }
  assertOrigin(env.CLERK_ALLOWED_ORIGIN);
  assertPublishableBinding(env.CLERK_PUBLISHABLE_KEY, env.CLERK_FRONTEND_API);
  const pattern = env.CLERK_OTP_PATTERN || DEFAULT_OTP_PATTERN;
  assertOtpPattern(pattern);
  const inbox = parseInbox(env.AGENTMAIL_INBOX);
  const signInEmail = env.E2E_SIGN_IN_EMAIL || "";
  if (signInEmail && !recipientOnInbox(inbox, signInEmail)) throw new Error("sign-in mailbox is not on the configured inbox");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tag = env.RELEASE_TAG || `v${pkg.version}`;
  const zipPath = deps.packageZip ? deps.packageZip() : packageZip();
  const packageSha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  const browserSha = zipEntrySha256(zipPath, CLERK_BROWSER_ENTRY);
  const project = mkdtempSync("/tmp/gd-clerk-e2e-project-XXXXXX");
  const outDir = mkdtempSync("/tmp/gd-clerk-e2e-web-XXXXXX");
  let server;
  try {
    prepareProject(zipPath, join(root, "tests/e2e/harness"), project);
    const outHtml = join(outDir, "index.html");
    exportWebProject({
      godotBin: env.GODOT_BIN || "godot",
      projectDir: project,
      outHtml,
      env: {
        ...process.env,
        XDG_DATA_HOME: env.XDG_DATA_HOME || "/tmp/godot-data",
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || "/tmp/godot-config",
        GODOT_SILENCE_ROOT_WARNING: "1",
      },
    });
    assertWebExport(readFileSync(outHtml, "utf8"), join(outDir, "gd-clerk/clerk.browser.js"), browserSha);
    server = await createExportServer(outDir);
    const signUpEmail = plusAddress(inbox, `${env.GITHUB_RUN_ID}${randomBytes(3).toString("hex")}`);
    const report = await (deps.exerciseBrowser || exerciseBrowser)({
      url: `${E2E_ORIGIN}/index.html`,
      origin: E2E_ORIGIN,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
      frontendApi: env.CLERK_FRONTEND_API,
      signUpEmail,
      signInEmail,
      classify: classifySignUpAttempt,
      fetchOtp: ({ recipient, testStart }) => waitForOtp({
        inbox,
        recipient,
        sender: env.CLERK_OTP_FROM,
        subject: env.CLERK_OTP_SUBJECT || "",
        testStart,
        pattern,
      }).then((found) => found.code),
    });
    return buildEvidence({
      email_code_sign_in: "delivered",
      email_code_sign_up: report.email_code_sign_up,
      captcha_challenge: report.captcha_challenge,
      captcha_constraint: report.captcha_constraint,
    }, {
      commit: env.GITHUB_SHA,
      tag,
      package_sha256: packageSha,
      clerk_browser_sha256: browserSha,
      frontend_api: env.CLERK_FRONTEND_API,
      origin: E2E_ORIGIN,
      publishable_key_prefix: env.CLERK_PUBLISHABLE_KEY.startsWith("pk_live_") ? "pk_live_" : "pk_test_",
      run_id: env.GITHUB_RUN_ID,
      run_url: `https://github.com/aviorstudio/gd-clerk/actions/runs/${env.GITHUB_RUN_ID}`,
    });
  } finally {
    if (server) server.close();
    rmSync(project, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("live-e2e.mjs")) {
  installRedactingConsole();
  delete process.env.DEBUG;
  const evidencePath = join(root, "dist/e2e-evidence.json");
  runLive(process.env).then((evidence) => {
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(evidence.captcha_challenge === "presented_unsolved"
      ? "live evidence written; captcha challenge not accepted"
      : "live evidence written; captcha challenge not presented");
  }).catch((err) => {
    try { unlinkSync(evidencePath); } catch {}
    console.error(redact(err.message));
    process.exit(1);
  });
}
