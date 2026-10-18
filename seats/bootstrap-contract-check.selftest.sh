#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-bootstrap-contract-check.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" || return; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
bun "$HERE/fixtures/scratch-ownership.ts" bootstrap "$HERE/.." "$FIX"
bun "$HERE/fixtures/scratch-ownership.ts" bootstrap-second-fail "$HERE/.." "$FIX"
echo 'bootstrap-contract-check.selftest: PASS (old files intact; second allocation failure cleans only the first allocation)'
