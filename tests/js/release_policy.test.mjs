import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertNoCommittedSentinel, isSentinel, verifyEvidence } from "../../scripts/e2e-evidence.mjs";
import { assertReleaseIdentity } from "../../scripts/check-release-identity.mjs";
import { godotLogProblems } from "../../scripts/reject-godot-log.mjs";
import { assertNotes, renderNotes } from "../../scripts/release-notes.mjs";
import { assertWorkflows } from "../../scripts/workflow-policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const commit = "a".repeat(40);
const sha = "b".repeat(64);
const browserSha = "c".repeat(64);
const expected = { commit, tag: "v0.1.0", package_sha256: sha, clerk_browser_sha256: browserSha };

function evidence(overrides = {}) {
  return {
    schema: "gd-clerk.e2e.v2",
    source: "github-actions-e2e",
    live: true,
    mocked_clerk: false,
    commit,
    tag: "v0.1.0",
    package_sha256: sha,
    clerk_browser_sha256: browserSha,
    clerk_version: "6.33.0",
    godot_version: "4.7.2-stable",
    runner: "scripts/live-e2e.mjs",
    frontend_api: "https://example.clerk.accounts.dev",
    origin: "https://app.revik.gg",
    publishable_key_prefix: "pk_test_",
    email_code_sign_in: "delivered",
    email_code_sign_up: "delivered",
    captcha_challenge: "not_presented",
    captcha_challenge_accepted: false,
    captcha_constraint: "",
    captcha_policy: "smart",
    captcha_slot: "mounted",
    invisible_fallback: "refused",
    captcha_bypass: "refused",
    sign_out: "confirmed",
    reload_signed_out: "confirmed",
    network_failure: "observed",
    godot_web_export: "observed",
    exercised: [
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
    ],
    run_id: "123",
    run_url: "https://github.com/aviorstudio/gd-clerk/actions/runs/123",
    ...overrides,
  };
}

test("sentinel and committed acceptance files are rejected", () => {
  assert.equal(isSentinel("ACCEPTED\n"), true);
  assert.throws(() => verifyEvidence("ACCEPTED", expected), /sentinel/);
  assert.throws(() => verifyEvidence(evidence({ source: "committed-file" }), expected), /source/);
  assert.throws(() => verifyEvidence(evidence({ package_sha256: "c".repeat(64) }), expected), /sha256/);
  assert.throws(() => verifyEvidence(evidence({ godot_web_export: "untested" }), expected), /godot_web_export/);
  assertNoCommittedSentinel(root);
  const dir = mkdtempSync("/tmp/gd-clerk-sentinel-XXXXXX");
  const file = join(dir, "notes.txt");
  writeFileSync(file, "ACCEPTED\n");
  const rejected = spawnSync(process.execPath, [join(root, "scripts/require-live-evidence.mjs"), "--file", file], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_COMMIT: commit, RELEASE_TAG: "v0.1.0", PACKAGE_SHA256: sha },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /sentinel/);
});

test("structured live evidence matches only the tested artifact", () => {
  assert.equal(verifyEvidence(evidence(), expected).live, true);
  assert.throws(() => assertReleaseIdentity({ tag: "v9.9.9", commit, version: "0.1.0" }));
  assert.doesNotThrow(() => assertReleaseIdentity({ tag: "v0.1.0", commit, version: "0.1.0" }));
});

test("godot log rejector fails closed on engine errors", () => {
  assert.deepEqual(godotLogProblems("ok native methods\n"), []);
  assert.equal(godotLogProblems("ERROR: boom\n").length, 1);
  assert.equal(godotLogProblems("SCRIPT ERROR: Parse Error: x\n").length, 1);
  assert.equal(godotLogProblems("WARNING: 3 ObjectDB instances were leaked at exit\n").length, 1);
});

test("release notes are package provenance", () => {
  const vendor = JSON.parse(readFileSync(join(root, "addons/@aviorstudio_gd-clerk/javascript/clerk/VENDOR.json"), "utf8"));
  const info = {
    version: "0.1.0",
    tag: "v0.1.0",
    commit,
    zipSha256: sha,
    clerkVersion: vendor.version,
    integrity: vendor.integrity,
    entries: 34,
  };
  const notes = renderNotes(info);
  assertNotes(notes, info);
  assert.doesNotThrow(() => assert.match(notes, /Web-only Godot 4\.7/));
  assert.throws(() => assertNotes("# Release failure recovery\n", info));
});

test("workflows keep verify read-only and publish narrow", () => {
  assertWorkflows(root);
  const allow = JSON.parse(readFileSync(join(root, "scripts/package-allowlist.json"), "utf8"));
  assert.equal(allow.addon_files, 33);
  assert.equal(allow.zip_entries, 34);
  assert.equal(allow.files.length, 33);
});
