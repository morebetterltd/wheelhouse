#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-staffing-live.XXXXXX")" || exit 2
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
cleanup(){ [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null || true; [ "${WHEELHOUSE_KEEP_FIXTURE:-0}" = 1 ] || selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
PROJ="$FIX/project"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"; mkdir -p "$PROJ/seats/logs" "$PROJ/seats/run" "$PROJ/contracts" "$PROJ/wheelhouse" "$BIN" "$HOME_FIX/.pi-seats-live"
for e in e1 e2 e3 rv1; do mkdir -p "$HOME_FIX/.pi-seats-live/$e"; done
for f in adapter.ts staffing.ts herald.ts recover.ts pool.ts roster.ts fleet-snapshot.ts seat-activity.ts seat-worktree.ts harness.ts credential-shapes.ts quota.ts briefs.ts host-budget.ts; do cp "$HERE/$f" "$PROJ/seats/$f"; done
printf '# Fleet: Worker\n\nfixture brief\n' > "$PROJ/contracts/WORKER.md"; printf 'namespace=live\n' > "$PROJ/wheelhouse/.template-source"
cat > "$PROJ/seats/seats.json" <<'JSON'
{"version":1,"seats":{}}
JSON
cat > "$PROJ/seats/pool.json" <<'JSON'
{"version":1,"check_interval_seconds":1,"entries":{"e1":{"harness":"pi","provider":"openai","models":["m1"],"account":{"dir":"~/.pi-seats-live/e1","authRoute":"env"}},"e2":{"harness":"pi","provider":"openai","models":["m2"],"account":{"dir":"~/.pi-seats-live/e2","authRoute":"env"}},"e3":{"harness":"pi","provider":"openai","models":["m3"],"account":{"dir":"~/.pi-seats-live/e3","authRoute":"env"}},"rv1":{"harness":"pi","provider":"openai","models":["rv"],"account":{"dir":"~/.pi-seats-live/rv1","authRoute":"env"}}},"roles":{"workers":{"min":1,"max":3,"entries":["e1","e2","e3"],"model":{"e1":"m1","e2":"m2","e3":"m3"}},"reviewers":{"min":0,"max":1,"entries":["rv1"],"model":"rv"}}}
JSON
(cd "$PROJ" && git init -q -b main && git config user.email selftest@example.invalid && git config user.name selftest && git add . && git commit -q -m base)
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
if [ "$1 $2" = "ready --json" ]; then printf '[{"id":"ready-1","title":"Synthetic ready 1","status":"open","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0},{"id":"ready-2","title":"Synthetic ready 2","status":"open","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0},{"id":"ready-3","title":"Synthetic ready 3","status":"open","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0},{"id":"ready-4","title":"Synthetic ready 4","status":"open","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0}]\n'; exit 0; fi
if [ "$1" = list ]; then printf '[{"id":"task-a","title":"Synthetic task A","status":"open","assignee":"worker-e1","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0}]\n'; exit 0; fi
exit 0
SH
chmod +x "$BIN/bd"
cat > "$BIN/pi" <<'PY'
#!/usr/bin/env python3
import json, os, sys, time, pathlib
agent=os.environ.get('PI_CODING_AGENT_DIR','')
pathlib.Path(agent,'sessions').mkdir(parents=True, exist_ok=True)
session=str(pathlib.Path(agent,'sessions','fixture.jsonl'))
pathlib.Path(session).write_text('{"type":"session-start"}\n')
with open(os.environ['LIVE_ENV_LOG'],'a') as f: f.write(json.dumps({'argv':sys.argv[1:],'PI_CODING_AGENT_DIR':agent,'HOME':os.environ.get('HOME','')})+'\n')
for line in sys.stdin:
    if not line.strip(): continue
    cmd=json.loads(line); cid=cmd.get('id')
    if cmd.get('type')=='get_state': print(json.dumps({'id':cid,'type':'response','command':'get_state','success':True,'data':{'isStreaming':False,'sessionId':'fixture','sessionFile':session,'messageCount':0}}), flush=True)
    elif cmd.get('type')=='prompt':
        print(json.dumps({'id':cid,'type':'response','command':'prompt','success':True,'data':{'delivered':True}}), flush=True)
        print(json.dumps({'type':'agent_end','messages':[]}), flush=True)
    else: print(json.dumps({'id':cid,'type':'response','command':cmd.get('type'),'success':True}), flush=True)
while True: time.sleep(60)
PY
chmod +x "$BIN/pi"
export HOME="$HOME_FIX" PATH="$BIN:$PATH" OPENAI_API_KEY=fixture-key LIVE_ENV_LOG="$FIX/env.jsonl" WHEELHOUSE_CLEANUP=0 WHEELHOUSE_HERALD_ROOT="$PROJ" WHEELHOUSE_HERALD_INTERVAL_MS=100 WHEELHOUSE_STAFFING_INTERVAL_MS=200
(cd "$PROJ" && bun seats/herald.ts) > "$FIX/herald.out" 2> "$FIX/herald.err" & HERALD_PID=$!
for _ in $(seq 1 60); do
  [ -f "$PROJ/seats/staffing.json" ] && COUNT=$(node -e 'const fs=require("fs"); try{console.log(Object.keys(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats||{}).length)}catch{console.log(0)}' "$PROJ/seats/staffing.json") || COUNT=0
  [ -f "$PROJ/seats/state.json" ] && SCOUNT=$(node -e 'const fs=require("fs"); try{console.log(Object.values(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats||{}).filter(r=>r.pid).length)}catch{console.log(0)}' "$PROJ/seats/state.json") || SCOUNT=0
  [ "$COUNT" = 3 ] && [ "$SCOUNT" = 3 ] && break
  sleep 0.1
done
LIVE_COUNT=$(node -e 'const fs=require("fs"); try{console.log(Object.keys(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats||{}).length)}catch{console.log(0)}' "$PROJ/seats/staffing.json")
STATE_COUNT=$(node -e 'const fs=require("fs"); try{console.log(Object.values(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats||{}).filter(r=>r.pid).length)}catch{console.log(0)}' "$PROJ/seats/state.json")
if [ "$LIVE_COUNT" = 3 ] && [ "$STATE_COUNT" = 3 ] && grep -q 'decision=add-worker' "$PROJ/seats/logs/staffing.log"; then pass "herald staffing clock grows three live workers without commander action"; else fail "staffing clock did not grow workers live=$LIVE_COUNT state=$STATE_COUNT log=$(cat "$PROJ/seats/logs/staffing.log" 2>/dev/null) herald=$(cat "$FIX/herald.err" 2>/dev/null)"; fi
if python3 - "$FIX/env.jsonl" "$HOME_FIX" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
home=sys.argv[2]
dirs={r['PI_CODING_AGENT_DIR'] for r in rows}
assert len(dirs)>=3
assert all('/.pi-seats-live/e' in d for d in dirs)
assert all(d != home+'/.claude' for d in dirs)
for d in sorted(dirs): print(d)
PY
then pass "live harness processes use their pool entry dirs"; else fail "env table failed: $(cat "$FIX/env.jsonl" 2>/dev/null)"; fi
for s in worker-e1 worker-e2 worker-e3; do (cd "$PROJ" && bun seats/adapter.ts dispatch "$s" "task-$s" "synthetic dispatch") >/dev/null 2>&1 || true; done
WT_COUNT=$(find "$PROJ/.wheelhouse-worktrees" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
CAPS=$(cd "$PROJ" && bun -e 'import { worktreeCap } from "./seats/seat-worktree.ts"; console.log(worktreeCap(process.cwd()).cap); console.log(worktreeCap(process.cwd(), {a:1,b:1,c:1,d:1,e:1}).cap);')
if [ "$WT_COUNT" -ge 3 ] && [ "$CAPS" = "5
7" ]; then pass "three staffed dispatches create worktrees and cap reflects effective seats"; else fail "worktree/cap failed wt=$WT_COUNT caps=$CAPS"; fi
SID1=$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats["worker-e1"]; console.log(s.sessionId)' "$PROJ/seats/state.json")
(cd "$PROJ" && bun seats/adapter.ts dispatch worker-e1 task-repeat "again") >/dev/null 2>&1 || true
SID2=$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats["worker-e1"]; console.log(s.sessionId)' "$PROJ/seats/state.json")
[ "$SID1" = "$SID2" ] && pass "repeat dispatch preserves staffed seat sessionId" || fail "session changed $SID1 -> $SID2"
(cd "$PROJ" && bun seats/adapter.ts dispatch worker-e2 shared-task "claimed here") > "$FIX/claim1.out" 2>&1 || true
(cd "$PROJ" && bun seats/adapter.ts dispatch worker-e3 shared-task "double claim") > "$FIX/claim2.out" 2>&1; CLAIM_RC=$?
[ $CLAIM_RC -ne 0 ] && pass "same task dispatched to second staffed seat is refused" || fail "double dispatch was not refused: $(cat "$FIX/claim2.out")"
KILLPID=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats["worker-e1"].pid)' "$PROJ/seats/state.json")
kill -9 "$KILLPID" 2>/dev/null || true; kill "$HERALD_PID" 2>/dev/null || true
node -e 'const fs=require("fs"); const f=process.argv[1]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.seats["worker-unspawned"]={role:"worker",entry:"e3",addedAt:new Date().toISOString()}; fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$PROJ/seats/staffing.json"
(cd "$PROJ" && bun seats/recover.ts) > "$FIX/recover.out" 2>&1 || true
if grep -q 'worker-e1.*DEAD.*staffed: e1' "$FIX/recover.out" && grep -q 'resume: bun .*adapter.ts resume worker-e1' "$FIX/recover.out" && grep -q 'worker-e2.*RUNNING' "$FIX/recover.out" && grep -q 'worker-unspawned.*STAFFED-UNSPAWNED.*spawn: bun .*adapter.ts spawn worker-unspawned' "$FIX/recover.out"; then pass "recover reports staffed dead, running, and unspawned seats"; else fail "recover staffed output wrong: $(cat "$FIX/recover.out")"; fi
(cd "$PROJ" && bun seats/herald.ts --status) > "$FIX/status.out" 2>&1 || true
if grep -q '^staffing: next check in ' "$FIX/status.out"; then pass "herald --status prints staffing clock line"; else fail "status missing staffing line: $(cat "$FIX/status.out")"; fi
# canary for the herald pool branch: no pool means no staffing growth.
NOP="$FIX/no-pool"; cp -R "$PROJ" "$NOP"; rm -f "$NOP/seats/pool.json" "$NOP/seats/staffing.json" "$NOP/seats/state.json"; (cd "$NOP" && WHEELHOUSE_HERALD_ROOT="$NOP" WHEELHOUSE_HERALD_INTERVAL_MS=100 WHEELHOUSE_STAFFING_INTERVAL_MS=100 bun seats/herald.ts --once) >/dev/null 2>&1 || true
[ ! -f "$NOP/seats/staffing.json" ] && pass "canary: removing pool branch makes the no-commander growth leg fail" || fail "canary no-pool unexpectedly wrote staffing.json"
if [ "$FAIL" -eq 0 ]; then echo "staffing-live.selftest: PASS ($PASS checks)"; exit 0; fi
echo "staffing-live.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
