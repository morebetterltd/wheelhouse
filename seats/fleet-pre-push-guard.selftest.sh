#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
GUARD="${1:-$ROOT/seats/fleet-pre-push-guard.sh}"
FAILED=0
FIX=""
pass() { printf 'ok - %s\n' "$*"; }
fail() { printf 'not ok - %s\n' "$*"; FAILED=$((FAILED + 1)); }
cleanup() { [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"; return 0; }
selftest_install_cleanup_traps cleanup

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-fleet-pre-push-guard-selftest.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
REMOTE="$FIX/remote.git"
REPO="$FIX/repo"
git init -q --bare -b main "$REMOTE"
git init -q -b main "$REPO"
git -C "$REPO" config user.email fleet-pre-push@example.invalid
git -C "$REPO" config user.name 'Fleet Pre Push Selftest'
printf 'base\n' > "$REPO/file.txt"
git -C "$REPO" add file.txt && git -C "$REPO" commit -qm base
git -C "$REPO" remote add origin "$REMOTE"
git -C "$REPO" push -q -u origin main
# The guard's default-line fallback is deliberately local, never a remote query.
git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
mkdir -p "$REPO/seats" "$REPO/.beads/hooks"
cp "$GUARD" "$REPO/seats/fleet-pre-push-guard.sh"
cp "$(dirname "$GUARD")/merge-gate-receipt.ts" "$REPO/seats/merge-gate-receipt.ts"
cp "$ROOT/seats/install-fleet-pre-push-guard.sh" "$REPO/seats/install-fleet-pre-push-guard.sh"
chmod +x "$REPO/seats/fleet-pre-push-guard.sh" "$REPO/seats/install-fleet-pre-push-guard.sh"
git -C "$REPO" config core.hooksPath .beads/hooks

# Reproduce the current-main failure mode first: before installing the guard, a
# seat shell can publish a fleet branch to a local bare remote.
git -C "$REPO" switch -q -c fleet/raw-main
printf 'raw before guard\n' > "$REPO/raw-main.txt"
git -C "$REPO" add raw-main.txt && git -C "$REPO" commit -qm 'raw fleet push before guard'
if git -C "$REPO" push -q origin fleet/raw-main:fleet/raw-main; then
  pass 'reproduce: without the wheelhouse guard, a raw fleet/* push to a local bare remote succeeds'
else
  fail 'reproduce: raw fleet/* push failed before guard was installed'
fi

cat > "$REPO/.beads/hooks/pre-push" <<HOOK
#!/usr/bin/env bash
printf 'existing hook ran\\n' >> "$FIX/existing-pre-push.log"
HOOK
chmod +x "$REPO/.beads/hooks/pre-push"
( cd "$REPO" && seats/install-fleet-pre-push-guard.sh )
if [ -x "$REPO/.beads/hooks/pre-push" ] && [ -x "$REPO/.beads/hooks/pre-push.before-wheelhouse-fleet-guard" ]; then
  pass 'install: guard lands under core.hooksPath=.beads/hooks and preserves an existing pre-push hook'
else
  fail 'install: guard or preserved pre-push hook missing under .beads/hooks'
fi

# Raw fleet push is refused and names the rule.
git -C "$REPO" switch -q -c fleet/raw-refused main
printf 'raw refused\n' > "$REPO/raw-refused.txt"
git -C "$REPO" add raw-refused.txt && git -C "$REPO" commit -qm 'raw fleet push refused'
if git -C "$REPO" push origin fleet/raw-refused:fleet/raw-refused >"$FIX/refused.out" 2>&1; then
  fail 'guard: raw fleet/* push unexpectedly succeeded'
elif grep -q 'refusing push to refs/heads/fleet/raw-refused' "$FIX/refused.out" && grep -q 'WHEELHOUSE_INTEGRATOR_PUSH=1' "$FIX/refused.out"; then
  pass 'guard: raw fleet/* push is refused with the integrator rule named'
else
  fail "guard: refusal did not name the rule: $(cat "$FIX/refused.out")"
fi

# Integrator-sanctioned fleet push succeeds and the pre-existing hook still runs.
: > "$FIX/existing-pre-push.log"
if WHEELHOUSE_INTEGRATOR_PUSH=1 git -C "$REPO" push -q origin fleet/raw-refused:fleet/raw-refused \
   && grep -q 'existing hook ran' "$FIX/existing-pre-push.log"; then
  pass 'guard: WHEELHOUSE_INTEGRATOR_PUSH=1 permits fleet/* and still runs the existing pre-push hook'
else
  fail "guard: integrator push failed or skipped existing hook: out=$(cat "$FIX/refused.out" 2>/dev/null) hook=$(cat "$FIX/existing-pre-push.log" 2>/dev/null)"
fi

# Non-fleet refs are unaffected.
git -C "$REPO" switch -q -c topic/non-fleet main
printf 'topic\n' > "$REPO/topic.txt"
git -C "$REPO" add topic.txt && git -C "$REPO" commit -qm topic
if git -C "$REPO" push -q origin topic/non-fleet:topic/non-fleet; then
  pass 'guard: non-fleet branch push is unaffected'
else
  fail 'guard: non-fleet branch push failed'
fi

# The adapter's rotation push is sanctioned: seat-worktree.ts sets the env for
# its own scanned push, while a raw shell push remains refused.
git -C "$REPO" switch -q main
mkdir -p "$REPO/.wheelhouse-worktrees"
git -C "$REPO" worktree add -q "$REPO/.wheelhouse-worktrees/worker-1" -b fleet/old-seat main
git -C "$REPO/.wheelhouse-worktrees/worker-1" config user.email fleet-pre-push@example.invalid
git -C "$REPO/.wheelhouse-worktrees/worker-1" config user.name 'Fleet Pre Push Selftest'
printf 'seat old\n' > "$REPO/.wheelhouse-worktrees/worker-1/seat-old.txt"
git -C "$REPO/.wheelhouse-worktrees/worker-1" add seat-old.txt && git -C "$REPO/.wheelhouse-worktrees/worker-1" commit -qm 'seat old branch'
OUT="$FIX/seat-worktree.out"
if env WHEELHOUSE_SKIP_BD=1 MODULE="$ROOT/seats/seat-worktree.ts" REPO="$REPO" bun -e '
const { ensureSeatWorktree } = await import(process.env.MODULE);
ensureSeatWorktree({ root: process.env.REPO, seat: "worker-1", beadId: "new-seat", base: "origin/main", roster: { "worker-1": {} }, state: { seats: {} }, seatPush: "on" });
' > "$OUT" 2>&1 \
  && git --git-dir="$REMOTE" rev-parse --verify --quiet refs/heads/fleet/old-seat >/dev/null; then
  pass 'seat-worktree: rotation push sets WHEELHOUSE_INTEGRATOR_PUSH=1 for its own scanned fleet/* push'
else
  fail "seat-worktree: sanctioned rotation push failed: $(cat "$OUT" 2>/dev/null)"
fi

git -C "$REPO/.wheelhouse-worktrees/worker-1" switch -q -c fleet/raw-seat-shell origin/main
printf 'raw shell\n' > "$REPO/.wheelhouse-worktrees/worker-1/raw-shell.txt"
git -C "$REPO/.wheelhouse-worktrees/worker-1" add raw-shell.txt && git -C "$REPO/.wheelhouse-worktrees/worker-1" commit -qm 'raw shell after guard'
if git -C "$REPO/.wheelhouse-worktrees/worker-1" push origin fleet/raw-seat-shell:fleet/raw-seat-shell >"$FIX/raw-seat-shell.out" 2>&1; then
  fail 'seat-worktree: raw shell fleet/* push unexpectedly bypassed the guard'
elif grep -q 'refusing push to refs/heads/fleet/raw-seat-shell' "$FIX/raw-seat-shell.out"; then
  pass 'seat-worktree: raw shell fleet/* push from a seat worktree is still refused'
else
  fail "seat-worktree: raw shell refusal missing: $(cat "$FIX/raw-seat-shell.out")"
fi

# Real completed review format, generated before any receipt/record fixtures.
SAMPLE="$FIX/actual-review.md"
if WHEELHOUSE_REVIEW_RECORD_ONLY=1 WHEELHOUSE_REVIEW_RECORD_SEED_ONLY=1 WHEELHOUSE_REVIEW_RECORD_SEED="$SAMPLE" bash "$HERE/verify.selftest.sh"; then
  for file in "$HERE/"*.ts "$HERE/"*.sh; do
    case "$file" in */fleet-pre-push-guard.sh|*/merge-gate-receipt.ts) continue ;; esac
    cp -f "$file" "$REPO/seats/"
  done
  cp -rf "$HERE/drivers" "$HERE/transports" "$REPO/seats/"
  if bun "$HERE/fixtures/merge-gate-push.ts" "$REPO" "$REMOTE" "$SAMPLE" "$HERE" "$GUARD"; then
    pass 'merge-gate integration receipt assertions completed'
  else fail 'merge-gate integration receipt assertions failed'; fi
else fail 'merge-gate actual review producer setup failed'; fi

if [ "$FAILED" -eq 0 ]; then
  echo 'fleet-pre-push-guard.selftest: PASS'
else
  echo "fleet-pre-push-guard.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
