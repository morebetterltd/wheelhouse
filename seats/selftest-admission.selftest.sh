#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-admission.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
bun "$HERE/fixtures/selftest-admission.ts" "$FIX" "${1:-$HERE/selftest-lib.sh}" "$HERE/selftest-sweep-lock.ts" "$HERE/selftest-sweep.sh"
