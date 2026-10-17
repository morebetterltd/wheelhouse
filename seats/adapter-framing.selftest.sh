#!/usr/bin/env bash
# Real adapter -> FIFO/0<> holder -> LF-only Node pi stand-in, no provider.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
ADAPTER="${1:-$HERE/adapter.ts}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-framing.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
RUNTIME_SOURCE="$HERE"
if [ "$ADAPTER" != "$HERE/adapter.ts" ]; then
  # Overlay the alternate in a complete source tree, not the final runtime.
  # The helper still supplies the runtime's entire dependency closure.
  selftest_copy_seat_runtime "$FIX/source" "$HERE" || exit 2
  bun -e 'import fs from "node:fs"; const [source, target] = process.argv.slice(1); fs.copyFileSync(source, target);' "$ADAPTER" "$FIX/source/seats/adapter.ts" || exit 2
  RUNTIME_SOURCE="$FIX/source/seats"
fi
selftest_copy_seat_runtime "$FIX/runtime" "$RUNTIME_SOURCE" || exit 2
bun "$HERE/fixtures/adapter-framing.ts" "$FIX"
[[ -f "$FIX/results.json" && -s "$FIX/results.json" ]] || { echo 'STOP: framing fixture exited without its completed results' >&2; exit 2; }
