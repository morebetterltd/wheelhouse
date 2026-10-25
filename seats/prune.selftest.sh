#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/fixtures/prune-fixture.sh"

# Full tier. Owned phases (the union of both suites is the original list):
# - categories verb
# - scan classifies fixture rows
# - active bench lock makes caches review-only
# - dry-run does not touch rows
# - host-budget auto_prune uses the real scanner and reviewed prune parser
# - ISC-71 fresh install with zero worktrees
# - install policy cleanup=off/report is honored by direct prune cleanup
# - ISC-42 squash-merge and ISC-117 mayline/main integration ref
# - ISC-43 bead landed on origin/fleet/ootb-agent
# - ISC-44 open bead with zero commits and no seat
# - ISC-45/56 run folder kept while a live process has its cwd inside
# - ISC-46/138 concurrent cleanups, lock refusal, and a race with another remover
# - ISC-50 bead closed while its seat is mid-push
# - ISC-51 oversized worktree follows the same rules

prune_fixture_start "$@"
selftest_install_cleanup_traps cleanup

# Harness falsifiers stay full-tier; the real enclosing-Git check is core.
if bun "$HERE/fixtures/prune-nested-git.ts" "$HERE" "$FIX/nested-controls" "$PRUNE"; then
  pass 'nested Git leak check detects HEAD/index corruption, child failure and timeout'
else
  fail 'nested Git leak check regression controls'
fi

# Allocation/collision measurement remains in full; setup is shared.
bun "$HERE/fixtures/scratch-ownership.ts" prune "$HERE/.." "$FIX" || exit 1
if [ "${WHEELHOUSE_PRUNE_WAIT_ONLY:-0}" = 1 ]; then
  prune_wait_regression; exit $?
fi

prune_fixture_reviewed
phase 'categories verb'
CATS=$(cd "$ROOT" && bun seats/prune.ts categories 2>&1)
if printf '%s\n' "$CATS" | grep >/dev/null 'merged-worktree' && printf '%s\n' "$CATS" | grep >/dev/null 'seat-anchor' && printf '%s\n' "$CATS" | grep >/dev/null 'bench-junk' && printf '%s\n' "$CATS" | grep >/dev/null 'run-scratch' && printf '%s\n' "$CATS" | grep >/dev/null 'bead-tmp' && printf '%s\n' "$CATS" | grep >/dev/null 'bead-simulator' && printf '%s\n' "$CATS" | grep >/dev/null 'xctest-devices'; then pass 'categories names worktree, bench-junk, scratch, simulator, xctest, and seat safety categories'; else fail "categories output missing expected categories: $CATS"; fi

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
if awk -F '\t' '$1=="bead-simulator" && $2=="1" && $4=="simctl:11111111-1111-1111-1111-111111111111" {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead simctl device is safe bead-simulator'; else fail "closed bead-simulator row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$1=="needs-review" && $2=="0" && $4=="simctl:22222222-2222-2222-2222-222222222222" && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead simctl device is needs-review'; else fail "open bead-simulator guard row missing:\n$(cat "$SCAN")"; fi
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

phase 'host-budget auto_prune uses the real scanner and reviewed prune parser'
CAP_REAL="$FIX/actual-auto-prune"
mkdir -p "$CAP_REAL/seats/logs" "$CAP_REAL/seats/run" "$CAP_REAL/.wheelhouse-worktrees"
selftest_copy_seat_runtime "$CAP_REAL" "$(dirname "$PRUNE")"
git -C "$CAP_REAL" init -q -b main
git -C "$CAP_REAL" config user.email selftest@example.invalid
git -C "$CAP_REAL" config user.name selftest
printf 'owned cap fixture\n' > "$CAP_REAL/base.txt"
git -C "$CAP_REAL" add base.txt && git -C "$CAP_REAL" commit -q -m base
( cd "$CAP_REAL" && bd init --non-interactive --skip-agents -p cap >/dev/null 2>&1 ) || { echo 'selftest: cap graph init failed' >&2; exit 2; }
CAP_IDS=()
for n in 1 2; do
  id=$(cd "$CAP_REAL" && bd create "real auto-prune $n" --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
  [ -n "$id" ] || { echo 'selftest: cap bead missing' >&2; exit 2; }
  CAP_IDS+=("$id")
  wt="$CAP_REAL/.wheelhouse-worktrees/$id"
  git -C "$CAP_REAL" worktree add -q -b "fleet/$id" "$wt" main
  printf 'work\n' > "$wt/$id.txt"
  git -C "$wt" add "$id.txt" && git -C "$wt" commit -q -m "work $id"
  git -C "$CAP_REAL" merge -q --no-ff "fleet/$id" -m "merge $id"
  ( cd "$CAP_REAL" && bd close "$id" >/dev/null 2>&1 )
done
printf '{"seats":{}}\n' > "$CAP_REAL/seats/seats.json"
printf '{"type":"agent_end"}\n' > "$CAP_REAL/seats/logs/fixture-status.jsonl"
printf '{"seats":{"fixture-status":{"pid":null,"role":"worker","log":"%s","fifo":"%s"}}}\n' "$CAP_REAL/seats/logs/fixture-status.jsonl" "$CAP_REAL/seats/run/fixture-status.stdin" > "$CAP_REAL/seats/state.json"
printf '{"enabled":true,"max_worktrees":1,"auto_prune":true}\n' > "$CAP_REAL/seats/host-budget.json"
CAP_BEFORE=$(git -C "$CAP_REAL" worktree list --porcelain | grep -c '^worktree ')
[ "$CAP_BEFORE" -eq 3 ] || { echo 'selftest: real cap subjects absent' >&2; exit 2; }
set +e
( cd "$CAP_REAL" && bun seats/adapter.ts status ) > "$FIX/cap-real.out" 2> "$FIX/cap-real.err"; CAP_REAL_RC=$?
set -e
printf 'MEASUREMENT real-auto-prune rc=%s\n' "$CAP_REAL_RC"
while IFS= read -r line; do printf '  adapter stdout: %s\n' "$line"; done < "$FIX/cap-real.out"
while IFS= read -r line; do printf '  adapter stderr: %s\n' "$line"; done < "$FIX/cap-real.err"
if [ "$CAP_REAL_RC" -eq 0 ] && grep -q 'HOST-BUDGET worktree cap exceeded' "$FIX/cap-real.out" && grep -q 'prune summary: touched=2' "$FIX/cap-real.out" && ! grep -q 'auto_prune failed' "$FIX/cap-real.out" && [ "$(git -C "$CAP_REAL" worktree list --porcelain | grep -c '^worktree ')" -eq 1 ] && [ ! -e "$CAP_REAL/.wheelhouse-worktrees/${CAP_IDS[0]}" ] && [ ! -e "$CAP_REAL/.wheelhouse-worktrees/${CAP_IDS[1]}" ] && grep -q '"kind": "wheelhouse-prune-scan"' "$CAP_REAL/seats/logs/prune-worktree-cap-scan.json"; then
  pass 'actual adapter auto_prune consumes bound JSON and removes two clean merged worktrees'
else fail "actual adapter auto_prune failed rc=$CAP_REAL_RC"; fi

prune_fixture_cleanup_helpers
phase 'ISC-71 fresh install with zero worktrees'
FRESH="$FIX/fresh"; mk_install "$FRESH"; mkdir -p "$FIX/fresh-home"
FRESH_SCAN=$(cd "$FRESH" && HOME="$FIX/fresh-home" bun seats/prune.ts scan --format jsonl 2>&1); FRESH_RC=$?
[ "$FRESH_RC" -eq 0 ] && [ "$(printf '%s\n' "$FRESH_SCAN" | grep -c .)" -eq 1 ] && printf '%s\n' "$FRESH_SCAN" | grep >/dev/null '"kind":"wheelhouse-prune-scan"' && pass 'scan on a fresh install prints root metadata only and exits 0' || fail "fresh scan rc=$FRESH_RC output: $FRESH_SCAN"
FRESH_OUT=$(cd "$FRESH" && HOME="$FIX/fresh-home" bun seats/prune.ts cleanup 2>&1); FRESH_RC=$?
[ "$FRESH_RC" -eq 0 ] && [ "$(printf '%s\n' "$FRESH_OUT" | grep -c .)" -eq 1 ] && printf '%s\n' "$FRESH_OUT" | grep >/dev/null 'Z cleanup done removed=0 kept=0 bytes=0$' && pass 'cleanup on a fresh install prints only "cleanup done removed=0 kept=0 bytes=0" and exits 0' || fail "fresh cleanup rc=$FRESH_RC output: $FRESH_OUT"

prune_fixture_ext
phase 'install policy cleanup=off/report is honored by direct prune cleanup'
mkdir -p "$EXT/wheelhouse"
OFF_ID=$(ext_bead 'cleanup off direct')
mkdir -p "$ERUNS/$OFF_ID-run"
printf 'keep\n' > "$ERUNS/$OFF_ID-run/file.txt"
ext_record_run "$ERUNS/$OFF_ID-run" "$OFF_ID"
printf 'cleanup=off\n' > "$EXT/wheelhouse/.template-source"
OUT=$(ext_cleanup --bead "$OFF_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -e "$ERUNS/$OFF_ID-run/file.txt" ] && printf '%s\n' "$OUT" | grep >/dev/null 'cleanup skipped cleanup=off in wheelhouse/.template-source' && ! printf '%s\n' "$OUT" | grep >/dev/null 'removed run-scratch' && pass 'cleanup=off direct cleanup exits without deleting closed-bead scratch' || fail "cleanup=off direct rc=$RC out=$OUT exists=$([ -e "$ERUNS/$OFF_ID-run/file.txt" ] && echo yes || echo no)"
REPORT_ID=$(ext_bead 'cleanup report direct')
mkdir -p "$ERUNS/$REPORT_ID-run"
printf 'report\n' > "$ERUNS/$REPORT_ID-run/file.txt"
ext_record_run "$ERUNS/$REPORT_ID-run" "$REPORT_ID"
printf 'cleanup=report\n' > "$EXT/wheelhouse/.template-source"
OUT=$(ext_cleanup --bead "$REPORT_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -e "$ERUNS/$REPORT_ID-run/file.txt" ] && printf '%s\n' "$OUT" | grep >/dev/null "dry-run would remove run-scratch $ERUNS/$REPORT_ID-run " && grep -q "dry-run would remove run-scratch $ERUNS/$REPORT_ID-run " "$ELOG" && pass 'cleanup=report direct cleanup writes a would-remove report and deletes nothing' || fail "cleanup=report direct rc=$RC out=$OUT log=$(grep -F "$REPORT_ID" "$ELOG" 2>/dev/null) exists=$([ -e "$ERUNS/$REPORT_ID-run/file.txt" ] && echo yes || echo no)"
rm -rf "$ERUNS/$OFF_ID-run" "$ERUNS/$REPORT_ID-run"
printf 'cleanup=on\n' > "$EXT/wheelhouse/.template-source"

phase 'ISC-42 squash-merge and ISC-117 mayline/main integration ref'
git -C "$EPROD" init --bare -q -b main "$FIX/ext-mayline.git"; git -C "$EPROD" remote add mayline "$FIX/ext-mayline.git"
MAY_ID=$(ext_bead 'merged only on mayline'); ext_wt "$MAY_ID"
git -C "$EPROD" checkout -q -b tmp-mayline main; git -C "$EPROD" merge -q --no-ff "fleet/$MAY_ID" -m "mayline merge"; git -C "$EPROD" push -q mayline tmp-mayline:main; git -C "$EPROD" checkout -q main; git -C "$EPROD" branch -q -D tmp-mayline
SQ_ID=$(ext_bead 'squash merged, never pushed'); ext_wt "$SQ_ID"
printf 'more\n' > "$EWTS/$SQ_ID/$SQ_ID-2.txt"; git -C "$EWTS/$SQ_ID" add "$SQ_ID-2.txt"; git -C "$EWTS/$SQ_ID" commit -q -m "work $SQ_ID part 2"
SQ_TIP=$(git -C "$EWTS/$SQ_ID" rev-parse HEAD)
git -C "$EPROD" merge -q --squash "fleet/$SQ_ID" >/dev/null 2>&1 && git -C "$EPROD" commit -q -m "squash $SQ_ID"; git -C "$EPROD" push -q origin main
ext_scan
ext_row "$EWTS/$MAY_ID" | grep >/dev/null '"category":"merged-worktree".*"reason":"[^"]*mayline/main' && pass 'branch merged only on mayline/main is merged-worktree naming mayline/main (ISC-117)' || fail "mayline row: $(ext_row "$EWTS/$MAY_ID")"
ext_row "$EWTS/$SQ_ID" | grep >/dev/null '"category":"merged-worktree".*"reason":"[^"]*squash-merged as [0-9a-f]\{12\} on [^"]*archive tag before removal' && pass 'squash-merged unpushed branch is merged-worktree naming the squash commit (ISC-42)' || fail "squash row: $(ext_row "$EWTS/$SQ_ID")"
OUT=$(ext_cleanup --bead "$MAY_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$MAY_ID" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed merged-worktree $EWTS/$MAY_ID " && pass 'mayline-merged worktree removed by cleanup' || fail "mayline cleanup rc=$RC: $OUT"
OUT=$(ext_cleanup --bead "$SQ_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$SQ_ID" ] && [ "$(git -C "$EPROD" rev-parse --verify --quiet "refs/tags/archive/$SQ_ID^{commit}")" = "$SQ_TIP" ] && git -C "$EPROD" branch --list "fleet/$SQ_ID" | grep >/dev/null . && pass 'squash-merged worktree removed after archive/<name> tag; branch ref kept (ISC-52/53)' || fail "squash cleanup rc=$RC tags=$(git -C "$EPROD" tag --list 'archive/*'): $OUT"

phase 'ISC-43 bead landed on origin/fleet/ootb-agent'
OOTB_ID=$(ext_bead 'landed on ootb-agent'); ext_wt "$OOTB_ID"
git -C "$EPROD" checkout -q -b fleet/ootb-agent main; git -C "$EPROD" merge -q --no-ff "fleet/$OOTB_ID" -m 'ootb merge'; git -C "$EPROD" push -q origin fleet/ootb-agent; git -C "$EPROD" checkout -q main; git -C "$EPROD" branch -q -D fleet/ootb-agent
ext_scan
ext_row "$EWTS/$OOTB_ID" | grep >/dev/null '"category":"merged-worktree".*"reason":"[^"]*fleet/ootb-agent' && pass 'bead merged only to origin/fleet/ootb-agent is merged-worktree naming that ref' || fail "ootb row: $(ext_row "$EWTS/$OOTB_ID")"
OUT=$(ext_cleanup --bead "$OOTB_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$OOTB_ID" ] && pass 'ootb-agent-merged worktree removed by cleanup' || fail "ootb cleanup rc=$RC: $OUT"

phase 'ISC-44 open bead with zero commits and no seat'
ZERO_ID=$(ext_bead 'open zero-commit bead' open)
git -C "$EPROD" worktree add -q -b "fleet/$ZERO_ID" "$EWTS/$ZERO_ID" main
ext_scan
ext_row "$EWTS/$ZERO_ID" | grep >/dev/null '"category":"zero-commit-worktree".*"reason":"[^"]*zero commits [^"]* no seat' && pass 'open bead at its base tip is zero-commit-worktree with a "zero commits ... no seat" reason' || fail "zero-commit row: $(ext_row "$EWTS/$ZERO_ID")"
OUT=$(ext_cleanup --bead "$ZERO_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$ZERO_ID" ] && git -C "$EPROD" branch --list "fleet/$ZERO_ID" | grep >/dev/null . && pass 'zero-commit worktree removed; its branch ref still exists' || fail "zero-commit cleanup rc=$RC branch=$(git -C "$EPROD" branch --list "fleet/$ZERO_ID"): $OUT"

phase 'ISC-45/56 run folder kept while a live process has its cwd inside'
RUN_ID=$(ext_bead 'closed bead with occupied run folder'); mkdir -p "$ERUNS/$RUN_ID-x"; printf 'scratch\n' > "$ERUNS/$RUN_ID-x/file.txt"
ext_record_run "$ERUNS/$RUN_ID-x" "$RUN_ID"
( cd "$ERUNS/$RUN_ID-x" && exec sleep 1000 ) >/dev/null 2>&1 & RUN_PID=$!; EXT_PIDS+=("$RUN_PID")
OUT=$(ext_cleanup --bead "$RUN_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$ERUNS/$RUN_ID-x" ] \
  && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $ERUNS/$RUN_ID-x reason=live process has its cwd" \
  && printf '%s\n' "$OUT" | grep >/dev/null "pid $RUN_PID" \
  && printf '%s\n' "$OUT" | grep >/dev/null "command sleep" \
  && printf '%s\n' "$OUT" | grep >/dev/null "cwd $ERUNS/$RUN_ID-x" \
  && pass 'run folder kept with holder pid, command, and cwd while occupied' || fail "occupied run folder did not name holder rc=$RC: $OUT"
kill "$RUN_PID" >/dev/null 2>&1; wait "$RUN_PID" 2>/dev/null
OUT=$(ext_cleanup --bead "$RUN_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$ERUNS/$RUN_ID-x" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed run-scratch $ERUNS/$RUN_ID-x " && pass 'run folder removed on the next cleanup once the process is gone' || fail "freed run folder rc=$RC: $OUT"
RO_ID=$(ext_bead 'closed bead with read-only scratch'); mkdir -p "$ERUNS/$RO_ID-run/.wheelhouse-verify-sources/allowed-sibling"
printf 'readonly\n' > "$ERUNS/$RO_ID-run/.wheelhouse-verify-sources/allowed-sibling/file.txt"
chmod -R a-w "$ERUNS/$RO_ID-run/.wheelhouse-verify-sources"
ext_record_run "$ERUNS/$RO_ID-run" "$RO_ID"
OUT=$(ext_cleanup --bead "$RO_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$ERUNS/$RO_ID-run" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed run-scratch $ERUNS/$RO_ID-run " && pass 'cleanup removes closed-bead scratch containing a read-only source snapshot subtree' || { chmod -R u+w "$ERUNS/$RO_ID-run" 2>/dev/null || true; fail "read-only scratch cleanup rc=$RC: $OUT"; }

phase 'ISC-46/138 concurrent cleanups, lock refusal, and a race with another remover'
if prune_wait_regression; then pass 'parallel cleanup progress is independent of elapsed host scan time'; else fail 'parallel cleanup lock-clock regression'; fi
CA_ID=$(ext_bead 'concurrent close A'); CB_ID=$(ext_bead 'concurrent close B')
mkdir -p "$ERUNS/$CA_ID-run" "$ERUNS/$CB_ID-run"; printf 'a\n' > "$ERUNS/$CA_ID-run/f"; printf 'b\n' > "$ERUNS/$CB_ID-run/f"
ext_record_run "$ERUNS/$CA_ID-run" "$CA_ID"; ext_record_run "$ERUNS/$CB_ID-run" "$CB_ID"
ext_wait_cleanup --bead "$CA_ID" --wait 30 > "$FIX/ext-ca.out" & CA_PID=$!
ext_wait_cleanup --bead "$CB_ID" --wait 30 > "$FIX/ext-cb.out" & CB_PID=$!
wait "$CA_PID"; CA_RC=$?; wait "$CB_PID"; CB_RC=$?
[ "$CA_RC" -eq 0 ] && [ "$CB_RC" -eq 0 ] && [ ! -e "$ERUNS/$CA_ID-run" ] && [ ! -e "$ERUNS/$CB_ID-run" ] && pass 'two parallel bead-scoped cleanups both exit 0 and both run folders are gone' || fail "parallel cleanups rc=$CA_RC/$CB_RC: $(cat "$FIX/ext-ca.out" "$FIX/ext-cb.out")"
[ "$(grep -c "removed run-scratch $ERUNS/$CA_ID-run " "$ELOG")" -eq 1 ] && [ "$(grep -c "removed run-scratch $ERUNS/$CB_ID-run " "$ELOG")" -eq 1 ] && pass 'cleanup log has exactly one removed line per bead (ISC-46)' || fail "log lines for A/B: $(grep -E "$CA_ID-run|$CB_ID-run" "$ELOG")"
if selftest_capture_lacks "$FIX/ext-ca.out" -q -- 'already running' && selftest_capture_lacks "$FIX/ext-cb.out" -q -- 'already running'; then pass 'neither waiting cleanup gave up on the lock'; else fail 'a --wait cleanup gave up or its capture is unavailable'; fi
# The same live holder must outlast refusal. Observe the real lock-wait call,
# not Bun startup/identity-check wall time; a waiting removal must fail by name.
if bun "$HERE/fixtures/prune-refusal.ts" "$EXT" "$FIX/refusal" "${WHEELHOUSE_PRUNE_REFUSAL_MODE:-fixed}"; then
  pass 'cleanup refuses with only "already running" and rc 0 while the holder still holds the lock, without waiting'
else
  fail 'cleanup lock refusal waited on the held lock or violated its refusal protocol'
fi
RACE_ID=$(ext_bead 'removed by another actor between scan and act'); mkdir -p "$ERUNS/$RACE_ID-run"; printf 'r\n' > "$ERUNS/$RACE_ID-run/f"
ext_record_run "$ERUNS/$RACE_ID-run" "$RACE_ID"
OUT=$(ext_cleanup --dry-run --bead "$RACE_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$ERUNS/$RACE_ID-run" ] && printf '%s\n' "$OUT" | grep >/dev/null "dry-run would remove run-scratch $ERUNS/$RACE_ID-run " && pass 'dry-run lists the run folder and leaves it in place' || fail "race dry-run rc=$RC: $OUT"
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
[ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep >/dev/null "already removed $ERUNS/$RACE_ID-run$" && ! printf '%s\n' "$OUT" | grep >/dev/null "^[^ ]* removed run-scratch $ERUNS/$RACE_ID-run " && pass 'a row removed between scan and act logs "already removed", no removed line, exit 0 (ISC-138)' || fail "race cleanup rc=$RC count=$(cat "$RACE_COUNT" 2>/dev/null): $OUT"
[ -z "$(git -C "$EPROD" worktree prune --dry-run 2>&1)" ] && pass 'worktree registry needs no prune after the race' || fail "registry inconsistent: $(git -C "$EPROD" worktree prune --dry-run 2>&1)"

phase 'ISC-50 bead closed while its seat is mid-push'
PUSH_ID=$(ext_bead 'closed mid-push'); ext_wt "$PUSH_ID"; ext_merge "$PUSH_ID"
( cd "$FIX" && exec sleep 1000 ) >/dev/null 2>&1 & PUSH_PID=$!; EXT_PIDS+=("$PUSH_PID")
mkdir -p "$EXT/seats/run"; printf '{"seat":"worker-1","branch":"fleet/%s","worktree":"%s","pid":%s}\n' "$PUSH_ID" "$EWTS/$PUSH_ID" "$PUSH_PID" > "$EXT/seats/run/push.worker-1.json"
OUT=$(ext_cleanup --bead "$PUSH_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EWTS/$PUSH_ID" ] && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $EWTS/$PUSH_ID reason=deferred: push in progress" && pass 'worktree kept with "deferred: push in progress" while the push marker names a live pid' || fail "mid-push rc=$RC: $OUT"
rm -f "$EXT/seats/run/push.worker-1.json"; kill "$PUSH_PID" >/dev/null 2>&1; wait "$PUSH_PID" 2>/dev/null
OUT=$(ext_cleanup --bead "$PUSH_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$PUSH_ID" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed merged-worktree $EWTS/$PUSH_ID " && pass 'worktree removed once the push has ended' || fail "post-push rc=$RC: $OUT"

phase 'ISC-51 oversized worktree follows the same rules'
BIG_ID=$(ext_bead 'oversized build output'); ext_wt "$BIG_ID"
printf 'target/\n' > "$EWTS/$BIG_ID/.gitignore"; git -C "$EWTS/$BIG_ID" add .gitignore; git -C "$EWTS/$BIG_ID" commit -q -m 'ignore target'; ext_merge "$BIG_ID"
mkdir -p "$EWTS/$BIG_ID/target"
if command -v mkfile >/dev/null 2>&1; then mkfile -n 21g "$EWTS/$BIG_ID/target/big"; else dd if=/dev/zero of="$EWTS/$BIG_ID/target/big" bs=1 count=0 seek=21g 2>/dev/null; fi
# A failed GNU stat BSD-style probe can still print filesystem information.
# Keep captures separate so only the successful dialect supplies the size.
if ! BIG_APPARENT=$(stat -f %z "$EWTS/$BIG_ID/target/big" 2>/dev/null); then
  BIG_APPARENT=$(stat -c %s "$EWTS/$BIG_ID/target/big")
fi
BIG_ALLOC_K=$(du -sk "$EWTS/$BIG_ID/target/big" | awk '{print $1}')
[ "$BIG_APPARENT" -ge 22000000000 ] && [ "$BIG_ALLOC_K" -lt 1048576 ] && pass "21 GB sparse build file allocates only ${BIG_ALLOC_K}K" || fail "sparse file apparent=$BIG_APPARENT allocated=${BIG_ALLOC_K}K"
[ -z "$(git -C "$EWTS/$BIG_ID" status --porcelain --untracked-files=all)" ] && pass 'ignored build output leaves the tree clean' || fail 'tree not clean with ignored target/'
ext_scan
ext_row "$EWTS/$BIG_ID" | grep >/dev/null '"category":"merged-worktree"' && pass 'oversized merged worktree is still merged-worktree; size never changes the category' || fail "oversized row: $(ext_row "$EWTS/$BIG_ID")"
OUT=$(ext_cleanup --bead "$BIG_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$BIG_ID" ] && ! ext_registered "$EWTS/$BIG_ID" && pass 'oversized worktree removed by cleanup' || fail "oversized cleanup rc=$RC: $OUT"

phase 'Misplaced parent scratch is visible but never removed'
if WHEELHOUSE_SCRATCH_PATH_CASE=parent bash "$HERE/scratch-path.selftest.sh" "$(dirname "$PRUNE")"; then
  pass 'parent scratch report and reviewed/automatic no-deletion proof'
else fail 'parent scratch report/no-deletion regression'; fi

if [ "$FAILED" -eq 0 ]; then
  echo 'prune.selftest: PASS'
  exit 0
fi
echo "prune.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
