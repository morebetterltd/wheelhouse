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
selftest_copy_seat_runtime "$FIX/runtime" "$HERE"
cp -f "$ADAPTER" "$FIX/runtime/seats/adapter.ts"
bun "$HERE/fixtures/adapter-framing.ts" "$FIX"
[[ -f "$FIX/results.json" && -s "$FIX/results.json" ]] || { echo 'STOP: framing fixture exited without its completed results' >&2; exit 2; }
