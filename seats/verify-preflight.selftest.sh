#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/selftest-lib.sh"
FIX=$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-verify-preflight.XXXXXX") || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/verify-preflight.ts" "$HERE/.." "$FIX"
