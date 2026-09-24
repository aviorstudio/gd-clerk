import { spawnSync } from "node:child_process";

export const OTP_POLL_MS = 2000;
export const OTP_DEADLINE_MS = 90000;
export const DEFAULT_OTP_PATTERN = "[0-9]{6}";

const LIST_JQ = String.raw`
def address:
  if type == "string" and test("<[^<>]+>$") then capture("<(?<value>[^<>]+)>$").value else . end;
def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
{
  candidates: [
    (.messages // [])[]
    | select((.from | address | ascii_downcase) == ($sender | ascii_downcase))
    | select(
        (((.to // []) + (.cc // []) + (.bcc // []))
          | map(address | ascii_downcase)
          | index($recipient | ascii_downcase)) != null
      )
    | select($subject == "" or ((.subject // "") == $subject))
    | select((.created_at | epoch) >= ($test_start | epoch))
    | {message_id, created_at}
  ]
}
`;

const CODE_JQ = String.raw`
[
  ((.extracted_text // .text // ""), (.extracted_html // .html // ""))
  | match($pattern; "g").string
]
| unique
| if length == 1 then .[0]
  else error("expected exactly one authentication value")
  end
`;

export function assertOtpPattern(pattern) {
  if (!/^\[0-9\]\{(?:[4-9]|1[0-2])\}$/.test(pattern)) {
    throw new Error("otp pattern is invalid");
  }
}

export function parseInbox(value) {
  const raw = String(value || "").trim();
  const address = raw.includes("<") ? (raw.match(/<([^<>]+)>/) || [])[1] : raw;
  if (!address || !/^[^@\s+]+@[^@\s]+$/.test(address)) {
    throw new Error("AGENTMAIL_INBOX must be a base inbox address");
  }
  return address.toLowerCase();
}

export function plusAddress(inbox, tag) {
  if (!/^[A-Za-z0-9]+$/.test(tag)) throw new Error("e2e mailbox tag is invalid");
  const [local, domain] = parseInbox(inbox).split("@");
  return `${local}+e2e-${tag}@${domain}`;
}

export function recipientOnInbox(inbox, recipient) {
  const base = parseInbox(inbox);
  const raw = String(recipient || "").trim();
  const address = raw.includes("<") ? (raw.match(/<([^<>]+)>/) || [])[1] : raw;
  const [local, domain] = base.split("@");
  const at = String(address || "").lastIndexOf("@");
  if (!address || at <= 0 || /\s/.test(address)) return false;
  const rdomain = address.slice(at + 1).toLowerCase();
  const rlocal = address.slice(0, at).toLowerCase();
  if (rdomain !== domain) return false;
  return rlocal === local || rlocal.startsWith(`${local}+`);
}

export const selectionJq = LIST_JQ;
export const codeJq = CODE_JQ;

function runPipeline(script, env) {
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("agentmail query failed");
  }
  return result.stdout;
}

export function listCandidates(env, spawn = runPipeline) {
  const script = `
set -euo pipefail
args=(--format json inboxes messages list --inbox-id "$OTP_INBOX" --to "$OTP_RECIPIENT" --from "$OTP_FROM" --limit 10)
if [ -n "\${OTP_SUBJECT}" ]; then
  args+=(--subject "$OTP_SUBJECT")
fi
agentmail "\${args[@]}" | jq -c --arg recipient "$OTP_RECIPIENT" --arg sender "$OTP_FROM" --arg subject "$OTP_SUBJECT" --arg test_start "$OTP_TEST_START" '${LIST_JQ.replaceAll("'", "'\\''")}'
`;
  const stdout = spawn(script, env);
  const parsed = JSON.parse(stdout);
  if (!parsed || !Array.isArray(parsed.candidates)) throw new Error("otp selection failed");
  return parsed.candidates;
}

export function extractCode(env, spawn = runPipeline) {
  if (!/^[A-Za-z0-9_-]+$/.test(env.OTP_MESSAGE_ID || "")) throw new Error("otp message id is invalid");
  assertOtpPattern(env.OTP_PATTERN);
  const script = `
set -euo pipefail
agentmail --format json inboxes messages get --inbox-id "$OTP_INBOX" --message-id "$OTP_MESSAGE_ID" | jq -er --arg pattern "$OTP_PATTERN" '${CODE_JQ.replaceAll("'", "'\\''")}'
`;
  const stdout = spawn(script, env).trim();
  if (!new RegExp(`^${env.OTP_PATTERN}$`).test(stdout)) throw new Error("otp extraction failed");
  return stdout;
}

export async function waitForOtp(options, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const list = deps.listCandidates || listCandidates;
  const extract = deps.extractCode || extractCode;
  const pattern = options.pattern || DEFAULT_OTP_PATTERN;
  assertOtpPattern(pattern);
  const deadline = now() + (options.deadlineMs ?? OTP_DEADLINE_MS);
  const interval = options.pollMs ?? OTP_POLL_MS;
  const env = {
    OTP_INBOX: options.inbox,
    OTP_RECIPIENT: options.recipient,
    OTP_FROM: options.sender,
    OTP_SUBJECT: options.subject || "",
    OTP_TEST_START: options.testStart,
    OTP_PATTERN: pattern,
  };
  while (now() <= deadline) {
    const candidates = list(env);
    if (candidates.length > 1) throw new Error("otp selection is ambiguous");
    if (candidates.length === 1) {
      const code = extract({ ...env, OTP_MESSAGE_ID: candidates[0].message_id });
      return { messageId: candidates[0].message_id, createdAt: candidates[0].created_at, code };
    }
    if (now() + interval > deadline) break;
    await sleep(interval);
  }
  throw new Error(`otp timed out after ${interval / 1000}s polls for ${Math.round((options.deadlineMs || OTP_DEADLINE_MS) / 1000)}s`);
}
