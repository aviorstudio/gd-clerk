export function redact(value) {
  let text = String(value ?? "");
  text = text.replace(/sk_(test|live)_[A-Za-z0-9]+/g, "[redacted]");
  text = text.replace(/pk_(test|live)_[A-Za-z0-9+/=_-]{8,}/g, "[redacted]");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
  text = text.replace(/\b\d{4,}\b/g, "[redacted]");
  text = text.replace(/AGENTMAIL_API_KEY=\S+/g, "AGENTMAIL_API_KEY=[redacted]");
  if (text.length > 400) text = text.slice(0, 400);
  return text;
}

export function installRedactingConsole() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(...args.map((item) => redact(item)));
  }
}
