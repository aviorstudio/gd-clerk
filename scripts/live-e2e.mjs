const names = ["CLERK_PUBLISHABLE_KEY", "CLERK_FRONTEND_API", "CLERK_ALLOWED_ORIGIN", "AGENTMAIL_INBOX"];
const missing = names.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`live acceptance missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.error("live acceptance missing: email-code delivery, Smart CAPTCHA, confirmed sign-out, and a real Godot web export have not been observed");
process.exit(1);
