#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ADAPTER="${1:-$HERE/adapter.ts}"
FAILED=0
pass(){ echo "  ok    $*"; }
fail(){ echo "  FAIL  $*"; FAILED=$((FAILED+1)); }
if rg -n 'function pidHoldsPath|function pidAlive\(pid: number \| null, fifo\?: string\)' "$ADAPTER" >/dev/null \
  && rg -n 'pidAlive\(rec\.pid, rec\.fifo\)|pidAlive\(existing\.pid, existing\.fifo\)' "$ADAPTER" >/dev/null; then
  pass 'adapter pid liveness is gated by the seat FIFO ownership proof, not bare kill -0 for recorded seats'
else
  fail 'adapter pid liveness did not show FIFO ownership proof at recorded-seat call sites'
fi
if [ "$FAILED" -eq 0 ]; then echo 'pid-ownership.selftest: PASS'; exit 0; fi
echo "pid-ownership.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
