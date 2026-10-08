import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("release publishes the tested zips to GitHub and then GDAM, only by hand", () => {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(release, /\non:\n  workflow_dispatch:\n/);
  assert.ok(release.indexOf("gh release create") < release.indexOf("gdam-actions/publish@"));
  assert.ok(release.includes("dist/@aviorstudio_gd-clerk.gdam.zip --target"));
  assert.ok(release.includes("sha256sum --check --strict @aviorstudio_gd-clerk.gdam.zip.sha256"));
  assert.equal(existsSync(join(root, "scripts/release-hold.mjs")), false);
});

test("GDAM publication is trusted publishing with no registry secret", () => {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const recovery = readFileSync(join(root, ".github/workflows/gdam-publish.yml"), "utf8");
  for (const text of [release, recovery]) {
    assert.doesNotMatch(text, /GDAM_SECRET_KEY|secret-key:/);
    assert.doesNotMatch(text, /gdam-actions\/install@/);
    assert.match(text, /id-token: write/);
    assert.match(text, /gdam-actions\/publish@[0-9a-f]{40}/);
  }
  const dir = mkdtempSync(join(tmpdir(), "gd-clerk-policy-"));
  const workflows = join(dir, ".github/workflows");
  mkdirSync(workflows, { recursive: true });
  const reset = () => {
    for (const name of ["release.yml", "ci.yml", "gdam-publish.yml"]) {
      copyFileSync(join(root, ".github/workflows", name), join(workflows, name));
    }
  };
  const mutate = (name, from, to, expected) => {
    reset();
    const text = readFileSync(join(root, ".github/workflows", name), "utf8");
    assert.ok(text.includes(from), `${name} lacks ${from}`);
    writeFileSync(join(workflows, name), text.replace(from, to));
    assert.throws(() => assertWorkflows(dir), expected);
  };
  try {
    reset();
    assert.doesNotThrow(() => assertWorkflows(dir));
    mutate("release.yml", "      id-token: write\n", "", /id-token: write/);
    mutate("gdam-publish.yml", "      id-token: write\n", "", /id-token: write/);
    mutate("release.yml", "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n", /only to the publishing jobs/);
    mutate("gdam-publish.yml", "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n", /only to the publishing jobs/);
    mutate("release.yml", "      id-token: write\n", "      id-token: write\n      GDAM_SECRET_KEY: x\n", /secret key/);
    mutate("gdam-publish.yml", "      - name: Publish to GDAM\n", "      - uses: aviorstudio/gdam-actions/install@3d9591c34711bb408302866d1e213409c2bdc59a\n      - name: Publish to GDAM\n", /installs the GDAM CLI/);
    mutate("gdam-publish.yml", "gdam-actions/publish@3d9591c34711bb408302866d1e213409c2bdc59a", "gdam-actions/publish@v0.3.0", /same full-SHA/);
    mutate("gdam-publish.yml", "gdam-actions/publish@3d9591c34711bb408302866d1e213409c2bdc59a", "gdam-actions/publish@" + "0".repeat(40), /same full-SHA/);
    mutate("gdam-publish.yml", 'test "$commit" = "$GITHUB_SHA"', "true", /bind the tag commit/);
    mutate("release.yml", 'test "$commit" = "$GITHUB_SHA"', "true", /release workflow missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate provenance is generic and is not a release", () => {
  const doc = buildCandidate({
    commit,
    zipSha256: sha,
    clerkBrowserSha256: browserSha,
    version: "0.1.0",
    entries: 38,
    clerkVersion: "6.38.1",
  });
  assert.equal(doc.release, false);
  assert.equal(doc.isolated_test_only, true);
  assert.equal(doc.schema, "gd-clerk.candidate.v1");
  assert.throws(() => buildCandidate({ commit: "abc", zipSha256: sha, clerkBrowserSha256: browserSha, entries: 38 }));
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
    entries: 38,
  };
  const notes = renderNotes(info);
  assertNotes(notes, info);
  assert.doesNotThrow(() => assert.match(notes, /Godot 4\.7 addon for Clerk email one-time codes on web and native builds/));
  assert.throws(() => assertNotes("# Release failure recovery\n", info));
});

test("addon version is declared once per surface and agrees everywhere", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const cfg = readFileSync(join(root, "addons/@aviorstudio_gd-clerk/plugin.cfg"), "utf8");
  const backend = readFileSync(join(root, "addons/@aviorstudio_gd-clerk/clerk_native_backend.gd"), "utf8");
  const packager = readFileSync(join(root, "scripts/package-addon.mjs"), "utf8");
  const verifier = readFileSync(join(root, "scripts/verify-zip.mjs"), "utf8");
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(cfg, new RegExp(`\nversion="${pkg.version.replaceAll(".", "\\.")}"\n`));
  assert.match(backend, new RegExp(`const ADDON_VERSION := "${pkg.version.replaceAll(".", "\\.")}"`));
  assert.ok(packager.includes(`plugin_version: "${pkg.version}"`));
  assert.ok(verifier.includes(`manifest.plugin_version !== "${pkg.version}"`));
  assert.ok(release.includes(`default: v${pkg.version}`));
  assert.doesNotMatch(cfg, /unavailable/i);
});

test("native backend never sends the publishable key and keeps the bridge untouched", () => {
  const backend = readFileSync(join(root, "addons/@aviorstudio_gd-clerk/clerk_native_backend.gd"), "utf8");
  assert.equal(backend.includes("publishable_key"), false);
  assert.ok(backend.includes("_is_native=true"));
  assert.ok(backend.includes("Clerk-API-Version: "));
  assert.ok(backend.includes("max_redirects = 0"));
  assert.ok(backend.includes("JSON.parse_string") === false);
  assert.equal(backend.includes("FileAccess.open"), false);
  const codes = JSON.parse(readFileSync(join(root, "addons/@aviorstudio_gd-clerk/observed_error_codes.json"), "utf8"));
  assert.equal(codes.native_codes.native_api_disabled, "CONFIG");
  assert.equal(codes.native_codes.verification_code_too_many_attempts, "RATE_LIMIT");
});

test("workflows keep the publish token narrow and releases manual", () => {
  assertWorkflows(root);
  const allow = JSON.parse(readFileSync(join(root, "scripts/package-allowlist.json"), "utf8"));
  assert.equal(allow.addon_files, 37);
  assert.equal(allow.zip_entries, 38);
  assert.equal(allow.files.length, 37);
});
