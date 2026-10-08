#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export PYTHONDONTWRITEBYTECODE=1
CICD_ENGINEERING="$(python3 scripts/engineering-bootstrap.py)"
export CICD_ENGINEERING
python3 "$CICD_ENGINEERING/helpers/godot-setup.py" --version 4.7.2 --origin godot --binary-checksum sha512:9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65 --templates-checksum sha256:f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011 --root "$root/.artifacts/godot" --templates
