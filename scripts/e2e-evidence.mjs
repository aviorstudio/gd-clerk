import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_ORIGINS = ["http://localhost:3100", "https://app.revik.gg"];
export const CAPTCHA_CONSTRAINT = "clerk_turnstile_interactive_unautomatable";
export const EXERCISED = [
  "captcha_bypass_refused",
  "captcha_policy_smart",
  "captcha_slot_mounted",
  "email_code_sign_in",
  "godot_web_export",
  "invisible_fallback_refused",
  "network_failure",
  "reload_signed_out",
  "sign_out",
  "sign_up_attempted",
];

export function isSentinel(value) {
  return typeof value === "string" && value.trim() === "ACCEPTED";
}

export function assertNoCommittedSentinel(root) {
  const path = join(root, "docs/E2E_ACCEPTANCE.md");
  if (existsSync(path)) {
    throw new Error("committed docs/E2E_ACCEPTANCE.md is not live evidence");
  }
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && (url.pathname === "" || url.pathname === "/") && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function assertNoSecrets(evidence) {
  const text = JSON.stringify(evidence);
  if (/sk_|pk_(test|live)_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{8,}/.test(text)) {
    throw new Error("live evidence contains a secret");
  }
  if (/@/.test(text)) throw new Error("live evidence contains an email");
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "run_id" || key === "run_url" || key === "origin" || key === "exercised") continue;
    if (typeof value === "string" && /\d{4,}/.test(value)) throw new Error("live evidence contains a code");
  }
}

export function verifyEvidence(evidence, expected) {
  if (typeof evidence === "string" || evidence == null || Array.isArray(evidence)) {
    throw new Error("live evidence must be a structured object, not a sentinel file");
  }
  if (isSentinel(JSON.stringify(evidence))) throw new Error("sentinel is not live evidence");
  const required = {
    schema: "gd-clerk.e2e.v2",
    source: "github-actions-e2e",
    live: true,
    mocked_clerk: false,
    email_code_sign_in: "delivered",
    sign_out: "confirmed",
    reload_signed_out: "confirmed",
    network_failure: "observed",
    godot_web_export: "observed",
    clerk_version: "6.33.0",
    godot_version: "4.7.2-stable",
    runner: "scripts/live-e2e.mjs",
    captcha_policy: "smart",
    captcha_slot: "mounted",
    invisible_fallback: "refused",
    captcha_bypass: "refused",
  };
  for (const [key, value] of Object.entries(required)) {
    if (evidence[key] !== value) throw new Error(`live evidence missing ${key}`);
  }
  if (evidence.captcha_challenge_accepted !== false) {
    throw new Error("captcha challenge was not genuinely observed");
  }
  if (evidence.captcha_challenge === "observed") {
    throw new Error("captcha challenge was not genuinely observed");
  }
  if (evidence.captcha_challenge === "not_presented") {
    if (evidence.email_code_sign_up !== "delivered" || evidence.captcha_constraint !== "") {
      throw new Error("live evidence sign-up outcome does not match the captcha observation");
    }
  } else if (evidence.captcha_challenge === "presented_unsolved") {
    if (evidence.email_code_sign_up !== "blocked_by_challenge" || evidence.captcha_constraint !== CAPTCHA_CONSTRAINT) {
      throw new Error("live evidence sign-up outcome does not match the captcha observation");
    }
  } else {
    throw new Error("live evidence missing captcha_challenge");
  }
  if (JSON.stringify(evidence.exercised) !== JSON.stringify(EXERCISED)) {
    throw new Error("live evidence exercised set is incomplete");
  }
  for (const value of Object.values(evidence)) {
    if (value === "ACCEPTED") throw new Error("sentinel value is not live evidence");
  }
  if (evidence.commit !== expected.commit || !/^[0-9a-f]{40}$/.test(evidence.commit)) {
    throw new Error("live evidence commit does not match the tested commit");
  }
  if (evidence.tag !== expected.tag) throw new Error("live evidence tag does not match");
  if (evidence.package_sha256 !== expected.package_sha256 || !/^[0-9a-f]{64}$/.test(evidence.package_sha256)) {
    throw new Error("live evidence package sha256 does not match the tested artifact");
  }
  if (evidence.clerk_browser_sha256 !== expected.clerk_browser_sha256 || !/^[0-9a-f]{64}$/.test(evidence.clerk_browser_sha256)) {
    throw new Error("live evidence clerk bundle sha256 does not match the tested artifact");
  }
  if (!ALLOWED_ORIGINS.includes(evidence.origin)) throw new Error("live evidence origin is not an allowed origin");
  if (!httpsOrigin(evidence.frontend_api)) throw new Error("live evidence frontend API is not an https origin");
  if (evidence.publishable_key_prefix !== "pk_test_" && evidence.publishable_key_prefix !== "pk_live_") {
    throw new Error("live evidence must record only a publishable key prefix");
  }
  if (!/^[0-9]+$/.test(String(evidence.run_id))) throw new Error("live evidence run id is missing");
  const runUrl = `https://github.com/aviorstudio/gd-clerk/actions/runs/${evidence.run_id}`;
  if (evidence.run_url !== runUrl) throw new Error("live evidence run url does not match the run id");
  assertNoSecrets(evidence);
  return evidence;
}

export function buildEvidence(report, binding) {
  const evidence = {
    schema: "gd-clerk.e2e.v2",
    source: "github-actions-e2e",
    live: true,
    mocked_clerk: false,
    commit: binding.commit,
    tag: binding.tag,
    package_sha256: binding.package_sha256,
    clerk_browser_sha256: binding.clerk_browser_sha256,
    clerk_version: "6.33.0",
    godot_version: "4.7.2-stable",
    runner: "scripts/live-e2e.mjs",
    frontend_api: binding.frontend_api,
    origin: binding.origin,
    publishable_key_prefix: binding.publishable_key_prefix,
    email_code_sign_in: report.email_code_sign_in,
    email_code_sign_up: report.email_code_sign_up,
    captcha_challenge: report.captcha_challenge,
    captcha_challenge_accepted: false,
    captcha_constraint: report.captcha_constraint,
    captcha_policy: "smart",
    captcha_slot: "mounted",
    invisible_fallback: "refused",
    captcha_bypass: "refused",
    sign_out: "confirmed",
    reload_signed_out: "confirmed",
    network_failure: "observed",
    godot_web_export: "observed",
    exercised: EXERCISED,
    run_id: binding.run_id,
    run_url: binding.run_url,
  };
  return verifyEvidence(evidence, binding);
}

export function assertRunBinding(run, evidence) {
  if (!run || run.conclusion !== "success") throw new Error("live acceptance missing");
  if (run.headSha !== evidence.commit) throw new Error("e2e run SHA does not match evidence");
  if (String(run.databaseId) !== String(evidence.run_id)) throw new Error("e2e run id does not match evidence");
  if (run.url !== evidence.run_url) throw new Error("e2e run url does not match evidence");
}

if (process.argv[1] && process.argv[1].endsWith("e2e-evidence.mjs")) {
  if (process.argv.includes("--reject-committed")) {
    try {
      assertNoCommittedSentinel(join(dirname(fileURLToPath(import.meta.url)), ".."));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
}
