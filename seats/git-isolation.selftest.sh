#!/usr/bin/env bash
# All destructive canaries run inside our own disposable enclosing repository.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-git-isolation.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_remove_fixture_dir "$FIX"'

# Audit the setup of every suite, not just fgit: exported ceilings also protect
# plain git -C, bare git after cd, and git launched by Node/Bun/runtime children.
bun "$HERE/fixtures/git-boundary-audit.ts" "$HERE" "$FIX/audit-sources"

OUTER="$FIX/enclosing"
mkdir -p "$OUTER/tmp"
git -C "$OUTER" init -q -b main
git -C "$OUTER" -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false commit --allow-empty -qm old
git -C "$OUTER" update-ref refs/remotes/origin/main HEAD
git -C "$OUTER" -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false commit --allow-empty -qm kept
BEFORE="$(git -C "$OUTER" rev-parse HEAD)"
[ "$(git -C "$OUTER" rev-parse --show-toplevel)" = "$OUTER" ]
INNER="$(selftest_make_fixture_dir "$OUTER/tmp/fixture.XXXXXX")" || exit 2
selftest_isolate_git "$INNER" || exit 2
# Use the actual fgit definition, so the reproducer covers its env/config flags.
FGIT="$(grep '^fgit() ' "$HERE/adapter.selftest.sh")"
[ -n "$FGIT" ]
printf '%s\n' "$FGIT" > "$FIX/fgit.sh"
cat > "$FIX/repro.sh" <<'REPRO'
set -eu
. "$LIB"
. "$FGIT_FILE"
HOME_FIX="$INNER/home"
mkdir -p "$HOME_FIX"
selftest_isolate_git "$INNER"
# Model a dispatch gate refusing before worktree creation. The empty seat cwd
# remains, but contains no .git: exactly the failed-dispatch precondition.
WT="$INNER/project/.wheelhouse-worktrees/worker-1"
failed_dispatch(){ mkdir -p "$WT"; return 1; }
rc=0; failed_dispatch || rc=$?
[ "$rc" = 1 ] && [ -d "$WT" ] && [ ! -e "$WT/.git" ]
reset_rc=0
fgit -C "$WT" reset -q --hard origin/main > "$INNER/reset.out" 2> "$INNER/reset.err" || reset_rc=$?
after="$(git -C "$OUTER" rev-parse HEAD)"
if [ "$after" != "$BEFORE" ]; then
  echo 'FAIL failed-dispatch reset moved the throwaway enclosing HEAD'
  exit 1
fi
[ "$reset_rc" != 0 ]
grep -q 'not a git repository' "$INNER/reset.err"
# At the fixture root itself, and in a plain subdirectory, discovery must also
# fail; existing nested repos/worktrees and their subdirectories must work.
mkdir -p "$INNER/plain"
for target in "$INNER" "$INNER/plain"; do
  if git -C "$target" rev-parse --show-toplevel > /dev/null 2>&1; then exit 1; fi
done
git -C "$INNER" init -q -b main "$INNER/repo"
git -C "$INNER/repo" -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false commit --allow-empty -qm base
git -C "$INNER/repo" worktree add -q -b fleet/fixture "$INNER/wt"
mkdir -p "$INNER/repo/sub" "$INNER/wt/sub"
for target in "$INNER/repo" "$INNER/repo/sub" "$INNER/wt" "$INNER/wt/sub"; do
  git -C "$target" rev-parse --verify HEAD > /dev/null
done
echo 'PASS failed dispatch, fixture root, plain directory, nested repo, worktree and their subdirectories stay contained'
REPRO
# Negative control: remove only the fix in a COPY of the helper. Never run an
# unguarded suite against the install or its enclosing umbrella repository.
cp -f "$HERE/selftest-lib.sh" "$FIX/unsafe-lib.sh"
printf '\nselftest_isolate_git() { :; }\n' >> "$FIX/unsafe-lib.sh"
rc=0
env -u GIT_CEILING_DIRECTORIES LIB="$FIX/unsafe-lib.sh" FGIT_FILE="$FIX/fgit.sh" INNER="$INNER" OUTER="$OUTER" BEFORE="$BEFORE" bash "$FIX/repro.sh" > "$FIX/unsafe.out" 2> "$FIX/unsafe.err" || rc=$?
[ "$rc" = 1 ]
grep -q 'FAIL failed-dispatch reset moved' "$FIX/unsafe.out"
[ "$(git -C "$OUTER" rev-parse HEAD)" = "$(git -C "$OUTER" rev-parse origin/main)" ]
echo 'PASS negative control: removing the ceiling moves only the throwaway enclosing HEAD (regression exits 1)'
# Restore only the canary repo, then execute the identical regression with fix.
git -C "$OUTER" reset -q --hard "$BEFORE"
env -u GIT_CEILING_DIRECTORIES LIB="$HERE/selftest-lib.sh" FGIT_FILE="$FIX/fgit.sh" INNER="$INNER" OUTER="$OUTER" BEFORE="$BEFORE" bash "$FIX/repro.sh"
[ "$(git -C "$OUTER" rev-parse HEAD)" = "$BEFORE" ]
echo 'git-isolation.selftest: PASS'
