#!/usr/bin/env bash
#
# wire-seats.selftest.sh — does wire-seats.sh still do what its runbook claims,
# on THIS machine?
#
# Seat discovery is a workaround over harness internals, not an interface. When
# it stops working the first question is which half moved: the script, or the
# substrate underneath it. This answers that. It builds a throwaway fleet in a
# temp directory — real directories, real live processes, real transcripts —
# runs wire-seats.sh against it, and checks the outcomes. Your actual registries
# are never touched: every run is pointed at the fixture through the script's
# MAIN_SESSIONS / SEATS_ROOT / PROJECT_CWD overrides.
#
# The last phase is a canary. It sabotages a COPY of the script and checks that
# these tests notice. A suite that passes everything, including a script with
# its reverse leg cut out, is decoration — so if the canary survives, this exits
# non-zero even when every real check passed.
#
# Usage: wire-seats.selftest.sh [path-to-wire-seats.sh]
#
# Exit 0 = the script works here. Non-zero = read the FAIL lines: a failure in
# the checks means the script is broken or the harness layout moved; a failure
# in the canary means these checks cannot be trusted to tell you either way.

set -uo pipefail   # deliberately not -e: half these cases are meant to fail

SCRIPT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wire-seats.sh}"
[ -x "$SCRIPT" ] || { echo "selftest: not executable: $SCRIPT" >&2; exit 2; }

FAILED=0
PIDS=""
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- fixture ---------------------------------------------------------------
# A registration is <pid>.json plus a key file; a session's OWNER is the config
# dir holding its transcript, so the fixture writes both.
spawn() { sleep 900 >/dev/null 2>&1 & PIDS="$PIDS $!"; SPAWNED=$!; }

register() { # sessions-dir pid name session-id
  printf '{"pid":%s,"sessionId":"%s","cwd":"%s","name":"%s","nameSource":"derived","status":"idle"}\n' \
    "$2" "$4" "$CWD" "$3" > "$1/$2.json"
  printf 'fixture-key-%s\n' "$2" > "$1/$2.abcdef.key"
}

build_fixture() {
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
  PIDS=""
  [ -n "$FIX" ] && rm -rf "$FIX"
  FIX="$(mktemp -d)"
  MAIN="$FIX/config/sessions"
  SEATS="$FIX/seats"
  CWD="$FIX/project"
  SLUG="fixture-slug"
  mkdir -p "$MAIN" "$FIX/config/projects/$SLUG" "$CWD"

  spawn; CMD=$SPAWNED
  spawn; A=$SPAWNED
  spawn; B=$SPAWNED
  sleep 0.1 & DEAD=$!; wait $DEAD 2>/dev/null

  register "$MAIN" "$CMD" "fixture-cmd" "sid-cmd"
  : > "$FIX/config/projects/$SLUG/sid-cmd.jsonl"

  for s in seat-a seat-b seat-e; do mkdir -p "$SEATS/$s/sessions" "$SEATS/$s/projects/$SLUG"; done
  mkdir -p "$SEATS/seat-never-ran"
  register "$SEATS/seat-a/sessions" "$A" "fixture-a" "sid-a"; : > "$SEATS/seat-a/projects/$SLUG/sid-a.jsonl"
  register "$SEATS/seat-b/sessions" "$B" "fixture-b" "sid-b"; : > "$SEATS/seat-b/projects/$SLUG/sid-b.jsonl"
  register "$SEATS/seat-e/sessions" "$DEAD" "fixture-dead" "sid-dead"; : > "$SEATS/seat-e/projects/$SLUG/sid-dead.jsonl"

  export MAIN_SESSIONS="$MAIN" SEATS_ROOT="$SEATS" PROJECT_CWD="$CWD"
}

run() { OUT="$("$RUN_SCRIPT" "$@" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
inventory() { find "$MAIN" "$SEATS" -name '*.json' | sort | tr '\n' ' '; }

# --- the checks ------------------------------------------------------------
# Run against $RUN_SCRIPT so the canary phase can point them at a sabotage.
check_wiring() {
  local label="$1"

  local before after
  before="$(inventory)"
  run --dry-run
  after="$(inventory)"
  if [ $RC -eq 0 ] && [ "$before" = "$after" ] && [ -n "$before" ]; then pass "$label: --dry-run plans without writing"
  else fail "$label: --dry-run wrote something or exited $RC"; fi

  run
  if [ $RC -ne 0 ]; then fail "$label: wiring run exited $RC"; else pass "$label: wiring run exits 0"; fi

  if [ -e "$MAIN/$A.json" ]; then pass "$label: forward leg — seat row reached the commander registry"
  else fail "$label: forward leg — $MAIN/$A.json missing"; fi

  if [ -e "$SEATS/seat-a/sessions/$CMD.json" ]; then pass "$label: reverse leg — commander row reached the seat registry"
  else fail "$label: reverse leg — commander row missing from seat-a"; fi

  if says "is dead — not forwarded"; then pass "$label: dead registration is not forwarded"
  else fail "$label: dead registration was not reported"; fi

  if says "no sessions dir"; then pass "$label: a seat that never ran is skipped by name"
  else fail "$label: seat-never-ran was not skipped"; fi
}

phase "1. wiring, against a fixture fleet"
build_fixture
RUN_SCRIPT="$SCRIPT"
check_wiring "wiring"

phase "2. idempotence and the stale-copy guard"
run
if [ $RC -eq 0 ] && says "already current" && ! says "+ forward"; then pass "rerun copies nothing"
else fail "rerun was not idempotent (exit $RC)"; fi

CMD_BEFORE="$(cat "$MAIN/$CMD.json")"
run
if [ "$(cat "$MAIN/$CMD.json")" = "$CMD_BEFORE" ] && says "belongs to"; then
  pass "a row the seat does not own is not forwarded back over the live one"
else fail "the commander's own row was forwarded back out of a seat registry"; fi

phase "3. refusing to guess"
run --commander-pid "$A"
if [ $RC -ne 0 ] && says "is a seat"; then pass "--commander-pid pointing at a seat is refused"
else fail "--commander-pid accepted a seat (exit $RC)"; fi

run --commander-pid
if [ $RC -eq 2 ] && says "needs a PID"; then pass "--commander-pid with no value is a usage error"
else fail "--commander-pid with no value exited $RC without saying why"; fi

run seat-never-ran
if [ $RC -ne 0 ] && says "nothing was wired"; then pass "a run that wires nothing exits non-zero"
else fail "a run that wired nothing exited $RC"; fi

spawn; OTHER=$SPAWNED
register "$MAIN" "$OTHER" "fixture-other" "sid-other"
: > "$FIX/config/projects/$SLUG/sid-other.jsonl"
run
if [ $RC -ne 0 ] && says "several live non-seat sessions"; then pass "two possible commanders — refuses, does not guess"
else fail "picked a commander with two candidates (exit $RC)"; fi

phase "4. canary — can these checks detect a broken script?"
build_fixture
SABOTAGED="$FIX/wire-seats-sabotaged.sh"
sed 's|copy "$part" "$seat_sessions/$(basename "$part")" "reverse"|:|' "$SCRIPT" > "$SABOTAGED"
chmod +x "$SABOTAGED"
if cmp -s "$SCRIPT" "$SABOTAGED"; then
  fail "canary: could not sabotage the script — the reverse leg no longer matches the pattern this test cuts"
else
  CANARY_FAILED_BEFORE=$FAILED
  RUN_SCRIPT="$SABOTAGED"
  check_wiring "canary" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: a script with its reverse leg removed is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a script with its reverse leg removed PASSED — these checks prove nothing"
  fi
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "wire-seats.sh works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-3, either the script is broken or the harness"
echo "moved its session registry / transcript layout — check the layout before"
echo "rewriting the script. If the failure is the canary, fix this test first."
exit 1
