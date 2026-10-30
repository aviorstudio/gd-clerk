#!/usr/bin/env bash
# Install the pinned gdam CLI, which restores this project's addon
# dependencies (gdam.lock) before the Godot tests run. The archive is the
# exact release asset, checked against its reviewed SHA-256 before anything
# is extracted, the same way the locked addon recipe pins the engine.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="v0.1.5"
archive="gdam_Linux_x86_64.tar.gz"
sha256="0c24b5958d7663b0cdc52465f39f4481d1d3e92ec1c6221b9dcc5e7faa1ef634"
destination="${1:-$root/.artifacts/bin/gdam}"
if [[ -x "$destination" ]] && "$destination" --version 2>/dev/null | grep -q "gdam ${version#v}"; then
  exit 0
fi
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
curl -fsSL --retry 3 -o "$staging/$archive" "https://github.com/aviorstudio/gdam/releases/download/$version/$archive"
echo "$sha256  $staging/$archive" | sha256sum --check --quiet
tar -xzf "$staging/$archive" -C "$staging" gdam
mkdir -p "$(dirname "$destination")"
install -m 755 "$staging/gdam" "$destination"
"$destination" --version
