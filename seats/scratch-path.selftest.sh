#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-scratch-path.XXXXXX")" || exit 2
selftest_isolate_git "$FIX"
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
selftest_copy_seat_runtime "$FIX/runtime" "${1:-${WHEELHOUSE_SCRATCH_PATH_SOURCE:-$HERE}}"
bun "$HERE/fixtures/scratch-path.mjs" "$FIX" "$FIX/runtime/seats" "$HERE"
