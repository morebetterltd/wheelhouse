#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-verify-graph.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
REAL_BD="${WHEELHOUSE_REAL_BD:-$(command -v bd)}"
selftest_copy_seat_runtime "$FIX/runtime" "$HERE" || exit 2
bun "$HERE/fixtures/verify-graph.ts" "$FIX" "$REAL_BD"
printf 'verify-graph.selftest: PASS\n'
