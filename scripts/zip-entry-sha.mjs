import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const CLERK_BROWSER_ENTRY = "addons/@aviorstudio_gd-clerk/javascript/clerk/clerk.browser.js";

export function zipEntrySha256(zipPath, entry) {
  if (!zipPath || !entry || entry.includes("..") || entry.startsWith("/")) {
    throw new Error("zip entry is invalid");
  }
  const data = execFileSync("unzip", ["-p", zipPath, entry], { maxBuffer: 64 * 1024 * 1024 });
  return createHash("sha256").update(data).digest("hex");
}

if (process.argv[1] && process.argv[1].endsWith("zip-entry-sha.mjs")) {
  try {
    process.stdout.write(`${zipEntrySha256(process.argv[2], process.argv[3])}\n`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
