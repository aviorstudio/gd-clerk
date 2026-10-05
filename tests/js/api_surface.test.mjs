import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const types = join(root, "node_modules/@clerk/clerk-js/dist/types");
const signIn = readFileSync(join(types, "core/resources/SignIn.d.ts"), "utf8");
const signUp = readFileSync(join(types, "core/resources/SignUp.d.ts"), "utf8");
const clerk = readFileSync(join(types, "core/clerk.d.ts"), "utf8");
const bridge = readFileSync(join(root, "addons/@aviorstudio_gd-clerk/javascript/gd_clerk_bridge.js"), "utf8");

test("pinned clerk-js types expose legacy resources and keep future methods internal", () => {
  assert.match(signIn, /prepareFirstFactor/);
  assert.match(signIn, /attemptFirstFactor/);
  assert.match(signIn, /__internal_future: SignInFuture/);
  assert.match(signUp, /prepareEmailAddressVerification/);
  assert.match(signUp, /attemptEmailAddressVerification/);
  assert.match(signUp, /__internal_future: SignUpFuture/);
  assert.match(clerk, /setActive:/);
  assert.match(clerk, /signOut: SignOut/);
  assert.match(clerk, /static version: string/);
  assert.equal(clerk.includes("__internal_future"), false);
  assert.equal(bridge.includes("__internal_future"), false);
  assert.equal(bridge.includes("emailCode"), false);
  assert.equal(bridge.includes("verifications."), false);
});
