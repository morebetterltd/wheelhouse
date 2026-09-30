#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
# Hermetic selftest for seats/prune.ts. It builds a scratch wheelhouse
# container with a product repo, a closed merged worktree, a seat-anchored
# worktree, an orphaned checkout directory, bead-named scratch, fake simctl
# devices, an idle XCTestDevices set, and build caches.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
PRUNE="${1:-$HERE/prune.ts}"
SCRUB="$HERE/evidence-scrub.sh"
[ -f "$PRUNE" ] || { echo "selftest: not found: $PRUNE" >&2; exit 2; }
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "selftest: git is required" >&2; exit 2; }
command -v bd >/dev/null 2>&1 || { echo "selftest: bd is required" >&2; exit 2; }

# Evidence captures should pipe this script through seats/evidence-scrub.sh;
# self-scrubbing here leaves process-substitution readers behind on some shells.
FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-prune-selftest.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
TMP_SCRATCH=()
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; rm -rf ${TMP_SCRATCH[@]+"${TMP_SCRATCH[@]}"}; }
trap cleanup EXIT INT TERM
export HOME="$FIX/home"
mkdir -p "$HOME"

ROOT="$FIX/container"
PROD="$ROOT/product"
WTS="$ROOT/.wheelhouse-worktrees"
mkdir -p "$PROD" "$WTS" "$ROOT/seats"
cp "$PRUNE" "$ROOT/seats/prune.ts"
cp "$(dirname "$PRUNE")/seat-worktree.ts" "$ROOT/seats/seat-worktree.ts"
chmod +x "$ROOT/seats/prune.ts"

git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email selftest@example.invalid
git -C "$ROOT" config user.name selftest

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
OPEN_LIVE_ID=$(cd "$ROOT" && bd create 'open live cwd anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
LIVE_ID=$(cd "$ROOT" && bd create 'closed live cwd anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
CLOSED_LIVE_ID=$(cd "$ROOT" && bd create 'closed live cwd needs-review' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
HIST_ID=$(cd "$ROOT" && bd create 'closed session history anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
STALE_ID=$(cd "$ROOT" && bd create 'closed stale branch no worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
UNMERGED_ID=$(cd "$ROOT" && bd create 'closed unmerged branch must survive' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
GOAL_CHILD_ID=$(cd "$ROOT" && bd create 'closed child merged only to goal branch' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
cd "$ROOT" && bd close "$CLOSED_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$LIVE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$CLOSED_LIVE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$HIST_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$STALE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$UNMERGED_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$GOAL_CHILD_ID" >/dev/null 2>&1

make_closed_worktree(){
  local id="$1" msg="$2"
  git -C "$PROD" worktree add -q -b "fleet/$id" "$WTS/$id" main
  printf '%s\n' "$msg" >> "$WTS/$id/app.txt"
  git -C "$WTS/$id" add app.txt
  git -C "$WTS/$id" commit -q -m "$msg"
  git -C "$PROD" checkout -q main
  git -C "$PROD" merge -q --no-ff "fleet/$id" -m "merge $msg"
  git -C "$PROD" push -q origin main
}
make_closed_worktree "$CLOSED_ID" "closed work"
git -C "$PROD" push -q origin "fleet/$CLOSED_ID"
make_closed_worktree "$LIVE_ID" "live cwd work"
make_closed_worktree "$CLOSED_LIVE_ID" "closed live cwd work"
make_closed_worktree "$HIST_ID" "history cwd work"
make_closed_worktree "$STALE_ID" "stale branch work"
git -C "$PROD" worktree remove --force "$WTS/$STALE_ID"
git -C "$PROD" push -q origin "fleet/$STALE_ID"
STALE_SHA="$(git -C "$PROD" rev-parse "fleet/$STALE_ID")"

git -C "$PROD" worktree add -q -b "fleet/$UNMERGED_ID" "$WTS/$UNMERGED_ID" main
printf 'unmerged work\n' >> "$WTS/$UNMERGED_ID/app.txt"
git -C "$WTS/$UNMERGED_ID" add app.txt
git -C "$WTS/$UNMERGED_ID" commit -q -m 'unmerged work'
git -C "$PROD" push -q origin "fleet/$UNMERGED_ID"

git -C "$PROD" checkout -q -b fleet/goal-x main
git -C "$PROD" push -q -u origin fleet/goal-x
git -C "$PROD" checkout -q main
git -C "$PROD" worktree add -q -b "fleet/$GOAL_CHILD_ID" "$WTS/$GOAL_CHILD_ID" main
printf 'goal child work\n' >> "$WTS/$GOAL_CHILD_ID/app.txt"
git -C "$WTS/$GOAL_CHILD_ID" add app.txt
git -C "$WTS/$GOAL_CHILD_ID" commit -q -m 'goal child work'
git -C "$PROD" checkout -q fleet/goal-x
git -C "$PROD" merge -q --no-ff "fleet/$GOAL_CHILD_ID" -m 'merge goal child work'
git -C "$PROD" push -q origin fleet/goal-x
git -C "$PROD" push -q origin "fleet/$GOAL_CHILD_ID"
git -C "$PROD" checkout -q main

git -C "$PROD" worktree add -q -b "fleet/$OPEN_ID" "$WTS/$OPEN_ID" main
git -C "$PROD" worktree add -q -b "fleet/$OPEN_LIVE_ID" "$WTS/$OPEN_LIVE_ID" main
mkdir -p "$ROOT/seats/logs" "$ROOT/seats/sessions"
SESSION_HISTORY="$ROOT/seats/sessions/history.jsonl"
printf '{"type":"session-start","cwd":"%s"}\n' "$WTS/$HIST_ID" > "$SESSION_HISTORY"
( cd "$WTS/$LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
LIVE_PID=$!
( cd "$WTS/$OPEN_LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
OPEN_LIVE_PID=$!
( cd "$WTS/$CLOSED_LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
CLOSED_LIVE_PID=$!
TMP_SCRATCH+=()
cleanup_live(){ kill "$LIVE_PID" "$OPEN_LIVE_PID" "$CLOSED_LIVE_PID" >/dev/null 2>&1 || true; }
cleanup_prune(){ cleanup_live; cleanup; }
trap cleanup_prune EXIT INT TERM
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"},"worker-live":{"pid":%s,"cwd":"%s"},"worker-history":{"pid":999998,"cwd":"%s","sessionFile":"%s"}}}\n' "$WTS/$OPEN_ID" "$LIVE_PID" "$WTS/$OPEN_ID" "$WTS/$OPEN_ID" "$SESSION_HISTORY" > "$ROOT/seats/state.json"
printf '{"seats":{"worker-rostered":{}}}\n' > "$ROOT/seats/seats.json"
mkdir -p "$WTS/worker-rostered"

mkdir -p "$WTS/orphaned-checkout" "$PROD/.wheelhouse-build" "$PROD/obj" "$PROD/dist" "$PROD/node_modules/pkg/dist" "$PROD/node_modules/.bin" "$ROOT/.wheelhouse-bench.lock.stale.12345"
printf 'orphan\n' > "$WTS/orphaned-checkout/file.txt"
printf 'cache\n' > "$PROD/.wheelhouse-build/cache.txt"
printf 'obj-cache\n' > "$PROD/obj/cache.txt"
printf 'root-dist\n' > "$PROD/dist/app.js"
printf 'package-dist\n' > "$PROD/node_modules/pkg/dist/index.js"
printf 'package-bin\n' > "$PROD/node_modules/.bin/tool"
printf 'stale-lock\n' > "$ROOT/.wheelhouse-bench.lock.stale.12345/pid"

mkdir -p "$ROOT/.wheelhouse-runs/$CLOSED_ID-build" "$ROOT/.wheelhouse-runs/$OPEN_ID-build"
printf 'closed runs scratch\n' > "$ROOT/.wheelhouse-runs/$CLOSED_ID-build/file.txt"
printf 'open runs scratch\n' > "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt"
TMP_ROOT="${TMPDIR:-/private/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
mkdir -p "$TMP_ROOT"
CLOSED_TMP="$TMP_ROOT/$CLOSED_ID-derivedData"
OPEN_TMP="$TMP_ROOT/$OPEN_ID-derivedData"
mkdir -p "$CLOSED_TMP" "$OPEN_TMP"
printf 'closed tmp scratch\n' > "$CLOSED_TMP/file.txt"
printf 'open tmp scratch\n' > "$OPEN_TMP/file.txt"
TMP_SCRATCH+=("$CLOSED_TMP" "$OPEN_TMP")
OPEN_RUNS_BEFORE=$(shasum -a 256 "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" | awk '{print $1}')
OPEN_TMP_BEFORE=$(shasum -a 256 "$OPEN_TMP/file.txt" | awk '{print $1}')

FAKEBIN="$FIX/fakebin"
SIMDATA_CLOSED="$FIX/simdata-closed"
SIMDATA_OPEN="$FIX/simdata-open"
mkdir -p "$FAKEBIN" "$SIMDATA_CLOSED" "$SIMDATA_OPEN" "$HOME/Library/Developer/XCTestDevices"
printf 'closed simulator bytes\n' > "$SIMDATA_CLOSED/payload"
printf 'open simulator bytes\n' > "$SIMDATA_OPEN/payload"
printf 'xctest device bytes\n' > "$HOME/Library/Developer/XCTestDevices/payload"
cat > "$FAKEBIN/pgrep" <<'SH'
#!/usr/bin/env bash
[ "$1" = "-x" ] && [ "$2" = "xcodebuild" ] && exit 1
exit 1
SH
cat > "$FAKEBIN/xcrun" <<SH
#!/usr/bin/env bash
set -eu
LOG="$FIX/xcrun.log"
if [ "\${1:-}" != simctl ]; then exit 2; fi
shift
if [ "\${1:-}" = help ]; then echo help; exit 0; fi
if [ "\${1:-}" = list ] && [ "\${2:-}" = devices ]; then
cat <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"$CLOSED_ID-walk","udid":"CLOSED-UDID","state":"Shutdown","dataPath":"$SIMDATA_CLOSED"},{"name":"$OPEN_ID-walk","udid":"OPEN-UDID","state":"Shutdown","dataPath":"$SIMDATA_OPEN"}]}}
JSON
exit 0
fi
if [ "\${1:-}" = --set ] && [ "\${3:-}" = list ]; then
cat <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"XCTest clone","udid":"XCTEST-UDID","state":"Shutdown"}]}}
JSON
exit 0
fi
if [ "\${1:-}" = delete ]; then echo "delete \${2:-}" >> "\$LOG"; exit 0; fi
if [ "\${1:-}" = --set ] && [ "\${3:-}" = delete ] && [ "\${4:-}" = all ]; then echo "set-delete \${2:-} all" >> "\$LOG"; rm -rf "\${2:-}"; exit 0; fi
exit 2
SH
chmod +x "$FAKEBIN/pgrep" "$FAKEBIN/xcrun"
export PATH="$FAKEBIN:$PATH"

BUSY="$FIX/busy-container"
mkdir -p "$BUSY/seats" "$BUSY/.wheelhouse-bench.lock" "$BUSY/product/.wheelhouse-build"
printf '{"seats":{}}\n' > "$BUSY/seats/state.json"
cp "$PRUNE" "$BUSY/seats/prune.ts"
cp "$(dirname "$PRUNE")/seat-worktree.ts" "$BUSY/seats/seat-worktree.ts"
chmod +x "$BUSY/seats/prune.ts"
printf 'active-lock\n' > "$BUSY/.wheelhouse-bench.lock/pid"
printf 'busy-cache\n' > "$BUSY/product/.wheelhouse-build/cache.txt"

phase 'categories verb'
CATS=$(cd "$ROOT" && bun seats/prune.ts categories 2>&1)
if printf '%s\n' "$CATS" | grep -q 'merged-worktree' && printf '%s\n' "$CATS" | grep -q 'seat-anchor' && printf '%s\n' "$CATS" | grep -q 'bench-junk' && printf '%s\n' "$CATS" | grep -q 'run-scratch' && printf '%s\n' "$CATS" | grep -q 'bead-tmp' && printf '%s\n' "$CATS" | grep -q 'bead-simulator' && printf '%s\n' "$CATS" | grep -q 'xctest-devices'; then pass 'categories names worktree, bench-junk, scratch, simulator, xctest, and seat safety categories'; else fail "categories output missing expected categories: $CATS"; fi

phase 'scan classifies fixture rows'
SCAN="$FIX/scan.tsv"
( cd "$ROOT" && bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan failed" >&2; exit 2; }
if awk -F '\t' -v p="$WTS/$CLOSED_ID" '$1=="merged-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed merged clean worktree is safe merged-worktree'; else fail "closed merged worktree row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v b="fleet/$STALE_ID" '$1=="stale-branch" && $2=="1" && $5==b && $6=="0" && $7=="0.0B" {found=1} END{exit found?0:1}' "$SCAN"; then pass 'safe stale-branch reports zero reclaimed size'; else fail "stale-branch zero-size row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$UNMERGED_ID" '$1=="needs-review" && $2=="0" && $4==p && $5 ~ /^fleet\// && $9 ~ /not merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed but unmerged fleet worktree is needs-review'; else fail "unmerged branch guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$GOAL_CHILD_ID" '$1=="needs-review" && $2=="0" && $4==p && $5 ~ /^fleet\// && $9 ~ /not merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'goal-branch child is needs-review before integration-refs.txt exists'; else fail "goal child before integration-refs row missing:\n$(cat "$SCAN")"; fi
cat > "$ROOT/seats/integration-refs.txt" <<'EOF'
# extra integration branches for this install

fleet/goal-x
fleet/never-created
EOF
( cd "$ROOT" && bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan with integration-refs failed" >&2; exit 2; }
if awk -F '\t' -v p="$WTS/$GOAL_CHILD_ID" '$1=="merged-worktree" && $2=="1" && $4==p && $5 ~ /^fleet\// {found=1} END{exit found?0:1}' "$SCAN"; then pass 'goal-branch child becomes safe merged-worktree when its goal branch is listed'; else fail "goal child merged-worktree row missing after integration-refs:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v b="fleet/goal-x" '$1=="needs-review" && $2=="0" && $5==b && $9 ~ /listed integration ref/ {found=1} $1=="stale-branch" && $5==b {bad=1} END{exit found && !bad ? 0 : 1}' "$SCAN"; then pass 'listed goal branch is needs-review, never stale-branch'; else fail "listed goal branch guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$UNMERGED_ID" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /not merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'listed goal ref does not widen matching to unrelated fleet branches'; else fail "unrelated unmerged branch was widened by integration-refs:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$OPEN_ID" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /recorded cwd/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'current recorded seat cwd is classified as non-prunable seat-anchor'; else fail "recorded cwd seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/worker-rostered" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /worktree of rostered seat worker-rostered/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'rostered .wheelhouse-worktrees/<seat> directory is classified as non-prunable seat-anchor'; else fail "rostered seat worktree anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$LIVE_ID" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /live cwd/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'live lsof cwd beats stale state.json cwd and is a seat-anchor'; else fail "live cwd seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$CLOSED_LIVE_ID" -v id="$CLOSED_LIVE_ID" '$1=="needs-review" && $2=="0" && $4==p && $9 == "live process has its cwd here; worktree belongs to closed bead " id {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead live-cwd worktree reason includes exact closed-bead wording'; else fail "closed bead live-cwd reason missing exact wording:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$OPEN_LIVE_ID" -v id="$OPEN_LIVE_ID" '$1=="needs-review" && $2=="0" && $4==p && $9 == "live process has its cwd here; worktree belongs to open bead " id {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead live-cwd worktree reason includes exact open-bead wording'; else fail "open bead live-cwd reason missing exact wording:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$HIST_ID" '$1=="merged-worktree" && $2=="1" && $4==p {found=1} $1=="seat-anchor" && $4==p {bad=1} END{exit found && !bad ? 0 : 1}' "$SCAN"; then pass 'session history cwd is scanned by normal closed-bead worktree rules, not as a seat-anchor'; else fail "session history worktree did not become a safe merged-worktree:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/orphaned-checkout" '$1=="orphaned-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'orphaned checkout is safe orphaned-worktree'; else fail "orphaned row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/.wheelhouse-build" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'build cache is safe build-cache'; else fail "build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/obj" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass '.NET obj cache is safe build-cache'; else fail "obj build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/dist" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'root dist is safe build-cache'; else fail "root dist build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/node_modules/pkg/dist" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /dependency/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'node_modules package dist is needs-review, not safe build-cache'; else fail "node_modules dist guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/node_modules/.bin" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /dependency/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'node_modules .bin is needs-review, not safe build-cache'; else fail "node_modules .bin guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$4 ~ /\/node_modules\// && $2=="1" {bad=1} END{exit bad?1:0}' "$SCAN"; then pass 'no safe scan rows appear under node_modules'; else fail "safe node_modules row present:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-bench.lock.stale.12345" '$1=="bench-junk" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'stale bench lock is safe bench-junk'; else fail "bench-junk row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-runs/$CLOSED_ID-build" '$1=="run-scratch" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead .wheelhouse-runs scratch is safe run-scratch'; else fail "closed bead-runs row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-runs/$OPEN_ID-build" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead .wheelhouse-runs scratch is needs-review'; else fail "open bead-runs guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$CLOSED_TMP" '$1=="bead-tmp" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead tmp scratch is safe bead-tmp'; else fail "closed bead-tmp row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$OPEN_TMP" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead tmp scratch is needs-review'; else fail "open bead-tmp guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$1=="bead-simulator" && $2=="1" && $4=="simctl:CLOSED-UDID" {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead simctl device is safe bead-simulator'; else fail "closed bead-simulator row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$1=="needs-review" && $2=="0" && $4=="simctl:OPEN-UDID" && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead simctl device is needs-review'; else fail "open bead-simulator guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$HOME/Library/Developer/XCTestDevices" '$1=="xctest-devices" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'idle XCTestDevices set is safe xctest-devices'; else fail "xctest-devices row missing:\n$(cat "$SCAN")"; fi

phase 'active bench lock makes caches review-only'
BUSY_SCAN="$FIX/busy-scan.tsv"
( cd "$BUSY" && bun seats/prune.ts scan > "$BUSY_SCAN" ) || { echo "selftest: busy scan failed" >&2; exit 2; }
if awk -F '\t' -v p="$BUSY/product/.wheelhouse-build" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /bench lock present/ {found=1} END{exit found?0:1}' "$BUSY_SCAN"; then pass 'active bench lock reclassifies cache as needs-review'; else fail "busy cache was not guarded:\n$(cat "$BUSY_SCAN")"; fi
( cd "$BUSY" && bun seats/prune.ts prune --from-file "$BUSY_SCAN" --yes --categories build-cache,needs-review > "$FIX/busy-prune.out" )
[ -d "$BUSY/product/.wheelhouse-build" ] && pass 'active-bench cache remains after prune --yes' || fail 'active-bench cache was removed'

phase 'dry-run does not touch rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --categories merged-worktree,orphaned-worktree,build-cache,bench-junk,bead-runs,bead-tmp,bead-simulator,xctest-devices > "$FIX/prune-dry.out" )
if [ -d "$WTS/$CLOSED_ID" ] && [ -d "$WTS/orphaned-checkout" ] && [ -d "$PROD/.wheelhouse-build" ] && [ -d "$PROD/dist" ] && [ -d "$PROD/node_modules/pkg/dist" ] && [ -d "$PROD/node_modules/.bin" ] && [ -d "$ROOT/.wheelhouse-bench.lock.stale.12345" ] && [ -d "$ROOT/.wheelhouse-runs/$CLOSED_ID-build" ] && [ -d "$CLOSED_TMP" ] && [ -d "$HOME/Library/Developer/XCTestDevices" ]; then pass 'prune without --yes is dry-run only'; else fail 'dry-run removed a fixture path'; fi
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --categories stale-branch > "$FIX/stale-branch-dry.out" )
if grep -q 'DRY-RUN branch stale-branch' "$FIX/stale-branch-dry.out" && grep -q 'reclaimed_bytes=0 reclaimed_human=0.0B' "$FIX/stale-branch-dry.out"; then pass 'stale-branch dry-run contributes zero reclaimed bytes'; else fail "stale-branch dry-run reclaimed bytes unexpectedly: $(cat "$FIX/stale-branch-dry.out")"; fi

phase 'prune --yes refuses while a rostered seat is mid-turn'
MID="$FIX/midturn"
mkdir -p "$MID/seats" "$MID/product/.wheelhouse-build"
cp "$PRUNE" "$MID/seats/prune.ts"
cp "$(dirname "$PRUNE")/seat-worktree.ts" "$MID/seats/seat-worktree.ts"
chmod +x "$MID/seats/prune.ts"
MID_FIFO="$MID/seats/mid.stdin"
MID_LOG="$MID/seats/mid.jsonl"
mkfifo "$MID_FIFO"
touch "$MID_LOG"
(
  while IFS= read -r line; do
    id=$(printf '%s\n' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [ -n "$id" ] && printf '{"id":"%s","type":"response","success":true,"data":{"isStreaming":true}}\n' "$id" >> "$MID_LOG"
  done <>"$MID_FIFO"
) >/dev/null 2>&1 &
MID_PID=$!
printf '{"seats":{"worker-busy":{"pid":%s,"cwd":"%s","fifo":"%s","log":"%s"}}}\n' "$MID_PID" "$MID/product" "$MID_FIFO" "$MID_LOG" > "$MID/seats/state.json"
printf 'category\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason\nbuild-cache\t1\t%s\t%s\t\t1\t1.0B\trm\tfixture\n' "$MID" "$MID/product/.wheelhouse-build" > "$FIX/mid-scan.tsv"
( cd "$MID" && bun seats/prune.ts prune --from-file "$FIX/mid-scan.tsv" > "$FIX/mid-dry.out" )
[ -d "$MID/product/.wheelhouse-build" ] && pass 'mid-turn seat still allows dry-run scan/prune preview' || fail 'mid-turn dry-run removed cache'
set +e
MID_RC=0; MID_OUT=$(cd "$MID" && bun seats/prune.ts prune --from-file "$FIX/mid-scan.tsv" --yes 2>&1) || MID_RC=$?
set +e
if [ $MID_RC -ne 0 ] && printf '%s\n' "$MID_OUT" | grep -q 'worker-busy' && printf '%s\n' "$MID_OUT" | grep -q 'mid-turn'; then pass 'prune --yes STOPs naming the mid-turn seat'; else fail "mid-turn prune did not STOP as specified (exit $MID_RC): $MID_OUT"; fi
[ -d "$MID/product/.wheelhouse-build" ] && pass 'mid-turn guarded cache remains after refused prune --yes' || fail 'mid-turn guarded cache was removed'
kill "$MID_PID" >/dev/null 2>&1 || true

phase 'prune --yes rechecks live seat anchors from reviewed scan files'
printf 'category\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason\norphaned-worktree\t1\t%s\t%s\t\t1\t1.0B\trm\tstale reviewed scan fixture\n' "$ROOT" "$WTS/$LIVE_ID" > "$FIX/stale-live-scan.tsv"
set +e
STALE_RC=0; STALE_OUT=$(cd "$ROOT" && bun seats/prune.ts prune --from-file "$FIX/stale-live-scan.tsv" --yes --categories orphaned-worktree 2>&1) || STALE_RC=$?
set +e
if [ $STALE_RC -ne 0 ] && printf '%s\n' "$STALE_OUT" | grep -q 'worker-live' && printf '%s\n' "$STALE_OUT" | grep -q 'refusing to prune'; then pass 'prune --yes refuses a stale safe row that is now a live seat cwd'; else fail "stale live-cwd row was not refused (exit $STALE_RC): $STALE_OUT"; fi
[ -d "$WTS/$LIVE_ID" ] && pass 'stale-scan live seat cwd remains after refused prune --yes' || fail 'stale-scan live seat cwd was removed'
printf 'category\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason\nmerged-worktree\t1\t%s\t%s\tfleet/%s\t1\t1.0B\tworktree\tstale reviewed scan fixture\n' "$PROD" "$WTS/$HIST_ID" "$HIST_ID" > "$FIX/stale-session-scan.tsv"
set +e
SESSION_STALE_RC=0; SESSION_STALE_OUT=$(cd "$ROOT" && bun seats/prune.ts prune --from-file "$FIX/stale-session-scan.tsv" --yes --categories merged-worktree 2>&1) || SESSION_STALE_RC=$?
set -e
if [ $SESSION_STALE_RC -eq 0 ] && printf '%s\n' "$SESSION_STALE_OUT" | grep -q "PRUNED worktree merged-worktree $WTS/$HIST_ID" && ! printf '%s\n' "$SESSION_STALE_OUT" | grep -q 'session history cwd'; then pass 'prune --yes removes a reviewed safe row that appears only in stored session history'; else fail "stale session-history row was not removed cleanly (exit $SESSION_STALE_RC): $SESSION_STALE_OUT"; fi
[ ! -d "$WTS/$HIST_ID" ] && pass 'stale-scan session-history worktree is removed by prune --yes' || fail 'stale-scan session-history worktree remains'

phase 'prune acts only on safe selected rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --yes --categories merged-worktree,orphaned-worktree,build-cache,bench-junk,bead-runs,bead-tmp,bead-simulator,xctest-devices > "$FIX/prune.out" )
if [ ! -e "$WTS/$CLOSED_ID" ] && ! git -C "$PROD" worktree list --porcelain | grep -qF "$WTS/$CLOSED_ID"; then pass 'safe merged worktree removed by git worktree remove'; else fail 'safe merged worktree still exists or is registered'; fi
if git -C "$PROD" branch --list "fleet/$CLOSED_ID" | grep -q . && git -C "$PROD" log -1 --format=%s "fleet/$CLOSED_ID" >/dev/null && ! grep -q 'PRUNED branch' "$FIX/prune.out"; then pass 'safe merged worktree prune keeps its merged branch ref'; else fail "merged worktree branch was deleted or PRUNED branch was logged: branch=$(git -C "$PROD" branch --list "fleet/$CLOSED_ID") output=$(cat "$FIX/prune.out")"; fi
if [ ! -e "$WTS/$GOAL_CHILD_ID" ] && git -C "$PROD" branch --list "fleet/$GOAL_CHILD_ID" | grep -q . && git -C "$PROD" log -1 --format=%s "fleet/$GOAL_CHILD_ID" >/dev/null && ! grep -q 'PRUNED branch' "$FIX/prune.out" && git -C "$PROD" branch --list fleet/goal-x | grep -q .; then pass 'goal-branch merged worktree prunes worktree while child and listed goal branches survive'; else fail "goal-branch prune outcome wrong: child_dir=$([ -e "$WTS/$GOAL_CHILD_ID" ] && echo present || echo gone) child_branch=$(git -C "$PROD" branch --list "fleet/$GOAL_CHILD_ID") goal_branch=$(git -C "$PROD" branch --list fleet/goal-x) output=$(cat "$FIX/prune.out")"; fi
if git -C "$PROD" branch --list "fleet/$UNMERGED_ID" | grep -q .; then pass 'unmerged fleet branch is not deleted by merged-worktree prune path'; else fail 'unmerged fleet branch was deleted'; fi
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --yes --categories stale-branch > "$FIX/stale-branch-prune.out" )
if ! git -C "$PROD" branch --list "fleet/$STALE_ID" | grep -q . \
  && grep -q "TAGGED archive/$STALE_ID ${STALE_SHA:0:12} before deleting fleet/$STALE_ID" "$FIX/stale-branch-prune.out" \
  && [ "$(git -C "$PROD" rev-parse "archive/$STALE_ID^{commit}" 2>/dev/null)" = "$STALE_SHA" ]; then
  pass 'stale-branch prune archive-tags the branch tip before deleting the branch ref'
else
  fail "stale-branch prune did not archive-tag before delete: branch=$(git -C "$PROD" branch --list "fleet/$STALE_ID") tag=$(git -C "$PROD" rev-parse "archive/$STALE_ID^{commit}" 2>/dev/null) want=$STALE_SHA output=$(cat "$FIX/stale-branch-prune.out")"
fi
[ ! -e "$WTS/orphaned-checkout" ] && pass 'safe orphaned checkout removed' || fail 'orphaned checkout still exists'
[ ! -e "$PROD/.wheelhouse-build" ] && pass 'safe build cache removed' || fail 'build cache still exists'
[ ! -e "$PROD/obj" ] && pass 'safe .NET obj cache removed' || fail 'obj cache still exists'
[ ! -e "$PROD/dist" ] && pass 'safe root dist cache removed' || fail 'root dist cache still exists'
[ ! -e "$ROOT/.wheelhouse-bench.lock.stale.12345" ] && pass 'safe stale bench lock removed' || fail 'stale bench lock still exists'
[ ! -e "$ROOT/.wheelhouse-runs/$CLOSED_ID-build" ] && pass 'safe closed bead runs scratch removed' || fail 'closed bead runs scratch still exists'
[ ! -e "$CLOSED_TMP" ] && pass 'safe closed bead tmp scratch removed' || fail 'closed bead tmp scratch still exists'
grep -q 'delete CLOSED-UDID' "$FIX/xcrun.log" && pass 'safe closed bead simulator deleted by simctl' || fail "closed bead simulator delete missing: $(cat "$FIX/xcrun.log" 2>/dev/null)"
grep -q "set-delete $HOME/Library/Developer/XCTestDevices all" "$FIX/xcrun.log" && [ ! -e "$HOME/Library/Developer/XCTestDevices" ] && pass 'idle XCTestDevices set deleted with simctl --set' || fail "XCTestDevices set delete missing: $(cat "$FIX/xcrun.log" 2>/dev/null)"
[ -d "$PROD/node_modules/pkg/dist" ] && pass 'node_modules package dist remains after prune --yes' || fail 'node_modules package dist was removed'
[ -d "$PROD/node_modules/.bin" ] && pass 'node_modules .bin remains after prune --yes' || fail 'node_modules .bin was removed'
[ -d "$WTS/$OPEN_ID" ] && pass 'recorded-cwd seat-anchor worktree remains' || fail 'recorded-cwd seat-anchor worktree was removed'
[ -d "$WTS/worker-rostered" ] && pass 'rostered seat worktree remains' || fail 'rostered seat worktree was removed'
[ -d "$WTS/$LIVE_ID" ] && pass 'live-cwd seat-anchor worktree remains' || fail 'live-cwd seat-anchor worktree was removed'
[ ! -d "$WTS/$HIST_ID" ] && pass 'session-history worktree was removed by normal pruning rules' || fail 'session-history worktree remains'
OPEN_RUNS_AFTER=$(shasum -a 256 "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" | awk '{print $1}')
OPEN_TMP_AFTER=$(shasum -a 256 "$OPEN_TMP/file.txt" | awk '{print $1}')
[ "$OPEN_RUNS_BEFORE" = "$OPEN_RUNS_AFTER" ] && pass 'open bead runs scratch remains byte-identical' || fail 'open bead runs scratch changed'
[ "$OPEN_TMP_BEFORE" = "$OPEN_TMP_AFTER" ] && pass 'open bead tmp scratch remains byte-identical' || fail 'open bead tmp scratch changed'
if ! grep -q 'delete OPEN-UDID' "$FIX/xcrun.log"; then pass 'open bead simulator is not deleted'; else fail "open bead simulator was deleted: $(cat "$FIX/xcrun.log")"; fi
if grep -q 'prune summary: touched=12' "$FIX/prune.out" && grep -q 'reclaimed_bytes=' "$FIX/prune.out"; then pass 'prune summary reports twelve touched rows and reclaimed bytes'; else fail "unexpected prune summary: $(cat "$FIX/prune.out")"; fi

# ---------------------------------------------------------------------------
# cleanup phases. One empty install proves the fresh-install case; every other
# phase seeds its own beads and paths in one shared install ($EXT) and scopes
# its cleanup with --bead, so phases never act on each other's rows.
# ---------------------------------------------------------------------------
set +e   # the phase above left -e on; these phases inspect exit codes themselves
json_id(){ bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)'; }
EXT_PIDS=()
cleanup_ext(){ for p in ${EXT_PIDS[@]+"${EXT_PIDS[@]}"}; do kill "$p" >/dev/null 2>&1 || true; done; cleanup_prune; }
trap cleanup_ext EXIT INT TERM
mk_install(){ # $1 root: container git repo, nested product repo with a bare origin at $1.origin.git, prune.ts in place
  mkdir -p "$1/product" "$1/seats"
  cp "$PRUNE" "$1/seats/prune.ts"; cp "$(dirname "$PRUNE")/seat-worktree.ts" "$1/seats/seat-worktree.ts"
  git -C "$1" init -q -b main
  git -C "$1/product" init -q -b main
  git -C "$1/product" config user.email selftest@example.invalid
  git -C "$1/product" config user.name selftest
  printf 'base\n' > "$1/product/app.txt"
  git -C "$1/product" add app.txt; git -C "$1/product" commit -q -m base
  git -C "$1/product" init --bare -q "$1.origin.git"
  git -C "$1/product" remote add origin "$1.origin.git"
  git -C "$1/product" push -q -u origin main
}

phase 'ISC-71 fresh install with zero worktrees'
FRESH="$FIX/fresh"; mk_install "$FRESH"; mkdir -p "$FIX/fresh-home"
FRESH_SCAN=$(cd "$FRESH" && HOME="$FIX/fresh-home" bun seats/prune.ts scan --format jsonl 2>&1); FRESH_RC=$?
[ "$FRESH_RC" -eq 0 ] && [ -z "$FRESH_SCAN" ] && pass 'scan on a fresh install prints nothing and exits 0' || fail "fresh scan rc=$FRESH_RC output: $FRESH_SCAN"
FRESH_OUT=$(cd "$FRESH" && HOME="$FIX/fresh-home" bun seats/prune.ts cleanup 2>&1); FRESH_RC=$?
[ "$FRESH_RC" -eq 0 ] && [ "$(printf '%s\n' "$FRESH_OUT" | grep -c .)" -eq 1 ] && printf '%s\n' "$FRESH_OUT" | grep -q 'Z cleanup done removed=0 kept=0 bytes=0$' && pass 'cleanup on a fresh install prints only "cleanup done removed=0 kept=0 bytes=0" and exits 0' || fail "fresh cleanup rc=$FRESH_RC output: $FRESH_OUT"

EXT="$FIX/ext"; EPROD="$EXT/product"; EWTS="$EXT/.wheelhouse-worktrees"; ERUNS="$EXT/.wheelhouse-runs"; ELOG="$EXT/seats/logs/cleanup.log"
mk_install "$EXT"; mkdir -p "$EWTS" "$ERUNS"
( cd "$EXT" && bd init --non-interactive --skip-agents -p ext >/dev/null 2>&1 ) || { echo "selftest: bd init failed in $EXT" >&2; exit 2; }
ext_bead(){ local id; id=$(cd "$EXT" && bd create "$1" --json | json_id); [ "${2:-closed}" = closed ] && ( cd "$EXT" && bd close "$id" >/dev/null 2>&1 ); printf '%s\n' "$id"; }
ext_wt(){ # $1 bead id, $2 optional dir: worktree on fleet/<id> with one commit touching <id>.txt
  local dir="${2:-$EWTS/$1}"
  git -C "$EPROD" worktree add -q -b "fleet/$1" "$dir" main
  printf '%s\n' "$1" > "$dir/$1.txt"; git -C "$dir" add "$1.txt"; git -C "$dir" commit -q -m "work $1"
}
ext_merge(){ git -C "$EPROD" checkout -q main; git -C "$EPROD" merge -q --no-ff "fleet/$1" -m "merge $1"; git -C "$EPROD" push -q origin main; git -C "$EPROD" push -q origin "fleet/$1"; }
ext_scan(){ ( cd "$EXT" && bun seats/prune.ts scan --format jsonl > "$FIX/ext-scan.jsonl" 2>/dev/null ); }
ext_row(){ grep -F "\"path\":\"$1\"" "$FIX/ext-scan.jsonl"; }
ext_registered(){ git -C "$EPROD" worktree list --porcelain | grep -qxF "worktree $1"; }
ext_cleanup(){ ( cd "$EXT" && bun seats/prune.ts cleanup "$@" 2>&1 ); }

phase 'ISC-42 squash-merge and ISC-117 mayline/main integration ref'
git -C "$EPROD" init --bare -q "$FIX/ext-mayline.git"; git -C "$EPROD" remote add mayline "$FIX/ext-mayline.git"
MAY_ID=$(ext_bead 'merged only on mayline'); ext_wt "$MAY_ID"
git -C "$EPROD" checkout -q -b tmp-mayline main; git -C "$EPROD" merge -q --no-ff "fleet/$MAY_ID" -m "mayline merge"; git -C "$EPROD" push -q mayline tmp-mayline:main; git -C "$EPROD" checkout -q main; git -C "$EPROD" branch -q -D tmp-mayline
SQ_ID=$(ext_bead 'squash merged, never pushed'); ext_wt "$SQ_ID"
printf 'more\n' > "$EWTS/$SQ_ID/$SQ_ID-2.txt"; git -C "$EWTS/$SQ_ID" add "$SQ_ID-2.txt"; git -C "$EWTS/$SQ_ID" commit -q -m "work $SQ_ID part 2"
SQ_TIP=$(git -C "$EWTS/$SQ_ID" rev-parse HEAD)
git -C "$EPROD" merge -q --squash "fleet/$SQ_ID" >/dev/null 2>&1 && git -C "$EPROD" commit -q -m "squash $SQ_ID"; git -C "$EPROD" push -q origin main
ext_scan
ext_row "$EWTS/$MAY_ID" | grep -q '"category":"merged-worktree".*"reason":"[^"]*mayline/main' && pass 'branch merged only on mayline/main is merged-worktree naming mayline/main (ISC-117)' || fail "mayline row: $(ext_row "$EWTS/$MAY_ID")"
ext_row "$EWTS/$SQ_ID" | grep -q '"category":"merged-worktree".*"reason":"[^"]*squash-merged as [0-9a-f]\{12\} on [^"]*archive tag before removal' && pass 'squash-merged unpushed branch is merged-worktree naming the squash commit (ISC-42)' || fail "squash row: $(ext_row "$EWTS/$SQ_ID")"
OUT=$(ext_cleanup --bead "$MAY_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$MAY_ID" ] && printf '%s\n' "$OUT" | grep -q "removed merged-worktree $EWTS/$MAY_ID " && pass 'mayline-merged worktree removed by cleanup' || fail "mayline cleanup rc=$RC: $OUT"
OUT=$(ext_cleanup --bead "$SQ_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$SQ_ID" ] && [ "$(git -C "$EPROD" rev-parse --verify --quiet "refs/tags/archive/$SQ_ID^{commit}")" = "$SQ_TIP" ] && git -C "$EPROD" branch --list "fleet/$SQ_ID" | grep -q . && pass 'squash-merged worktree removed after archive/<name> tag; branch ref kept (ISC-52/53)' || fail "squash cleanup rc=$RC tags=$(git -C "$EPROD" tag --list 'archive/*'): $OUT"

phase 'ISC-43 bead landed on origin/fleet/ootb-agent'
OOTB_ID=$(ext_bead 'landed on ootb-agent'); ext_wt "$OOTB_ID"
git -C "$EPROD" checkout -q -b fleet/ootb-agent main; git -C "$EPROD" merge -q --no-ff "fleet/$OOTB_ID" -m 'ootb merge'; git -C "$EPROD" push -q origin fleet/ootb-agent; git -C "$EPROD" checkout -q main; git -C "$EPROD" branch -q -D fleet/ootb-agent
ext_scan
ext_row "$EWTS/$OOTB_ID" | grep -q '"category":"merged-worktree".*"reason":"[^"]*fleet/ootb-agent' && pass 'bead merged only to origin/fleet/ootb-agent is merged-worktree naming that ref' || fail "ootb row: $(ext_row "$EWTS/$OOTB_ID")"
OUT=$(ext_cleanup --bead "$OOTB_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$OOTB_ID" ] && pass 'ootb-agent-merged worktree removed by cleanup' || fail "ootb cleanup rc=$RC: $OUT"

phase 'ISC-44 open bead with zero commits and no seat'
ZERO_ID=$(ext_bead 'open zero-commit bead' open)
git -C "$EPROD" worktree add -q -b "fleet/$ZERO_ID" "$EWTS/$ZERO_ID" main
ext_scan
ext_row "$EWTS/$ZERO_ID" | grep -q '"category":"zero-commit-worktree".*"reason":"[^"]*zero commits [^"]* no seat' && pass 'open bead at its base tip is zero-commit-worktree with a "zero commits ... no seat" reason' || fail "zero-commit row: $(ext_row "$EWTS/$ZERO_ID")"
OUT=$(ext_cleanup --bead "$ZERO_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$ZERO_ID" ] && git -C "$EPROD" branch --list "fleet/$ZERO_ID" | grep -q . && pass 'zero-commit worktree removed; its branch ref still exists' || fail "zero-commit cleanup rc=$RC branch=$(git -C "$EPROD" branch --list "fleet/$ZERO_ID"): $OUT"

phase 'ISC-45/56 run folder kept while a live process has its cwd inside'
RUN_ID=$(ext_bead 'closed bead with occupied run folder'); mkdir -p "$ERUNS/$RUN_ID-x"; printf 'scratch\n' > "$ERUNS/$RUN_ID-x/file.txt"
( cd "$ERUNS/$RUN_ID-x" && exec sleep 1000 ) >/dev/null 2>&1 & RUN_PID=$!; EXT_PIDS+=("$RUN_PID")
OUT=$(ext_cleanup --bead "$RUN_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$ERUNS/$RUN_ID-x" ] && printf '%s\n' "$OUT" | grep -q "kept needs-review $ERUNS/$RUN_ID-x reason=live process has its cwd" && pass 'run folder kept with "live process has its cwd" while occupied' || fail "occupied run folder rc=$RC: $OUT"
kill "$RUN_PID" >/dev/null 2>&1; wait "$RUN_PID" 2>/dev/null
OUT=$(ext_cleanup --bead "$RUN_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$ERUNS/$RUN_ID-x" ] && printf '%s\n' "$OUT" | grep -q "removed run-scratch $ERUNS/$RUN_ID-x " && pass 'run folder removed on the next cleanup once the process is gone' || fail "freed run folder rc=$RC: $OUT"

phase 'ISC-46/138 concurrent cleanups, lock refusal, and a race with another remover'
CA_ID=$(ext_bead 'concurrent close A'); CB_ID=$(ext_bead 'concurrent close B')
mkdir -p "$ERUNS/$CA_ID-run" "$ERUNS/$CB_ID-run"; printf 'a\n' > "$ERUNS/$CA_ID-run/f"; printf 'b\n' > "$ERUNS/$CB_ID-run/f"
ext_cleanup --bead "$CA_ID" --wait 30 > "$FIX/ext-ca.out" & CA_PID=$!
ext_cleanup --bead "$CB_ID" --wait 30 > "$FIX/ext-cb.out" & CB_PID=$!
wait "$CA_PID"; CA_RC=$?; wait "$CB_PID"; CB_RC=$?
[ "$CA_RC" -eq 0 ] && [ "$CB_RC" -eq 0 ] && [ ! -e "$ERUNS/$CA_ID-run" ] && [ ! -e "$ERUNS/$CB_ID-run" ] && pass 'two parallel bead-scoped cleanups both exit 0 and both run folders are gone' || fail "parallel cleanups rc=$CA_RC/$CB_RC: $(cat "$FIX/ext-ca.out" "$FIX/ext-cb.out")"
[ "$(grep -c "removed run-scratch $ERUNS/$CA_ID-run " "$ELOG")" -eq 1 ] && [ "$(grep -c "removed run-scratch $ERUNS/$CB_ID-run " "$ELOG")" -eq 1 ] && pass 'cleanup log has exactly one removed line per bead (ISC-46)' || fail "log lines for A/B: $(grep -E "$CA_ID-run|$CB_ID-run" "$ELOG")"
grep -q 'already running' "$FIX/ext-ca.out" "$FIX/ext-cb.out" && fail 'a --wait cleanup gave up with "already running"' || pass 'neither waiting cleanup gave up on the lock'
mkdir -p "$EXT/seats/run/cleanup.lock"; printf '%s\n' "$$" > "$EXT/seats/run/cleanup.lock/pid"
T0=$(date +%s); OUT=$(ext_cleanup); RC=$?; T1=$(date +%s)
[ "$RC" -eq 0 ] && [ "$OUT" = "already running" ] && [ $((T1-T0)) -le 3 ] && pass 'a cleanup while another holds the lock prints only "already running", exits 0, within ~1 s' || fail "lock refusal rc=$RC after $((T1-T0))s: $OUT"
rm -rf "$EXT/seats/run/cleanup.lock"
RACE_ID=$(ext_bead 'removed by another actor between scan and act'); mkdir -p "$ERUNS/$RACE_ID-run"; printf 'r\n' > "$ERUNS/$RACE_ID-run/f"
OUT=$(ext_cleanup --dry-run --bead "$RACE_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$ERUNS/$RACE_ID-run" ] && printf '%s\n' "$OUT" | grep -q "dry-run would remove run-scratch $ERUNS/$RACE_ID-run " && pass 'dry-run lists the run folder and leaves it in place' || fail "race dry-run rc=$RC: $OUT"
# The scan's lsof pass is call 1; the per-row re-verification right before acting is call 2. Removing the
# path there is exactly "another actor got there first" between scan and act.
RACE_LSOF="$FIX/race-lsof.sh"; RACE_COUNT="$FIX/race-lsof.count"; rm -f "$RACE_COUNT"
cat > "$RACE_LSOF" <<SH
#!/usr/bin/env bash
n=\$(cat "$RACE_COUNT" 2>/dev/null || echo 0); n=\$((n+1)); printf '%s\n' "\$n" > "$RACE_COUNT"
[ "\$n" -eq 2 ] && rm -rf "$ERUNS/$RACE_ID-run"
exec /usr/sbin/lsof "\$@"
SH
chmod +x "$RACE_LSOF"
OUT=$(WHEELHOUSE_LSOF="$RACE_LSOF" ext_cleanup --bead "$RACE_ID"); RC=$?
[ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q "already removed $ERUNS/$RACE_ID-run$" && ! printf '%s\n' "$OUT" | grep -q "^[^ ]* removed run-scratch $ERUNS/$RACE_ID-run " && pass 'a row removed between scan and act logs "already removed", no removed line, exit 0 (ISC-138)' || fail "race cleanup rc=$RC count=$(cat "$RACE_COUNT" 2>/dev/null): $OUT"
[ -z "$(git -C "$EPROD" worktree prune --dry-run 2>&1)" ] && pass 'worktree registry needs no prune after the race' || fail "registry inconsistent: $(git -C "$EPROD" worktree prune --dry-run 2>&1)"

phase 'ISC-50 bead closed while its seat is mid-push'
PUSH_ID=$(ext_bead 'closed mid-push'); ext_wt "$PUSH_ID"; ext_merge "$PUSH_ID"
( cd "$FIX" && exec sleep 1000 ) >/dev/null 2>&1 & PUSH_PID=$!; EXT_PIDS+=("$PUSH_PID")
mkdir -p "$EXT/seats/run"; printf '{"seat":"worker-1","branch":"fleet/%s","worktree":"%s","pid":%s}\n' "$PUSH_ID" "$EWTS/$PUSH_ID" "$PUSH_PID" > "$EXT/seats/run/push.worker-1.json"
OUT=$(ext_cleanup --bead "$PUSH_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EWTS/$PUSH_ID" ] && printf '%s\n' "$OUT" | grep -q "kept needs-review $EWTS/$PUSH_ID reason=deferred: push in progress" && pass 'worktree kept with "deferred: push in progress" while the push marker names a live pid' || fail "mid-push rc=$RC: $OUT"
rm -f "$EXT/seats/run/push.worker-1.json"; kill "$PUSH_PID" >/dev/null 2>&1; wait "$PUSH_PID" 2>/dev/null
OUT=$(ext_cleanup --bead "$PUSH_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$PUSH_ID" ] && printf '%s\n' "$OUT" | grep -q "removed merged-worktree $EWTS/$PUSH_ID " && pass 'worktree removed once the push has ended' || fail "post-push rc=$RC: $OUT"

phase 'ISC-51 oversized worktree follows the same rules'
BIG_ID=$(ext_bead 'oversized build output'); ext_wt "$BIG_ID"
printf 'target/\n' > "$EWTS/$BIG_ID/.gitignore"; git -C "$EWTS/$BIG_ID" add .gitignore; git -C "$EWTS/$BIG_ID" commit -q -m 'ignore target'; ext_merge "$BIG_ID"
mkdir -p "$EWTS/$BIG_ID/target"
if command -v mkfile >/dev/null 2>&1; then mkfile -n 21g "$EWTS/$BIG_ID/target/big"; else dd if=/dev/zero of="$EWTS/$BIG_ID/target/big" bs=1 count=0 seek=21g 2>/dev/null; fi
BIG_APPARENT=$(stat -f %z "$EWTS/$BIG_ID/target/big" 2>/dev/null || stat -c %s "$EWTS/$BIG_ID/target/big"); BIG_ALLOC_K=$(du -sk "$EWTS/$BIG_ID/target/big" | awk '{print $1}')
[ "$BIG_APPARENT" -ge 22000000000 ] && [ "$BIG_ALLOC_K" -lt 1048576 ] && pass "21 GB sparse build file allocates only ${BIG_ALLOC_K}K" || fail "sparse file apparent=$BIG_APPARENT allocated=${BIG_ALLOC_K}K"
[ -z "$(git -C "$EWTS/$BIG_ID" status --porcelain --untracked-files=all)" ] && pass 'ignored build output leaves the tree clean' || fail 'tree not clean with ignored target/'
ext_scan
ext_row "$EWTS/$BIG_ID" | grep -q '"category":"merged-worktree"' && pass 'oversized merged worktree is still merged-worktree; size never changes the category' || fail "oversized row: $(ext_row "$EWTS/$BIG_ID")"
OUT=$(ext_cleanup --bead "$BIG_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$BIG_ID" ] && ! ext_registered "$EWTS/$BIG_ID" && pass 'oversized worktree removed by cleanup' || fail "oversized cleanup rc=$RC: $OUT"

phase 'ISC-59/60 seat anchors and ISA-named worktrees are never removed'
SEAT_ID=$(ext_bead 'seat anchored merged worktree'); ext_wt "$SEAT_ID"; ext_merge "$SEAT_ID"
ISA_ID=$(ext_bead 'ISA named merged worktree'); ext_wt "$ISA_ID"; ext_merge "$ISA_ID"
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"}}}\n' "$EWTS/$SEAT_ID" > "$EXT/seats/state.json"
mkdir -p "$EXT/wheelhouse"; printf '# ISA\n\nIntegration worktree: `.wheelhouse-worktrees/%s` holds the goal branch.\n' "$ISA_ID" > "$EXT/wheelhouse/ISA.md"
ext_scan
ext_row "$EWTS/$SEAT_ID" | grep -q '"category":"seat-anchor"' && pass 'seats/state.json cwd is listed seat-anchor (ISC-59)' || fail "seat row: $(ext_row "$EWTS/$SEAT_ID")"
ext_row "$EWTS/$ISA_ID" | grep -q '"category":"needs-review".*"reason":"named by wheelhouse/ISA.md"' && pass 'worktree named in wheelhouse/ISA.md is needs-review "named by wheelhouse/ISA.md" (ISC-60)' || fail "ISA row: $(ext_row "$EWTS/$ISA_ID")"
OUT=$(ext_cleanup --bead "$SEAT_ID"; ext_cleanup --bead "$ISA_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EWTS/$SEAT_ID" ] && ext_registered "$EWTS/$SEAT_ID" && printf '%s\n' "$OUT" | grep -q "kept seat-anchor $EWTS/$SEAT_ID reason=seat-anchor" && pass 'seat-anchor worktree kept with "seat-anchor" and still registered' || fail "seat-anchor cleanup rc=$RC: $OUT"
[ -d "$EWTS/$ISA_ID" ] && ext_registered "$EWTS/$ISA_ID" && printf '%s\n' "$OUT" | grep -q "kept needs-review $EWTS/$ISA_ID reason=named by wheelhouse/ISA.md" && pass 'ISA-named worktree kept with "named by wheelhouse/ISA.md" and still registered' || fail "ISA cleanup: $OUT"

phase 'ISC-61 lsof unavailable removes nothing'
LSOF_ID=$(ext_bead 'removable but unverifiable'); ext_wt "$LSOF_ID"; ext_merge "$LSOF_ID"
mkdir -p "$ERUNS/$LSOF_ID-run"; printf 'x\n' > "$ERUNS/$LSOF_ID-run/f"
OUT=$(WHEELHOUSE_LSOF=/nonexistent/lsof ext_cleanup); RC=$?
[ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q "kept needs-review $EWTS/$LSOF_ID reason=cannot verify: lsof unavailable" && printf '%s\n' "$OUT" | grep -q "kept needs-review $ERUNS/$LSOF_ID-run reason=cannot verify: lsof unavailable" && pass 'otherwise-removable worktree and run folder are kept with "cannot verify: lsof unavailable"' || fail "no-lsof rc=$RC: $OUT"
! printf '%s\n' "$OUT" | grep -q '^[^ ]* removed ' && printf '%s\n' "$OUT" | tail -1 | grep -q 'cleanup done removed=0 ' && [ -d "$EWTS/$LSOF_ID" ] && [ -d "$ERUNS/$LSOF_ID-run" ] && pass 'nothing removed without lsof; exit 0' || fail "no-lsof removed something: $OUT"
OUT=$(ext_cleanup --bead "$LSOF_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$LSOF_ID" ] && [ ! -e "$ERUNS/$LSOF_ID-run" ] && pass 'the same rows are removed once lsof is available again' || fail "post-lsof rc=$RC: $OUT"

phase 'ISC-64 symlinked entries and paths with spaces'
LINK_ID=$(ext_bead 'worktree reached through a symlink'); mkdir -p "$FIX/elsewhere/$LINK_ID"
ext_wt "$LINK_ID" "$FIX/elsewhere/$LINK_ID"; ext_merge "$LINK_ID"; ln -s "$FIX/elsewhere/$LINK_ID" "$EWTS/$LINK_ID"
mkdir -p "$FIX/elsewhere/orphan-target"; printf 'keep me\n' > "$FIX/elsewhere/orphan-target/file.txt"; ln -s "$FIX/elsewhere/orphan-target" "$EWTS/linked-orphan"
SPACE_ID=$(ext_bead 'worktree path with a space'); ext_wt "$SPACE_ID" "$EWTS/$SPACE_ID with space"; ext_merge "$SPACE_ID"
ext_scan
ext_row "$FIX/elsewhere/$LINK_ID" | grep -q '"category":"needs-review".*"reason":"interactive checkout outside' && pass 'symlinked worktree registers at its real path and is needs-review (outside the container)' || fail "symlink worktree row: $(ext_row "$FIX/elsewhere/$LINK_ID") link-path row: $(ext_row "$EWTS/$LINK_ID")"
ext_row "$EWTS/linked-orphan" | grep -q '"category":"\(orphaned-worktree\|needs-review\)"' && pass 'orphaned symlink under .wheelhouse-worktrees/ is listed by scan' || fail "orphaned symlink has no scan row (scan skips symlinked entries): $(grep -F linked-orphan "$FIX/ext-scan.jsonl")"
OUT=$(ext_cleanup --bead "$LINK_ID"; ext_cleanup --bead "$SPACE_ID"; ext_cleanup); RC=$?
[ "$RC" -eq 0 ] && pass 'cleanup over symlinked entries exits 0' || fail "symlink cleanup rc=$RC: $OUT"
printf '%s\n' "$OUT" | grep -q "path mismatch" && pass 'cleanup logs "path mismatch" for a symlinked entry' || fail "no \"path mismatch\" line for a symlinked entry under .wheelhouse-worktrees/: $OUT"
[ -L "$EWTS/$LINK_ID" ] && [ -L "$EWTS/linked-orphan" ] && [ -f "$FIX/elsewhere/orphan-target/file.txt" ] && [ -f "$FIX/elsewhere/$LINK_ID/.git" ] && ext_registered "$FIX/elsewhere/$LINK_ID" && pass 'symlinks, their targets and the out-of-container worktree are untouched' || fail 'a symlink, its target, or the out-of-container worktree was touched'
! grep -E "^[^ ]+ removed [^ ]+ ($EWTS/$LINK_ID|$EWTS/linked-orphan|$FIX/elsewhere)" "$ELOG" | grep -q . && pass 'no removed line names a symlinked or out-of-container path' || fail "removed line for a symlinked path: $(grep -F elsewhere "$ELOG")"
[ ! -e "$EWTS/$SPACE_ID with space" ] && ! ext_registered "$EWTS/$SPACE_ID with space" && grep -q "removed merged-worktree $EWTS/$SPACE_ID with space bytes=" "$ELOG" && pass 'merged worktree whose path has a space is resolved and removed' || fail "space path cleanup: $(grep -F "$SPACE_ID" "$ELOG")"

phase 'ISC-62 interactive .worktrees/ checkouts are never touched'
INT_ID=$(ext_bead 'interactive checkout, merged and closed'); mkdir -p "$EXT/.worktrees"
ext_wt "$INT_ID" "$EXT/.worktrees/$INT_ID"; ext_merge "$INT_ID"
ext_scan
ext_row "$EXT/.worktrees/$INT_ID" | grep -q '"category":"needs-review".*"reason":"interactive checkout' && pass 'interactive .worktrees/ checkout on a merged fleet branch is needs-review "interactive checkout"' || fail "interactive row: $(ext_row "$EXT/.worktrees/$INT_ID")"
OUT=$(ext_cleanup --bead "$INT_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EXT/.worktrees/$INT_ID" ] && ext_registered "$EXT/.worktrees/$INT_ID" && printf '%s\n' "$OUT" | grep -q "kept needs-review $EXT/.worktrees/$INT_ID reason=interactive checkout" && pass 'interactive checkout kept and still registered after cleanup' || fail "interactive cleanup rc=$RC: $OUT"
! awk '$2=="removed"{print $4}' "$ELOG" | grep -q '/\.worktrees/' && pass 'no removed line in the cleanup log names a .worktrees/ path' || fail "removed .worktrees/ path: $(grep '/\.worktrees/' "$ELOG")"

if [ "$FAILED" -eq 0 ]; then
  echo 'prune.selftest: PASS'
  exit 0
fi
echo "prune.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
