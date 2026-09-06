#!/usr/bin/env bash
# Hermetic selftest for seats/prune.ts. It builds a scratch wheelhouse
# container with a product repo, a closed merged worktree, a seat-anchored
# worktree, an orphaned checkout directory, and a build cache.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
PRUNE="${1:-$HERE/prune.ts}"
SCRUB="$HERE/evidence-scrub.sh"
[ -f "$PRUNE" ] || { echo "selftest: not found: $PRUNE" >&2; exit 2; }
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "selftest: git is required" >&2; exit 2; }
command -v bd >/dev/null 2>&1 || { echo "selftest: bd is required" >&2; exit 2; }

exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-prune-selftest.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
cleanup(){ rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

ROOT="$FIX/container"
PROD="$ROOT/product"
WTS="$ROOT/.wheelhouse-worktrees"
mkdir -p "$PROD" "$WTS" "$ROOT/seats"
cp "$PRUNE" "$ROOT/seats/prune.ts"
chmod +x "$ROOT/seats/prune.ts"

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

( cd "$ROOT" && bd init --non-interactive --skip-agents -p prune >/dev/null 2>&1 ) || { echo "selftest: bd init failed" >&2; exit 2; }
CLOSED_ID=$(cd "$ROOT" && bd create 'closed merged worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
OPEN_ID=$(cd "$ROOT" && bd create 'seat anchored worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
cd "$ROOT" && bd close "$CLOSED_ID" >/dev/null 2>&1

git -C "$PROD" worktree add -q -b "fleet/$CLOSED_ID" "$WTS/$CLOSED_ID" main
printf 'closed work\n' >> "$WTS/$CLOSED_ID/app.txt"
git -C "$WTS/$CLOSED_ID" add app.txt
git -C "$WTS/$CLOSED_ID" commit -q -m "closed work"
git -C "$PROD" checkout -q main
git -C "$PROD" merge -q --no-ff "fleet/$CLOSED_ID" -m "merge closed work"
git -C "$PROD" push -q origin main

git -C "$PROD" worktree add -q -b "fleet/$OPEN_ID" "$WTS/$OPEN_ID" main
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"}}}\n' "$WTS/$OPEN_ID" > "$ROOT/seats/state.json"

mkdir -p "$WTS/orphaned-checkout" "$PROD/.wheelhouse-build"
printf 'orphan\n' > "$WTS/orphaned-checkout/file.txt"
printf 'cache\n' > "$PROD/.wheelhouse-build/cache.txt"

phase 'categories verb'
CATS=$(cd "$ROOT" && bun seats/prune.ts categories 2>&1)
if printf '%s\n' "$CATS" | grep -q 'merged-worktree' && printf '%s\n' "$CATS" | grep -q 'seat-anchor'; then pass 'categories names worktree and seat safety categories'; else fail "categories output missing expected categories: $CATS"; fi

phase 'scan classifies fixture rows'
SCAN="$FIX/scan.tsv"
( cd "$ROOT" && bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan failed" >&2; exit 2; }
if awk -F '\t' -v p="$WTS/$CLOSED_ID" '$1=="merged-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed merged clean worktree is safe merged-worktree'; else fail "closed merged worktree row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$OPEN_ID" '$1=="seat-anchor" && $2=="0" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'seat cwd is classified as non-prunable seat-anchor'; else fail "seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/orphaned-checkout" '$1=="orphaned-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'orphaned checkout is safe orphaned-worktree'; else fail "orphaned row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/.wheelhouse-build" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'build cache is safe build-cache'; else fail "build-cache row missing:\n$(cat "$SCAN")"; fi

phase 'dry-run does not touch rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --categories merged-worktree,orphaned-worktree,build-cache >/tmp/prune-dry.out )
if [ -d "$WTS/$CLOSED_ID" ] && [ -d "$WTS/orphaned-checkout" ] && [ -d "$PROD/.wheelhouse-build" ]; then pass 'prune without --yes is dry-run only'; else fail 'dry-run removed a fixture path'; fi

phase 'prune acts only on safe selected rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --yes --categories merged-worktree,orphaned-worktree,build-cache > "$FIX/prune.out" )
if [ ! -e "$WTS/$CLOSED_ID" ] && ! git -C "$PROD" worktree list --porcelain | grep -qF "$WTS/$CLOSED_ID"; then pass 'safe merged worktree removed by git worktree remove'; else fail 'safe merged worktree still exists or is registered'; fi
[ ! -e "$WTS/orphaned-checkout" ] && pass 'safe orphaned checkout removed' || fail 'orphaned checkout still exists'
[ ! -e "$PROD/.wheelhouse-build" ] && pass 'safe build cache removed' || fail 'build cache still exists'
[ -d "$WTS/$OPEN_ID" ] && pass 'seat-anchor worktree remains' || fail 'seat-anchor worktree was removed'
if grep -q 'prune summary: touched=3' "$FIX/prune.out"; then pass 'prune summary reports three touched rows'; else fail "unexpected prune summary: $(cat "$FIX/prune.out")"; fi

if [ "$FAILED" -eq 0 ]; then
  echo 'prune.selftest: PASS'
  exit 0
fi
echo "prune.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
