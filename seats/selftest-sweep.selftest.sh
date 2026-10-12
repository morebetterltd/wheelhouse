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
if [ -n "${SWEEP_RELEASE:-}" ]; then
  while [ ! -f "$SWEEP_RELEASE" ]; do sleep 0.05; done
fi
printf '%s end\n' "$SWEEP_ID" >> "$SWEEP_EVENTS"
EOF
chmod +x "$SUITES/fixture.selftest.sh"

RELEASE_A="$FIX/release-A"
SWEEP_RELEASE="$RELEASE_A" SWEEP_ID=A SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/A.out" 2> "$FIX/A.err" &
PID_A=$!
for _ in $(seq 1 100); do grep -q '^A start$' "$EVENTS" 2>/dev/null && break; sleep 0.05; done
if [ -f "$LOCK" ] && grep -q '^pid=' "$LOCK"; then
  pass "atomic acquire publishes a pid-bearing lock file before waiters can see it"
else
  fail "active lock was not a pid-bearing file (lock=$(ls -ld "$LOCK" 2>/dev/null || true) content=$(cat "$LOCK" 2>/dev/null || true))"
fi
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

RACE="$FIX/race.lock"
mkdir -p "$RACE"
printf '999999999\n' > "$RACE/pid"
RELEASE_RACE="$FIX/release-race"
SWEEP_RELEASE="$RELEASE_RACE" SWEEP_ID=D SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$RACE" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/race-D.out" 2> "$FIX/race-D.err" &
PID_D=$!
SWEEP_RELEASE="$RELEASE_RACE" SWEEP_ID=E SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$RACE" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/race-E.out" 2> "$FIX/race-E.err" &
PID_E=$!
for _ in $(seq 1 100); do grep -Eq '^[DE] start$' "$EVENTS" 2>/dev/null && break; sleep 0.05; done
sleep 0.2
REMOVE_COUNT="$(grep -h -c 'removing stale lock' "$FIX/race-D.err" "$FIX/race-E.err" 2>/dev/null | awk '{s += $1} END {print s + 0}')"
: > "$RELEASE_RACE"
wait "$PID_D"; RC_D=$?
wait "$PID_E"; RC_E=$?
if [ "$RC_D" -eq 0 ] && [ "$RC_E" -eq 0 ] && [ "$REMOVE_COUNT" -eq 1 ]; then
  pass "exactly one waiter wins stale-lock takeover"
else
  fail "stale-lock takeover was not single-winner (rcD=$RC_D rcE=$RC_E remove_count=$REMOVE_COUNT D.err=$(cat "$FIX/race-D.err" 2>/dev/null) E.err=$(cat "$FIX/race-E.err" 2>/dev/null))"
fi

ORPHANED_TAKEOVER="$FIX/orphaned-takeover.lock"
mkdir -p "$ORPHANED_TAKEOVER" "$ORPHANED_TAKEOVER.takeover"
printf '999999999\n' > "$ORPHANED_TAKEOVER/pid"
SWEEP_ID=F SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$ORPHANED_TAKEOVER" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/orphaned-takeover.out" 2> "$FIX/orphaned-takeover.err"
RC_ORPHANED=$?
if [ "$RC_ORPHANED" -eq 0 ] && grep -q 'removing stale lock' "$FIX/orphaned-takeover.err"; then
  pass "orphaned takeover guard cannot wedge stale-lock recovery"
else
  fail "orphaned takeover guard wedged recovery (rc=$RC_ORPHANED err=$(cat "$FIX/orphaned-takeover.err" 2>/dev/null))"
fi
rm -rf "$ORPHANED_TAKEOVER.takeover"

NO_PID="$FIX/no-pid.lock"
mkdir -p "$NO_PID"
SWEEP_ID=G SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$NO_PID" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/no-pid.out" 2> "$FIX/no-pid.err"
RC_NO_PID=$?
if [ "$RC_NO_PID" -eq 0 ] && grep -q 'held by missing pid' "$FIX/no-pid.err"; then
  pass "legacy pid-less stale lock is recovered before running"
else
  fail "pid-less stale lock was not recovered (rc=$RC_NO_PID err=$(cat "$FIX/no-pid.err" 2>/dev/null))"
fi

EPERM="$FIX/eperm.lock"
mkdir -p "$EPERM"
printf '1\n' > "$EPERM/pid"
SWEEP_ID=H SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$EPERM" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/eperm.out" 2> "$FIX/eperm.err" &
PID_G=$!
sleep 0.2
if [ -d "$EPERM" ] && grep -q 'waiting for host-wide lock' "$FIX/eperm.err" && ! grep -q 'removing stale lock' "$FIX/eperm.err"; then
  pass "EPERM holder pid is treated as live instead of stale"
else
  fail "EPERM holder pid was not treated as live (err=$(cat "$FIX/eperm.err" 2>/dev/null))"
fi
kill -TERM "$PID_G" 2>/dev/null || true
wait "$PID_G" 2>/dev/null || true
rm -rf "$EPERM"

TERM_SUITES="$FIX/term-suites"
TERM_LOCK="$FIX/term.lock"
TERM_EVENTS="$FIX/term-events.log"
TERM_STARTED="$FIX/term-started"
mkdir -p "$TERM_SUITES"
cat > "$TERM_SUITES/one.selftest.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'one start\n' >> "$TERM_EVENTS"
: > "$TERM_STARTED"
( trap 'exit 0' TERM; sleep 1; printf 'child survived\n' >> "$TERM_EVENTS" ) &
while :; do sleep 0.05; done
EOF
cat > "$TERM_SUITES/two.selftest.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'two start\n' >> "$TERM_EVENTS"
EOF
chmod +x "$TERM_SUITES"/*.selftest.sh
TERM_EVENTS="$TERM_EVENTS" TERM_STARTED="$TERM_STARTED" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$TERM_SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$TERM_LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/term.out" 2> "$FIX/term.err" &
PID_TERM=$!
for _ in $(seq 1 100); do [ -f "$TERM_STARTED" ] && break; sleep 0.05; done
kill -TERM "$PID_TERM" 2>/dev/null || true
wait "$PID_TERM"; RC_TERM=$?
sleep 1.2
TERM_ORDER="$(tr '\n' '|' < "$TERM_EVENTS" 2>/dev/null || true)"
if [ "$RC_TERM" -eq 143 ] && [ "$TERM_ORDER" = 'one start|' ] && [ ! -e "$TERM_LOCK" ]; then
  pass "TERM stops the running fixture suite process group, skips later suites, and releases the lock"
else
  fail "TERM did not stop cleanly (rc=$RC_TERM order=$TERM_ORDER lock=$(ls -ld "$TERM_LOCK" 2>/dev/null || true) out=$(cat "$FIX/term.out" 2>/dev/null) err=$(cat "$FIX/term.err" 2>/dev/null))"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "selftest-sweep.selftest: PASS (9 checks)"
else
  echo "selftest-sweep.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
