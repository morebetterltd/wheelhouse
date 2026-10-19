#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-no-verdict.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
# A real private graph: task notification is checked by reading bd comments,
# not just by trusting that a fake bd accepted a command.
GRAPH_BASE_PATH="$PATH"
eval "$(selftest_scratch_graph "$FIX/graph")"
# Keep task notifications in that real private graph, but let the dispatcher's
# bd init/where use its own nested graph instead of the fixed -C wrapper.
export PATH="$GRAPH_BASE_PATH" BEADS_DIR="$FIX/graph/.beads"
# Only the tiny tracked fixture suite runs inside these nested reviews.
export WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/review-sweep.lock"
selftest_copy_seat_runtime "$FIX/runtime" "$HERE"
bun "$HERE/fixtures/verify-no-verdict.ts" "$HERE" "$FIX" "${WHEELHOUSE_VERIFY_NO_VERDICT_SOURCE:-$HERE/verify.ts}"
