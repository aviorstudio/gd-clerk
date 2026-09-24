import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codeJq, parseInbox, plusAddress, recipientOnInbox, selectionJq, waitForOtp } from "../../scripts/agentmail-otp.mjs";
import { assertReleaseRules } from "../../scripts/check-release-rules.mjs";
import { buildEvidence, CAPTCHA_CONSTRAINT, verifyEvidence } from "../../scripts/e2e-evidence.mjs";
import { createExportServer } from "../../scripts/e2e-web.mjs";
import { classifySignUpAttempt, missingLiveEnv, assertPublishableBinding } from "../../scripts/live-e2e.mjs";
import { redact } from "../../scripts/redact.mjs";

const commit = "a".repeat(40);
const sha = "b".repeat(64);
const browserSha = "c".repeat(64);
const binding = {
  commit,
  tag: "v0.1.0",
  package_sha256: sha,
  clerk_browser_sha256: browserSha,
  frontend_api: "https://example.clerk.accounts.dev",
  origin: "http://localhost:3100",
  publishable_key_prefix: "pk_test_",
  run_id: "123",
  run_url: "https://github.com/aviorstudio/gd-clerk/actions/runs/123",
};

test("live runner names missing configuration and does not claim an impossible observation", () => {
  assert.deepEqual(missingLiveEnv({}), [
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_FRONTEND_API",
    "CLERK_ALLOWED_ORIGIN",
    "AGENTMAIL_INBOX",
    "AGENTMAIL_API_KEY",
    "CLERK_OTP_FROM",
  ]);
  const source = readFileSync(new URL("../../scripts/live-e2e.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("have not been observed"), false);
  assert.equal(source.includes("captcha_challenge: \"observed\""), false);
});

test("sign-up classification refuses bypass and does not mark an unsolved challenge accepted", () => {
  assert.equal(classifySignUpAttempt({ state: "CODE_SENT", errorKey: "", captcha: { slotMounted: true } }).captcha_challenge, "not_presented");
  const blocked = classifySignUpAttempt({
    state: "ERROR",
    errorKey: "UNKNOWN",
    captcha: { slotMounted: true, challengeVisible: true },
  });
  assert.equal(blocked.captcha_challenge, "presented_unsolved");
  assert.equal(blocked.email_code_sign_up, "blocked_by_challenge");
  assert.equal(blocked.captcha_constraint, CAPTCHA_CONSTRAINT);
  assert.match(classifySignUpAttempt({ captcha: { testingToken: true, slotMounted: true } }).fail, /not marked accepted/);
  assert.match(classifySignUpAttempt({ captcha: { invisible: true, slotMounted: true } }).fail, /invisible/);
  assert.match(classifySignUpAttempt({ state: "ERROR", errorKey: "UNSUPPORTED_CHALLENGE", captcha: {} }).fail, /not confirmed/);
});

test("evidence accepts an exercised normal path and rejects a claimed challenge", () => {
  const normal = buildEvidence({
    email_code_sign_in: "delivered",
    email_code_sign_up: "delivered",
    captcha_challenge: "not_presented",
    captcha_constraint: "",
  }, binding);
  assert.equal(normal.captcha_challenge_accepted, false);
  assert.equal(verifyEvidence(normal, binding).live, true);
  assert.throws(() => buildEvidence({
    email_code_sign_in: "delivered",
    email_code_sign_up: "blocked_by_challenge",
    captcha_challenge: "presented_unsolved",
    captcha_constraint: CAPTCHA_CONSTRAINT,
  }, binding), /not genuinely observed|not acceptance/);
  assert.throws(() => verifyEvidence({ ...normal, captcha_challenge: "observed" }, binding), /not genuinely observed/);
  assert.throws(() => verifyEvidence({ ...normal, captcha_challenge_accepted: true }, binding), /not genuinely observed/);
});

test("web export preset is the tracked nothreads Web preset", () => {
  const listed = spawnSync("git", ["ls-files", "--error-unmatch", "tests/e2e/harness/export_presets.cfg"], { encoding: "utf8" });
  assert.equal(listed.status, 0);
  const text = readFileSync(new URL("../../tests/e2e/harness/export_presets.cfg", import.meta.url), "utf8");
  assert.match(text, /platform="Web"/);
  assert.match(text, /variant\/thread_support=false/);
});

test("redaction and mailbox helpers do not keep codes or leave the inbox", () => {
  const redacted = redact("code 123456 for user@example.com pk_test_abcdefghijklmnopqrstuvwxyz");
  assert.equal(redacted.includes("123456"), false);
  assert.equal(redacted.includes("user@example.com"), false);
  assert.equal(redacted.includes("pk_test_abc"), false);
  assert.equal(plusAddress("agent@agentmail.to", "run1ab"), "agent+e2e-run1ab@agentmail.to");
  assert.equal(recipientOnInbox("agent@agentmail.to", "agent+e2e-run1ab@agentmail.to"), true);
  assert.equal(recipientOnInbox("agent@agentmail.to", "other@agentmail.to"), false);
  assert.throws(() => parseInbox("agent+shared@agentmail.to"));
  assert.doesNotThrow(() => assertPublishableBinding(
    "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
    "https://example.clerk.accounts.dev",
  ));
});

test("otp selection keeps the exact recipient and emits one code", () => {
  const fixture = {
    messages: [
      {
        message_id: "keep",
        created_at: "2026-08-23T04:00:02Z",
        from: "Clerk <no-reply@example.com>",
        to: ["Agent <agent+e2e-run1ab@agentmail.to>"],
        subject: "Verification code",
      },
      {
        message_id: "drop",
        created_at: "2026-08-23T03:00:00Z",
        from: "no-reply@example.com",
        to: ["agent+e2e-run1ab@agentmail.to"],
        subject: "Verification code",
      },
    ],
  };
  const selected = spawnSync("jq", [
    "-c",
    "--arg", "recipient", "agent+e2e-run1ab@agentmail.to",
    "--arg", "sender", "no-reply@example.com",
    "--arg", "subject", "Verification code",
    "--arg", "test_start", "2026-08-23T04:00:00Z",
    selectionJq,
  ], { input: JSON.stringify(fixture), encoding: "utf8" });
  assert.equal(selected.status, 0);
  assert.deepEqual(JSON.parse(selected.stdout).candidates, [{ message_id: "keep", created_at: "2026-08-23T04:00:02Z" }]);
  const extracted = spawnSync("jq", ["-er", "--arg", "pattern", "[0-9]{6}", codeJq], {
    input: JSON.stringify({ text: "Your code is 123456", html: "<p>123456</p>" }),
    encoding: "utf8",
  });
  assert.equal(extracted.stdout.trim(), "123456");
  const ambiguous = spawnSync("jq", ["-er", "--arg", "pattern", "[0-9]{6}", codeJq], {
    input: JSON.stringify({ text: "123456 and 654321" }),
    encoding: "utf8",
  });
  assert.notEqual(ambiguous.status, 0);
});

test("otp wait stops on ambiguity and does not log the code", async () => {
  const seen = [];
  await assert.rejects(() => waitForOtp({
    inbox: "agent@agentmail.to",
    recipient: "agent+e2e-run1ab@agentmail.to",
    sender: "no-reply@example.com",
    testStart: "2026-08-23T04:00:00Z",
    deadlineMs: 0,
  }, {
    now: () => 10,
    sleep: async () => {},
    listCandidates: () => [{ message_id: "a" }, { message_id: "b" }],
    extractCode: () => {
      seen.push("extracted");
      return "123456";
    },
  }), /ambiguous/);
  assert.deepEqual(seen, []);
});

test("release rules reject an Actions bypass and a non-main environment", () => {
  const ok = {
    environment: {
      name: "release",
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    policies: { branch_policies: [{ name: "main", type: "branch" }] },
    ruleset: {
      name: "gd-clerk-release-tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"] } },
      rules: [{ type: "creation" }],
      bypass_actors: [{ actor_id: 42, actor_type: "User" }],
    },
  };
  assert.equal(assertReleaseRules(ok), true);
  assert.throws(() => assertReleaseRules({
    ...ok,
    ruleset: { ...ok.ruleset, bypass_actors: [{ actor_id: 15368, actor_type: "Integration" }] },
  }), /GitHub Actions/);
  assert.throws(() => assertReleaseRules({
    ...ok,
    policies: { branch_policies: [{ name: "feature", type: "branch" }] },
  }), /exactly main/);
});

test("export server refuses paths outside the web export", async () => {
  const dir = mkdtempSync("/tmp/gd-clerk-e2e-server-XXXXXX");
  writeFileSync(join(dir, "index.html"), "ok");
  const server = await createExportServer(dir, 0);
  const port = server.address().port;
  const status = (path) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    assert.equal(await status("/%2e%2e/etc/passwd"), 403);
    assert.equal(await status("/../etc/passwd"), 403);
    const allowed = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(await allowed.text(), "ok");
  } finally {
    server.close();
  }
});
