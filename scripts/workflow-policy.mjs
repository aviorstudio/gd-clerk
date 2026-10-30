import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { execFileSync } from "node:child_process";
import { FORBIDDEN_COUPLING } from "./consumer-boundary.mjs";

function workflow(root, name) {
  const text = readFileSync(join(root, ".github/workflows", name), "utf8");
  const doc = parseDocument(text, { uniqueKeys: true, stringKeys: true });
  if (doc.errors.length) throw new Error(`${name}: ${doc.errors[0].message}`);
  return doc.toJS({ maxAliasCount: 0 });
}
const commands = (job) => (job.steps ?? []).map((step) => step.run ?? "").join("\n");
const unconditional = (step) => step.if === undefined && step["continue-on-error"] === undefined;
const requireText = (text, value, message) => {
  if (!text.includes(value)) throw new Error(message ?? `release workflow missing ${value}`);
};

function assertNativeGate(doc, jobName, revision) {
  const job = doc.jobs?.[jobName];
  const steps = job?.steps ?? [];
  const index = steps.findIndex((step) => step.run?.trim() === "set -euo pipefail\nmise run check");
  const check = steps[index];
  if (!job || job["continue-on-error"] !== undefined || !check || !unconditional(check)
      || check.with !== undefined || check["working-directory"] !== undefined
      || doc.defaults?.run?.["working-directory"] || job.defaults?.run?.["working-directory"]
      || !steps.slice(0, index).some((step) => step.uses === `nicodes/tools/setup@${revision}` && unconditional(step)
        && Object.keys(step.with ?? {}).length === 0)) {
    throw new Error(`${jobName} must run the unconditional complete native gate after matching tools setup`);
  }
}

function assertProjectGate(root, ci) {
  const project = JSON.parse(execFileSync("python3", ["-c",
    "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", join(root, "mise.toml")], { encoding: "utf8" }));
  const tasks = project.tasks;
  assert.deepEqual(tasks["_unit"].run, ["bash scripts/test-env.sh npm test", "bash scripts/test-env.sh bash scripts/run-godot-tests.sh", "bash scripts/test-env.sh npm run test:browser", "bash scripts/test-env.sh node --test tests/web/origin_export.test.mjs", "bash scripts/test-env.sh node --test tests/web/configure_export.test.mjs", "bash scripts/test-env.sh node --test tests/web/revoke_export.test.mjs"], "project must retain every native/browser/web export regression");
  assert.deepEqual(tasks["lint"].run, ["npm audit --audit-level=high", "node scripts/vendor-clerk.mjs --check", "node scripts/scan.mjs", "node scripts/workflow-policy.mjs"], "project must retain source and dependency controls");
  assert.deepEqual(tasks["_build"].run, ["node scripts/package-addon.mjs", "node scripts/verify-zip.mjs dist/@aviorstudio_gd-clerk.zip"], "project must verify the assembled ZIP");
  assert.deepEqual(tasks["artifact-check"].run, ["bash scripts/test-env.sh node scripts/editor-lifecycle.mjs dist/@aviorstudio_gd-clerk.zip"], "project must verify the installed ZIP editor lifecycle");
  assert.deepEqual(tasks["unit"].run, "python3 \"$TOOLS_ROOT/helpers/verification.py\" test --name unit --artifact dist -- mise run _unit", "project must retain source-bound unit evidence");
  assert.deepEqual(tasks["build"].run, "python3 \"$TOOLS_ROOT/helpers/verification.py\" build --name build --artifact dist -- mise run _build", "project must retain source-bound build evidence");
  assert.deepEqual(tasks["check"].run, "python3 \"$TOOLS_ROOT/helpers/verification.py\" session --test unit -- mise run _check-stages", "project must require current-session test evidence");
  assert.deepEqual(tasks["_check-stages"].run, [{"task": "install"}, {"task": "lint"}, {"task": "build"}, {"task": "unit"}, {"task": "artifact-check"}], "project must retain the complete native gate");
  assert.deepEqual(tasks["install"].run, ["env GODOT_BIN=\"$PWD/.artifacts/godot/bin/godot\" XDG_DATA_HOME=\"$PWD/.artifacts/godot-data\" PATH=\"$PWD/.artifacts/godot/bin:$PATH\" python3 \"$TOOLS_ROOT/helpers/godot-setup.py\" --version 4.7.2 --expected-version 4.7.2.stable.official.ed1daf0bf --binary-checksum sha256:cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4 --root .artifacts/godot --origin godot-builds --templates --templates-checksum sha256:f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011", "npm ci", "bash scripts/install.sh"], "project must install frozen dependencies and checksum-verified Godot engine/templates");
  for (const name of ["unit", "build", "lint"]) assert.deepEqual(tasks[name].depends, ["install"]);
  assert.deepEqual(tasks["artifact-check"].depends, ["build"]);
  const setup = ci.jobs.ci.steps.find((step) => /^nicodes\/tools\/setup@[a-f0-9]{40}$/.test(step.uses ?? ""));
  if (!setup) throw new Error("complete native gate requires a full source pin for tools setup");
  return setup.uses.split("@")[1];
}

export function assertWorkflows(root) {
  if (existsSync(join(root, ".github/workflows/e2e.yml"))) throw new Error("e2e workflow must not live in this repository");
  const release = workflow(root, "release.yml");
  const ci = workflow(root, "ci.yml");
  const recovery = workflow(root, "gdam-publish.yml");
  if (release.permissions?.contents !== "read") throw new Error("release workflow must default to contents: read");
  for (const doc of [release, ci, recovery]) {
    if (doc.permissions?.["id-token"] !== undefined) throw new Error("id-token must be granted only to the publishing jobs");
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      if (name !== "publish" && job.permissions?.["id-token"] !== undefined) throw new Error("id-token must be granted only to the publishing jobs");
    }
    const text = JSON.stringify(doc);
    if (/GDAM_SECRET_KEY|secret-key/.test(text)) throw new Error("workflow must not use a gdam secret key");
    if (/gdam-actions\/install@/.test(text)) throw new Error("workflow installs the gdam CLI, which publishing no longer needs");
  }
  if (release.jobs.test.permissions?.contents === "write") throw new Error("test job must not have contents: write");
  const publishing = [release.jobs.publish, recovery.jobs.publish];
  for (const [index, job] of publishing.entries()) {
    if (job.permissions?.["id-token"] !== "write") throw new Error("publish job must grant id-token: write for gdam trusted publishing");
    if (index === 0 && job.permissions?.contents !== "write") throw new Error("publish job must grant contents: write");
    if (job.permissions?.actions === "write" || job.environment !== undefined) throw new Error("publish job must use only GITHUB_TOKEN contents: write");
  }
  const pins = publishing.map((job) => job.steps.filter((step) => step.uses?.startsWith("aviorstudio/gdam-actions/publish@")));
  if (pins.some((steps) => steps.length !== 1 || !/^aviorstudio\/gdam-actions\/publish@[0-9a-f]{40}$/.test(steps[0].uses))
      || pins[0][0].uses !== pins[1][0].uses) throw new Error("release and gdam-publish must pin the same full-SHA gdam-actions/publish");
  for (const steps of pins) {
    if (steps[0].with?.asset !== "@aviorstudio_gd-clerk.gdam.zip") throw new Error("gdam must publish the flat addon asset");
  }
  // Token references belong to step env, rather than executable shell text.
  for (const job of publishing) {
    if (!job.steps.some((step) => step.env?.GH_TOKEN === "${{ secrets.GITHUB_TOKEN }}")) throw new Error("publish job must use GITHUB_TOKEN");
  }
  if (!/^\s*test "\$commit" = "\$GITHUB_SHA"\s*$/m.test(commands(recovery.jobs.publish))) throw new Error("gdam-publish must bind the tag commit to the run's commit");
  if (!/^\s*test "\$commit" = "\$GITHUB_SHA"\s*$/m.test(commands(release.jobs.test))) throw new Error("release workflow missing exact dispatch commit binding");
  if (Object.keys(release.on ?? {}).join() !== "workflow_dispatch") throw new Error("release must only run from a manual workflow_dispatch");
  for (const doc of [release, ci]) {
    const text = JSON.stringify(doc);
    for (const item of [...FORBIDDEN_COUPLING, "live-e2e", "e2e-evidence", "ACCEPTED", "docs/E2E_ACCEPTANCE.md", "check-release-rules.mjs"]) {
      if (text.includes(item)) throw new Error(`workflow contains ${item}`);
    }
  }
  const publisher = release.jobs.publish;
  const createAt = publisher.steps.findIndex((step) => step.run?.includes("gh release create"));
  const gdamAt = publisher.steps.findIndex((step) => step === pins[0][0]);
  if (createAt < 0 || gdamAt <= createAt) throw new Error("gdam publish must follow the GitHub release it points at");
  for (const text of [commands(release.jobs.test), commands(publisher)]) requireText(text, "node scripts/release-guard.mjs --main");
  for (const value of ["sha256sum --check --strict @aviorstudio_gd-clerk.zip.sha256", "sha256sum --check --strict @aviorstudio_gd-clerk.gdam.zip.sha256", "gh release create"]) requireText(commands(publisher), value);
  requireText(JSON.stringify(ci.jobs.ci), "github.event.pull_request.head.sha", "CI candidate provenance must bind the branch commit, not the merge commit");
  requireText(commands(ci.jobs.ci), "node scripts/candidate-provenance.mjs", "CI must record candidate provenance");
  const revision = assertProjectGate(root, ci);
  assertNativeGate(ci, "ci", revision);
  assertNativeGate(release, "test", revision);
}

if (process.argv[1]?.endsWith("workflow-policy.mjs")) {
  try {
    assertWorkflows(join(dirname(fileURLToPath(import.meta.url)), ".."));
    console.log("workflow policy ok");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
