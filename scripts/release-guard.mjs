import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function assertMainRef({ ref, head, originMain }) {
  if (ref !== "refs/heads/main") throw new Error("release only runs from main");
  if (!/^[0-9a-f]{40}$/.test(head || "") || head !== originMain) {
    throw new Error("release commit is not origin/main");
  }
}

export function assertChecksum(actual, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected || "") || !/^[0-9a-f]{64}$/.test(actual || "") || actual !== expected) {
    throw new Error("tested ZIP checksum does not match");
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (process.argv[1] && process.argv[1].endsWith("release-guard.mjs")) {
  try {
    if (process.argv.includes("--main")) {
      assertMainRef({
        ref: process.env.RELEASE_REF || "",
        head: process.env.RELEASE_HEAD || "",
        originMain: process.env.RELEASE_ORIGIN_MAIN || "",
      });
      console.log("main ref ok");
    } else if (process.argv.includes("--checksum")) {
      const file = process.argv[process.argv.indexOf("--checksum") + 1];
      const expected = readFileSync(file, "utf8").trim().split(/\s+/)[0];
      const actual = sha256File(file.replace(/\.sha256$/, ""));
      assertChecksum(actual, expected);
      console.log("checksum ok");
    } else {
      throw new Error("release guard was not checked");
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
