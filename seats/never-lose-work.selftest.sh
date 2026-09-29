#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
# Hermetic never-lose-work selftest for `bun seats/prune.ts cleanup` (ISC-70).
# One scratch install with a product repo, a bare origin and a real bd store
# seeds six registered worktrees on closed-bead fleet/ branches:
#   (a) real-change: modified tracked file + untracked file      -> kept "uncommitted changes"
#   (b) phantom-only: hundreds of deleted once-committed build files -> removed "build output only"
#   (c) unpushed squash-merged: commits on no remote ref         -> archive tag, then removed
#   (d) occupied: clean, merged, a live process cwd inside       -> kept "live process has its cwd"
#   (e) plain: clean, merged, pushed                             -> removed
#   (f) unmerged clean closed bead                               -> kept
# Then it proves only (b), (c), (e) went, every fleet/* ref survived, every
# removed path is gone, and a second (nightly) run changes nothing.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
PRUNE="${1:-$HERE/prune.ts}"
[ -f "$PRUNE" ] || { echo "selftest: not found: $PRUNE" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "selftest: git is required" >&2; exit 2; }
command -v bd >/dev/null 2>&1 || { echo "selftest: bd is required" >&2; exit 2; }
command -v lsof >/dev/null 2>&1 || { echo "selftest: lsof is required" >&2; exit 2; }

FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
json_id(){ bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)'; }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-nlw-selftest.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
SLEEP_PID=""
cleanup(){ [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" >/dev/null 2>&1; selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
export HOME="$FIX/home"
mkdir -p "$HOME"

ROOT="$FIX/container"
PROD="$ROOT/product"
WTS="$ROOT/.wheelhouse-worktrees"
LOG="$ROOT/seats/logs/cleanup.log"
mkdir -p "$PROD" "$WTS" "$ROOT/seats"
cp "$PRUNE" "$ROOT/seats/prune.ts"
cp "$(dirname "$PRUNE")/seat-worktree.ts" "$ROOT/seats/seat-worktree.ts"

# No simulator or Xcode scanning on this machine: a fake xcrun that knows nothing.
FAKEBIN="$FIX/fakebin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nexit 2\n' > "$FAKEBIN/xcrun"; chmod +x "$FAKEBIN/xcrun"
export PATH="$FAKEBIN:$PATH"

git -C "$ROOT" init -q -b main
git -C "$PROD" init -q -b main
git -C "$PROD" config user.email selftest@example.invalid
git -C "$PROD" config user.name selftest
printf 'base\n' > "$PROD/app.txt"
git -C "$PROD" add app.txt
git -C "$PROD" commit -q -m base
BARE="$FIX/origin.git"
git -C "$PROD" init --bare -q "$BARE"
git -C "$PROD" remote add origin "$BARE"
git -C "$PROD" push -q -u origin main

( cd "$ROOT" && bd init --non-interactive --skip-agents -p nlw >/dev/null 2>&1 ) || { echo "selftest: bd init failed" >&2; exit 2; }
closed_bead(){ local id; id=$(cd "$ROOT" && bd create "$1" --json | json_id); ( cd "$ROOT" && bd close "$id" >/dev/null 2>&1 ); printf '%s\n' "$id"; }
A_ID=$(closed_bead 'real uncommitted change')
B_ID=$(closed_bead 'phantom build output only')
C_ID=$(closed_bead 'unpushed squash-merged')
D_ID=$(closed_bead 'occupied by live cwd')
E_ID=$(closed_bead 'plain merged and pushed')
F_ID=$(closed_bead 'closed but unmerged')

wt_add(){ # worktree on fleet/<id> with one commit touching <id>.txt
  git -C "$PROD" worktree add -q -b "fleet/$1" "$WTS/$1" main
  printf '%s\n' "$1" > "$WTS/$1/$1.txt"
  git -C "$WTS/$1" add "$1.txt"
  git -C "$WTS/$1" commit -q -m "work $1"
}
merge_main(){ git -C "$PROD" checkout -q main; git -C "$PROD" merge -q --no-ff "fleet/$1" -m "merge $1"; git -C "$PROD" push -q origin main; }

# (a) real-change: merged and pushed, but the tree carries real work
wt_add "$A_ID"; merge_main "$A_ID"; git -C "$PROD" push -q origin "fleet/$A_ID"
printf 'edited after close\n' >> "$WTS/$A_ID/app.txt"
printf 'not yet added\n' > "$WTS/$A_ID/untracked.txt"

# (b) phantom-only: once-committed build output under both phantom prefixes, then deleted
git -C "$PROD" worktree add -q -b "fleet/$B_ID" "$WTS/$B_ID" main
mkdir -p "$WTS/$B_ID/.cargo-target-shared/x" "$WTS/$B_ID/car-rs/.wt-target"
i=0; while [ $i -lt 300 ]; do printf 'obj %s\n' "$i" > "$WTS/$B_ID/.cargo-target-shared/x/o$i.rlib"; i=$((i+1)); done
i=0; while [ $i -lt 8 ]; do printf 'wt %s\n' "$i" > "$WTS/$B_ID/car-rs/.wt-target/t$i.o"; i=$((i+1)); done
git -C "$WTS/$B_ID" add -A
git -C "$WTS/$B_ID" commit -q -m 'commit build output'
merge_main "$B_ID"; git -C "$PROD" push -q origin "fleet/$B_ID"
rm -rf "$WTS/$B_ID/.cargo-target-shared" "$WTS/$B_ID/car-rs"
B_STATUS=$(git -C "$WTS/$B_ID" status --porcelain --untracked-files=all)
B_D=$(printf '%s\n' "$B_STATUS" | grep -c '^ D ')
B_OTHER=$(printf '%s\n' "$B_STATUS" | grep -vc '^ D ')

# (c) unpushed: two commits, squash-merged to main; the branch is on no remote ref
wt_add "$C_ID"
printf 'second\n' > "$WTS/$C_ID/$C_ID-2.txt"
git -C "$WTS/$C_ID" add "$C_ID-2.txt"
git -C "$WTS/$C_ID" commit -q -m "work $C_ID part 2"
C_TIP=$(git -C "$WTS/$C_ID" rev-parse HEAD)
git -C "$PROD" checkout -q main
git -C "$PROD" merge -q --squash "fleet/$C_ID" && git -C "$PROD" commit -q -m "squash $C_ID"
git -C "$PROD" push -q origin main

# (d) occupied: clean and merged, but a live process sits inside
wt_add "$D_ID"; merge_main "$D_ID"; git -C "$PROD" push -q origin "fleet/$D_ID"
( cd "$WTS/$D_ID" && exec sleep 1000 ) >/dev/null 2>&1 &
SLEEP_PID=$!

# (e) plain merged and pushed; (f) closed but never merged
wt_add "$E_ID"; merge_main "$E_ID"; git -C "$PROD" push -q origin "fleet/$E_ID"
wt_add "$F_ID"

BRANCHES_BEFORE=$(git -C "$PROD" for-each-ref --format='%(refname:short)' refs/heads/fleet | sort)
registered(){ git -C "$PROD" worktree list --porcelain | grep -qxF "worktree $1"; }

phase 'fixture seeded as intended'
[ "$B_D" -ge 300 ] && [ "$B_OTHER" -eq 0 ] && pass "phantom worktree shows $B_D ' D' lines and nothing else" || fail "phantom worktree status unexpected: D=$B_D other=$B_OTHER"
[ -z "$(git -C "$PROD" branch -r --contains "$C_TIP")" ] && pass 'unpushed worktree tip is on no remote ref' || fail 'unpushed tip is unexpectedly on a remote ref'
[ "$(printf '%s\n' "$BRANCHES_BEFORE" | grep -c .)" -eq 6 ] && pass 'six fleet/ branches exist before cleanup' || fail "expected six fleet branches: $BRANCHES_BEFORE"

phase 'cleanup removes only the phantom, unpushed-but-integrated and plain merged worktrees'
( cd "$ROOT" && bun seats/prune.ts cleanup > "$FIX/cleanup.out" 2> "$FIX/cleanup.err" ); RC=$?
[ "$RC" -eq 0 ] && pass 'cleanup exits 0' || fail "cleanup exited $RC: $(cat "$FIX/cleanup.err")"
[ -f "$LOG" ] && pass 'cleanup log written at seats/logs/cleanup.log' || fail 'cleanup log missing'
if cmp -s "$LOG" "$FIX/cleanup.out"; then pass 'stdout mirrors the cleanup log line for line'; else fail "stdout and log differ:\n$(diff "$LOG" "$FIX/cleanup.out")"; fi
for id in "$A_ID" "$D_ID" "$F_ID"; do
  [ -d "$WTS/$id" ] && registered "$WTS/$id" && pass "$id still exists and is still registered" || fail "$id was removed or unregistered"
done
for id in "$B_ID" "$C_ID" "$E_ID"; do
  [ ! -e "$WTS/$id" ] && ! registered "$WTS/$id" && pass "$id removed and unregistered" || fail "$id still exists or is still registered"
done
grep -q "^[^ ]* kept needs-review $WTS/$A_ID reason=.*uncommitted changes" "$LOG" && pass 'real-change worktree kept with "uncommitted changes" (ISC-54)' || fail "no uncommitted-changes kept line for $A_ID"
[ -f "$WTS/$A_ID/untracked.txt" ] && grep -q 'edited after close' "$WTS/$A_ID/app.txt" && pass 'real-change worktree contents untouched' || fail 'real-change worktree contents changed'
grep -q "^[^ ]* kept needs-review $WTS/$D_ID reason=.*live process has its cwd" "$LOG" && pass 'occupied worktree kept with "live process has its cwd" (ISC-56)' || fail "no live-cwd kept line for $D_ID"
grep -q "^[^ ]* kept needs-review $WTS/$F_ID reason=" "$LOG" && pass 'unmerged closed-bead worktree kept with a reason' || fail "no kept line for $F_ID"
grep -q "^[^ ]* removed merged-worktree $WTS/$B_ID bytes=[0-9]* reason=.*build output only" "$LOG" && pass 'phantom-only worktree removed with "build output only" (ISC-55)' || fail "no build-output-only removed line for $B_ID"
grep -q "^[^ ]* removed merged-worktree $WTS/$C_ID bytes=[0-9]* reason=.*squash-merged as [0-9a-f]\{12\} on " "$LOG" && pass 'unpushed worktree recognised as squash-merged, naming the merge commit (ISC-42)' || fail "no squash-merged removed line for $C_ID"
grep -q "^[^ ]* removed merged-worktree $WTS/$C_ID .*archived as archive/$C_ID" "$LOG" && pass 'removed line names the archive tag' || fail "removed line for $C_ID does not name archive/$C_ID"
[ "$(git -C "$PROD" rev-parse --verify --quiet "refs/tags/archive/$C_ID^{commit}")" = "$C_TIP" ] && pass 'archive/<name> tag points at the old tip (ISC-53)' || fail "archive/$C_ID tag missing or not at $C_TIP: $(git -C "$PROD" tag --list 'archive/*')"
[ "$(git -C "$PROD" tag --list 'archive/*')" = "archive/$C_ID" ] && pass 'only the unpushed worktree was archive-tagged' || fail "unexpected archive tags: $(git -C "$PROD" tag --list 'archive/*')"
git -C "$PROD" branch --list "fleet/$C_ID" | grep -q . && git -C "$PROD" log -1 --oneline "fleet/$C_ID" >/dev/null 2>&1 && [ "$(git -C "$PROD" rev-parse "fleet/$C_ID")" = "$C_TIP" ] && pass 'unpushed branch ref survives at its tip' || fail "fleet/$C_ID ref missing or moved"
grep -q "^[^ ]* removed merged-worktree $WTS/$E_ID bytes=[0-9]* reason=.*tip is an ancestor of " "$LOG" && pass 'plain merged worktree removed as an ancestor of an integration ref' || fail "no ancestor removed line for $E_ID"
BRANCHES_AFTER=$(git -C "$PROD" for-each-ref --format='%(refname:short)' refs/heads/fleet | sort)
[ "$BRANCHES_BEFORE" = "$BRANCHES_AFTER" ] && pass 'every fleet/* branch ref still exists (ISC-52)' || fail "branch refs changed:\nbefore: $BRANCHES_BEFORE\nafter: $BRANCHES_AFTER"
for b in $BRANCHES_AFTER; do git -C "$PROD" log -1 "$b" >/dev/null 2>&1 || fail "git log -1 $b failed"; done
GONE=0; STILL=""
while IFS= read -r p; do [ -n "$p" ] || continue; if [ -e "$p" ]; then STILL="$STILL $p"; else GONE=$((GONE+1)); fi; done <<EOF
$(awk '$2=="removed"{print $4}' "$LOG")
EOF
[ "$GONE" -ge 1 ] && [ -z "$STILL" ] && pass 'every removed line names a path that no longer exists (ISC-47)' || fail "removed paths still present: $STILL (gone=$GONE)"
[ "$(awk '$2=="removed"' "$LOG" | wc -l | tr -d ' ')" -eq 3 ] && pass 'exactly three removed lines' || fail "removed lines: $(awk '$2=="removed"' "$LOG")"
[ "$(awk '$2=="kept"' "$LOG" | wc -l | tr -d ' ')" -eq 3 ] && pass 'exactly three kept lines' || fail "kept lines: $(awk '$2=="kept"' "$LOG")"
tail -1 "$LOG" | grep -q '^[0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9:]*Z cleanup done removed=3 kept=3 bytes=[0-9]*$' && pass 'final line is "cleanup done removed=3 kept=3 bytes=<n>"' || fail "unexpected final line: $(tail -1 "$LOG")"
[ -z "$(git -C "$PROD" worktree prune --dry-run 2>&1)" ] && pass 'worktree registry is consistent after cleanup' || fail "worktree prune --dry-run has work: $(git -C "$PROD" worktree prune --dry-run 2>&1)"
grep -q 'Z ' "$LOG" && ! grep -q "$(printf '\t')" "$LOG" && pass 'log lines are ISO8601Z-stamped and tab-free' || fail 'log format violation'

phase 'a second (nightly) cleanup changes nothing'
( cd "$ROOT" && bun seats/prune.ts cleanup > "$FIX/cleanup2.out" 2>&1 ); RC2=$?
[ "$RC2" -eq 0 ] && pass 'second cleanup exits 0' || fail "second cleanup exited $RC2: $(cat "$FIX/cleanup2.out")"
tail -1 "$FIX/cleanup2.out" | grep -q 'cleanup done removed=0 kept=3 bytes=0$' && pass 'nightly run removed nothing and kept the same three' || fail "unexpected second summary: $(tail -1 "$FIX/cleanup2.out")"
[ -d "$WTS/$A_ID" ] && [ -d "$WTS/$D_ID" ] && [ -d "$WTS/$F_ID" ] && pass 'real-change, occupied and unmerged worktrees survive the nightly run' || fail 'a kept worktree vanished on the second run'
[ "$(git -C "$PROD" for-each-ref --format='%(refname:short)' refs/heads/fleet | sort)" = "$BRANCHES_BEFORE" ] && pass 'branch refs unchanged after the nightly run' || fail 'branch refs changed on the second run'

if [ "$FAILED" -eq 0 ]; then
  echo 'never-lose-work.selftest: PASS'
  exit 0
fi
echo "never-lose-work.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
