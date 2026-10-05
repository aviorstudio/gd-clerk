#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
godot="${GODOT_BIN:-godot}"
export TMPDIR="${TMPDIR:-/tmp}"
export GODOT_SILENCE_ROOT_WARNING=1
export HOME="${HOME:-/tmp}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/godot-config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/tmp/godot-userdata}"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
log="$(mktemp /tmp/gd-clerk-godot.XXXXXX)"
set +e
"$godot" --headless --import --path . --quit >"$log" 2>&1
import_status=$?
set -e
if [[ "$import_status" -ne 0 ]]; then
  cat "$log"
  exit "$import_status"
fi
node scripts/reject-godot-log.mjs "$log"
: >"$log"
set +e
"$godot" --headless --path . --quit-after 1 --script res://tests/gdscript/run_gd_tests.gd >"$log" 2>&1
test_status=$?
set -e
cat "$log"
node scripts/reject-godot-log.mjs --require-ok "$log"
exit "$test_status"
