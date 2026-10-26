#!/usr/bin/env bash
# Settled-task reminders use their own observation namespace, not stream health.
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-seat-settled.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
selftest_copy_seat_runtime "$FIX/runtime" "$HERE"
bun "$HERE/fixtures/seat-settled.ts" "$FIX/runtime/seats" "$FIX" || exit $?
bun "$HERE/fixtures/seat-settled-canaries.ts" "$FIX/runtime/seats" "$FIX"
