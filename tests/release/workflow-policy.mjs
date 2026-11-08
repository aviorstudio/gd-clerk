import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { FORBIDDEN_COUPLING } from "../security/consumer-boundary.mjs";

export function assertProjectGate(root) {
  const readToml = (name) => JSON.parse(execFileSync("python3", ["-c",
    "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", join(root, name)], { encoding: "utf8" }));
  const pins = readToml("mise.toml");
  const recipe = JSON.parse(execFileSync("python3", ["-c",
    "import json,sys; sys.path.insert(0,sys.argv[1]); from configuration import expand_tests; from godot_addon import package_data; data=json.load(sys.stdin); data['tests']=expand_tests(data['tests']); data['package']=package_data(data); print(json.dumps(data))",
    join(process.env.COOKBOOK_ROOT, "cookbook")], { encoding: "utf8", input: JSON.stringify(readToml("cookbook.toml")) }));
  assert.equal(recipe.recipe, "godot-addon");
  assert.deepEqual(recipe.node.packages, [{ directory: ".", manager: "npm", build: "vendor:check" }], "project must retain frozen Node dependencies and dependency audit");
  assert.equal(recipe.package.embedded_manifest, true, "project must verify both assembled ZIP forms");
  assert.equal(recipe.package.archive, "dist/@aviorstudio_gd-clerk.zip");
  assert.equal(recipe.package.registry_archive, "dist/@aviorstudio_gd-clerk.gdam.zip");
  assert.equal(recipe.package.prefix, "addons/@aviorstudio_gd-clerk/");
  assert.equal(recipe.package.script_uids, true);
  assert.equal(recipe.publication.mode, "tag", "release tag must match the native package version");
  assert.equal(recipe.publication.registry_auth, "oidc", "registry publication must use trusted OIDC identity");
  assert.equal(recipe.publication.provenance, "package-provenance.toml");
  const check = (suite, runner, path) => assert.ok(recipe.tests[suite]?.some((entry) => entry.runner === runner && entry.path === path), "project must retain every native/browser/web export regression: " + path);
  check("unit", "node-test", "tests/js");
  check("integration", "bash", "tests/native/run_tests.sh");
  check("integration", "node", "tests/editor/lifecycle.mjs");
  check("e2e", "node-test", "tests/browser");
  for (const name of ["origin", "configure", "revoke"])
    check("e2e", "node-test", `tests/web/${name}_export.test.mjs`);
  check("security", "node", "tests/security/source.mjs");
  assert.deepEqual(recipe.components.browser, { package: "." });
  assert.deepEqual(recipe.components.addon_dependencies, { mise_tool: "github:aviorstudio/gdam", sha256: "0c24b5958d7663b0cdc52465f39f4481d1d3e92ec1c6221b9dcc5e7faa1ef634", destination: ".artifacts/bin/gdam" });
  assert.equal(pins.tools["github:aviorstudio/gdam"].version, "v0.1.5", "registry SDK version must match the reviewed installer");
  assert.deepEqual(Object.fromEntries(["GODOT_VERSION", "GODOT_EXPECTED_VERSION", "GODOT_BINARY_CHECKSUM", "GODOT_TEMPLATES_CHECKSUM"].map((key) => [key, pins.env[key]])), {
    GODOT_VERSION: "4.7.2", GODOT_EXPECTED_VERSION: "4.7.2.stable.official.ed1daf0bf",
    GODOT_BINARY_CHECKSUM: "sha256:cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4",
    GODOT_TEMPLATES_CHECKSUM: "sha256:f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011"
  }, "project must retain checksum-verified Godot engine/templates");
  execFileSync("python3", ["-c",
    "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import generate,sdk_identity; root=Path(sys.argv[2]); generate.check_entrypoint(root,sdk_identity.source_identity(root)['revision'])",
    join(process.env.COOKBOOK_ROOT, "cookbook"), root], { encoding: "utf8" });
  return recipe;
}

export function assertWorkflows(root) {
  assertProjectGate(root);
  if (existsSync(join(root, ".github/workflows/e2e.yml"))) throw new Error("e2e workflow must not live in this repository");
  const cookbook = process.env.COOKBOOK_ROOT;
  if (!cookbook) throw new Error("run mise run setup before workflow policy assertions");
  const revision = JSON.parse(execFileSync("python3", ["-c",
    "import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import mise_entrypoint; print(json.dumps(mise_entrypoint.read(Path(sys.argv[2]))['revision']))",
    join(cookbook, "cookbook"), root], { encoding: "utf8" }));
  if (!revision) throw new Error("complete native gate requires a full source pin");
  const expected = JSON.parse(execFileSync("python3", ["-c",
    "import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import generate; print(json.dumps(generate.workflow_files(Path(sys.argv[2]),sys.argv[3])))",
    join(cookbook, "cookbook"), root, revision], { encoding: "utf8" }));
  if (!expected[".github/workflows/gdam-publish.yml"]) throw new Error("trusted publishing must retain exact-tag recovery");
  for (const [name, text] of Object.entries(expected)) {
    if (readFileSync(join(root, name), "utf8") !== text) throw new Error("complete native gate and publication callers must match the pinned cookbook: " + name);
    const doc = parse(text);
    for (const job of Object.values(doc.jobs ?? {})) {
      if (job.steps !== undefined || !/^nicodes\/cookbook\/\.github\/workflows\/[^@]+@[a-f0-9]{40}$/.test(job.uses ?? ""))
        throw new Error("all project workflow jobs must use pinned cookbook entrypoints");
    }
    for (const token of [...FORBIDDEN_COUPLING, "GDAM_SECRET_KEY", "secret-key", "live-e2e", "e2e-evidence", "ACCEPTED", "docs/E2E_ACCEPTANCE.md", "check-release-rules.mjs"])
      if (text.includes(token)) throw new Error("workflow contains forbidden coupling or registry secret: " + token);
  }
  const release = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
  const recovery = parse(readFileSync(join(root, ".github/workflows/gdam-publish.yml"), "utf8"));
  for (const doc of [release, recovery]) {
    assert.deepEqual(Object.keys(doc.on ?? {}), ["workflow_dispatch"], "publication must remain manual");
    assert.equal(Object.values(doc.jobs).some((job) => job.permissions?.["id-token"] === "write"), true, "trusted publication requires narrow job id-token: write");
    assert.equal(doc.permissions?.["id-token"], undefined, "id-token must be granted only to the publishing jobs");
  }
}
