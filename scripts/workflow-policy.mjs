import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
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
  const index = steps.findIndex((step) => step.uses === `nicodes/komizo/run@${revision}`);
  const check = steps[index];
  if (!job || job["continue-on-error"] !== undefined || !check || !unconditional(check)
      || check.with?.target !== "check" || check["working-directory"] !== undefined
      || Object.keys(check.with).some((key) => !["target", "go-cache", "web-cache", "build-cache"].includes(key))
      || doc.defaults?.run?.["working-directory"] || job.defaults?.run?.["working-directory"]
      || !steps.slice(0, index).some((step) => step.uses === `nicodes/komizo/setup@${revision}` && unconditional(step)
        && Object.keys(step.with ?? {}).length === 0)) {
    throw new Error(`${jobName} must run the unconditional complete locked Komizo gate after matching setup`);
  }
}

function assertProjectGate(root) {
  const project = JSON.parse(readFileSync(join(root, "komizo.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "komizo.lock"), "utf8"));
  if (project.recipe !== "godot-addon" || project.verification !== undefined || !/^[0-9a-f]{40}$/.test(lock.platform_revision)) {
    throw new Error("project must use the complete locked Godot addon recipe");
  }
  // These literal argv checks follow the executable manifest, rather than
  // mistaking workflow comments or a partial native command for product tests.
  const unit = [["npm", "test"], ["bash", "scripts/run-godot-tests.sh"], ["npm", "run", "test:browser"],
    ...["origin", "configure", "revoke"].map((name) => ["node", "--test", `tests/web/${name}_export.test.mjs`])];
  assert.deepEqual(project.stages.unit, unit.map((argv) => ["bash", "scripts/test-env.sh", ...argv]), "project must retain every native/browser/web export regression");
  assert.deepEqual(project.stages.lint, [["npm", "audit", "--audit-level=high"], ["node", "scripts/vendor-clerk.mjs", "--check"],
    ["node", "scripts/scan.mjs"], ["node", "scripts/workflow-policy.mjs"]], "project must retain source and dependency controls");
  assert.deepEqual(project.stages.build, [["node", "scripts/package-addon.mjs"], ["node", "scripts/verify-zip.mjs", "dist/@aviorstudio_gd-clerk.zip"]], "project must verify the assembled ZIP");
  assert.deepEqual(project.stages["artifact-check"], [["bash", "scripts/test-env.sh", "node", "scripts/editor-lifecycle.mjs", "dist/@aviorstudio_gd-clerk.zip"]], "project must verify the installed ZIP editor lifecycle");
  assert.deepEqual(project.stages.install.slice(1), [["npm", "ci"], ["bash", "scripts/install.sh"]], "project must install frozen dependencies");
  assert.deepEqual(project.stages.install[0], ["python3", "-c", 'import os,runpy;runpy.run_path(os.environ["CICD_ENGINEERING"]+"/helpers/godot-addon.py",run_name="__main__")', "install"], "project must use locked Godot engine/template setup");
  return lock.platform_revision;
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
    if (/GDAM_SECRET_KEY|secret-key/.test(text)) throw new Error("workflow must not use a GDAM secret key");
    if (/gdam-actions\/install@/.test(text)) throw new Error("workflow installs the GDAM CLI, which publishing no longer needs");
  }
  if (release.jobs.test.permissions?.contents === "write") throw new Error("test job must not have contents: write");
  const publishing = [release.jobs.publish, recovery.jobs.publish];
  for (const [index, job] of publishing.entries()) {
    if (job.permissions?.["id-token"] !== "write") throw new Error("publish job must grant id-token: write for GDAM trusted publishing");
    if (index === 0 && job.permissions?.contents !== "write") throw new Error("publish job must grant contents: write");
    if (job.permissions?.actions === "write" || job.environment !== undefined) throw new Error("publish job must use only GITHUB_TOKEN contents: write");
  }
  const pins = publishing.map((job) => job.steps.filter((step) => step.uses?.startsWith("aviorstudio/gdam-actions/publish@")));
  if (pins.some((steps) => steps.length !== 1 || !/^aviorstudio\/gdam-actions\/publish@[0-9a-f]{40}$/.test(steps[0].uses))
      || pins[0][0].uses !== pins[1][0].uses) throw new Error("release and gdam-publish must pin the same full-SHA gdam-actions/publish");
  for (const steps of pins) {
    if (steps[0].with?.asset !== "@aviorstudio_gd-clerk.gdam.zip") throw new Error("GDAM must publish the flat addon asset");
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
  if (createAt < 0 || gdamAt <= createAt) throw new Error("GDAM publish must follow the GitHub release it points at");
  for (const text of [commands(release.jobs.test), commands(publisher)]) requireText(text, "node scripts/release-guard.mjs --main");
  for (const value of ["sha256sum --check --strict @aviorstudio_gd-clerk.zip.sha256", "sha256sum --check --strict @aviorstudio_gd-clerk.gdam.zip.sha256", "gh release create"]) requireText(commands(publisher), value);
  requireText(JSON.stringify(ci.jobs.ci), "github.event.pull_request.head.sha", "CI candidate provenance must bind the branch commit, not the merge commit");
  requireText(commands(ci.jobs.ci), "node scripts/candidate-provenance.mjs", "CI must record candidate provenance");
  const revision = assertProjectGate(root);
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
