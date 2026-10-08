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
# npm dependencies are not Godot project assets. Avoid importing their fixtures.
if [[ -d node_modules ]]; then
  touch node_modules/.gdignore
fi
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
if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi

# Native Frontend API backend against the loopback fixture. The fixture serves
# plain http on 127.0.0.1; the addon accepts that only with GD_CLERK_TEST_LOOPBACK=1.
port_file="$(mktemp "$TMPDIR/gd-clerk-fixture-port.XXXXXX")"
rm -f "$port_file"
python3 -I tests/native/fapi_fixture.py --port-file "$port_file" &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
  [[ -s "$port_file" ]] && break
  sleep 0.1
done
if [[ ! -s "$port_file" ]]; then
  echo "fixture did not start" >&2
  exit 1
fi
: >"$log"
set +e
GD_CLERK_TEST_LOOPBACK=1 GD_CLERK_FIXTURE_PORT="$(cat "$port_file")" timeout 180 "$godot" --headless --path . --script res://tests/native/run_native_tests.gd >"$log" 2>&1
native_status=$?
set -e
cat "$log"
node scripts/reject-godot-log.mjs --require-ok "$log"
rm -f "$port_file"
exit "$native_status"
