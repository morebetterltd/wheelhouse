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
selftest_install_cleanup_traps cleanup
FAILED=0
ALLOW="$FIX/allow.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$ALLOW"
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILED=$((FAILED+1)); }

expect() { # name, expected exit, helper, repository or subdirectory
  local name="$1" expected="$2" helper="$3" repo="$4" rc legacy_rc
  [ -d "$repo" ] || { fail "$name: subject directory missing"; return; }
  bash "$helper" "$repo" > "$FIX/$name.out" 2> "$FIX/$name.err"
  rc=$?
  if [ "$rc" -eq "$expected" ]; then pass "$name exit=$rc";
  else fail "$name expected=$expected actual=$rc"; fi
  if [ "$helper" = "$GUARD" ] && [ -f "${LEGACY:-}" ] && git -C "$repo" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    bash "$LEGACY" "$repo" > "$FIX/$name.legacy.out" 2> "$FIX/$name.legacy.err"
    legacy_rc=$?
    if [ "$rc" -eq "$legacy_rc" ] && cmp -s "$FIX/$name.out" "$FIX/$name.legacy.out" && cmp -s "$FIX/$name.err" "$FIX/$name.legacy.err"; then
      pass "$name committed exit/stdout/stderr unchanged"
    else fail "$name changed committed-repository behavior"; fi
  fi
  if [ "$expected" -ne 0 ]; then
    # Removing the guard must make this exact refusal assertion fail.
    bash "$ALLOW" "$repo" > "$FIX/$name.control.out" 2> "$FIX/$name.control.err"
    rc=$?
    if [ "$rc" -eq 0 ]; then pass "control $name fix-removed exit=0 would fail expected=$expected";
    else fail "control $name did not reproduce acceptance"; fi
  fi
}
unborn_notice() {
  if bun - "$FIX/$1.err" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const file=process.argv[2];assert(fs.statSync(file).isFile());
const text=fs.readFileSync(file,'utf8');
assert.equal(text.split('\n').filter(line=>line==='no commits yet: HEAD check skipped; index checked').length,1);
assert(!text.includes('STOP: cannot inspect HEAD'));
JS
  then pass "$1 reports index-only check once"; else fail "$1 missing or incorrect unborn notice"; fi
}
unborn_cases() { # name, repository or subdirectory, with an ignored capture present
  local name="$1" repo="$2"
  if git -C "$repo" rev-parse --verify -q HEAD >/dev/null; then fail "$name has a commit, not an unborn HEAD"; return 2; fi
  expect "$name" 0 "$GUARD" "$repo"
  unborn_notice "$name"
  git -C "$repo" add -f -- ':(top,literal)evidence/task/run.log' || return 2
  expect "$name-forced-add" 1 "$GUARD" "$repo"
  unborn_notice "$name-forced-add"
  if grep -Fq -- 'evidence/task/run.log' "$FIX/$name-forced-add.err"; then pass "$name-forced-add names evidence/task/run.log";
  else fail "$name-forced-add omitted the staged capture path"; fi
  git -C "$repo" rm --cached -q -- ':(top,literal)evidence/task/run.log' || return 2
}
new_unborn() {
  git init -q -b main "$1" &&
  cp -f "$ROOT/.gitignore" "$1/.gitignore" &&
  mkdir -p "$1/evidence/task" "$1/subdirectory" &&
  printf 'ignored private capture\n' > "$1/evidence/task/run.log"
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
UNBORN="$FIX/unborn"
new_unborn "$UNBORN" || exit 2
unborn_cases unborn-head "$UNBORN" || exit 2
unborn_cases unborn-subdirectory "$UNBORN/subdirectory" || exit 2
# Restore ONLY the original unconditional HEAD probe. This reconstructs the
# pre-fix guard without requiring Git history in a fresh bootstrap install.
LEGACY="$FIX/unborn-fix-removed.sh"
SWALLOW="$FIX/head-error-removed.sh"
bun - "$GUARD" "$LEGACY" "$SWALLOW" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const [file,legacy,swallow]=process.argv.slice(2),s=fs.readFileSync(file,'utf8');
const start='if git -C "$repo" rev-parse --verify -q HEAD >/dev/null; then\n';
assert.equal(s.split(start).length,2);
const at=s.indexOf(start),body=at+start.length,otherwise=s.indexOf('\nelse\n',body);
const end=s.indexOf('\nfi\nif [ -n "$tracked_index" ] || [ -n "$tracked_head" ]; then',otherwise);
assert(otherwise>body && end>otherwise);
const lines=s.slice(body,otherwise).split('\n');assert(lines.every(line=>line.startsWith('  ')));
fs.writeFileSync(legacy,s.slice(0,at)+lines.map(line=>line.slice(2)).join('\n')+s.slice(end+3));
const refusal="    echo 'STOP: cannot inspect HEAD for tracked evidence/' >&2\n    exit 2";
assert.equal(s.split(refusal).length,2);fs.writeFileSync(swallow,s.replace(refusal,'    tracked_head=""'));
JS
[ "$?" -eq 0 ] || exit 2
LC_ALL=C bash "$LEGACY" "$UNBORN" > "$FIX/unborn-legacy.out" 2> "$FIX/unborn-legacy.err"
rc=$?
if [ "$rc" -eq 2 ] && grep -Fq -- 'Not a valid object name HEAD' "$FIX/unborn-legacy.err"; then
  pass 'control unborn-head fix-removed exit=2: Not a valid object name HEAD would fail expected=0'
else fail "unborn-head control missing native HEAD failure, exit=$rc"; fi
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
UNBORN_NESTED="$REPO/subdirectory/nested-unborn"
new_unborn "$UNBORN_NESTED" || exit 2
unborn_cases unborn-nested-repository "$UNBORN_NESTED" || exit 2
# Ordinary worktree add + checkout --orphan works without requiring a newer
# Git worktree --orphan option. Its current HEAD is absent, despite shared objects.
UNBORN_WT="$FIX/unborn-worktree"
git -C "$NESTED" worktree add -q -b unborn-worktree-base "$UNBORN_WT" || exit 2
git -C "$UNBORN_WT" checkout -q --orphan unborn-worktree || exit 2
git -C "$UNBORN_WT" read-tree --empty || exit 2
cp -f "$ROOT/.gitignore" "$UNBORN_WT/.gitignore" || exit 2
mkdir -p "$UNBORN_WT/evidence/task" "$UNBORN_WT/subdirectory"
printf 'ignored private capture\n' > "$UNBORN_WT/evidence/task/run.log"
unborn_cases unborn-linked-worktree "$UNBORN_WT" || exit 2
unborn_cases unborn-worktree-subdirectory "$UNBORN_WT/subdirectory" || exit 2
# A valid HEAD with an unavailable ls-tree is an instrument error, NOT unborn.
GIT_BIN="$(command -v git)"
BROKEN_BIN="$FIX/broken-bin"
mkdir -p "$BROKEN_BIN"
printf '#!/usr/bin/env bash\nfor arg in "$@"; do if [ "$arg" = ls-tree ]; then echo "planted ls-tree diagnostic" >&2; exit 23; fi; done\nexec %s "$@"\n' "$(selftest_shell_quote "$GIT_BIN")" > "$BROKEN_BIN/git"
chmod +x "$BROKEN_BIN/git"
PATH="$BROKEN_BIN:$PATH" expect head-instrument-error 2 "$GUARD" "$NESTED"
if grep -Fq -- 'STOP: cannot inspect HEAD for tracked evidence/' "$FIX/head-instrument-error.err" && grep -Fq -- 'planted ls-tree diagnostic' "$FIX/head-instrument-error.err" && selftest_capture_lacks "$FIX/head-instrument-error.err" -Fq -- 'no commits yet'; then
  pass 'valid HEAD retains ls-tree error and STOP, never the unborn notice'
else fail 'valid HEAD inspection error was misclassified'; fi
PATH="$BROKEN_BIN:$PATH" expect head-error-fix-removed 0 "$SWALLOW" "$NESTED"
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
