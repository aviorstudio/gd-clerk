import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { FIXED_ZIP_STAMP, zipDosStamp } from "../../scripts/zip-stamp.mjs";
import { buildCandidate } from "../../scripts/candidate-provenance.mjs";
import { couplingHits } from "../../scripts/consumer-boundary.mjs";
import { assertReleaseIdentity } from "../../scripts/check-release-identity.mjs";
import { godotLogProblems } from "../../scripts/reject-godot-log.mjs";
import { assertChecksum, assertMainRef } from "../../scripts/release-guard.mjs";
import { assertPublishBlocked } from "../../scripts/release-hold.mjs";
import { assertNotes, renderNotes } from "../../scripts/release-notes.mjs";
import { assertWorkflows } from "../../scripts/workflow-policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const commit = "a".repeat(40);
const sha = "b".repeat(64);
const browserSha = "c".repeat(64);

test("release guards reject a non-main ref and a checksum mismatch", () => {
  assert.throws(() => assertMainRef({ ref: "refs/heads/feat", head: commit, originMain: commit }), /main/);
  assert.throws(() => assertMainRef({ ref: "refs/heads/main", head: commit, originMain: "d".repeat(40) }), /origin\/main/);
  assert.doesNotThrow(() => assertMainRef({ ref: "refs/heads/main", head: commit, originMain: commit }));
  assert.throws(() => assertChecksum(sha, "d".repeat(64)), /checksum/);
  assert.throws(() => assertChecksum("", sha), /checksum/);
  assert.doesNotThrow(() => assertChecksum(sha, sha));
});

test("zip stamp stays at UTC epoch in every timezone", () => {
  assert.deepEqual(FIXED_ZIP_STAMP, { time: 0, day: 33 });
  const script = "import { zipDosStamp } from './scripts/zip-stamp.mjs'; const stamp = zipDosStamp(new Date(Date.UTC(1980,0,1,0,0,0))); if (stamp.time !== 0 || stamp.day !== 33) process.exit(1);";
  for (const tz of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    });
    assert.equal(ran.status, 0, ran.stderr);
  }
});

test("publish hold ignores sentinel files and acceptance inputs", () => {
  assert.throws(() => assertPublishBlocked(), /publishing is disabled/);
  const dir = mkdtempSync("/tmp/gd-clerk-hold-XXXXXX");
  writeFileSync(join(dir, "ACCEPTED"), "ACCEPTED\n");
  const rejected = spawnSync(process.execPath, [join(root, "scripts/release-hold.mjs"), "--accept", dir], {
    encoding: "utf8",
    env: { ...process.env, EXTERNAL_EVIDENCE_ACCEPTED: "true", ACCEPTED: "1" },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /publishing is disabled/);
});

test("candidate provenance is generic and is not a release", () => {
  const doc = buildCandidate({
    commit,
    zipSha256: sha,
    clerkBrowserSha256: browserSha,
    version: "0.1.0",
    entries: 34,
    clerkVersion: "6.33.0",
  });
  assert.equal(doc.release, false);
  assert.equal(doc.isolated_test_only, true);
  assert.equal(doc.schema, "gd-clerk.candidate.v1");
  assert.throws(() => buildCandidate({ commit: "abc", zipSha256: sha, clerkBrowserSha256: browserSha, entries: 34 }));
  assert.throws(() => assertReleaseIdentity({ tag: "v9.9.9", commit, version: "0.1.0" }));
  assert.doesNotThrow(() => assertReleaseIdentity({ tag: "v0.1.0", commit, version: "0.1.0" }));
});

test("repository source does not name a consuming game or inbox", () => {
  assert.deepEqual(couplingHits(root), []);
  const removed = ["live-e2e.mjs", ["agent", "mail-otp.mjs"].join(""), "e2e-web.mjs", "e2e-evidence.mjs", "require-live-evidence.mjs", "check-release-rules.mjs", "redact.mjs"];
  for (const name of removed) {
    assert.equal(existsSync(join(root, "scripts", name)), false);
  }
  assert.equal(existsSync(join(root, ".github/workflows/e2e.yml")), false);
  assert.equal(existsSync(join(root, "docs/E2E_ACCEPTANCE.md")), false);
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

test("workflows keep the publish token narrow and the evidence hold unconditional", () => {
  assertWorkflows(root);
  const allow = JSON.parse(readFileSync(join(root, "scripts/package-allowlist.json"), "utf8"));
  assert.equal(allow.addon_files, 33);
  assert.equal(allow.zip_entries, 34);
  assert.equal(allow.files.length, 33);
});
