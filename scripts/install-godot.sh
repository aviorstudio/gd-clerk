#!/usr/bin/env bash
set -euo pipefail
dest="${1:-/usr/local/bin/godot}"
url="https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip"
sha="9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65"
tmp="$(mktemp -d /tmp/gd-clerk-godot-install.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/godot.zip" "$url"
echo "${sha}  $tmp/godot.zip" | sha512sum -c -
unzip -q "$tmp/godot.zip" -d "$tmp"
install -m 755 "$tmp/Godot_v4.7.2-stable_linux.x86_64" "$dest"
