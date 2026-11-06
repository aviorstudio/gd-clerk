import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { couplingHits, FORBIDDEN_COUPLING } from "../security/consumer-boundary.mjs";
import { assertWorkflows } from "../release/workflow-policy.mjs";
const sharedUrl = pathToFileURL(join(process.env.TOOLS_ROOT, "helpers/addon-provenance.mjs")).href;
const shared = await import(sharedUrl);
const { FIXED_ZIP_STAMP, zipDosStamp, assertReleaseIdentity, godotLogProblems, assertChecksum, assertMainRef } = shared;


const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const policy = { ...shared.loadPolicy(root), forbidden_tokens: FORBIDDEN_COUPLING };
const normalize = (info) => ({ ...info, vendorVersion: info.clerkVersion, vendorBrowserSha256: info.clerkBrowserSha256 });
const buildCandidate = (info) => shared.buildCandidate(normalize(info), policy);
const renderNotes = (info) => shared.renderNotes(normalize(info), policy);
const assertNotes = (text, info) => shared.assertNotes(text, normalize(info));
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
  const script = `import { zipDosStamp } from ${JSON.stringify(sharedUrl)}; const stamp = zipDosStamp(new Date(Date.UTC(1980,0,1,0,0,0))); if (stamp.time !== 0 || stamp.day !== 33) process.exit(1);`;
  for (const tz of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    });
    assert.equal(ran.status, 0, ran.stderr);
  }
});

test("release publishes the tested zips to GitHub and then gdam, only by hand", () => {
  assertWorkflows(root);
  const release = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
  assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"]);
  assert.equal(policy.archive, "dist/@aviorstudio_gd-clerk.zip");
  assert.equal(policy.registry_archive, "dist/@aviorstudio_gd-clerk.gdam.zip");
  assert.equal(existsSync(join(root, "scripts/release-hold.mjs")), false);
});

test("gdam publication is trusted publishing with no registry secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-clerk-policy-"));
  const workflows = join(dir, ".github/workflows");
  mkdirSync(workflows, { recursive: true });
  const reset = () => {
    for (const name of ["release.yml", "ci.yml", "request-merge.yml", "gdam-publish.yml"])
      copyFileSync(join(root, ".github/workflows", name), join(workflows, name));
    for (const name of ["mise.toml", "cookbook.toml", "Makefile", "package-provenance.json"])
      copyFileSync(join(root, name), join(dir, name));
    cpSync(join(root, "tests"), join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "addon"), { recursive: true });
    copyFileSync(join(root, "addon/plugin.cfg"), join(dir, "addon/plugin.cfg"));
  };
  const mutate = (name, change) => {
    reset();
    const path = join(workflows, name);
    const doc = parse(readFileSync(path, "utf8"));
    change(doc);
    writeFileSync(path, stringify(doc));
    assert.throws(() => assertWorkflows(dir), /complete native gate|publishing|publication|id-token/);
  };
  const job = (doc) => Object.values(doc.jobs)[0];
  try {
    reset();
    assert.doesNotThrow(() => assertWorkflows(dir));
    for (const name of ["release.yml", "gdam-publish.yml"]) {
      mutate(name, (doc) => { delete job(doc).permissions["id-token"]; });
      mutate(name, (doc) => { doc.permissions["id-token"] = "write"; });
      mutate(name, (doc) => { job(doc).with["registry-key"] = "unreviewed-secret"; });
      mutate(name, (doc) => { job(doc).uses = job(doc).uses.replace(/@[a-f0-9]{40}$/, "@v0.3.0"); });
      mutate(name, (doc) => { job(doc).uses = job(doc).uses.replace(/@[a-f0-9]{40}$/, "@" + "0".repeat(40)); });
      mutate(name, (doc) => { job(doc).with.source = "unbound-run-commit"; });
    }
    mutate("ci.yml", (doc) => { job(doc).permissions["id-token"] = "write"; });
    mutate("release.yml", (doc) => { job(doc).secrets = { GDAM_SECRET_KEY: "x" }; });
    mutate("gdam-publish.yml", (doc) => { job(doc).steps = [{ uses: "aviorstudio/gdam-actions/install@" + "a".repeat(40) }]; });
    mutate("ci.yml", (doc) => { job(doc).uses = "nicodes/tools/.github/workflows/lint-only.yml@" + "a".repeat(40); });
    mutate("ci.yml", (doc) => { job(doc).if = "false"; });
    mutate("ci.yml", (doc) => { job(doc).with.base = "a".repeat(40); });
    mutate("ci.yml", (doc) => { job(doc).with["tools-ref"] = "0".repeat(40); });
    reset();
    const recipePath = join(dir, "cookbook.toml");
    const recipeSource = readFileSync(recipePath, "utf8");
    let pathChanges = 0;
    const changedRecipe = recipeSource.replace(/\bpath\s*=\s*"tests\/web\/revoke_export\.test\.mjs"/g, () => {
      pathChanges += 1;
      return 'path = "tests/removed-web"';
    });
    assert.equal(pathChanges, 1, "the missing regression control must change exactly one declared path");
    writeFileSync(recipePath, changedRecipe);
    assert.throws(() => assertWorkflows(dir), /every native\/browser\/web export regression/);
    reset();
    const projectPath = join(dir, "mise.toml");
    writeFileSync(projectPath, readFileSync(projectPath, "utf8").replace("sha256:cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4", "sha256:" + "0".repeat(64)));
    assert.throws(() => assertWorkflows(dir), /checksum-verified Godot/);
    reset();
    assert.doesNotThrow(() => assertWorkflows(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("candidate provenance is generic and is not a release", () => {
  const doc = buildCandidate({
    commit,
    zipSha256: sha,
    clerkBrowserSha256: browserSha,
    version: "0.1.0",
    entries: 37,
    clerkVersion: "6.38.1",
  });
  assert.equal(doc.release, false);
  assert.equal(doc.isolated_test_only, true);
  assert.equal(doc.schema, "gd-clerk.candidate.v1");
  assert.throws(() => buildCandidate({ commit: "abc", zipSha256: sha, clerkBrowserSha256: browserSha, entries: 37 }));
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
  const vendor = JSON.parse(readFileSync(join(root, "addon/javascript/clerk/VENDOR.json"), "utf8"));
  const info = {
    version: "0.1.0",
    tag: "v0.1.0",
    commit,
    zipSha256: sha,
    clerkVersion: vendor.version,
    integrity: vendor.integrity,
    entries: 37,
  };
  const notes = renderNotes(info);
  assertNotes(notes, info);
  assert.doesNotThrow(() => assert.match(notes, /Godot 4\.7 addon for Clerk email one-time codes on web and native builds/));
  assert.throws(() => assertNotes("# Release failure recovery\n", info));
});

test("addon version is declared once per surface and agrees everywhere", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const cfg = readFileSync(join(root, "addon/plugin.cfg"), "utf8");
  const backend = readFileSync(join(root, "addon/clerk_native_backend.gd"), "utf8");
  const recipe = JSON.parse(spawnSync("python3", ["-c", "import json,tomllib; print(json.dumps(tomllib.load(open(\"cookbook.toml\", \"rb\"))))"], { cwd: root, encoding: "utf8" }).stdout);
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(cfg, new RegExp(`\nversion="${pkg.version.replaceAll(".", "\\.")}"\n`));
  assert.match(backend, new RegExp(`const ADDON_VERSION := "${pkg.version.replaceAll(".", "\\.")}"`));
  assert.equal(recipe.package.format, "manifest");
  assert.equal(recipe.package.version_source, "package.json");
  assert.equal(recipe.package.allowlist, "package-allowlist.json");
  assert.equal(recipe.publication.provenance, "package-provenance.json");
  assert.match(release, /workflow_dispatch/);
  assert.doesNotMatch(cfg, /unavailable/i);
});

test("native backend never sends the publishable key and keeps the bridge untouched", () => {
  const backend = readFileSync(join(root, "addon/clerk_native_backend.gd"), "utf8");
  assert.equal(backend.includes("publishable_key"), false);
  assert.ok(backend.includes("_is_native=true"));
  assert.ok(backend.includes("Clerk-API-Version: "));
  assert.ok(backend.includes("max_redirects = 0"));
  assert.ok(backend.includes("JSON.parse_string") === false);
  assert.equal(backend.includes("FileAccess.open"), false);
  const codes = JSON.parse(readFileSync(join(root, "addon/observed_error_codes.json"), "utf8"));
  assert.equal(codes.native_codes.native_api_disabled, "CONFIG");
  assert.equal(codes.native_codes.verification_code_too_many_attempts, "RATE_LIMIT");
});

test("workflows keep the publish token narrow and releases manual", () => {
  assertWorkflows(root);
  const allow = JSON.parse(readFileSync(join(root, "package-allowlist.json"), "utf8"));
  assert.equal(allow.addon_files, 36);
  assert.equal(allow.zip_entries, 37);
  assert.equal(allow.files.length, 36);
});
