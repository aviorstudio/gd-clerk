#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export GODOT_BIN="$root/.artifacts/godot/bin/godot"
export XDG_DATA_HOME="$root/.artifacts/godot-data"
export XDG_CONFIG_HOME="$root/.artifacts/godot-config"
export PLAYWRIGHT_BROWSERS_PATH="$root/.artifacts/playwright"
export TMPDIR="$root/.artifacts/tmp"
export GODOT_SILENCE_ROOT_WARNING=1
mkdir -p "$TMPDIR"
exec "$@"
