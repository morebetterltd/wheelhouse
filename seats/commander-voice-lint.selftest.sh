#!/usr/bin/env bash
# commander-voice-lint.selftest.sh — hermetic checks for commander voice lint.

set -u

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
LINT="$SCRIPT_DIR/commander-voice-lint.sh"
[ -x "$LINT" ] || { echo "selftest: not executable: $LINT" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-commander-voice-lint-selftest.XXXXXX")"
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM
PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail() { FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }

GOOD="$FIX/good.md"
cat > "$GOOD" <<'MD'
Ship the README install proof. Evidence needs the cold-install transcript and the reviewer rerun. Dispatch the task to worker one and keep the branch moving until review.
MD
OUT="$($LINT "$GOOD" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'commander-voice-lint: PASS (1 file(s))'; then pass "human task prose passes"
else fail "human task prose failed (rc=$RC): $OUT"; fi

BAD_BEAD="$FIX/bad-bead.md"
cat > "$BAD_BEAD" <<'MD'
Dispatch the bead to worker one and ask for evidence.
MD
OUT="$($LINT "$BAD_BEAD" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses bead/beads'; then pass "planted negative: bead wording fails"
else fail "bead wording was not caught (rc=$RC): $OUT"; fi

BAD_ID="$FIX/bad-id.md"
cat > "$BAD_ID" <<'MD'
Send wheelhouse-project-d6xo to reviewer two after the selftest passes.
MD
OUT="$($LINT "$BAD_ID" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses a bare work id'; then pass "planted negative: bare namespace id fails"
else fail "bare id was not caught (rc=$RC): $OUT"; fi

if [ $FAIL -eq 0 ]; then
  echo "commander-voice-lint.selftest: PASS ($PASS checks)"
  exit 0
fi

echo "commander-voice-lint.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
