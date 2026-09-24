import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname;
const addon = join(root, "addons/@aviorstudio_gd-clerk");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc.sort();
}

const files = walk(addon);
const entries = files.map((path) => {
  const data = readFileSync(path);
  const name = "addons/@aviorstudio_gd-clerk/" + relative(addon, path).replaceAll("\\", "/");
  return { name, data, sha256: createHash("sha256").update(data).digest("hex") };
});
const manifest = {
  plugin_version: "0.1.0",
  files: entries.map(({ name, sha256, data }) => ({ path: name, sha256, bytes: data.length })),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
entries.push({
  name: "PACKAGE_MANIFEST.json",
  data: manifestBytes,
  sha256: createHash("sha256").update(manifestBytes).digest("hex"),
});

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const fixed = dosTime(new Date(Date.UTC(1980, 0, 1, 0, 0, 0)));
const parts = [];
const central = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name);
  const compressed = deflateRawSync(entry.data);
  const useStore = compressed.length >= entry.data.length;
  const method = useStore ? 0 : 8;
  const payload = useStore ? entry.data : compressed;
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(fixed.time, 10);
  local.writeUInt16LE(fixed.day, 12);
  local.writeUInt32LE(crc32(entry.data), 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(entry.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  parts.push(local, payload);
  const cen = Buffer.alloc(46 + name.length);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(fixed.time, 12);
  cen.writeUInt16LE(fixed.day, 14);
  cen.writeUInt32LE(crc32(entry.data), 16);
  cen.writeUInt32LE(payload.length, 20);
  cen.writeUInt32LE(entry.data.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt16LE(0, 30);
  cen.writeUInt16LE(0, 32);
  cen.writeUInt16LE(0, 34);
  cen.writeUInt16LE(0, 36);
  cen.writeUInt32LE(0, 38);
  cen.writeUInt32LE(offset, 42);
  name.copy(cen, 46);
  central.push(cen);
  offset += local.length + payload.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
const zip = Buffer.concat([...parts, centralBuf, end]);
const zipPath = join(dist, "@aviorstudio_gd-clerk.zip");
writeFileSync(zipPath, zip);
const sha = createHash("sha256").update(zip).digest("hex");
writeFileSync(zipPath + ".sha256", sha + "  @aviorstudio_gd-clerk.zip\n");
writeFileSync(join(dist, "PACKAGE_MANIFEST.json"), manifestBytes);
console.log(sha);

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}
