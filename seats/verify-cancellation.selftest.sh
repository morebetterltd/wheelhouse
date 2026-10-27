#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-verify-cancellation.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){
  for ledger in "$FIX"/groups.*; do
    [ -f "$ledger" ] || continue
    while IFS= read -r pgid; do
      case "$pgid" in ''|*[!0-9]*) continue ;; esac
      [ "$pgid" -gt 1 ] && kill -KILL -- "-$pgid" 2>/dev/null || true
    done < "$ledger"
  done
  selftest_remove_fixture_dir "$FIX"
}
selftest_install_cleanup_traps cleanup
selftest_copy_seat_runtime "$FIX/runtime" "${WHEELHOUSE_VERIFY_CANCELLATION_RUNTIME:-$HERE}" || exit 2
if [ -n "${WHEELHOUSE_VERIFY_CANCELLATION_SOURCE:-}" ]; then
  cp -f "$WHEELHOUSE_VERIFY_CANCELLATION_SOURCE" "$FIX/runtime/seats/verify.ts"
fi
# Unlike FIX and the per-suite TMPDIR, this root survives fixture teardown.
export WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT="${WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT:-${WHEELHOUSE_VERIFY_CANCEL_EVIDENCE:-$HERE/verdicts/verify-cancellation-failures}}"
normal=0
bun "$HERE/fixtures/verify-cancellation.ts" "$FIX" || normal=$?
[[ -f "$FIX/completed.json" ]] || { echo 'STOP: cancellation fixture did not complete' >&2; exit 2; }
retention=0
bun "$HERE/fixtures/verify-cancellation-retention.ts" "$FIX/retention-canary" "$HERE/fixtures/verify-cancellation.ts" "$FIX/runtime/seats" || retention=$?
residual=0
bun "$HERE/fixtures/verify-cancellation-residual-test.ts" "$FIX/retention-residual" "$HERE/fixtures/verify-cancellation-retention.ts" "$HERE/fixtures/verify-cancellation.ts" "$FIX/runtime/seats" || residual=$?
[ "$normal" = 0 ] && [ "$retention" = 0 ] && [ "$residual" = 0 ]
