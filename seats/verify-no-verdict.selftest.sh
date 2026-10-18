#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-no-verdict.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
# A real private graph: task notification is checked by reading bd comments,
# not just by trusting that a fake bd accepted a command.
eval "$(selftest_scratch_graph "$FIX/graph")"
selftest_copy_seat_runtime "$FIX/runtime" "$HERE"
bun "$HERE/fixtures/verify-no-verdict.ts" "$HERE" "$FIX" "${WHEELHOUSE_VERIFY_NO_VERDICT_SOURCE:-$HERE/verify.ts}"
