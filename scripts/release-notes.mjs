import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadProvenance() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const vendor = JSON.parse(readFileSync(join(root, "addons/@aviorstudio_gd-clerk/javascript/clerk/VENDOR.json"), "utf8"));
  const allow = JSON.parse(readFileSync(join(root, "scripts/package-allowlist.json"), "utf8"));
  return {
    version: pkg.version,
    clerkVersion: vendor.version,
    integrity: vendor.integrity,
    entries: allow.zip_entries,
  };
}

export function renderNotes(info) {
  return [
    `# gd-clerk ${info.tag}`,
    "",
    "Web-only Godot 4.7 addon for Clerk email one-time codes. Sign-in and sign-up stay separate. Native sign-in is unavailable. The browser SDK owns the session.",
    "",
    `- Plugin version: ${info.version}`,
    "- Package: @aviorstudio_gd-clerk.zip",
    `- SHA256: ${info.zipSha256}`,
    `- ZIP entries: ${info.entries}`,
    `- @clerk/clerk-js: ${info.clerkVersion}`,
    `- Integrity: ${info.integrity}`,
    `- Commit: ${info.commit}`,
    `- Tag: ${info.tag}`,
    "",
  ].join("\n");
}

export function assertNotes(text, info) {
  for (const field of [info.tag, info.commit, info.zipSha256, info.clerkVersion, info.integrity, String(info.entries), info.version]) {
    if (!field || !text.includes(field)) throw new Error("release notes missing package provenance");
  }
  if (text.includes("ACCEPTED") || text.includes("# Release failure recovery")) {
    throw new Error("release notes must be feature and package provenance");
  }
}

function fromEnv(extra = {}) {
  const base = loadProvenance();
  return {
    ...base,
    tag: process.env.RELEASE_TAG || extra.tag,
    commit: process.env.RELEASE_COMMIT || extra.commit,
    zipSha256: process.env.PACKAGE_SHA256 || extra.zipSha256,
  };
}

if (process.argv[1] && process.argv[1].endsWith("release-notes.mjs")) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--check") {
      assertNotes(readFileSync(args[1], "utf8"), fromEnv());
      console.log("release notes ok");
    } else {
      const out = args[args.indexOf("--out") + 1];
      const info = fromEnv({
        tag: arg(args, "--tag"),
        commit: arg(args, "--commit"),
        zipSha256: arg(args, "--zip-sha256"),
      });
      const text = renderNotes(info);
      assertNotes(text, info);
      writeFileSync(out, text);
      console.log(out);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function arg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
