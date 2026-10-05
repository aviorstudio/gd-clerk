import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGodotLog } from "./reject-godot-log.mjs";
import { verifyZip } from "./verify-zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zip = process.argv[2] || join(root, "dist/@aviorstudio_gd-clerk.zip");
const godot = process.env.GODOT_BIN || "godot";
const project = join("/tmp", `gd-clerk-lifecycle-${process.pid}`);

verifyZip(zip);
rmSync(project, { recursive: true, force: true });
mkdirSync(join(project, "config"), { recursive: true });
mkdirSync(join(project, "xdg"), { recursive: true });
const unpacked = spawnSync("unzip", ["-o", zip, "-d", project], { encoding: "utf8" });
if (unpacked.status !== 0) {
  console.error(unpacked.stderr || unpacked.stdout);
  process.exit(unpacked.status || 1);
}
cpSync(join(root, "tests/editor/lifecycle_probe"), join(project, "addons/lifecycle_probe"), { recursive: true });
writeFileSync(join(project, "project.godot"), `config_version=5

[application]

config/name="gd-clerk-lifecycle"
config/features=PackedStringArray("4.7")

[editor_plugins]

enabled=PackedStringArray("res://addons/@aviorstudio_gd-clerk/plugin.cfg", "res://addons/lifecycle_probe/plugin.cfg")
`);

function run(phase) {
  writeFileSync(join(project, "lifecycle_phase.txt"), `${phase}\n`);
  const result = spawnSync(godot, ["--headless", "--editor", "--path", project, "--quit-after", "90"], {
    env: {
      ...process.env,
      GODOT_SILENCE_ROOT_WARNING: "1",
      XDG_CONFIG_HOME: join(project, "config"),
      XDG_DATA_HOME: join(project, "xdg"),
      HOME: "/tmp",
    },
    encoding: "utf8",
  });
  const log = `${result.stdout || ""}\n${result.stderr || ""}`;
  writeFileSync(join(project, `editor-${phase}.log`), log);
  try {
    assertGodotLog(log);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(log);
    process.exit(result.status || 1);
  }
  const observed = readFileSync(join(project, "lifecycle_result.txt"), "utf8").trim();
  if (!observed.startsWith(`ok phase=${phase}`)) {
    console.error(observed);
    process.exit(1);
  }
  if (phase !== "disable" && !/uid:\/\/|gd_clerk\.gd/.test(observed)) {
    console.error("autoload did not reference the installed script");
    console.error(observed);
    process.exit(1);
  }
  console.log(observed);
}

for (const phase of ["enable", "restart", "disable"]) run(phase);
console.log("editor lifecycle ok");
