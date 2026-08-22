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
# MAIN_SESSIONS / SEATS_ROOT / PROJECT_CWD overrides. One phase deliberately
# leaves SEATS_ROOT unset so the script's own default expression runs; that
# phase points HOME at the fixture too, so the default resolves inside it.
#
# Phase 4 builds TWO fleets on one machine and runs the wiring both ways: with
# each fleet under its own seat root, and with both under the shared default an
# install predating the namespace uses. It asserts the scoped run ignores the
# sibling fleet AND that the shared one does not — a guard whose failure state
# is never exercised is a guard nobody has seen work.
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

# --- two fleets on one machine ----------------------------------------------
# Two projects, two roots or one, four processes. THIS project is alpha, with
# its own project directory; the sibling wheelhouse is beta, whose seat records
# a DIFFERENT cwd — which is the only thing on disk that separates the two
# fleets under a shared root, and therefore what the preflight reads.
#
# HOME is pointed at the fixture throughout, so the roots the script computes
# for itself — the derived $HOME/.claude-seats-<namespace> and the shared
# $HOME/.claude-seats fallback — are its real expressions and not stand-ins.
# The namespace is recorded the way an install records it, in a .template-source
# handed to the script through TEMPLATE_SOURCE.
build_two_fleet_fixture() {   # $1 = shared | namespaced
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
  PIDS=""
  [ -n "$FIX" ] && rm -rf "$FIX"
  FIX="$(mktemp -d)"
  HOME_FIX="$FIX/home"
  MAIN="$FIX/config/sessions"
  CWD="$FIX/project-alpha"      # this project
  CWD_B="$FIX/project-beta"     # the sibling wheelhouse
  SLUG="fixture-slug"
  TSRC="$FIX/template-source"
  mkdir -p "$MAIN" "$FIX/config/projects/$SLUG" "$CWD" "$CWD_B" "$HOME_FIX"

  if [ "$1" = shared ]; then
    A_DIR="$HOME_FIX/.claude-seats/alpha-worker-1"
    B_DIR="$HOME_FIX/.claude-seats/beta-worker-1"
    : > "$TSRC"                                   # no namespace= : the fallback runs
    EXPECT_ROOT="$HOME_FIX/.claude-seats"
  else
    A_DIR="$HOME_FIX/.claude-seats-alpha/alpha-worker-1"
    B_DIR="$HOME_FIX/.claude-seats-beta/beta-worker-1"
    printf 'source=fixture\ncommit=fixture\nnamespace=alpha\n' > "$TSRC"
    EXPECT_ROOT="$HOME_FIX/.claude-seats-alpha"
  fi

  spawn; CMD=$SPAWNED
  spawn; A=$SPAWNED
  spawn; B=$SPAWNED

  register "$MAIN" "$CMD" "fixture-cmd" "sid-cmd"
  : > "$FIX/config/projects/$SLUG/sid-cmd.jsonl"
  mkdir -p "$A_DIR/sessions" "$A_DIR/projects/$SLUG" "$B_DIR/sessions" "$B_DIR/projects/$SLUG"
  register "$A_DIR/sessions" "$A" "fixture-alpha" "sid-alpha"; : > "$A_DIR/projects/$SLUG/sid-alpha.jsonl"
  # register() writes $CWD into the row, and the sibling's row must carry the
  # OTHER project's cwd — that difference is the whole subject of 4c.
  CWD_SAVE="$CWD"; CWD="$CWD_B"
  register "$B_DIR/sessions" "$B" "fixture-beta" "sid-beta"
  CWD="$CWD_SAVE"
  : > "$B_DIR/projects/$SLUG/sid-beta.jsonl"

  # Assert the subjects exist before anything measures their absence: an
  # un-wired sibling fleet and a sibling fleet that was never built look
  # identical from the other end of this test. The cwd is asserted too — it is
  # the discriminator under test, and a fixture where both fleets accidentally
  # share one would pass the refusal checks by never posing the question.
  [ -s "$B_DIR/sessions/$B.json" ] || fail "two-fleet fixture: the sibling fleet's registration was never written"
  [ -s "$A_DIR/sessions/$A.json" ] || fail "two-fleet fixture: this fleet's registration was never written"
  grep -q "\"cwd\":\"$CWD_B\"" "$B_DIR/sessions/$B.json" \
    || fail "two-fleet fixture: the sibling's registration does not record a foreign cwd"
}

run_fleet() {   # $1 = script to run; rest = its arguments
  local s="$1"; shift
  OUT="$(env -u SEATS_ROOT HOME="$HOME_FIX" MAIN_SESSIONS="$MAIN" \
             PROJECT_CWD="$CWD" TEMPLATE_SOURCE="$TSRC" "$s" "$@" 2>&1)"; RC=$?
}

phase "4. two fleets on one machine"

# 4a. THE FAILURE STATE, exercised rather than described, and exercised BOTH
# WAYS. The reverse leg is the worse half and the one that gets left out of the
# description: it does not merely let the newcomer see the incumbent's seats, it
# writes the newcomer's COMMANDER into a running fleet's registries. Run against
# a copy of the script with the preflight cut out, which is what every install
# before this check had. (Credit: bidirectional reproduction is Releaf's
# seat-worker-2, 2026-08-22.)
build_two_fleet_fixture shared
NOTEETH="$FIX/wire-seats-no-preflight.sh"
sed 's|^foreign_cwd_preflight$|:|' "$SCRIPT" > "$NOTEETH"
chmod +x "$NOTEETH"
if cmp -s "$SCRIPT" "$NOTEETH"; then
  fail "4a: could not remove the preflight — its call no longer matches the pattern this test cuts, so 4a and 4c below prove nothing"
else
  run_fleet "$NOTEETH"
  if [ $RC -eq 0 ]; then pass "no preflight, shared root: run exits 0"
  else fail "no preflight, shared root: run exited $RC"; fi

  if [ -e "$MAIN/$B.json" ]; then
    pass "no preflight: FORWARD leg crossed — the sibling's seat reached this commander's registry"
  else fail "no preflight: the forward leg did not cross, so this test proves nothing"; fi

  if [ -e "$B_DIR/sessions/$CMD.json" ]; then
    pass "no preflight: REVERSE leg crossed — this commander was written into the sibling's running fleet"
  else fail "no preflight: the reverse leg did not cross, so this test proves nothing"; fi

  if says "no namespace= is recorded"; then pass "no preflight: the run warns that its root is the shared fallback"
  else fail "no preflight: no warning that every seat on the machine was in scope"; fi
fi

# 4b. THE FIRST TOOTH — a root derived from the recorded namespace. Nothing is
# passed to the script: it reads namespace=alpha and computes the root itself.
build_two_fleet_fixture namespaced
run_fleet "$SCRIPT"
if [ $RC -eq 0 ]; then pass "namespaced: run exits 0"
else fail "namespaced: run exited $RC"; fi

if says "seat root: $EXPECT_ROOT" && says "namespace=alpha"; then
  pass "namespaced: the root was DERIVED from the recorded namespace, not passed in"
else fail "namespaced: the run did not derive its root from namespace="; fi

if [ -e "$MAIN/$A.json" ] && [ -e "$A_DIR/sessions/$CMD.json" ]; then
  pass "namespaced: this fleet's seat is wired, both legs"
else fail "namespaced: this fleet's seat was not wired"; fi

if [ ! -e "$MAIN/$B.json" ]; then pass "namespaced: forward leg did not cross to the sibling"
else fail "namespaced: the sibling's seat reached this commander's registry"; fi

if [ ! -e "$B_DIR/sessions/$CMD.json" ]; then pass "namespaced: reverse leg did not cross to the sibling"
else fail "namespaced: this commander was written into the sibling's fleet"; fi

if says "beta-worker-1"; then fail "namespaced: the sibling fleet's seat was even considered"
else pass "namespaced: the sibling fleet's seat is never enumerated"; fi

# 4c. THE SECOND TOOTH — the refusal, on the machine the first tooth cannot
# help: one shared root, both fleets inside it, which is every install that has
# not migrated. Same fixture as 4a, real script.
build_two_fleet_fixture shared
INV_BEFORE="$(find "$MAIN" "$HOME_FIX" -name '*.json' | sort | tr '\n' ' ')"
run_fleet "$SCRIPT"
if [ $RC -ne 0 ]; then pass "shared root: the run REFUSES rather than wiring a foreign seat"
else fail "shared root: the run exited 0 and wired across fleets"; fi

if says "belongs to a different project" && says "beta-worker-1" && says "$CWD_B"; then
  pass "shared root: the refusal names the seat and the project it actually serves"
else fail "shared root: the refusal did not say which seat or whose"; fi

if [ "$(find "$MAIN" "$HOME_FIX" -name '*.json' | sort | tr '\n' ' ')" = "$INV_BEFORE" ] \
   && [ ! -e "$B_DIR/sessions/$CMD.json" ] && [ ! -e "$MAIN/$B.json" ]; then
  pass "shared root: nothing was written — the refusal is not a partial wiring"
else fail "shared root: the refusal still wrote something"; fi

phase "5. canary — can these checks detect a broken script?"
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
echo "If the failures are in phases 1-4, either the script is broken or the harness"
echo "moved its session registry / transcript layout — check the layout before"
echo "rewriting the script. If the failure is the canary, fix this test first."
exit 1
