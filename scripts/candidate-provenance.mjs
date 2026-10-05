import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLERK_BROWSER_ENTRY, zipEntrySha256 } from "./zip-entry-sha.mjs";
import { FORBIDDEN_COUPLING } from "./consumer-boundary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function buildCandidate(info) {
  if (!/^[0-9a-f]{40}$/.test(info.commit || "")) throw new Error("commit is not a full SHA");
  if (!/^[0-9a-f]{64}$/.test(info.zipSha256 || "")) throw new Error("zip sha256 is invalid");
  if (!/^[0-9a-f]{64}$/.test(info.clerkBrowserSha256 || "")) throw new Error("clerk bundle sha256 is invalid");
  if (info.entries !== 34) throw new Error("candidate ZIP must have 34 entries");
  const doc = {
    schema: "gd-clerk.candidate.v1",
    release: false,
    isolated_test_only: true,
    commit: info.commit,
    package_sha256: info.zipSha256,
    clerk_browser_sha256: info.clerkBrowserSha256,
    plugin_version: info.version,
    zip_entries: info.entries,
    clerk_version: info.clerkVersion,
  };
  const text = JSON.stringify(doc);
  const lowered = text.toLowerCase();
  if (FORBIDDEN_COUPLING.some((item) => lowered.includes(item.toLowerCase())) || /sk_|pk_live_|pk_test_/.test(text)) {
    throw new Error("candidate provenance must stay generic");
  }
  return doc;
}

function arg(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? "" : args[index + 1];
}

if (process.argv[1] && process.argv[1].endsWith("candidate-provenance.mjs")) {
  try {
    const args = process.argv.slice(2);
    const zip = arg(args, "--zip");
    const commit = arg(args, "--commit");
    const out = arg(args, "--out");
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const vendor = JSON.parse(readFileSync(join(root, "addons/@aviorstudio_gd-clerk/javascript/clerk/VENDOR.json"), "utf8"));
    const allow = JSON.parse(readFileSync(join(root, "scripts/package-allowlist.json"), "utf8"));
    const doc = buildCandidate({
      commit,
      zipSha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
      clerkBrowserSha256: zipEntrySha256(zip, CLERK_BROWSER_ENTRY),
      version,
      entries: allow.zip_entries,
      clerkVersion: vendor.version,
    });
    writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
    console.log(doc.package_sha256);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
