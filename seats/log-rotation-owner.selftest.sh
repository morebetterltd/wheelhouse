#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
SOURCE="${1:-$HERE/..}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-log-rotation-owner.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ trap '' INT TERM HUP; selftest_cleanup_fixture_processes "$FIX" || return; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
selftest_copy_seat_runtime "$FIX/runtime" "$SOURCE/seats"
bun "$HERE/fixtures/log-rotation-owner.ts" "$FIX/runtime" "$FIX" "${2:-all}"
printf '%s\n' 'log-rotation-owner.selftest: PASS'
