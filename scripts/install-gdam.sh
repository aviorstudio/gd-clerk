#!/usr/bin/env bash
# Install the pinned gdam CLI, which restores this project's addon
# dependencies (gdam.lock) before the Godot tests run. The archive is the
# exact release asset, checked against its reviewed SHA-256 before anything
# is extracted, the same way scripts/install-godot.sh pins the engine.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="v0.1.0"
archive="gdam_Linux_x86_64.tar.gz"
sha256="63bfb66ff08b1191607e37324321a6bdb093d7639e38421d1f1f0854cf7ccb13"
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
