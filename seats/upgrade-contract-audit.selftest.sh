#!/usr/bin/env bash
# Run exactly the top-level step-7 bash blocks the upgrade bench extracts.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/.." && pwd -P)
. "$HERE/selftest-lib.sh"
DOC=${1:-$ROOT/runbooks/UPGRADE.md}
CASE=${WHEELHOUSE_UPGRADE_CONTRACT_CASE:-all}
case "$CASE" in all|bash-legacy|zsh-legacy|bash-valid|zsh-valid|bash-unreadable|zsh-unreadable) ;; *) echo "unknown test case: $CASE" >&2; exit 2;; esac
selected(){ [ "$CASE" = all ] || [ "$CASE" = "$1" ]; }
FIX=$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-upgrade-contract.XXXXXX") || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
fail(){ echo "FAIL $*"; exit 1; }
pass(){ echo "PASS $*"; }
command -v zsh >/dev/null || fail 'zsh required'
[ -s "$DOC" ] || fail "missing runbook: $DOC"
# Keep this extraction identical to wheelhouse/crew/bench.sh's extract_step.
awk -v n=7 '
  $0 ~ ("^## " n "\\.") { insec = 1; next }
  insec && /^## / { exit }
  insec && /^```bash$/ { infence = 1; next }
  insec && infence && /^```$/ { infence = 0; next }
  insec && infence { print }
' "$DOC" > "$FIX/step7.sh"
[ -s "$FIX/step7.sh" ] || fail 'empty extracted step 7'
grep -q 'contract.ts audit' "$FIX/step7.sh" || fail 'missing audit'
grep -q 'bd list' "$FIX/step7.sh" || fail 'missing later sweep'
eval "$(selftest_scratch_graph "$FIX/install")"
cd "$FIX/install"
mkdir -p seats
# Step 3 ships all runtime modules, not contract.ts alone: intake also needs
# credential-shapes, lock and seat-activity. Keep this install-shaped fixture
# aligned with that copy without importing source-worktree runtime state.
cp -f "$HERE"/*.ts seats/
bd create 'Open old-dialect fixture' --description 'Implement crew/bench.sh against contracts/BENCH.md' --json > "$FIX/open.json"
bd create 'Claimed old-dialect fixture' --description 'Implement crew/bench.sh against contracts/BENCH.md' --json > "$FIX/claimed.json"
OPEN=$(node -e 'console.log(require(process.argv[1]).id)' "$FIX/open.json")
CLAIMED=$(node -e 'console.log(require(process.argv[1]).id)' "$FIX/claimed.json")
[ -n "$OPEN" ] && [ -n "$CLAIMED" ] || fail 'fixture beads absent'
bd update "$CLAIMED" --status in_progress >/dev/null
export TEMPLATE="$ROOT" BASE=ad61b15 TARGET=HEAD
# Contract diff is real; the same backticked-path sweep ran in the bench.
git -C "$TEMPLATE" cat-file -e "$BASE^{commit}" || fail 'baseline absent'
run_step7(){
  RC=0
  env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE \
    "$SHELL_BIN" -c 'set -eu; . "$1"; echo STEP7_COMPLETED' \
    "$SHELL_BIN" "$FIX/step7.sh" > "$FIX/$LEG.out" 2> "$FIX/$LEG.err" || RC=$?
}
for SHELL_BIN in bash zsh; do
  LEG="$SHELL_BIN-legacy"
  selected "$LEG" || continue
  run_step7
  [ "$RC" = 0 ] || fail "$LEG exited $RC: $(<"$FIX/$LEG.err")"
  grep -q 'Contract audit found legacy beads: repair' "$FIX/$LEG.out" || fail "$LEG no repair instruction"
  grep -q '^STEP7_COMPLETED$' "$FIX/$LEG.out" || fail "$LEG stopped before completion"
  grep -Fq "$OPEN" "$FIX/$LEG.out" || fail "$LEG sweep missed open bead"
  grep -Fq "$CLAIMED" "$FIX/$LEG.out" || fail "$LEG sweep missed claimed bead"
  grep -Fq "$OPEN: contract: Intent: missing" "$FIX/$LEG.err" || fail "$LEG audit hid open defect"
  grep -Fq "$CLAIMED: contract: Intent: missing" "$FIX/$LEG.err" || fail "$LEG audit hid claimed defect"
  pass "$LEG audit exit 1 reports both defects and continues the sweep (exit 0)"
done
# All-valid control: audit still remains quiet and reaches the same sweep.
for id in "$OPEN" "$CLAIMED"; do
  bd update "$id" --description "$(<"$HERE/fixtures/contracts/valid.md")" >/dev/null
done
for SHELL_BIN in bash zsh; do
  LEG="$SHELL_BIN-valid"
  selected "$LEG" || continue
  run_step7
  [ "$RC" = 0 ] && grep -q '^STEP7_COMPLETED$' "$FIX/$LEG.out" || fail "$LEG did not complete"
  [ ! -s "$FIX/$LEG.err" ] || fail "$LEG unexpected audit error: $(<"$FIX/$LEG.err")"
  if grep -q 'Contract audit found' "$FIX/$LEG.out"; then fail "$LEG false legacy warning"; fi
  pass "$LEG clean audit completes without warning (exit 0)"
done
# Error != finding: graph failure must stop before the later list commands.
mkdir -p "$FIX/unreadable"
printf '#!/bin/sh\necho fixture-graph-unavailable >&2\nexit 7\n' > "$FIX/unreadable/bd"
chmod +x "$FIX/unreadable/bd"
export PATH="$FIX/unreadable:$PATH"
for SHELL_BIN in bash zsh; do
  LEG="$SHELL_BIN-unreadable"
  selected "$LEG" || continue
  run_step7
  [ "$RC" = 3 ] || fail "$LEG expected 3, got $RC"
  grep -q 'fixture-graph-unavailable' "$FIX/$LEG.err" || fail "$LEG lost graph error"
  grep -q 'STOP: contract audit could not read the graph (exit 3)' "$FIX/$LEG.err" || fail "$LEG no explicit STOP"
  if grep -q 'STEP7_COMPLETED\|continuing the upgrade sweep' "$FIX/$LEG.out"; then fail "$LEG swallowed graph failure"; fi
  pass "$LEG unreadable graph STOPs before the sweep (exit 3)"
done
echo "upgrade-contract-audit.selftest: PASS (case=$CASE)"
