#!/usr/bin/env bash
# Private-lock diagnostics and network-name changes; no installed lock writes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-sweep-identity.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/sweep-identity.ts" "$FIX" "${1:-$HERE/selftest-sweep-lock.ts}" "$HERE/selftest-sweep.sh"
[[ -s "$FIX/results.json" ]] || { echo 'STOP: identity fixture did not complete its results' >&2; exit 2; }
