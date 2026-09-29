#!/usr/bin/env bash
# push-authority-lint.selftest.sh — hermetic checks for reviewer PUSH authority lint.

set -u

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
LINT="$SCRIPT_DIR/push-authority-lint.sh"
[ -x "$LINT" ] || { echo "selftest: not executable: $LINT" >&2; exit 2; }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-push-authority-lint-selftest.XXXXXX")" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail() { FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }

mkproj() {
  local dir="$1" grant="$2"
  mkdir -p "$dir/wheelhouse" "$dir/seats/verdicts"
  if [ "$grant" = grant ]; then
    cat > "$dir/wheelhouse/INTEGRATOR.md" <<'MD'
# The Integrator

## Contract

### Push, PR, deploy, and reserved-action authority, written down

## This project

### Who integrates

The commander merges reviewed branches and pushes main.
MD
  else
    cat > "$dir/wheelhouse/INTEGRATOR.md" <<'MD'
# The Integrator

## Contract

### Push, PR, deploy, and reserved-action authority, written down

## This project

### Who integrates

<!-- Not filled yet. -->
MD
  fi
}

GOOD="$FIX/good"; mkproj "$GOOD" grant
cat > "$GOOD/seats/verdicts/good.md" <<'MD'
VERDICT: APPROVE
PUSH:    OK — INTEGRATOR.md records standing authority to push main after merge.
MD
RC=0; OUT="$($LINT "$GOOD" 2>&1)" || RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'push-authority-lint: PASS (grant=1, verdicts=1)'; then pass "grant plus authority-citing PUSH line passes"
else fail "good verdict failed (rc=$RC): $OUT"; fi

NEWFORMAT="$FIX/newformat"; mkproj "$NEWFORMAT" grant
cat > "$NEWFORMAT/seats/verdicts/newformat.md" <<'MD'
# Verdict — bead example

- bead: example
- branch: fleet/example
- tip: 0123456789abcdef0123456789abcdef01234567
- verdict: APPROVE
- push: APPROVE origin — verified: clean integration gate at reviewed tip

## Verifier output

Evidence goes here.
VERDICT: APPROVE
PUSH: APPROVE origin — verified: clean integration gate at reviewed tip
MD
RC=0; OUT="$($LINT "$NEWFORMAT" 2>&1)" || RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'push-authority-lint: PASS (grant=1, verdicts=1)'; then pass "new-format verify.ts verdict header passes despite raw verifier output"
else fail "new-format verdict failed (rc=$RC): $OUT"; fi

BAD="$FIX/bad"; mkproj "$BAD" grant
cat > "$BAD/seats/verdicts/bad.md" <<'MD'
VERDICT: APPROVE
PUSH:    HOLD — pushing is principal-only on this project.
MD
RC=0; OUT="$($LINT "$BAD" 2>&1)" || RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'FAIL push-authority: .*contradicts INTEGRATOR.md project push grant'; then pass "planted negative: legacy principal-only PUSH line fails when project grants push"
else fail "planted legacy principal-only verdict was not caught (rc=$RC): $OUT"; fi

BADHEADER="$FIX/badheader"; mkproj "$BADHEADER" grant
cat > "$BADHEADER/seats/verdicts/badheader.md" <<'MD'
# Verdict — bead example

- verdict: APPROVE
- push: HOLD — pushing is principal-only on this project.

## Verifier output

PUSH: HOLD — pushing is principal-only on this project.
MD
RC=0; OUT="$($LINT "$BADHEADER" 2>&1)" || RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'FAIL push-authority: .*contradicts INTEGRATOR.md project push grant'; then pass "planted negative: new-format principal-only push header fails when project grants push"
else fail "planted new-format principal-only verdict was not caught (rc=$RC): $OUT"; fi

MISSING="$FIX/missing"; mkproj "$MISSING" grant
cat > "$MISSING/seats/verdicts/missing.md" <<'MD'
VERDICT: APPROVE
MD
RC=0; OUT="$($LINT "$MISSING" 2>&1)" || RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'require.*exactly one'; then pass "missing PUSH line fails lint"
else fail "missing PUSH line was not caught (rc=$RC): $OUT"; fi

DUPHEADER="$FIX/dupheader"; mkproj "$DUPHEADER" grant
cat > "$DUPHEADER/seats/verdicts/dupheader.md" <<'MD'
# Verdict — bead example

- verdict: APPROVE
- push: APPROVE origin — verified: first line
- push: APPROVE origin — verified: second line

## Verifier output

PUSH: APPROVE origin — verified: raw output is ignored when a header is present
MD
RC=0; OUT="$($LINT "$DUPHEADER" 2>&1)" || RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'has 2 push verdict lines'; then pass "duplicate new-format push headers fail lint"
else fail "duplicate new-format push headers were not caught (rc=$RC): $OUT"; fi

NOGRANT="$FIX/nogrant"; mkproj "$NOGRANT" nogrant
cat > "$NOGRANT/seats/verdicts/hold.md" <<'MD'
VERDICT: APPROVE
PUSH:    HOLD — pushing is principal-only on this project.
MD
RC=0; OUT="$($LINT "$NOGRANT" 2>&1)" || RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'push-authority-lint: PASS (grant=0, verdicts=1)'; then pass "principal-only PUSH line is not flagged when no project grant is recorded"
else fail "no-grant verdict should not fail this lint (rc=$RC): $OUT"; fi

if [ $FAIL -eq 0 ]; then
  echo "push-authority-lint.selftest: PASS ($PASS checks)"
  exit 0
fi

echo "push-authority-lint.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
