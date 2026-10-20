#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-seat-stream.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
unset WHEELHOUSE_SEAT_QUIET_MS WHEELHOUSE_SEAT_STALL_NEED_MS
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
selftest_copy_seat_runtime "$FIX/project" "${1:-$HERE}"
bun "$HERE/fixtures/seat-stream.ts" "$FIX/project" "${WHEELHOUSE_SEAT_STREAM_CASE:-all}"
