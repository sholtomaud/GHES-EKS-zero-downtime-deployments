#!/usr/bin/env bash
# `cdktn synth`, failing on any [ERROR] line the CLI logs. The CLI keeps going
# (exit 0) after some errors, so without this they only show up as noise.
set -euo pipefail

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
cdktn synth 2>&1 | tee "$log"
if grep -q '\[ERROR\]' "$log"; then
  echo "cdktn synth logged errors (see above)" >&2
  exit 1
fi
