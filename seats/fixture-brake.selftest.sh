#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
set -uo pipefail
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-fixture-brake.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/fixture-brake.ts" "$FIX" "${WHEELHOUSE_TEST_FIXTURE_BRAKE_LIB:-$HERE/selftest-lib.sh}" "$HERE/selftest-sweep-lock.ts"
