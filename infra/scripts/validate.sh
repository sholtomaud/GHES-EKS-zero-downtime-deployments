#!/usr/bin/env bash
# Validate every synthesised stack with OpenTofu, without a backend or AWS credentials.
# Run inside the toolchain container (`make validate`); needs registry access for providers.
set -euo pipefail

out="${1:-cdktn.out/tofu}"
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$PWD/.tofu-plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

tofu version | head -1
# The engine cdktn calls must answer its `-v` probe (see scripts/tofu-cdktn).
"${TERRAFORM_BINARY_NAME:-tofu}" -v | grep -q '^OpenTofu v1\.' \
  || { echo "TERRAFORM_BINARY_NAME=${TERRAFORM_BINARY_NAME:-tofu} does not answer -v with an OpenTofu version" >&2; exit 1; }
for dir in "$out"/*/; do
  stack="$(basename "$dir")"
  echo "== $stack"
  tofu -chdir="$dir" init -backend=false -input=false -no-color >/dev/null
  tofu -chdir="$dir" validate -no-color
  tofu fmt -check -recursive "$dir" >/dev/null || { echo "not tofu-fmt clean: $dir" >&2; exit 1; }
done
