#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-verify-batch.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
GRAPH_BASE_PATH="$PATH"
eval "$(selftest_scratch_graph "$FIX/graph")"
# A real private task graph. Nested dispatcher sweeps must initialize/resolve
# their OWN graph, not inherit a fixed -C graph wrapper.
export PATH="$GRAPH_BASE_PATH" BEADS_DIR="$FIX/graph/.beads"
unset WHEELHOUSE_SKIP_BD WHEELHOUSE_CONTRACT_FIXTURE
export WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/review-sweep.lock"
selftest_copy_seat_runtime "$FIX/runtime" "$HERE" || exit 2
bun "$HERE/fixtures/verify-batch.ts" "$HERE" "$FIX" "${WHEELHOUSE_VERIFY_BATCH_SOURCE:-$HERE/verify.ts}"
