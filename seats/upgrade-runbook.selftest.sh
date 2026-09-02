#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
BASELINE=${WHEELHOUSE_UPGRADE_SELFTEST_BASELINE:-d8128d4}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-upgrade-selftest.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
fail() { echo "not ok $((PASS+1)) - $*"; exit 1; }
pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }

command -v zsh >/dev/null 2>&1 || fail "zsh is required for this selftest"

PROJ="$TMP/project"
mkdir -p "$PROJ/wheelhouse/fleet" "$PROJ/wheelhouse/runbooks"
git -C "$ROOT" show "${BASELINE}:contracts/WORKER.md" > "$PROJ/wheelhouse/fleet/WORKER.md"
for b in PROMOTION.md RUNNING_THE_LOOP.md UPGRADE.md; do
  git -C "$ROOT" show "${BASELINE}:runbooks/$b" > "$PROJ/wheelhouse/runbooks/$b"
done

STEP0_OUT=$(zsh -c '
set -e
TEMPLATE=$1
PROJECT=$2
for c in $(git -C "$TEMPLATE" rev-list HEAD -- contracts/); do
  if diff -rq <(git -C "$TEMPLATE" show ${c}:contracts/WORKER.md) "$PROJECT/wheelhouse/fleet/WORKER.md" >/dev/null 2>&1; then
    echo "candidate baseline: $c"
    break
  fi
done
' zsh "$ROOT" "$PROJ")
case "$STEP0_OUT" in
  "candidate baseline: "*) pass "zsh step 0 baseline reconstruction reads commit:path with braces" ;;
  *) fail "zsh step 0 did not find a healthy baseline: $STEP0_OUT" ;;
esac

STEP3_OUT=$(zsh -c '
set -e
TEMPLATE=$1
PROJECT=$2
BASE=$3
TARGET=HEAD
cd "$PROJECT"
mkdir -p wheelhouse/runbooks
for f in "$TEMPLATE"/runbooks/*; do
  b=$(basename "$f")
  if [ ! -e "wheelhouse/runbooks/$b" ]; then
    cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook ARRIVED: $b"
    continue
  fi

  baseline=$(mktemp)
  if git -C "$TEMPLATE" show "${BASE:-unknown}:runbooks/$b" >"$baseline" 2>/dev/null; then
    if diff -q "$baseline" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
      cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook updated: $b"
    elif diff -q "$f" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
      echo "runbook current: $b"
    else
      echo "runbook YOURS, merge by hand: $b"
    fi
  else
    echo "runbook baseline unreadable — re-run before hand-merging: $b"
  fi
  rm -f "$baseline"
done
' zsh "$ROOT" "$PROJ" "$BASELINE")
printf '%s\n' "$STEP3_OUT" | grep -q 'baseline unreadable' && fail "zsh step 3 reported baseline unreadable on a healthy baseline: $STEP3_OUT"
for b in PROMOTION.md RUNNING_THE_LOOP.md UPGRADE.md; do
  printf '%s\n' "$STEP3_OUT" | grep -Eq "runbook updated: $b" || fail "zsh step 3 did not update ${b}: $STEP3_OUT"
done
pass "zsh step 3 runbook loop reads real baseline for every runbook"

GITPROJ="$TMP/gitproj"
mkdir -p "$GITPROJ/wheelhouse/evidence-dir" "$GITPROJ/seats"
git -C "$GITPROJ" init -b main >/dev/null
printf 'x\n' > "$GITPROJ/CLAUDE.md"
printf 'x\n' > "$GITPROJ/.gitignore"
printf 'x\n' > "$GITPROJ/seats/README.md"
printf 'untracked\n' > "$GITPROJ/wheelhouse/evidence-dir/proof.txt"
(
  cd "$GITPROJ"
  git add wheelhouse/ seats/ .gitignore CLAUDE.md
)
if git -C "$GITPROJ" diff --cached --name-only | grep -qx 'wheelhouse/evidence-dir/proof.txt'; then
  pass "step 8 broad wheelhouse add stages untracked files under wheelhouse"
else
  fail "step 8 broad wheelhouse add did not demonstrate untracked wheelhouse staging"
fi

echo "upgrade-runbook.selftest: PASS ($PASS checks)"
