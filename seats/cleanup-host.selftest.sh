#!/usr/bin/env bash
# Stable scratch/cleanup host ownership, with fixture-only machine/name changes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-cleanup-host.$$.XXXXXX" wheelhouse-cleanup-host)" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
mkdir -p "$FIX/source"
selftest_copy_seat_runtime "$FIX/source" "$HERE" || exit 2
bun "$HERE/fixtures/cleanup-host.ts" "$FIX" "$FIX/source/seats"
