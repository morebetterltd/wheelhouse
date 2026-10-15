#!/usr/bin/env bash
# Inspect tracked sources and run child probes with an owned Git boundary.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-bun-inline.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_remove_fixture_dir "$FIX"'
bun "$HERE/fixtures/bun-inline-guard.ts" "$(cd "$HERE/.." && pwd -P)"
