import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function assertReleaseIdentity({ tag, commit, version }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("tag is not a version tag");
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match package version ${version}`);
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("commit is not a full SHA");
}

if (process.argv[1] && process.argv[1].endsWith("check-release-identity.mjs")) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  try {
    assertReleaseIdentity({
      tag: process.env.RELEASE_TAG || "",
      commit: process.env.RELEASE_COMMIT || "",
      version,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
