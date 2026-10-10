.DEFAULT_GOAL := help
SHELL := /bin/bash
.NOTPARALLEL:
.PHONY: help install lint test build check dev stop clean
help:
	@echo 'make check  Run the existing addon, browser fixture, export and installed ZIP gates'
install:
	mise trust .mise.toml
	mise install node@22.20.0 python@3.13.11 http:cicd-engineering
	npm ci
	mkdir -p .artifacts/bin
	touch .artifacts/.gdignore
	bash scripts/install-godot.sh "$(CURDIR)/.artifacts/bin/godot"
	bash scripts/install-gdam.sh "$(CURDIR)/.artifacts/bin/gdam"
	"$(CURDIR)/.artifacts/bin/gdam" install --frozen-lockfile
	CICD_ENGINEERING="$$(python3 scripts/engineering-bootstrap.py)" XDG_DATA_HOME="$(CURDIR)/.artifacts/godot-data" bash scripts/install-godot-templates.sh
	PLAYWRIGHT_BROWSERS_PATH="$(CURDIR)/.artifacts/playwright" npx --no-install playwright install chromium
lint:
	npm audit --audit-level=high
	node scripts/vendor-clerk.mjs --check
	node scripts/scan.mjs
	node scripts/workflow-policy.mjs
test:
	bash scripts/profile-tests.sh
build:
	node scripts/package-addon.mjs
	node scripts/verify-zip.mjs dist/@aviorstudio_gd-clerk.zip
check: install lint test build
	GODOT_BIN="$(CURDIR)/.artifacts/bin/godot" node scripts/editor-lifecycle.mjs dist/@aviorstudio_gd-clerk.zip
dev stop:
	@echo '$@: unsupported: run the addon in its consuming Godot project'
clean:
	python3 -c 'import shutil; [shutil.rmtree(path, ignore_errors=True) for path in (".artifacts", "dist", "node_modules", ".godot")]'
