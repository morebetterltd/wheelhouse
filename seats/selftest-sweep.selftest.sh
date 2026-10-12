#!/usr/bin/env bash
# selftest-sweep.selftest.sh — fixture proof for the host-wide sweep lock.

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
SWEEP="$HERE/selftest-sweep.sh"
[ -x "$SWEEP" ] || { echo "selftest: not executable: $SWEEP" >&2; exit 2; }

FAILED=0
FIX=""
pass(){ printf 'ok - %s\n' "$*"; }
fail(){ printf 'not ok - %s\n' "$*"; FAILED=$((FAILED + 1)); }
cleanup(){
  [ -n "$FIX" ] && selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true
  [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-sweep-selftest.$$.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
SUITES="$FIX/suites"
LOCK="$FIX/host.lock"
EVENTS="$FIX/events.log"
mkdir -p "$SUITES"
cat > "$SUITES/fixture.selftest.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
: "${SWEEP_ID:?}"
: "${SWEEP_EVENTS:?}"
printf '%s start\n' "$SWEEP_ID" >> "$SWEEP_EVENTS"
if [ "${SWEEP_ID}" = A ]; then
  : "${SWEEP_RELEASE:?}"
  while [ ! -f "$SWEEP_RELEASE" ]; do sleep 0.05; done
fi
printf '%s end\n' "$SWEEP_ID" >> "$SWEEP_EVENTS"
EOF
chmod +x "$SUITES/fixture.selftest.sh"

RELEASE_A="$FIX/release-A"
SWEEP_RELEASE="$RELEASE_A" SWEEP_ID=A SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/A.out" 2> "$FIX/A.err" &
PID_A=$!
for _ in $(seq 1 100); do grep -q '^A start$' "$EVENTS" 2>/dev/null && break; sleep 0.05; done
SWEEP_RELEASE="$RELEASE_A" SWEEP_ID=B SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/B.out" 2> "$FIX/B.err" &
PID_B=$!
sleep 0.2
if grep -q 'waiting for host-wide lock' "$FIX/B.err" && ! grep -q '^B start$' "$EVENTS" 2>/dev/null; then
  pass "second fixture sweep reports the holder and waits before starting"
else
  fail "second fixture sweep did not wait (B.err=$(cat "$FIX/B.err" 2>/dev/null) events=$(cat "$EVENTS" 2>/dev/null))"
fi
: > "$RELEASE_A"
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
ORDER="$(tr '\n' '|' < "$EVENTS")"
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ] && [ "$ORDER" = 'A start|A end|B start|B end|' ]; then
  pass "host-wide lock serializes concurrent fixture sweeps in order"
else
  fail "fixture sweeps did not serialize (rcA=$RC_A rcB=$RC_B order=$ORDER A=$(cat "$FIX/A.out" 2>/dev/null) B=$(cat "$FIX/B.out" 2>/dev/null))"
fi

STALE="$FIX/stale.lock"
mkdir -p "$STALE"
printf '999999999\n' > "$STALE/pid"
SWEEP_ID=C SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$STALE" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/stale.out" 2> "$FIX/stale.err"
RC_STALE=$?
if [ "$RC_STALE" -eq 0 ] && grep -q 'removing stale lock' "$FIX/stale.err"; then
  pass "dead-pid stale lock is recovered before running"
else
  fail "stale lock was not recovered (rc=$RC_STALE err=$(cat "$FIX/stale.err" 2>/dev/null))"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "selftest-sweep.selftest: PASS (3 checks)"
else
  echo "selftest-sweep.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
