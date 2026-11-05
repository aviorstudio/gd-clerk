# Generated cookbook entrypoint. Change cookbook.toml and regenerate.
# Recipe data SHA256: 1f892089a68c89d619feab4bc67818ccc8cbe652d00945f1e6e0536c3b581c04
COOKBOOK_REF := ade449c3150fd5a9c86fb6ec21d8ae905d6a2754
COOKBOOK_RECIPE := godot-addon
COOKBOOK_ROOT ?= .artifacts/cookbook/$(COOKBOOK_REF)
COOKBOOK_TEST_SUITES := lint unit security integration e2e
COOKBOOK_CAPABILITIES :=
COOKBOOK_EMPTY :=
COOKBOOK_SPACE := $(COOKBOOK_EMPTY) $(COOKBOOK_EMPTY)
cookbook_path = $(subst $(COOKBOOK_SPACE),\$(COOKBOOK_SPACE),$(1))
COOKBOOK_ENTRY := $(call cookbook_path,$(COOKBOOK_ROOT)/cookbook/recipes/$(COOKBOOK_RECIPE).mk)

ifeq ($(wildcard $(COOKBOOK_ENTRY)),)
.DEFAULT_GOAL := help
.PHONY: help setup
help:
	@printf '%s\n' 'make help' 'make setup' 'make fmt' 'make build' 'make test' 'make test:lint' 'make test:unit' 'make test:security' 'make test:integration' 'make test:e2e' 'make clean'
	@printf '%s\n' 'Run make setup once to fetch the pinned cookbook and prepare dependencies.'
setup:
	@mkdir -p "$(COOKBOOK_ROOT)"
	@git -C "$(COOKBOOK_ROOT)" init -q
	@git -C "$(COOKBOOK_ROOT)" fetch --quiet --depth=1 https://github.com/nicodes/tools.git "$(COOKBOOK_REF)"
	@git -C "$(COOKBOOK_ROOT)" checkout --quiet --detach "$(COOKBOOK_REF)"
	@test "$$(git -C "$(COOKBOOK_ROOT)" rev-parse HEAD)" = "$(COOKBOOK_REF)"
	@$(MAKE) --no-print-directory setup
else
include $(COOKBOOK_ENTRY)
endif
