#!/usr/bin/env bash
# Two real stop invocations, ordered by peer-owned SIGTERM/release barriers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
ADAPTER="${1:-$HERE/adapter.ts}"
[ -f "$ADAPTER" ] || exit 2
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-state.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"' EXIT
mkdir -p "$FIX/home"
FAILED=0
for order in ab ba; do
  PROJ="$FIX/$order"
  mkdir -p "$PROJ/seats"
  selftest_copy_seat_runtime "$PROJ" "$HERE"
  cp -f "$ADAPTER" "$PROJ/seats/adapter.ts"
  if HOME="$FIX/home" bun "$HERE/fixtures/adapter-state.ts" "$PROJ" "$order"; then :; else FAILED=1; fi
done
exit "$FAILED"
