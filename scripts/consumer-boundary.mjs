import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function piece(...parts) {
  return parts.join("");
}

export const FORBIDDEN_COUPLING = [
  piece("local", "host:31", "00"),
  piece("local", "host:31", "01"),
  piece("local", "host:31", "02"),
  piece("re", "vik"),
  piece("agent", "mail"),
  piece("CLERK_OTP_", "FROM"),
  piece("RELEASE_", "TOKEN"),
];

const TEXT = /\.(gd|js|mjs|md|json|yml|yaml|cfg|html|txt|sh|tscn)$/;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".godot" || name === ".git") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (path.endsWith("/javascript/clerk") || path.endsWith("/javascript\\clerk")) continue;
      walk(path, acc);
    } else if (TEXT.test(name)) acc.push(path);
  }
  return acc;
}

export function couplingHits(root) {
  const hits = [];
  for (const path of walk(root)) {
    const text = readFileSync(path, "utf8").toLowerCase();
    for (const item of FORBIDDEN_COUPLING) {
      if (text.includes(item.toLowerCase())) hits.push(`${path} contains ${item}`);
    }
  }
  return hits;
}
