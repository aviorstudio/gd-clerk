#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mkdir -p .artifacts/bin .artifacts/tmp
touch .artifacts/.gdignore
bash scripts/install-gdam.sh "$root/.artifacts/bin/gdam"
"$root/.artifacts/bin/gdam" install --frozen-lockfile
flags=(install chromium)
if [[ "${CI:-false}" == true ]]; then flags+=(--with-deps); fi
PLAYWRIGHT_BROWSERS_PATH="$root/.artifacts/playwright" TMPDIR="$root/.artifacts/tmp" npx --no-install playwright "${flags[@]}"
