#!/usr/bin/env bash
# Real stop invocations with commit latency, ordered by peer-owned barriers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
ADAPTER="${1:-$HERE/adapter.ts}"
[ -f "$ADAPTER" ] || exit 2
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-state.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
mkdir -p "$FIX/home"
FAILED=0
for order in ab ba; do
  PROJ="$FIX/$order"
  mkdir -p "$PROJ/seats"
  selftest_copy_seat_runtime "$PROJ" "$HERE"
  cp -f "$ADAPTER" "$PROJ/seats/adapter.ts"
  if HOME="$FIX/home" bun "$HERE/fixtures/adapter-state.ts" "$PROJ" "$order"; then :; else FAILED=1; fi
done
if HOME="$FIX/home" bun "$HERE/fixtures/adapter-state-order.ts" "$HERE" "$FIX"; then :; else FAILED=1; fi
exit "$FAILED"
