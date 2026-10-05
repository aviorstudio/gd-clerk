#!/usr/bin/env bash
set -euo pipefail
url="https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz"
sha="f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011"
data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
dest="${data_home}/godot/export_templates/4.7.2.stable"
if [ -f "${dest}/web_nothreads_release.zip" ]; then
  exit 0
fi
tmp="$(mktemp -d /tmp/gd-clerk-templates.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/templates.tpz" "$url"
echo "${sha}  $tmp/templates.tpz" | sha256sum -c -
unzip -q "$tmp/templates.tpz" -d "$tmp"
test -f "$tmp/templates/web_nothreads_release.zip"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
mv "$tmp/templates" "$dest"
