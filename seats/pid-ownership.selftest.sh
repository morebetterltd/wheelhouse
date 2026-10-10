#!/usr/bin/env bash
set -u

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ADAPTER="${1:-$HERE/adapter.ts}"
SEAT_ACTIVITY="$(cd "$(dirname "$ADAPTER")" && pwd)/seat-activity.ts"
FIX=""
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; }
trap cleanup EXIT INT TERM
FAILED=0
pass(){ echo "  ok    $*"; }
fail(){ echo "  FAIL  $*"; FAILED=$((FAILED+1)); }
if grep -En 'function pidHoldsPath|function pidMatchesStartedAt|function pidAlive\(pid: number \| null \| undefined, fifo\?: string, startedAt\?: string\)' "$SEAT_ACTIVITY" >/dev/null \
  && grep -En 'return \(fifo \? pidHoldsPath\(pid!, fifo\) : false\) \|\| pidMatchesStartedAt\(pid!, startedAt\)' "$SEAT_ACTIVITY" >/dev/null \
  && grep -En 'import \{[^}]*pidAlive[^}]*\} from "\./seat-activity"' "$ADAPTER" >/dev/null \
  && grep -En 'pidAlive\(rec\.pid, rec\.fifo, rec\.startedAt\)|pidAlive\(existing\.pid, existing\.fifo, existing\.startedAt\)' "$ADAPTER" >/dev/null; then
  pass 'adapter pid liveness is gated by FIFO ownership or recorded start-time proof, not bare kill -0 for recorded seats'
else
  fail 'adapter pid liveness did not show ownership/start-time proof at recorded-seat call sites'
fi
if [ "$FAILED" -eq 0 ]; then echo 'pid-ownership.selftest: PASS'; exit 0; fi
echo "pid-ownership.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
