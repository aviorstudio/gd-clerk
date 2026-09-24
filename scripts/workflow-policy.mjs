import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function jobBlock(text, name) {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`missing job ${name}`);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

export function assertWorkflows(root) {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const e2e = readFileSync(join(root, ".github/workflows/e2e.yml"), "utf8");
  const releaseHead = release.split("\njobs:")[0];
  if (!/permissions:\n  contents: read\n/.test(releaseHead) || /contents: write/.test(releaseHead)) {
    throw new Error("release workflow must default to contents: read");
  }
  const verify = jobBlock(release, "verify");
  const publish = jobBlock(release, "publish");
  if (/contents: write/.test(verify)) throw new Error("verify job must not have contents: write");
  if (/contents: write/.test(publish)) throw new Error("publish job must not grant contents: write");
  if (/actions: write/.test(verify)) throw new Error("verify job must not have actions: write");
  if (!/actions: read/.test(verify)) throw new Error("verify job must read e2e artifacts");
  if (!/environment: release/.test(publish) || !/secrets\.RELEASE_TOKEN/.test(publish)) {
    throw new Error("publish job must use the main-only release environment token");
  }
  if (!/actions: read/.test(publish)) throw new Error("publish job must read the tested artifact");
  for (const forbidden of ["ACCEPTED", "docs/E2E_ACCEPTANCE.md", "docs/FAILURE_RECOVERY.md"]) {
    if (release.includes(forbidden) || e2e.includes(forbidden)) {
      throw new Error(`workflow still treats ${forbidden} as acceptance`);
    }
  }
  const required = [
    "npm test",
    "node scripts/scan.mjs",
    "bash scripts/run-godot-tests.sh",
    "npm run test:browser",
    "node scripts/package-addon.mjs",
    "node scripts/verify-zip.mjs",
    "node scripts/editor-lifecycle.mjs",
    "node scripts/require-live-evidence.mjs",
    "node scripts/release-notes.mjs",
    "git rev-parse origin/main",
    "gh release create",
    "node scripts/check-release-rules.mjs --from-github",
    "node scripts/zip-entry-sha.mjs",
  ];
  for (const item of required) {
    if (!release.includes(item)) throw new Error(`release workflow missing ${item}`);
  }
  if (release.split("node scripts/require-live-evidence.mjs").length < 3) {
    throw new Error("verify and publish must both require live evidence");
  }
  if (ci.includes("godot --headless --path . --quit-after 1")) {
    throw new Error("CI must reject Godot engine errors through the runner");
  }
  for (const item of ["bash scripts/run-godot-tests.sh", "node scripts/editor-lifecycle.mjs", "node scripts/verify-zip.mjs", "node scripts/e2e-evidence.mjs --reject-committed"]) {
    if (!ci.includes(item)) throw new Error(`CI missing ${item}`);
  }
  if (!e2e.includes("node scripts/live-e2e.mjs") || !e2e.includes("name: e2e-evidence")) {
    throw new Error("e2e workflow must fail closed and only upload a real evidence artifact");
  }
  if (e2e.includes("have not been observed") || !e2e.includes("scripts/install-godot-templates.sh")) {
    throw new Error("e2e workflow must run the real web export runner");
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
