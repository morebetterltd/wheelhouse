#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-admission.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
if [ "${WHEELHOUSE_SELFTEST_ANCESTRY_ONLY:-0}" != 1 ]; then
  bun "$HERE/fixtures/selftest-admission.ts" "$FIX" "${1:-$HERE/selftest-lib.sh}" "$HERE/selftest-sweep-lock.ts" "$HERE/selftest-sweep.sh" || exit "$?"
fi
bun "$HERE/fixtures/selftest-ancestry.ts" "$FIX" "$HERE/selftest-sweep-lock.ts"
