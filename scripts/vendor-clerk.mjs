import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const dest = join(root, "addons/@aviorstudio_gd-clerk/javascript/clerk");
const pkgRoot = join(root, "node_modules/@clerk/clerk-js");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const locked = lock.packages["node_modules/@clerk/clerk-js"];
if (!locked || locked.version !== "6.33.0") {
  throw new Error("package-lock does not pin @clerk/clerk-js@6.33.0");
}
const expectedIntegrity = "sha512-cguJDbEOHNlNknh2E2pkqcQkuqhALZqGU76v91W9cP38tWYl+fxh374PA1XbcAeSUl6r0sa/OJBuGjuJNEuC2A==";
if (locked.integrity !== expectedIntegrity) {
  throw new Error("lockfile integrity does not match the pinned registry integrity");
}
const dist = join(pkgRoot, "dist");
const names = readdirSync(dist).filter((name) => name.includes("clerk.browser") && !name.includes("legacy") && !name.includes("native") && name.endsWith(".js")).sort();
if (!names.includes("clerk.browser.js")) {
  throw new Error("clerk.browser.js missing from the pinned package");
}
const files = names.map((name) => {
  const bytes = readFileSync(join(dist, name));
  return {
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
});
const manifest = {
  package: "@clerk/clerk-js",
  version: "6.33.0",
  integrity: locked.integrity,
  files,
};
if (check) {
  const current = JSON.parse(readFileSync(join(dest, "VENDOR.json"), "utf8"));
  if (JSON.stringify(current) !== JSON.stringify(manifest)) {
    throw new Error("vendored Clerk manifest does not match the lockfile package");
  }
  for (const file of files) {
    const onDisk = readFileSync(join(dest, file.name));
    const hash = createHash("sha256").update(onDisk).digest("hex");
    if (hash !== file.sha256 || onDisk.length !== file.bytes) {
      throw new Error(`vendored file mismatch: ${file.name}`);
    }
  }
  console.log(`vendor check ok (${files.length} files)`);
} else {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of names) copyFileSync(join(dist, name), join(dest, name));
  writeFileSync(join(dest, "VENDOR.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`vendored ${files.length} files into ${dest}`);
}
