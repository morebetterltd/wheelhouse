#!/usr/bin/env bash
# Reused recorded PID + departed FIFO reader: guard before any blocking lookup.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
SOURCE="${1:-$HERE/..}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-recover-dead-pipe.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/recover-dead-pipe.ts" "$SOURCE" "$FIX"
printf '%s\n' 'recover-dead-pipe.selftest: PASS'
