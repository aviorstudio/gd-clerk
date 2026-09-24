import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRunBinding, verifyEvidence } from "./e2e-evidence.mjs";

function expectedFromEnv() {
  return {
    commit: process.env.RELEASE_COMMIT || "",
    tag: process.env.RELEASE_TAG || "",
    package_sha256: process.env.PACKAGE_SHA256 || "",
    clerk_browser_sha256: process.env.CLERK_BROWSER_SHA256 || "",
  };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", env: process.env });
}

export function requireFromGithub(expected) {
  let runs;
  try {
    runs = JSON.parse(gh([
      "run", "list",
      "--workflow", "e2e.yml",
      "--commit", expected.commit,
      "--status", "success",
      "--json", "databaseId,headSha,url,conclusion",
    ]));
  } catch (err) {
    console.error("live acceptance missing: e2e workflow could not be queried");
    process.exit(1);
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    console.error("live acceptance missing: no successful e2e run for this commit");
    process.exit(1);
  }
  const run = runs[0];
  const dir = mkdtempSync("/tmp/gd-clerk-e2e-XXXXXX");
  try {
    gh(["run", "download", String(run.databaseId), "--name", "e2e-evidence", "--dir", dir]);
  } catch {
    console.error("live acceptance missing: e2e evidence artifact was not produced");
    process.exit(1);
  }
  const evidence = JSON.parse(readFileSync(join(dir, "e2e-evidence.json"), "utf8"));
  verifyEvidence(evidence, expected);
  assertRunBinding(run, evidence);
  return evidence;
}

if (process.argv[1] && process.argv[1].endsWith("require-live-evidence.mjs")) {
  const expected = expectedFromEnv();
  try {
    if (process.argv.includes("--from-github")) {
      requireFromGithub(expected);
      console.log("live evidence ok");
    } else if (process.argv.includes("--file")) {
      const file = process.argv[process.argv.indexOf("--file") + 1];
      const raw = readFileSync(file, "utf8");
      if (raw.trim() === "ACCEPTED") throw new Error("sentinel is not live evidence");
      verifyEvidence(JSON.parse(raw), expected);
      console.log("evidence file ok");
    } else {
      console.error("live acceptance missing");
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
