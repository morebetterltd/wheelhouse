#!/usr/bin/env bash
# Two isolated installs, idle payloads, one private host endpoint. The enclosing
# suite itself uses the real host FIFO through selftest-lib.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
set -uo pipefail
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-heavy-test.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/heavy-test.ts" "$FIX" "$HERE"
