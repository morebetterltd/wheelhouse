#!/usr/bin/env bash
# RPC outcomes follow replies/process/pipe signals, never elapsed budgets.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
. "$S/selftest-lib.sh"
ADAPTER="${1:-$S/adapter.ts}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-rpc.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
selftest_copy_seat_runtime "$FIX/runtime" "$S" || exit 2
cp -f "$ADAPTER" "$FIX/runtime/seats/adapter.ts" || exit 2
bun "$S/fixtures/adapter-rpc.ts" "$FIX"
