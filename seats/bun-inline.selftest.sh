#!/usr/bin/env bash
# No filesystem fixture or service: inspect tracked sources and run child probes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
bun "$HERE/fixtures/bun-inline-guard.ts" "$(cd "$HERE/.." && pwd -P)"
