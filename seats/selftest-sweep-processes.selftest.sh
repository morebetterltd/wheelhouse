#!/usr/bin/env bash
# Real output-holding plants, through the current runner's own lifecycle.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-sweep-survivors.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
PROJECT="$FIX/project"
selftest_copy_seat_runtime "$PROJECT" "$HERE" || exit 2
cp -f "${1:-$HERE/selftest-sweep.sh}" "$PROJECT/seats/selftest-sweep.sh" || exit 2
git -C "$PROJECT" init -q -b main || exit 2
git -C "$PROJECT" add seats || exit 2
bun "$HERE/fixtures/sweep-survivors.ts" "$FIX" "$PROJECT/seats" || exit "$?"
bun "$HERE/fixtures/sweep-survivor-canaries.ts" "$FIX" "$PROJECT/seats" "$HERE" || exit "$?"
echo 'selftest-sweep-processes: PASS'
