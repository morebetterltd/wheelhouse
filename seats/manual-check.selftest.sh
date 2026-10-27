#!/usr/bin/env bash
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
IMPL="${1:-$HERE/manual-check.ts}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-manual-check.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/manual-check.ts" "$HERE" "$FIX" "$IMPL"
