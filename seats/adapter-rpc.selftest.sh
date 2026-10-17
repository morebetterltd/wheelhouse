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
RUNTIME_SOURCE="$S"
if [ "$ADAPTER" != "$S/adapter.ts" ]; then
  # Overlay the alternate file in a complete source tree, never in the runtime.
  # The helper still supplies the runtime's entire dependency closure.
  selftest_copy_seat_runtime "$FIX/source" "$S" || exit 2
  bun -e 'import fs from "node:fs"; const [source, target] = process.argv.slice(1); fs.copyFileSync(source, target);' "$ADAPTER" "$FIX/source/seats/adapter.ts" || exit 2
  RUNTIME_SOURCE="$FIX/source/seats"
fi
selftest_copy_seat_runtime "$FIX/runtime" "$RUNTIME_SOURCE" || exit 2
bun "$S/fixtures/adapter-rpc.ts" "$FIX"
