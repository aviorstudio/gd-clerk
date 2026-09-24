import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_ORIGINS = ["http://localhost:3100", "https://app.revik.gg"];

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

export function verifyEvidence(evidence, expected) {
  if (typeof evidence === "string" || evidence == null || Array.isArray(evidence)) {
    throw new Error("live evidence must be a structured object, not a sentinel file");
  }
  if (isSentinel(JSON.stringify(evidence))) throw new Error("sentinel is not live evidence");
  const required = {
    schema: "gd-clerk.e2e.v1",
    source: "github-actions-e2e",
    live: true,
    mocked_clerk: false,
    email_code_sign_in: "delivered",
    email_code_sign_up: "delivered",
    captcha_challenge: "observed",
    sign_out: "confirmed",
    godot_web_export: "observed",
    clerk_version: "6.33.0",
  };
  for (const [key, value] of Object.entries(required)) {
    if (evidence[key] !== value) throw new Error(`live evidence missing ${key}`);
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
  if (!ALLOWED_ORIGINS.includes(evidence.origin)) throw new Error("live evidence origin is not an allowed origin");
  if (!httpsOrigin(evidence.frontend_api)) throw new Error("live evidence frontend API is not an https origin");
  if (evidence.publishable_key_prefix !== "pk_test_" && evidence.publishable_key_prefix !== "pk_live_") {
    throw new Error("live evidence must record only a publishable key prefix");
  }
  if (!/^[0-9]+$/.test(String(evidence.run_id))) throw new Error("live evidence run id is missing");
  const runUrl = `https://github.com/aviorstudio/gd-clerk/actions/runs/${evidence.run_id}`;
  if (evidence.run_url !== runUrl) throw new Error("live evidence run url does not match the run id");
  return evidence;
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
