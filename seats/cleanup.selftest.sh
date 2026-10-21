#!/usr/bin/env bash
# Real dispatch/graph-close/cleanup path, with only the provider stubbed.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd -P)"
. "$S/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-cleanup.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
# Never close tasks in the install's graph, even in this integration test.
graph_env="$(selftest_scratch_graph "$FIX/graph")" || exit 2
eval "$graph_env"
selftest_copy_seat_runtime "$FIX/project" "$S" || exit 2
bun "$S/fixtures/cleanup-dispatch.ts" "$FIX"
