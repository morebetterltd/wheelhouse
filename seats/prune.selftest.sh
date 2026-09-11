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

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-prune-selftest.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
TMP_SCRATCH=()
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; rm -rf "$FIX" ${TMP_SCRATCH[@]+"${TMP_SCRATCH[@]}"}; }
trap cleanup EXIT INT TERM
export HOME="$FIX/home"
mkdir -p "$HOME"

ROOT="$FIX/container"
PROD="$ROOT/product"
WTS="$ROOT/.wheelhouse-worktrees"
mkdir -p "$PROD" "$WTS" "$ROOT/seats"
cp "$PRUNE" "$ROOT/seats/prune.ts"
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
LIVE_ID=$(cd "$ROOT" && bd create 'closed live cwd anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
HIST_ID=$(cd "$ROOT" && bd create 'closed session history anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
STALE_ID=$(cd "$ROOT" && bd create 'closed stale branch no worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
UNMERGED_ID=$(cd "$ROOT" && bd create 'closed unmerged branch must survive' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
cd "$ROOT" && bd close "$CLOSED_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$LIVE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$HIST_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$STALE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$UNMERGED_ID" >/dev/null 2>&1

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
make_closed_worktree "$HIST_ID" "history cwd work"
make_closed_worktree "$STALE_ID" "stale branch work"
git -C "$PROD" worktree remove --force "$WTS/$STALE_ID"
git -C "$PROD" push -q origin "fleet/$STALE_ID"

git -C "$PROD" worktree add -q -b "fleet/$UNMERGED_ID" "$WTS/$UNMERGED_ID" main
printf 'unmerged work\n' >> "$WTS/$UNMERGED_ID/app.txt"
git -C "$WTS/$UNMERGED_ID" add app.txt
git -C "$WTS/$UNMERGED_ID" commit -q -m 'unmerged work'
git -C "$PROD" push -q origin "fleet/$UNMERGED_ID"

git -C "$PROD" worktree add -q -b "fleet/$OPEN_ID" "$WTS/$OPEN_ID" main
mkdir -p "$ROOT/seats/logs" "$ROOT/seats/sessions"
SESSION_HISTORY="$ROOT/seats/sessions/history.jsonl"
printf '{"type":"session-start","cwd":"%s"}\n' "$WTS/$HIST_ID" > "$SESSION_HISTORY"
( cd "$WTS/$LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
LIVE_PID=$!
TMP_SCRATCH+=()
cleanup_live(){ kill "$LIVE_PID" >/dev/null 2>&1 || true; }
cleanup_prune(){ cleanup_live; cleanup; }
trap cleanup_prune EXIT INT TERM
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"},"worker-live":{"pid":%s,"cwd":"%s"},"worker-history":{"pid":999998,"cwd":"%s","sessionFile":"%s"}}}\n' "$WTS/$OPEN_ID" "$LIVE_PID" "$WTS/$OPEN_ID" "$WTS/$OPEN_ID" "$SESSION_HISTORY" > "$ROOT/seats/state.json"

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
CLOSED_TMP="/private/tmp/$CLOSED_ID-derivedData"
OPEN_TMP="/private/tmp/$OPEN_ID-derivedData"
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
chmod +x "$BUSY/seats/prune.ts"
printf 'active-lock\n' > "$BUSY/.wheelhouse-bench.lock/pid"
printf 'busy-cache\n' > "$BUSY/product/.wheelhouse-build/cache.txt"

phase 'categories verb'
CATS=$(cd "$ROOT" && bun seats/prune.ts categories 2>&1)
if printf '%s\n' "$CATS" | grep -q 'merged-worktree' && printf '%s\n' "$CATS" | grep -q 'seat-anchor' && printf '%s\n' "$CATS" | grep -q 'bench-junk' && printf '%s\n' "$CATS" | grep -q 'bead-runs' && printf '%s\n' "$CATS" | grep -q 'bead-tmp' && printf '%s\n' "$CATS" | grep -q 'bead-simulator' && printf '%s\n' "$CATS" | grep -q 'xctest-devices'; then pass 'categories names worktree, bench-junk, scratch, simulator, xctest, and seat safety categories'; else fail "categories output missing expected categories: $CATS"; fi

phase 'scan classifies fixture rows'
SCAN="$FIX/scan.tsv"
( cd "$ROOT" && bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan failed" >&2; exit 2; }
if awk -F '\t' -v p="$WTS/$CLOSED_ID" '$1=="merged-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed merged clean worktree is safe merged-worktree'; else fail "closed merged worktree row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v b="fleet/$STALE_ID" '$1=="stale-branch" && $2=="1" && $5==b && $6=="0" && $7=="0.0B" {found=1} END{exit found?0:1}' "$SCAN"; then pass 'safe stale-branch reports zero reclaimed size'; else fail "stale-branch zero-size row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$UNMERGED_ID" '$1=="needs-review" && $2=="0" && $4==p && $5 ~ /^fleet\// && $9 ~ /not both merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed but unmerged fleet worktree is needs-review'; else fail "unmerged branch guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$OPEN_ID" '$1=="seat-anchor" && $2=="0" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'seat cwd is classified as non-prunable seat-anchor'; else fail "seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$LIVE_ID" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /live cwd/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'live lsof cwd beats stale state.json cwd and is a seat-anchor'; else fail "live cwd seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$HIST_ID" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /session history cwd/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'session history cwd is a non-prunable seat-anchor'; else fail "session history seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/orphaned-checkout" '$1=="orphaned-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'orphaned checkout is safe orphaned-worktree'; else fail "orphaned row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/.wheelhouse-build" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'build cache is safe build-cache'; else fail "build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/obj" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass '.NET obj cache is safe build-cache'; else fail "obj build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/dist" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'root dist is safe build-cache'; else fail "root dist build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/node_modules/pkg/dist" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /dependency/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'node_modules package dist is needs-review, not safe build-cache'; else fail "node_modules dist guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/node_modules/.bin" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /dependency/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'node_modules .bin is needs-review, not safe build-cache'; else fail "node_modules .bin guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$4 ~ /\/node_modules\// && $2=="1" {bad=1} END{exit bad?1:0}' "$SCAN"; then pass 'no safe scan rows appear under node_modules'; else fail "safe node_modules row present:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-bench.lock.stale.12345" '$1=="bench-junk" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'stale bench lock is safe bench-junk'; else fail "bench-junk row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-runs/$CLOSED_ID-build" '$1=="bead-runs" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead .wheelhouse-runs scratch is safe bead-runs'; else fail "closed bead-runs row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-runs/$OPEN_ID-build" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead .wheelhouse-runs scratch is needs-review'; else fail "open bead-runs guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$CLOSED_TMP" '$1=="bead-tmp" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead /private/tmp scratch is safe bead-tmp'; else fail "closed bead-tmp row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$OPEN_TMP" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead /private/tmp scratch is needs-review'; else fail "open bead-tmp guard row missing:\n$(cat "$SCAN")"; fi
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
MID_OUT=$(cd "$MID" && bun seats/prune.ts prune --from-file "$FIX/mid-scan.tsv" --yes 2>&1)
MID_RC=$?
set +e
if [ $MID_RC -ne 0 ] && printf '%s\n' "$MID_OUT" | grep -q 'worker-busy' && printf '%s\n' "$MID_OUT" | grep -q 'mid-turn'; then pass 'prune --yes STOPs naming the mid-turn seat'; else fail "mid-turn prune did not STOP as specified (exit $MID_RC): $MID_OUT"; fi
[ -d "$MID/product/.wheelhouse-build" ] && pass 'mid-turn guarded cache remains after refused prune --yes' || fail 'mid-turn guarded cache was removed'
kill "$MID_PID" >/dev/null 2>&1 || true

phase 'prune --yes rechecks live seat anchors from reviewed scan files'
printf 'category\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason\norphaned-worktree\t1\t%s\t%s\t\t1\t1.0B\trm\tstale reviewed scan fixture\n' "$ROOT" "$WTS/$LIVE_ID" > "$FIX/stale-live-scan.tsv"
set +e
STALE_OUT=$(cd "$ROOT" && bun seats/prune.ts prune --from-file "$FIX/stale-live-scan.tsv" --yes --categories orphaned-worktree 2>&1)
STALE_RC=$?
set +e
if [ $STALE_RC -ne 0 ] && printf '%s\n' "$STALE_OUT" | grep -q 'worker-live' && printf '%s\n' "$STALE_OUT" | grep -q 'refusing to prune'; then pass 'prune --yes refuses a stale safe row that is now a live seat cwd'; else fail "stale live-cwd row was not refused (exit $STALE_RC): $STALE_OUT"; fi
[ -d "$WTS/$LIVE_ID" ] && pass 'stale-scan live seat cwd remains after refused prune --yes' || fail 'stale-scan live seat cwd was removed'

phase 'prune acts only on safe selected rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --yes --categories merged-worktree,orphaned-worktree,build-cache,bench-junk,bead-runs,bead-tmp,bead-simulator,xctest-devices > "$FIX/prune.out" )
if [ ! -e "$WTS/$CLOSED_ID" ] && ! git -C "$PROD" worktree list --porcelain | grep -qF "$WTS/$CLOSED_ID"; then pass 'safe merged worktree removed by git worktree remove'; else fail 'safe merged worktree still exists or is registered'; fi
if ! git -C "$PROD" branch --list "fleet/$CLOSED_ID" | grep -q . && grep -q "PRUNED branch merged-worktree fleet/$CLOSED_ID" "$FIX/prune.out"; then pass 'safe merged worktree prune also deletes its merged branch in the same pass'; else fail "merged worktree branch survived same-pass prune: $(git -C "$PROD" branch --list "fleet/$CLOSED_ID") output=$(cat "$FIX/prune.out")"; fi
if git -C "$PROD" branch --list "fleet/$UNMERGED_ID" | grep -q .; then pass 'unmerged fleet branch is not deleted by merged-worktree prune path'; else fail 'unmerged fleet branch was deleted'; fi
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
[ -d "$WTS/$OPEN_ID" ] && pass 'seat-anchor worktree remains' || fail 'seat-anchor worktree was removed'
[ -d "$WTS/$LIVE_ID" ] && pass 'live-cwd seat-anchor worktree remains' || fail 'live-cwd seat-anchor worktree was removed'
[ -d "$WTS/$HIST_ID" ] && pass 'session-history seat-anchor worktree remains' || fail 'session-history seat-anchor worktree was removed'
OPEN_RUNS_AFTER=$(shasum -a 256 "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" | awk '{print $1}')
OPEN_TMP_AFTER=$(shasum -a 256 "$OPEN_TMP/file.txt" | awk '{print $1}')
[ "$OPEN_RUNS_BEFORE" = "$OPEN_RUNS_AFTER" ] && pass 'open bead runs scratch remains byte-identical' || fail 'open bead runs scratch changed'
[ "$OPEN_TMP_BEFORE" = "$OPEN_TMP_AFTER" ] && pass 'open bead tmp scratch remains byte-identical' || fail 'open bead tmp scratch changed'
if ! grep -q 'delete OPEN-UDID' "$FIX/xcrun.log"; then pass 'open bead simulator is not deleted'; else fail "open bead simulator was deleted: $(cat "$FIX/xcrun.log")"; fi
if grep -q 'prune summary: touched=10' "$FIX/prune.out" && grep -q 'reclaimed_bytes=' "$FIX/prune.out"; then pass 'prune summary reports ten touched rows and reclaimed bytes'; else fail "unexpected prune summary: $(cat "$FIX/prune.out")"; fi

if [ "$FAILED" -eq 0 ]; then
  echo 'prune.selftest: PASS'
  exit 0
fi
echo "prune.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
