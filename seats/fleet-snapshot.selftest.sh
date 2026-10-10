#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-fleet-snapshot.XXXXXX")" || exit 2
PIDS=""
cleanup(){ [ -n "$PIDS" ] && kill $PIDS >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; exit 1; }
ROOT="$FIX/proj"; BIN="$FIX/bin"; mkdir -p "$ROOT/seats/logs" "$ROOT/seats/run" "$ROOT/wheelhouse" "$ROOT/contracts" "$BIN" "$FIX/home/.pi-seats-snap/worker" "$FIX/home/.pi-seats-snap/verifier"
printf 'namespace=snap\n' > "$ROOT/wheelhouse/.template-source"
cp "$HERE/fleet-snapshot.ts" "$ROOT/seats/fleet-snapshot.ts"; cp "$HERE/seat-activity.ts" "$ROOT/seats/seat-activity.ts"; cp "$HERE/roster.ts" "$ROOT/seats/roster.ts"; cp "$HERE/pool.ts" "$ROOT/seats/pool.ts"; cp "$HERE/harness.ts" "$ROOT/seats/harness.ts"; cp "$HERE/credential-shapes.ts" "$ROOT/seats/credential-shapes.ts"
cat > "$ROOT/seats/seats.json" <<'JSON'
{"version":1,"seats":{"worker-1":{"role":"worker","harness":"codex","provider":"openai","model":"m","account":{"dir":"~/.pi-seats-snap/worker","authRoute":"oauth"}},"verifier":{"role":"verifier","harness":"codex","provider":"openai","model":"m","account":{"dir":"~/.pi-seats-snap/verifier","authRoute":"oauth"}}}}
JSON
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
[ "${BD_FAIL:-}" = 1 ] && { echo fixture bd failure >&2; exit 7; }
case "$1 $2" in
  "ready --json") cat "$BD_FIX/ready.json" ;;
  "list --json") cat "$BD_FIX/list.json" ;;
  *) if [ "$1" = list ]; then cat "$BD_FIX/list.json"; else echo unexpected bd "$@" >&2; exit 9; fi ;;
esac
SH
chmod +x "$BIN/bd"
write_graph(){ cat > "$ROOT/ready.json" <<'JSON'
[{"id":"r1","title":"ready one","description":"Integration: fleet/a"},{"id":"r2","title":"ready two","description":"Integration: fleet/a"},{"id":"r3","title":"ready three","parent":"epic-x"}]
JSON
cat > "$ROOT/list.json" <<'JSON'
[{"id":"r1","title":"ready one","status":"open","description":"Integration: fleet/a"},{"id":"r2","title":"ready two","status":"open","description":"Integration: fleet/a"},{"id":"r3","title":"ready three","status":"open","parent":"epic-x"},{"id":"dep","title":"dependent","status":"open","blocks":["r2"]},{"id":"rev1","title":"review one","status":"open","labels":["needs-review"],"assignee":"worker-1"},{"id":"rev2","title":"review two","status":"open","labels":["needs-review"],"assignee":"worker-1"},{"id":"busy-bead","title":"busy","status":"in_progress"}]
JSON
}
run_snap(){ RC=0; OUT="$(cd "$ROOT" && HOME="$FIX/home" PATH="$BIN:$PATH" BD_FIX="$ROOT" bun seats/fleet-snapshot.ts --json 2>&1)" || RC=$?; }
assert_js(){ node -e "$1" <<EOF
$OUT
EOF
}
write_graph
run_snap; [ $RC -eq 0 ] && assert_js 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); if(s.readyCount!==3||s.chainedCount!==1||s.overlapCount!==2||s.reviewBacklog.length!==2||s.workers.live.length!==0||s.reviewers.live.length!==1||s.reviewers.busy!==0) process.exit(1)' && pass 'empty graph/live-seat table counts ready, chained, overlap, backlog, reviewers' || fail "empty snapshot wrong rc=$RC out=$OUT"
(cd "$ROOT" && HOME="$FIX/home" PATH="$BIN:$PATH" BD_FIX="$ROOT" bun -e 'import { fleetSnapshot, readyWorkNobodyOnIt } from "./seats/fleet-snapshot.ts"; if(!readyWorkNobodyOnIt(fleetSnapshot(process.cwd()))) process.exit(1);') && pass 'readyWorkNobodyOnIt true when ready exists and no worker is busy' || fail 'readyWorkNobodyOnIt true row failed'
FIFO="$ROOT/seats/run/worker-1.stdin"; mkfifo "$FIFO"; (exec 3<>"$FIFO"; sleep 1000) & PIDS="$PIDS $!"; WPID=$!
printf '%s\n' '{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}' > "$ROOT/seats/logs/worker-1.jsonl"
cat > "$ROOT/seats/state.json" <<JSON
{"seats":{"worker-1":{"pid":$WPID,"startedAt":"2026-01-01T00:00:00Z","fifo":"$FIFO","log":"$ROOT/seats/logs/worker-1.jsonl","lastBead":"busy-bead"}}}
JSON
run_snap; [ $RC -eq 0 ] && assert_js 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); if(s.workers.live.length!==1||s.workers.busy!==1||s.workers.idle!==0) process.exit(1)' && pass 'settled worker remains busy when lastBead is in progress/rework' || fail "busy worker snapshot wrong rc=$RC out=$OUT"
(cd "$ROOT" && HOME="$FIX/home" PATH="$BIN:$PATH" BD_FIX="$ROOT" bun -e 'import { fleetSnapshot, readyWorkNobodyOnIt } from "./seats/fleet-snapshot.ts"; if(readyWorkNobodyOnIt(fleetSnapshot(process.cwd()))) process.exit(1);') && pass 'readyWorkNobodyOnIt false when a worker is busy' || fail 'readyWorkNobodyOnIt false row failed'
python3 - <<PY
import json
p='$ROOT/seats/state.json'; j=json.load(open(p)); j['seats']['worker-1']['lastBead']='closed-bead'; json.dump(j,open(p,'w'))
p='$ROOT/list.json'; rows=json.load(open(p)); rows.append({'id':'closed-bead','status':'closed'}); json.dump(rows,open(p,'w'))
PY
run_snap; [ $RC -eq 0 ] && assert_js 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); if(s.workers.idle!==1||s.workers.busy!==0) process.exit(1)' && pass 'settled live worker with closed bead is idle' || fail "idle worker wrong rc=$RC out=$OUT"
printf '%s\n' '{"pid":'$$',"bead":"rev1","startedAt":"2026-01-01T00:00:00Z"}' > "$ROOT/seats/run/verify.verifier.json"
printf '%s\n' '{"pid":999999,"bead":"rev2","startedAt":"2026-01-01T00:00:00Z"}' > "$ROOT/seats/run/verify.stale.json"
run_snap; [ $RC -eq 0 ] && assert_js 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); if(s.reviewBacklog.length!==1||s.reviewBacklog[0].id!=="rev2"||s.reviewers.busy!==1) process.exit(1)' && pass 'live verify marker removes backlog; stale marker does not' || fail "verify marker table wrong rc=$RC out=$OUT"
BD_FAIL=1 run_snap; [ $RC -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'STOP: bd ready --json failed' && pass 'bd non-zero is STOP, not a zero snapshot' || fail "bd failure behavior wrong rc=$RC out=$OUT"
DEFS="$(rg -n 'function readyWorkNobodyOnIt' "$HERE" -g '*.ts' | wc -l | tr -d ' ')"; [ "$DEFS" = 1 ] && pass 'grep finds exactly one readyWorkNobodyOnIt definition under seats/' || fail "definition count=$DEFS"
BROKEN="$ROOT/seats/fleet-snapshot-broken.ts"; cp "$ROOT/seats/fleet-snapshot.ts" "$BROKEN"; python3 - <<PY
p='$BROKEN'; s=open(p).read(); s=s.replace('&& pidAlive(Number(m.pid))',''); open(p,'w').write(s)
PY
if (cd "$ROOT" && HOME="$FIX/home" PATH="$BIN:$PATH" BD_FIX="$ROOT" bun -e 'import { fleetSnapshot } from "./seats/fleet-snapshot-broken.ts"; const s=fleetSnapshot(process.cwd()); if(s.reviewBacklog.length===1) process.exit(1);' >/dev/null 2>&1); then pass 'canary: removing stale-marker check makes backlog leg fail'; else fail 'canary did not prove stale-marker leg catches breakage'; fi

echo 'fleet-snapshot.selftest.sh works on this machine.'
