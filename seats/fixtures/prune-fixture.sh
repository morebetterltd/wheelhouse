#!/usr/bin/env bash
# Test-only shared fixture construction for prune (full) and prune-safety (core).
# Each suite owns a fresh root, graph, product and bare origin; no shared state.
# Assertion phases live in the two entrypoints, not behind selection switches.
# Setup bodies retain their spelling for the real-source extraction controls.

prune_fixture_start(){
set -uo pipefail

export WHEELHOUSE_FIXTURE_COMMAND_MODULE="$HERE/fixtures/fixture-command.cjs"
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
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
export GIT_CEILING_DIRECTORIES="$FIX${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}"
TMP_SCRATCH=()
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; rm -rf ${TMP_SCRATCH[@]+"${TMP_SCRATCH[@]}"}; }
selftest_install_cleanup_traps cleanup
export HOME="$FIX/home"
mkdir -p "$HOME"


# Both graphs disable detached bd telemetry in fixture-owned configuration.
selftest_disable_bd_metrics "$FIX" || exit 2
METRICS_CONFIG="$XDG_CONFIG_HOME/bd/config.yaml"
if [ -f "$METRICS_CONFIG" ] && grep -Eq '^[[:space:]]+disabled: true$' "$METRICS_CONFIG"; then
  pass 'fixture-owned bd metrics config disables detached telemetry flushers'
else
  fail 'fixture-owned bd metrics config does not disable detached telemetry flushers'
fi

}

# Graph exports never escape these per-command subshells, including HOME/XDG.
prune_graph_run(){
  local graph_env="$1"; shift
  (
    unset WHEELHOUSE_SELFTEST_BD_ROOT
    eval "$graph_env"
    case "${WHEELHOUSE_SELFTEST_BD_ROOT:-}" in "$FIX"/*) ;; *) echo 'STOP: prune command lacks its fixture helper graph' >&2; exit 1 ;; esac
    [ "$(command -v bd)" = "$WHEELHOUSE_SELFTEST_BD_ROOT/bin/bd" ] || { echo 'STOP: prune bd is not the helper wrapper' >&2; exit 1; }
    "$@"
  )
}
prune_graph_guard(){ bun "$HERE/fixtures/prune-graph.ts" guard "$1" "$2" || exit 1; }
prune_graph_assert(){
  local label="$1" graph_env="$2"; shift 2
  if prune_graph_run "$graph_env" bun "$HERE/fixtures/prune-graph.ts" assert "$label" "$@"; then
    pass "$label tasks were written to the selftest scratch graph only"
  else
    fail "$label tasks were written to the selftest scratch graph only"; return 1
  fi
}

prune_wait_regression(){
  local source="$FIX/prune-wait-source" graph="$FIX/prune-wait-graph" graph_env
  prune_graph_guard waitcase "$HERE/fixtures/prune-wait.ts"
  graph_env="$(selftest_scratch_graph "$graph")" || return 2
  mkdir -p "$source"
  selftest_copy_seat_runtime "$source" "$(dirname "$PRUNE")" || return 2
  prune_graph_run "$graph_env" bun "$HERE/fixtures/prune-wait.ts" "$FIX/prune-wait" "$source" "$PRUNE" "$HERE/fixtures/prune-wait-clock.ts" "${WHEELHOUSE_PRUNE_WAIT_MODE:-fixed}" "$graph"
}

prune_init_git_fixture(){
  ROOT="$FIX/container"; PROD="$ROOT/product"; WTS="$ROOT/.wheelhouse-worktrees"
  mkdir -p "$PROD" "$WTS" "$ROOT/seats" || return 2
  selftest_copy_seat_runtime "$ROOT" "$(dirname "$PRUNE")" || return 2
  chmod +x "$ROOT/seats/prune.ts" || return 2
  git -C "$ROOT" init -q -b main || return 2
  git -C "$ROOT" config user.email selftest@example.invalid || return 2
  git -C "$ROOT" config user.name selftest || return 2
  git -C "$PROD" init -q -b main || return 2
  git -C "$PROD" config user.email selftest@example.invalid || return 2
  git -C "$PROD" config user.name selftest || return 2
  printf 'base\n' > "$PROD/app.txt"
  git -C "$PROD" add app.txt || return 2
  git -C "$PROD" commit -q -m base || return 2
}


# Common reviewed-scan corpus. Both suites build exactly these rows.
prune_fixture_reviewed(){
prune_graph_guard 'reviewed fixture' "$HERE/fixtures/prune-fixture.sh"
reviewed_tsv_header(){ printf '# wheelhouse-prune-scan-v1\t["%s"]\ncategory\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason\n' "$1"; }

prune_init_git_fixture || exit 2
BARE="$FIX/origin.git"
git -C "$PROD" init --bare -q -b main "$BARE"
git -C "$PROD" remote add origin "$BARE"
git -C "$PROD" push -q -u origin main

REVIEWED_GRAPH="$FIX/reviewed-graph"
REVIEWED_GRAPH_ENV="$(selftest_scratch_graph "$REVIEWED_GRAPH")" || exit 2
ln -s "$REVIEWED_GRAPH/.beads" "$ROOT/.beads" || exit 2
REVIEWED_HOME="$(prune_graph_run "$REVIEWED_GRAPH_ENV" bash -c 'printf "%s" "$HOME"')" || exit 2
reviewed_bead(){
  local id
  id=$(prune_graph_run "$REVIEWED_GRAPH_ENV" bd create "$1" --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)') || return 1
  if [ "$2" = closed ]; then prune_graph_run "$REVIEWED_GRAPH_ENV" bd close "$id" >/dev/null || return 1; fi
  printf '%s\n' "$id"
}
CLOSED_ID=$(reviewed_bead 'closed merged worktree' closed) || exit 2
OPEN_ID=$(reviewed_bead 'seat anchored worktree' open) || exit 2
OPEN_LIVE_ID=$(reviewed_bead 'open live cwd anchor' open) || exit 2
LIVE_ID=$(reviewed_bead 'closed live cwd anchor' closed) || exit 2
CLOSED_LIVE_ID=$(reviewed_bead 'closed live cwd needs-review' closed) || exit 2
HIST_ID=$(reviewed_bead 'closed session history anchor' closed) || exit 2
STALE_ID=$(reviewed_bead 'closed stale branch no worktree' closed) || exit 2
UNMERGED_ID=$(reviewed_bead 'closed unmerged branch must survive' closed) || exit 2
GOAL_CHILD_ID=$(reviewed_bead 'closed child merged only to goal branch' closed) || exit 2
prune_graph_assert 'reviewed fixture' "$REVIEWED_GRAPH_ENV" "$ROOT" "$REVIEWED_GRAPH" "$CLOSED_ID:closed" "$OPEN_ID:open" "$OPEN_LIVE_ID:open" "$LIVE_ID:closed" "$CLOSED_LIVE_ID:closed" "$HIST_ID:closed" "$STALE_ID:closed" "$UNMERGED_ID:closed" "$GOAL_CHILD_ID:closed" || exit 1

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
selftest_install_cleanup_traps cleanup_prune
LIVE_STARTED="$(bun -e 'const { spawnSync } = await import(process.env.WHEELHOUSE_FIXTURE_COMMAND_MODULE); const r=spawnSync("ps",["-p",process.argv[1],"-o","lstart="],{encoding:"utf8"}); console.error("CAPTURE prune fixture ps "+JSON.stringify({status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr})); if(r.status!==0||r.signal||r.error)process.exit(2); console.log(new Date(Date.parse(r.stdout.trim())).toISOString());' "$LIVE_PID")" || exit 2
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"},"worker-live":{"pid":%s,"startedAt":"%s","cwd":"%s"},"worker-history":{"pid":999998,"cwd":"%s","sessionFile":"%s"}}}\n' "$WTS/$OPEN_ID" "$LIVE_PID" "$LIVE_STARTED" "$WTS/$OPEN_ID" "$WTS/$OPEN_ID" "$SESSION_HISTORY" > "$ROOT/seats/state.json"
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
# Own the parent, not merely a bead-derived name in somebody else's TMPDIR.
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-prune-tmp.XXXXXX")" || exit 2
TMP_SCRATCH+=("$TMP_ROOT")
# The scanner records physical paths, even if inherited TMPDIR is an alias.
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)" || exit 2
export TMPDIR="$TMP_ROOT"
CLOSED_TMP="$TMP_ROOT/$CLOSED_ID-derivedData"
OPEN_TMP="$TMP_ROOT/$OPEN_ID-derivedData"
mkdir -p "$CLOSED_TMP" "$OPEN_TMP"
printf 'closed tmp scratch\n' > "$CLOSED_TMP/file.txt"
printf 'open tmp scratch\n' > "$OPEN_TMP/file.txt"
OPEN_RUNS_BEFORE=$(shasum -a 256 "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" | awk '{print $1}')
OPEN_TMP_BEFORE=$(shasum -a 256 "$OPEN_TMP/file.txt" | awk '{print $1}')

FAKEBIN="$FIX/fakebin"
SIMDATA_CLOSED="$FIX/simdata-closed"
SIMDATA_OPEN="$FIX/simdata-open"
mkdir -p "$FAKEBIN" "$SIMDATA_CLOSED" "$SIMDATA_OPEN" "$REVIEWED_HOME/Library/Developer/XCTestDevices"
printf 'closed simulator bytes\n' > "$SIMDATA_CLOSED/payload"
printf 'open simulator bytes\n' > "$SIMDATA_OPEN/payload"
printf 'xctest device bytes\n' > "$REVIEWED_HOME/Library/Developer/XCTestDevices/payload"
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
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"$CLOSED_ID-walk","udid":"11111111-1111-1111-1111-111111111111","state":"Shutdown","dataPath":"$SIMDATA_CLOSED"},{"name":"$OPEN_ID-walk","udid":"22222222-2222-2222-2222-222222222222","state":"Shutdown","dataPath":"$SIMDATA_OPEN"}]}}
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
git -C "$BUSY" init -q -b main
printf '{"seats":{}}\n' > "$BUSY/seats/state.json"
selftest_copy_seat_runtime "$BUSY" "$(dirname "$PRUNE")"
chmod +x "$BUSY/seats/prune.ts"
printf 'active-lock\n' > "$BUSY/.wheelhouse-bench.lock/pid"
printf 'busy-cache\n' > "$BUSY/product/.wheelhouse-build/cache.txt"

}

# Safety needs the same saved scan that the full classification phase produces.
# Classification assertions stay in the full suite; only preparation is shared.
prune_fixture_scan(){
SCAN="$FIX/scan.tsv"
cat > "$ROOT/seats/integration-refs.txt" <<'EOF'
# extra integration branches for this install

fleet/goal-x
fleet/never-created
EOF
( cd "$ROOT" && prune_graph_run "$REVIEWED_GRAPH_ENV" bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan failed" >&2; exit 2; }
}

prune_fixture_cleanup_helpers(){
set +e   # the phase above left -e on; these phases inspect exit codes themselves
json_id(){ bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)'; }
EXT_PIDS=()
cleanup_ext(){ for p in ${EXT_PIDS[@]+"${EXT_PIDS[@]}"}; do kill "$p" >/dev/null 2>&1 || true; done; cleanup_prune; }
selftest_install_cleanup_traps cleanup_ext
mk_install(){ # $1 root: container git repo, nested product repo with a bare origin at $1.origin.git, prune.ts in place
  mkdir -p "$1/product" "$1/seats"
  selftest_copy_seat_runtime "$1" "$(dirname "$PRUNE")"
  git -C "$1" init -q -b main
  git -C "$1/product" init -q -b main
  git -C "$1/product" config user.email selftest@example.invalid
  git -C "$1/product" config user.name selftest
  printf 'base\n' > "$1/product/app.txt"
  git -C "$1/product" add app.txt; git -C "$1/product" commit -q -m base
  git -C "$1/product" init --bare -q -b main "$1.origin.git"
  git -C "$1/product" remote add origin "$1.origin.git"
  git -C "$1/product" push -q -u origin main
}

}

prune_fixture_ext(){
prune_graph_guard 'extended fixture' "$HERE/fixtures/prune-fixture.sh"
EXT="$FIX/ext"; EPROD="$EXT/product"; EWTS="$EXT/.wheelhouse-worktrees"; ERUNS="$EXT/.wheelhouse-runs"; ELOG="$EXT/seats/logs/cleanup.log"
mk_install "$EXT"; mkdir -p "$EWTS" "$ERUNS"
EXT_GRAPH="$FIX/ext-graph"
EXT_GRAPH_ENV="$(selftest_scratch_graph "$EXT_GRAPH")" || exit 2
ln -s "$EXT_GRAPH/.beads" "$EXT/.beads" || exit 2
ext_bead(){
  local id status="${2:-closed}"
  id=$(prune_graph_run "$EXT_GRAPH_ENV" bd create "$1" --json | json_id) || return 1
  if [ "$status" = closed ]; then prune_graph_run "$EXT_GRAPH_ENV" bd close "$id" >/dev/null || return 1; fi
  prune_graph_run "$EXT_GRAPH_ENV" bun "$HERE/fixtures/prune-graph.ts" assert 'extended fixture' "$EXT" "$EXT_GRAPH" "$id:$status" >/dev/null || return 1
  printf '%s\n' "$id"
}
ext_wt(){ # $1 bead id, $2 optional dir: worktree on fleet/<id> with one commit touching <id>.txt
  local dir="${2:-$EWTS/$1}"
  git -C "$EPROD" worktree add -q -b "fleet/$1" "$dir" main || { fail "worktree add failed for $dir"; return 1; }
  [ -e "$dir/.git" ] || { fail "worktree $dir has no .git after git worktree add; refusing to commit"; return 1; }
  printf '%s\n' "$1" > "$dir/$1.txt"; git -C "$dir" add "$1.txt" && git -C "$dir" commit -q -m "work $1"
}
ext_merge(){ git -C "$EPROD" checkout -q main; git -C "$EPROD" merge -q --no-ff "fleet/$1" -m "merge $1"; git -C "$EPROD" push -q origin main; git -C "$EPROD" push -q origin "fleet/$1"; }
ext_scan(){ ( cd "$EXT" && prune_graph_run "$EXT_GRAPH_ENV" bun seats/prune.ts scan --format jsonl > "$FIX/ext-scan.jsonl" 2>/dev/null ); }
ext_row(){ grep -F "\"path\":\"$1\"" "$FIX/ext-scan.jsonl"; }
ext_registered(){ git -C "$EPROD" worktree list --porcelain | grep -xF >/dev/null "worktree $1"; }
ext_cleanup(){ ( cd "$EXT" && prune_graph_run "$EXT_GRAPH_ENV" bun seats/prune.ts cleanup "$@" 2>&1 ); }
# This case asserts eventual progress, not expiry at a host-speed-dependent 30s.
# Keep only these progress clients' budget clock stationary; ordinary cleanup
# and the separate immediate lock-refusal case retain the native clock.
ext_wait_cleanup(){ ( cd "$EXT" && prune_graph_run "$EXT_GRAPH_ENV" bun --preload "$HERE/fixtures/prune-wait-clock.ts" seats/prune.ts cleanup "$@" 2>&1 ); }
ext_record_run(){
  ( cd "$EXT" && prune_graph_run "$EXT_GRAPH_ENV" bun -e 'import {recordCleanupScratch} from "./seats/cleanup-identity.ts"; recordCleanupScratch(process.argv[1],process.argv[2],process.argv[3]);' "$EXT" "$1" "$2" ) || exit 2
}

}
