#!/usr/bin/env bash
# Dispatch must bind the worker's brief to the actual adopted Git worktree.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-dispatch-worktree.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
selftest_copy_seat_runtime "$FIX/runtime" "$HERE" || exit 2
bun "$HERE/fixtures/dispatch-worktree.ts" "$HERE" "$FIX" "${WHEELHOUSE_DISPATCH_WORKTREE_CASE:-all}"
