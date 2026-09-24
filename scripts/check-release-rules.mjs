import { execFileSync } from "node:child_process";

export const ACTIONS_APP_ID = 15368;
export const RELEASE_ENVIRONMENT = "release";
export const TAG_RULESET = "gd-clerk-release-tags";
export const TAG_RULES = ["creation", "update", "deletion"];
export const REPOSITORY_ADMIN_ROLE_ID = 5;
// Not pinned until a separate release credential exists. A null id fails closed.
export const DEDICATED_PUBLISHER_ACTOR_ID = null;
// Read-only remote check: main is unprotected, rulesets and environments are empty,
// and the default Actions GITHUB_TOKEN permission is write. Tag rules do not close this.
export const MAIN_PR_CI_RULE_GAP = "main has no pull-request or required-CI ruleset; tag rules do not protect main";

export function assertReleaseRules({ environment, policies, ruleset }, options = {}) {
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
  const exclude = ruleset.conditions.ref_name.exclude;
  if (Array.isArray(exclude) && exclude.some((name) => name === "refs/tags/v*" || name === "~ALL")) {
    throw new Error("release tag ruleset must not exclude v* tags");
  }
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules.map((rule) => rule.type) : [];
  for (const type of TAG_RULES) {
    if (!rules.includes(type)) throw new Error(`release tag ruleset must restrict ${type}`);
  }
  const bypass = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];
  if (bypass.length !== 1) throw new Error("release tag ruleset bypass must be only the dedicated publisher");
  const actor = bypass[0];
  if (actor.actor_id === ACTIONS_APP_ID) {
    throw new Error("release tag ruleset must not bypass GitHub Actions");
  }
  if (actor.actor_type === "OrganizationAdmin" || (actor.actor_type === "RepositoryRole" && actor.actor_id === REPOSITORY_ADMIN_ROLE_ID) || actor.actor_type === "RepositoryRole") {
    throw new Error("release tag ruleset must not bypass a repo admin, owner, or role");
  }
  if (actor.actor_type !== "Integration" || !Number.isInteger(actor.actor_id) || actor.actor_id <= 0) {
    throw new Error("release tag ruleset bypass must be only the dedicated publisher");
  }
  if (actor.bypass_mode && actor.bypass_mode !== "always") {
    throw new Error("release tag ruleset bypass must be only the dedicated publisher");
  }
  const publisherId = Object.hasOwn(options, "publisherActorId") ? options.publisherActorId : DEDICATED_PUBLISHER_ACTOR_ID;
  if (!Number.isInteger(publisherId) || publisherId <= 0 || publisherId === ACTIONS_APP_ID) {
    throw new Error("dedicated publisher actor is not pinned");
  }
  if (actor.actor_id !== publisherId) {
    throw new Error("release tag ruleset bypass must be only the dedicated publisher");
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
    console.log(MAIN_PR_CI_RULE_GAP);
  } catch (err) {
    console.error(err.message);
    console.error(MAIN_PR_CI_RULE_GAP);
    process.exit(1);
  }
}
