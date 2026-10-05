import { readFileSync } from "node:fs";

export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function godotLogProblems(text) {
  const clean = stripAnsi(text);
  const problems = [];
  for (const line of clean.split(/\r?\n/)) {
    if (
      /^ERROR:/.test(line) ||
      line.includes("SCRIPT ERROR") ||
      line.includes("Parse Error") ||
      line.includes("ObjectDB instances were leaked") ||
      /RID allocations of type/.test(line)
    ) {
      problems.push(line);
    }
  }
  return problems;
}

export function assertGodotLog(text, { requireOk = false } = {}) {
  const problems = godotLogProblems(text);
  if (problems.length) {
    throw new Error(problems.join("\n"));
  }
  if (requireOk && !/^ok /m.test(stripAnsi(text))) {
    throw new Error("godot log did not report an ok result");
  }
}

function main() {
  const args = process.argv.slice(2);
  const requireOk = args.includes("--require-ok");
  const path = args.find((arg) => !arg.startsWith("--"));
  const text = path ? readFileSync(path, "utf8") : "";
  try {
    assertGodotLog(text, { requireOk });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("reject-godot-log.mjs")) main();
