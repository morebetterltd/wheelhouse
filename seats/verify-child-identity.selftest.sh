#!/usr/bin/env bash
# Native generation/state checks for the pre-readiness exit regression.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
export WHEELHOUSE_REVIEWER_REPLY_MODULE="$HERE/fixtures/reviewer-reply.cjs"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-verify-child-identity.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/verify-child-identity.ts" "$HERE" "$FIX"
