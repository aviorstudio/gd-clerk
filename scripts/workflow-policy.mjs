import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_COUPLING } from "./consumer-boundary.mjs";

function jobBlock(text, name) {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`missing job ${name}`);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

export function assertWorkflows(root) {
  const releasePath = join(root, ".github/workflows/release.yml");
  const ciPath = join(root, ".github/workflows/ci.yml");
  const e2ePath = join(root, ".github/workflows/e2e.yml");
  if (existsSync(e2ePath)) throw new Error("e2e workflow must not live in this repository");
  const release = readFileSync(releasePath, "utf8");
  const ci = readFileSync(ciPath, "utf8");
  const releaseHead = release.split("\njobs:")[0];
  if (!/permissions:\n  contents: read\n/.test(releaseHead) || /contents: write/.test(releaseHead)) {
    throw new Error("release workflow must default to contents: read");
  }
  const testJob = jobBlock(release, "test");
  const publish = jobBlock(release, "publish");
  if (/contents: write/.test(testJob)) throw new Error("test job must not have contents: write");
  if (!/contents: write/.test(publish)) throw new Error("publish job must grant contents: write");
  if (/actions: write/.test(publish) || /environment:/.test(publish)) {
    throw new Error("publish job must use only GITHUB_TOKEN contents: write");
  }
  if (!/secrets\.GITHUB_TOKEN/.test(publish)) throw new Error("publish job must use GITHUB_TOKEN");
  // GDAM publication is trusted publishing: the job's OIDC token is the only
  // credential, so the job must mint one and no registry secret may remain.
  if (!/id-token: write/.test(publish)) throw new Error("publish job must grant id-token: write for GDAM trusted publishing");
  const gdamPublish = readFileSync(join(root, ".github/workflows/gdam-publish.yml"), "utf8");
  if (!/id-token: write/.test(jobBlock(gdamPublish, "publish"))) {
    throw new Error("gdam-publish job must grant id-token: write for GDAM trusted publishing");
  }
  for (const [name, text] of [["release", release], ["gdam-publish", gdamPublish], ["ci", ci]]) {
    if (/GDAM_SECRET_KEY|secret-key:/.test(text)) throw new Error(`${name} workflow must not use a GDAM secret key`);
    if (/gdam-actions\/install@/.test(text)) throw new Error(`${name} workflow installs the GDAM CLI, which publishing no longer needs`);
  }
  const pins = new Set([...release.matchAll(/gdam-actions\/publish@([0-9a-f]{40})/g), ...gdamPublish.matchAll(/gdam-actions\/publish@([0-9a-f]{40})/g)].map((m) => m[1]));
  if (pins.size !== 1 || (release.match(/gdam-actions\/publish@/g) ?? []).length !== 1 || (gdamPublish.match(/gdam-actions\/publish@/g) ?? []).length !== 1) {
    throw new Error("release and gdam-publish must pin the same full-SHA gdam-actions/publish");
  }
  const forbidden = [
    ...FORBIDDEN_COUPLING,
    "live-e2e",
    "e2e-evidence",
    "ACCEPTED",
    "docs/E2E_ACCEPTANCE.md",
    "check-release-rules.mjs",
  ];
  for (const item of forbidden) {
    if (release.includes(item) || ci.includes(item)) throw new Error(`workflow contains ${item}`);
  }
  if (!/\non:\n  workflow_dispatch:\n/.test(release) || /\n  (push|pull_request|schedule|release|workflow_run):/.test(releaseHead)) {
    throw new Error("release must only run from a manual workflow_dispatch");
  }
  const createAt = publish.indexOf("gh release create");
  const gdamAt = publish.indexOf("aviorstudio/gdam-actions/publish@");
  if (createAt < 0 || gdamAt < createAt) throw new Error("GDAM publish must follow the GitHub release it points at");
  if (!publish.includes('asset: "@aviorstudio_gd-clerk.gdam.zip"')) {
    throw new Error("GDAM must publish the flat addon asset");
  }
  const required = [
    "npm test",
    "node scripts/scan.mjs",
    "bash scripts/run-godot-tests.sh",
    "npm run test:browser",
    "node scripts/package-addon.mjs",
    "node scripts/verify-zip.mjs",
    "node scripts/editor-lifecycle.mjs",
    "node scripts/release-guard.mjs --main",
    "sha256sum --check --strict",
    "gh release create",
    "refs/heads/main",
    "secrets.GITHUB_TOKEN",
  ];
  for (const item of required) {
    if (!release.includes(item)) throw new Error(`release workflow missing ${item}`);
  }
  if (ci.includes("godot --headless --path . --quit-after 1")) {
    throw new Error("CI must reject Godot engine errors through the runner");
  }
  for (const item of ["bash scripts/run-godot-tests.sh", "node scripts/editor-lifecycle.mjs", "node scripts/verify-zip.mjs", "node scripts/candidate-provenance.mjs"]) {
    if (!ci.includes(item)) throw new Error(`CI missing ${item}`);
  }
  if (!ci.includes("node --test tests/web/origin_export.test.mjs") || !ci.includes("scripts/install-godot-templates.sh")) {
    throw new Error("CI must run the web export origin regression");
  }
  if (!release.includes("node --test tests/web/origin_export.test.mjs")) {
    throw new Error("release verification must run the web export origin regression");
  }
  if (!ci.includes("node --test tests/web/configure_export.test.mjs") || !release.includes("node --test tests/web/configure_export.test.mjs")) {
    throw new Error("CI and release verification must run the web export configure regression");
  }
  if (!ci.includes("node --test tests/web/revoke_export.test.mjs") || !release.includes("node --test tests/web/revoke_export.test.mjs")) {
    throw new Error("CI and release verification must run the web export revoke regression");
  }
  if (!ci.includes("github.event.pull_request.head.sha")) {
    throw new Error("CI candidate provenance must bind the branch commit, not the merge commit");
  }
}

if (process.argv[1] && process.argv[1].endsWith("workflow-policy.mjs")) {
  try {
    assertWorkflows(join(dirname(fileURLToPath(import.meta.url)), ".."));
    console.log("workflow policy ok");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
