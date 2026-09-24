import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { couplingHits } from "./consumer-boundary.mjs";

const root = new URL("..", import.meta.url).pathname;
const bridge = readFileSync(join(root, "addons/@aviorstudio_gd-clerk/javascript/gd_clerk_bridge.js"), "utf8");
const forbidden = [
  "__internal_future",
  "emailCode",
  "verifications.send",
  "useSignIn",
  "useSignUp",
  "signUpIfMissing",
  "localStorage",
  "fetch(",
  "captchaBypass",
  "finalize(",
  "strategy: \"password\"",
  "strategy: 'password'",
];
const hits = forbidden.filter((item) => bridge.includes(item));
if (hits.length) {
  console.error("bridge contains forbidden API usage:", hits.join(", "));
  process.exit(1);
}
if (!bridge.includes('getElementById(CAPTCHA_ELEMENT_ID)') && !bridge.includes('getElementById("clerk-captcha")') && !bridge.includes("CAPTCHA_ELEMENT_ID")) {
  console.error("bridge does not reference the Smart CAPTCHA slot");
  process.exit(1);
}
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".godot" || name === "dist") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, acc);
    else if (/\.(gd|js|mjs|md|json|yml|cfg)$/.test(name) && !path.includes("/javascript/clerk/") && !path.includes("/tests/")) acc.push(path);
  }
  return acc;
}
const secret = /sk_(live|test)_[A-Za-z0-9]/;
for (const path of walk(root)) {
  const text = readFileSync(path, "utf8");
  if (secret.test(text)) {
    console.error("secret key pattern found in", path);
    process.exit(1);
  }
}
if (/tokenCache\s*:/.test(bridge) || /localStorage\.setItem/.test(bridge)) {
  console.error("addon must not install a token cache");
  process.exit(1);
}
if (/new\s+Ctor\s*\([^)]*,/.test(bridge)) {
  console.error("Clerk constructor must not receive option overrides");
  process.exit(1);
}
const coupling = couplingHits(root);
if (coupling.length) {
  console.error(coupling.join("\n"));
  process.exit(1);
}
console.log("scan ok");
