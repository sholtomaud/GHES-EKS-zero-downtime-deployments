# One entry point for the infra toolchain, on a Mac or in GitHub Actions.
# The OS picks the container runtime: Apple `container` on macOS, Docker on
# Linux. Override with `make CONTAINER=podman ...` if you need to, or
# `make CONTAINER=none ...` to run on the host with your own node, tofu,
# cdktn and tsgo (`make doctor` checks them).
#
#   make ci                      image + deps + typecheck + test + synth + validate
#   make test                    unit tests (hermetic: no AWS, no network)
#   make plan STACK=workload-dev tofu plan for one stack (needs AWS credentials)
#   make shell                   interactive shell in the toolchain container

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  CONTAINER ?= container
else
  CONTAINER ?= docker
endif

IMAGE      ?= infra-toolchain:local
NODE_IMAGE ?= docker.io/library/node:24.21.0-bookworm-slim
STACK      ?=

RUN_FLAGS := --rm -v "$(CURDIR)":/work -w /work/infra
# Docker on Linux: write files as the invoking user, not root.
ifeq ($(CONTAINER),docker)
  RUN_FLAGS += --user $(shell id -u):$(shell id -g)
endif
# Pass AWS credentials through by NAME only (`-e VAR`), so values never appear
# in the echoed command or CI logs. Only variables that are set are passed.
AWS_VARS := AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION
RUN_FLAGS += $(foreach v,$(AWS_VARS),$(if $($(v)),-e $(v)))

ifeq ($(CONTAINER),none)
  RUN := cd infra && TERRAFORM_BINARY_NAME=tofu CHECKPOINT_DISABLE=1
else
  RUN := $(CONTAINER) run $(RUN_FLAGS) $(IMAGE)
endif

.DEFAULT_GOAL := help
.PHONY: help runtime image doctor deps typecheck test coverage synth validate plan shell ci clean print-runtime

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'
	@echo "  runtime: $(CONTAINER)"

print-runtime: ## Print the container runtime this OS uses
	@echo $(CONTAINER)

runtime: ## Make sure the container runtime is up (Apple container needs its system service)
ifeq ($(CONTAINER),none)
	@true
else ifeq ($(CONTAINER),container)
	@container system status >/dev/null 2>&1 || container system start
else
	@$(CONTAINER) version >/dev/null
endif

image: runtime ## Build the toolchain image from the Containerfile
ifeq ($(CONTAINER),none)
	@echo "CONTAINER=none: using host tools"; $(MAKE) --no-print-directory doctor
else
	$(CONTAINER) build --build-arg NODE_IMAGE=$(NODE_IMAGE) -t $(IMAGE) -f Containerfile .
endif

doctor: ## Check toolchain versions (inside the image, or on the host with CONTAINER=none)
	$(RUN) sh -c 'node --version && tofu version | head -1 && cdktn --version && tsgo --version' \
	  | tee /dev/stderr | awk '/^v[0-9]/ { split(substr($$1,2),v,"."); if (v[1] < 22 || (v[1] == 22 && v[2] < 18)) exit 1 } \
	    /^OpenTofu v/ { split(substr($$2,2),t,"."); if (t[1] == 1 && t[2] < 13) exit 1 }' >/dev/null \
	  || { echo "need Node >= 22.18 (24 in the image) and OpenTofu >= 1.13" >&2; exit 1; }

deps: ## Install locked npm dependencies into infra/node_modules
	$(RUN) npm ci --no-audit --no-fund

typecheck: ## Typecheck with TypeScript 7 (tsgo)
	$(RUN) tsgo -p .

test: ## Run the infra unit tests
	$(RUN) npm test

coverage: ## Unit tests with lcov coverage (infra/coverage/lcov.info, read by SonarQube)
	$(RUN) sh -c 'mkdir -p coverage && npm run test:coverage'

synth: ## Synthesise OpenTofu JSON into infra/cdktn.out
	$(RUN) cdktn synth

validate: synth ## tofu init -backend=false && tofu validate for every stack
	$(RUN) bash scripts/validate.sh

plan: synth ## tofu plan for one stack: make plan STACK=workload-dev
	@test -n "$(STACK)" || { echo "usage: make plan STACK=<tooling|workload-dev|...>" >&2; exit 2; }
	$(RUN) sh -c 'tofu -chdir=cdktn.out/tofu/$(STACK) init -input=false && tofu -chdir=cdktn.out/tofu/$(STACK) plan -input=false -lock-timeout=5m'

shell: ## Interactive shell in the toolchain container
	$(CONTAINER) run -it $(RUN_FLAGS) $(IMAGE) bash

ci: image doctor deps typecheck coverage validate ## Everything CI runs, in order

clean: ## Remove build output (keeps node_modules)
	rm -rf infra/cdktn.out infra/.tofu-plugin-cache
