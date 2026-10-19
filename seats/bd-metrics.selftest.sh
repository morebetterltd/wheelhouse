#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-bd-metrics.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_remove_fixture_dir "$FIX"'
REAL_BD="$(command -v bd)" || { echo 'selftest: bd is required' >&2; exit 2; }
selftest_copy_seat_runtime "$FIX/runtime" "$HERE" || exit 2
if [ -n "${WHEELHOUSE_TEST_METRICS_VERIFY_SOURCE:-}" ]; then
  cp -f "$WHEELHOUSE_TEST_METRICS_VERIFY_SOURCE" "$FIX/runtime/seats/verify.ts" || exit 2
fi
bun "$HERE/fixtures/bd-metrics.ts" "$FIX" "${1:-$HERE/selftest-lib.sh}" "$REAL_BD" "$HERE/selftest-sweep-lock.ts" "$FIX/runtime/seats"
