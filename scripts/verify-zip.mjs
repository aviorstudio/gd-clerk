import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("zip missing end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central header");
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const payload = buf.subarray(dataOff, dataOff + compSize);
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);
    entries.push({ name, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function verifyZip(zipPath) {
  const allow = JSON.parse(readFileSync(join(root, "scripts/package-allowlist.json"), "utf8"));
  const zip = readFileSync(zipPath);
  const sidecar = readFileSync(`${zipPath}.sha256`, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(zip).digest("hex");
  if (sidecar !== actual) throw new Error("zip sha256 sidecar does not match bytes");
  const entries = readZip(zip);
  if (entries.length !== 34 || allow.zip_entries !== 34 || allow.addon_files !== 33) {
    throw new Error(`zip has ${entries.length} entries; closed package requires 34`);
  }
  const names = entries.map((entry) => entry.name).sort();
  const expected = [
    ...allow.files.map((name) => `addons/@aviorstudio_gd-clerk/${name}`),
    "PACKAGE_MANIFEST.json",
  ].sort();
  if (names.join("\n") !== expected.join("\n")) {
    throw new Error("zip entries are not the closed allowlist plus PACKAGE_MANIFEST.json");
  }
  const manifestEntry = entries.find((entry) => entry.name === "PACKAGE_MANIFEST.json");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  if (manifest.closed !== true || manifest.zip_entries !== 34 || manifest.plugin_version !== "0.1.0") {
    throw new Error("package manifest is not closed");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 33) {
    throw new Error("package manifest file list is not the 33 addon files");
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  for (const file of manifest.files) {
    const data = byName.get(file.path);
    if (!data) throw new Error(`manifest path missing from zip: ${file.path}`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== file.sha256 || data.length !== file.bytes) {
      throw new Error(`manifest checksum mismatch: ${file.path}`);
    }
  }
  const manifestSha = createHash("sha256").update(manifestEntry.data).digest("hex");
  if (manifestSha !== createHash("sha256").update(manifestEntry.data).digest("hex")) {
    throw new Error("manifest bytes changed during check");
  }
  return { sha256: actual, entries: entries.length };
}

if (process.argv[1] && process.argv[1].endsWith("verify-zip.mjs")) {
  try {
    const result = verifyZip(process.argv[2]);
    console.log(`zip ok entries=${result.entries} sha256=${result.sha256}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
