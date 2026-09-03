#!/usr/bin/env bash
# push-authority-lint.selftest.sh — hermetic checks for reviewer PUSH authority lint.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
LINT="$SCRIPT_DIR/push-authority-lint.sh"
[ -x "$LINT" ] || { echo "selftest: not executable: $LINT" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-push-authority-lint-selftest.XXXXXX")"
trap 'rm -rf "$FIX"' EXIT INT TERM
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
OUT="$($LINT "$GOOD" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'push-authority-lint: PASS (grant=1, verdicts=1)'; then pass "grant plus authority-citing PUSH line passes"
else fail "good verdict failed (rc=$RC): $OUT"; fi

BAD="$FIX/bad"; mkproj "$BAD" grant
cat > "$BAD/seats/verdicts/bad.md" <<'MD'
VERDICT: APPROVE
PUSH:    HOLD — pushing is principal-only on this project.
MD
OUT="$($LINT "$BAD" 2>&1)"; RC=$?
if [ $RC -eq 1 ] && echo "$OUT" | grep -q 'FAIL push-authority: .*contradicts INTEGRATOR.md project push grant'; then pass "planted negative: principal-only PUSH line fails when project grants push"
else fail "planted principal-only verdict was not caught (rc=$RC): $OUT"; fi

NOGRANT="$FIX/nogrant"; mkproj "$NOGRANT" nogrant
cat > "$NOGRANT/seats/verdicts/hold.md" <<'MD'
VERDICT: APPROVE
PUSH:    HOLD — pushing is principal-only on this project.
MD
OUT="$($LINT "$NOGRANT" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'push-authority-lint: PASS (grant=0, verdicts=1)'; then pass "principal-only PUSH line is not flagged when no project grant is recorded"
else fail "no-grant verdict should not fail this lint (rc=$RC): $OUT"; fi

if [ $FAIL -eq 0 ]; then
  echo "push-authority-lint.selftest: PASS ($PASS checks)"
  exit 0
fi

echo "push-authority-lint.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
