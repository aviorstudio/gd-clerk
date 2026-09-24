import { execFileSync } from "node:child_process";

export const ACTIONS_APP_ID = 15368;
export const RELEASE_ENVIRONMENT = "release";
export const TAG_RULESET = "gd-clerk-release-tags";

export function assertReleaseRules({ environment, policies, ruleset }) {
  if (!environment || environment.name !== RELEASE_ENVIRONMENT) {
    throw new Error("release environment is missing");
  }
  const policy = environment.deployment_branch_policy;
  if (!policy || policy.protected_branches !== false || policy.custom_branch_policies !== true) {
    throw new Error("release environment must use a custom main-only branch policy");
  }
  const items = policies && Array.isArray(policies.branch_policies) ? policies.branch_policies : [];
  if (items.length !== 1 || items[0].name !== "main" || items[0].type !== "branch") {
    throw new Error("release environment branch policy must be exactly main");
  }
  if (!ruleset || ruleset.name !== TAG_RULESET || ruleset.target !== "tag" || ruleset.enforcement !== "active") {
    throw new Error("release tag ruleset is missing");
  }
  const include = ruleset.conditions && ruleset.conditions.ref_name && ruleset.conditions.ref_name.include;
  if (!Array.isArray(include) || !include.includes("refs/tags/v*")) {
    throw new Error("release tag ruleset must cover v* tags");
  }
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules.map((rule) => rule.type) : [];
  if (!rules.includes("creation")) throw new Error("release tag ruleset must restrict creation");
  const bypass = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];
  if (bypass.length < 1) throw new Error("release tag ruleset has no non-Actions publisher bypass");
  for (const actor of bypass) {
    if (actor.actor_id === ACTIONS_APP_ID || (actor.actor_type === "Integration" && actor.actor_id === ACTIONS_APP_ID)) {
      throw new Error("release tag ruleset must not bypass GitHub Actions");
    }
  }
  return true;
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", env: process.env }));
}

export function loadReleaseRules(repo = process.env.GITHUB_REPOSITORY || "aviorstudio/gd-clerk") {
  const environment = ghJson(["api", `repos/${repo}/environments/${RELEASE_ENVIRONMENT}`]);
  const policies = ghJson(["api", `repos/${repo}/environments/${RELEASE_ENVIRONMENT}/deployment-branch-policies`]);
  const listed = ghJson(["api", `repos/${repo}/rulesets`]);
  const summary = (Array.isArray(listed) ? listed : []).find((item) => item.name === TAG_RULESET);
  if (!summary) throw new Error("release tag ruleset is missing");
  const ruleset = summary.rules ? summary : ghJson(["api", `repos/${repo}/rulesets/${summary.id}`]);
  return { environment, policies, ruleset };
}

if (process.argv[1] && process.argv[1].endsWith("check-release-rules.mjs")) {
  if (!process.argv.includes("--from-github")) {
    console.error("release rules were not checked");
    process.exit(1);
  }
  try {
    assertReleaseRules(loadReleaseRules());
    console.log("release rules ok");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
