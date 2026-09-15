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

NS="releaf"
PROJECT="$FIX/project"
mkdir -p "$PROJECT/wheelhouse"
printf 'namespace=%s\n' "$NS" > "$PROJECT/wheelhouse/.template-source"
GOOD="$FIX/good.md"
cat > "$GOOD" <<'MD'
Ship the README install proof. Evidence needs the cold-install transcript and the reviewer rerun. Dispatch the task to worker one and keep the branch moving until review.
MD
OUT="$(cd "$PROJECT" && "$LINT" "$GOOD" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "commander-voice-lint: PASS (1 file(s), namespace=$NS)"; then pass "human task prose passes with fixture namespace"
else fail "human task prose failed (rc=$RC): $OUT"; fi

GOOD_HYPHENS="$FIX/good-hyphens.md"
cat > "$GOOD_HYPHENS" <<'MD'
The fleet-gate hook is read-only and runs a two-step check before morning startup chores (done). Try the setup again (again) on the main branch (main branch).
MD
OUT="$(cd "$PROJECT" && "$LINT" "$GOOD_HYPHENS" 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "ordinary hyphenated English and parenthesized words pass"
else fail "ordinary hyphenated English or parenthesized words were flagged (rc=$RC): $OUT"; fi

BAD_BEAD="$FIX/bad-bead.md"
cat > "$BAD_BEAD" <<'MD'
Dispatch the bead to worker one and ask for evidence.
MD
OUT="$(cd "$PROJECT" && "$LINT" "$BAD_BEAD" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses bead/beads'; then pass "planted negative: bead wording fails"
else fail "bead wording was not caught (rc=$RC): $OUT"; fi

BAD_ID="$FIX/bad-id.md"
cat > "$BAD_ID" <<'MD'
Send releaf-d6xo to reviewer two after the selftest passes.
MD
OUT="$(cd "$PROJECT" && "$LINT" "$BAD_ID" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses a bare work id'; then pass "planted negative: bare namespace id fails"
else fail "bare id was not caught (rc=$RC): $OUT"; fi

BAD_3CHAR="$FIX/bad-3char.md"
cat > "$BAD_3CHAR" <<'MD'
Shipped releaf-0pf to main.
MD
OUT="$(cd "$PROJECT" && "$LINT" "$BAD_3CHAR" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses a bare work id'; then pass "planted negative: 3-character issue id fails"
else fail "3-character issue id was not caught (rc=$RC): $OUT"; fi

BAD_CHILD="$FIX/bad-child.md"
cat > "$BAD_CHILD" <<'MD'
Continue releaf-er5m.2 after the merge.
MD
OUT="$(cd "$PROJECT" && "$LINT" "$BAD_CHILD" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses a bare work id'; then pass "planted negative: child issue id fails"
else fail "child issue id was not caught (rc=$RC): $OUT"; fi

BAD_BEFORE3="$FIX/bad-before3.md"
cat > "$BAD_BEFORE3" <<'MD'
Same morning the commander synced this umbrella's seats/ + runbooks/ to 20a1c92 (q4v) BEFORE spawning a seat, caught by the principal.
MD
OUT="$(cd "$PROJECT" && "$LINT" "$BAD_BEFORE3" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'uses a bare work id'; then pass "planted negative: before-example #3 bare shorthand id fails"
else fail "before-example #3 id was not caught (rc=$RC): $OUT"; fi

FRESH="$FIX/fresh-seats"
mkdir -p "$FRESH"
cp "$LINT" "$FRESH/commander-voice-lint.sh"
chmod +x "$FRESH/commander-voice-lint.sh"
OUT="$(cd "$PROJECT" && "$FRESH/commander-voice-lint.sh" "$GOOD" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "namespace=$NS"; then pass "fresh seats copy outside this umbrella uses fixture namespace"
else fail "fresh seats copy did not run from fixture namespace (rc=$RC): $OUT"; fi

ACME_GOOD="$FIX/acme-good.md"
printf 'Ship the README install proof without naming internal ids.\n' > "$ACME_GOOD"
OUT="$($LINT --namespace acme "$ACME_GOOD" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'namespace=acme'; then pass "--namespace option makes namespace explicit outside any install"
else fail "--namespace explicit namespace check failed (rc=$RC): $OUT"; fi

if [ $FAIL -eq 0 ]; then
  echo "commander-voice-lint.selftest: PASS ($PASS checks, namespace=$NS)"
  exit 0
fi

echo "commander-voice-lint.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
