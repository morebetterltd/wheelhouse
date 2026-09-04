#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
BASELINE=${WHEELHOUSE_UPGRADE_SELFTEST_BASELINE:-d8128d4}
TEMPLATE_SOURCE="$ROOT/wheelhouse/.template-source"

source_refusal() {
  echo "REFUSED template source: $*" >&2
  exit 42
}

template_root() {
  local recorded=""
  if [ -d "$ROOT/wheelhouse" ] && [ ! -d "$ROOT/contracts" ]; then
    [ -f "$TEMPLATE_SOURCE" ] || source_refusal "$TEMPLATE_SOURCE missing; expected a path= line naming the template clone that carries baseline $BASELINE"
    recorded=$(sed -n 's/^path=//p' "$TEMPLATE_SOURCE" | tail -1)
    [ -n "$recorded" ] || source_refusal "$TEMPLATE_SOURCE has no path= line; expected path=/path/to/template-clone carrying baseline $BASELINE"
    git -C "$recorded" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || source_refusal "$TEMPLATE_SOURCE path=$recorded is not a git repository carrying baseline $BASELINE"
    git -C "$recorded" cat-file -e "${BASELINE}^{commit}" >/dev/null 2>&1 \
      || source_refusal "$TEMPLATE_SOURCE path=$recorded is a git repository but baseline object $BASELINE is absent"
    printf '%s\n' "$recorded"
    return 0
  fi
  printf '%s\n' "$ROOT"
}
TEMPLATE=$(template_root)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-upgrade-selftest.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
fail() { echo "not ok $((PASS+1)) - $*"; exit 1; }
pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }

command -v zsh >/dev/null 2>&1 || fail "zsh is required for this selftest"

PROJ="$TMP/project"
mkdir -p "$PROJ/wheelhouse/fleet" "$PROJ/wheelhouse/runbooks"
git -C "$TEMPLATE" show "${BASELINE}:contracts/WORKER.md" > "$PROJ/wheelhouse/fleet/WORKER.md"
for b in PROMOTION.md RUNNING_THE_LOOP.md UPGRADE.md; do
  git -C "$TEMPLATE" show "${BASELINE}:runbooks/$b" > "$PROJ/wheelhouse/runbooks/$b"
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
' zsh "$TEMPLATE" "$PROJ")
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
' zsh "$TEMPLATE" "$PROJ" "$BASELINE")
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

if [ "${WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG:-1}" = 1 ]; then
  INSTALL="$TMP/install-root"
  mkdir -p "$INSTALL/seats" "$INSTALL/wheelhouse"
  git -C "$INSTALL" init -b main >/dev/null
  cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=fixture
commit=$BASELINE
path=$TEMPLATE
namespace=fixture
EOF
  cp "$ROOT/seats/upgrade-runbook.selftest.sh" "$INSTALL/seats/upgrade-runbook.selftest.sh"
  INSTALLED_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL/seats/upgrade-runbook.selftest.sh" 2>&1)
  case "$INSTALLED_OUT" in
    *"upgrade-runbook.selftest: PASS"*) pass "installed-layout copied upgrade-runbook selftest resolves baseline through wheelhouse/.template-source path" ;;
    *) fail "installed-layout copied upgrade-runbook selftest failed: $INSTALLED_OUT" ;;
  esac

  INSTALL_MISSING="$TMP/install-missing-source"
  mkdir -p "$INSTALL_MISSING/seats" "$INSTALL_MISSING/wheelhouse"
  git -C "$INSTALL_MISSING" init -b main >/dev/null
  cp "$ROOT/seats/upgrade-runbook.selftest.sh" "$INSTALL_MISSING/seats/upgrade-runbook.selftest.sh"
  set +e
  MISSING_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_MISSING/seats/upgrade-runbook.selftest.sh" 2>&1)
  MISSING_RC=$?
  set -e
  if [ "$MISSING_RC" -eq 42 ] && printf '%s\n' "$MISSING_OUT" | grep -q 'wheelhouse/.template-source missing' && printf '%s\n' "$MISSING_OUT" | grep -q 'expected a path= line'; then
    pass "installed-layout missing .template-source fails legibly with path= expectation"
  else
    fail "installed-layout missing .template-source was not legible (rc=$MISSING_RC): $MISSING_OUT"
  fi

  INSTALL_BAD="$TMP/install-bad-source"
  mkdir -p "$INSTALL_BAD/seats" "$INSTALL_BAD/wheelhouse"
  git -C "$INSTALL_BAD" init -b main >/dev/null
  cp "$ROOT/seats/upgrade-runbook.selftest.sh" "$INSTALL_BAD/seats/upgrade-runbook.selftest.sh"
  printf 'path=%s\n' "$TMP/not-a-template-repo" > "$INSTALL_BAD/wheelhouse/.template-source"
  set +e
  BAD_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_BAD/seats/upgrade-runbook.selftest.sh" 2>&1)
  BAD_RC=$?
  set -e
  if [ "$BAD_RC" -eq 42 ] && printf '%s\n' "$BAD_OUT" | grep -q 'wheelhouse/.template-source path=' && printf '%s\n' "$BAD_OUT" | grep -q 'not a git repository'; then
    pass "installed-layout bad path= fails legibly before raw git fatal"
  else
    fail "installed-layout bad path= was not legible (rc=$BAD_RC): $BAD_OUT"
  fi
fi

echo "upgrade-runbook.selftest: PASS ($PASS checks)"
