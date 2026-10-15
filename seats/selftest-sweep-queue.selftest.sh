#!/usr/bin/env bash
# FIFO sweep admission: barriers fix arrival/release order, never elapsed time.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-sweep-queue.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
export WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER="${WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:-$HERE/selftest-sweep-lock.ts}"
bun "$HERE/fixtures/sweep-queue.ts" "$FIX" "${1:-$HERE/selftest-sweep.sh}" "$WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER"
