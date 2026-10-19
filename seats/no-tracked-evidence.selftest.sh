#!/usr/bin/env bash
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
GUARD="$HERE/no-tracked-evidence.sh"
[ -f "$GUARD" ] || { echo 'missing no-tracked-evidence.sh' >&2; exit 2; }
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-no-tracked-evidence.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
FAILED=0
ALLOW="$FIX/allow.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$ALLOW"
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILED=$((FAILED+1)); }

expect() { # name, expected exit, helper, repository or subdirectory
  local name="$1" expected="$2" helper="$3" repo="$4" rc
  [ -d "$repo" ] || { fail "$name: subject directory missing"; return; }
  bash "$helper" "$repo" > "$FIX/$name.out" 2> "$FIX/$name.err"
  rc=$?
  if [ "$rc" -eq "$expected" ]; then pass "$name exit=$rc";
  else fail "$name expected=$expected actual=$rc"; fi
  if [ "$expected" -ne 0 ]; then
    # Removing the guard must make this exact refusal assertion fail.
    bash "$ALLOW" "$repo" > "$FIX/$name.control.out" 2> "$FIX/$name.control.err"
    rc=$?
    if [ "$rc" -eq 0 ]; then pass "control $name fix-removed exit=0 would fail expected=$expected";
    else fail "control $name did not reproduce acceptance"; fi
  fi
}
new_repo() {
  git init -q -b main "$1" &&
  git -C "$1" config user.name fixture &&
  git -C "$1" config user.email fixture@example.invalid &&
  printf 'product\n' > "$1/product.txt" &&
  git -C "$1" add product.txt && git -C "$1" commit -qm base
}

# The live check is part of the full suite: it must reject a force-added path
# in this repository even when .gitignore would otherwise hide the capture.
expect template 0 "$GUARD" "$ROOT"
REPO="$FIX/repo"
new_repo "$REPO" || exit 2
cp -f "$ROOT/.gitignore" "$REPO/.gitignore" || exit 2
git -C "$REPO" add .gitignore && git -C "$REPO" commit -qm ignore || exit 2
mkdir -p "$REPO/evidence/task" "$REPO/subdirectory"
printf 'private local capture\n' > "$REPO/evidence/task/run.log"
if git -C "$REPO" check-ignore -q -- evidence/task/run.log; then
  pass 'template ignore excludes new evidence/task/run.log'
else fail 'template ignore does not exclude task captures'; fi
expect ignored-local 0 "$GUARD" "$REPO"
# A similar filename outside the forbidden root is product content, not a log
# archive. The guard must not become a content/substring scanner.
printf 'product documentation\n' > "$REPO/evidence-policy.md"
git -C "$REPO" add evidence-policy.md || exit 2
expect similar-name 0 "$GUARD" "$REPO"
git -C "$REPO" add -f evidence/task/run.log || exit 2
expect forced-index 1 "$GUARD" "$REPO"
expect plain-subdirectory 1 "$GUARD" "$REPO/subdirectory"
git -C "$REPO" commit -qm 'planted task capture' || exit 2
expect committed 1 "$GUARD" "$REPO"
# HEAD still contains the published capture even with a staged deletion.
git -C "$REPO" rm -q evidence/task/run.log || exit 2
expect staged-deletion 1 "$GUARD" "$REPO"
git -C "$REPO" restore --staged --worktree evidence/task/run.log || exit 2
WT="$FIX/worktree"
git -C "$REPO" worktree add -q -b fixture-worktree "$WT" || exit 2
mkdir -p "$WT/subdirectory"
expect linked-worktree 1 "$GUARD" "$WT"
expect worktree-subdirectory 1 "$GUARD" "$WT/subdirectory"
NESTED="$REPO/subdirectory/nested"
new_repo "$NESTED" || exit 2
expect nested-repository 0 "$GUARD" "$NESTED"
# Native Git quotes unusual names; the guard tests presence, not pretty-output
# line counts or shell evaluation of filenames.
ODD="$FIX/odd"
new_repo "$ODD" || exit 2
mkdir -p "$ODD/evidence"
printf 'capture\n' > "$ODD/evidence/space and
newline.log"
git -C "$ODD" add evidence || exit 2
expect unusual-name 1 "$GUARD" "$ODD"
NOGIT="$FIX/no-git"
mkdir -p "$NOGIT"
expect non-repository 2 "$GUARD" "$NOGIT"

# Refusal assertions above include fix-removed controls at the same subject
# state, including index-only adds, worktrees and failed Git instruments.
# Remove only the HEAD check: staged deletion must then slip past the guard.
NO_HEAD="$FIX/no-head.sh"
bun - "$GUARD" "$NO_HEAD" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const s=fs.readFileSync(process.argv[2],'utf8'),anchor=' || [ -n "$tracked_head" ]';
assert.equal(s.split(anchor).length,2);fs.writeFileSync(process.argv[3],s.replace(anchor,''));
JS
[ "$?" -eq 0 ] || exit 2
git -C "$REPO" rm -q evidence/task/run.log || exit 2
expect head-check-removed 0 "$NO_HEAD" "$REPO"
# Drop the ignore rule in a private copy to prove the native ignore assertion
# depends on the template rule, not a global user ignore setting.
IGNORE_CONTROL="$FIX/ignore-control"
new_repo "$IGNORE_CONTROL" || exit 2
if git -C "$IGNORE_CONTROL" check-ignore -q -- evidence/task/run.log; then
  fail 'ignore-removed control unexpectedly ignored evidence';
else
  rc=$?
  if [ "$rc" -eq 1 ]; then pass 'ignore-removed control fails native ignore assertion (exit=1)';
  else fail "ignore-removed instrument failed exit=$rc"; fi
fi

if [ "$FAILED" -eq 0 ]; then echo 'no-tracked-evidence.selftest: PASS';
else echo "no-tracked-evidence.selftest: FAIL ($FAILED)"; exit 1; fi
