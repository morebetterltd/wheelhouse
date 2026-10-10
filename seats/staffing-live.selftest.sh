#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REAL_PI="$(command -v pi 2>/dev/null || true)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-staffing-live.XXXXXX")" || exit 2
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
skip(){ PASS=$((PASS+1)); echo "ok $PASS - SKIP $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
cleanup(){ [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null || true; [ "${WHEELHOUSE_KEEP_FIXTURE:-0}" = 1 ] || selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
PROJ="$FIX/project"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"; mkdir -p "$PROJ/seats/logs" "$PROJ/seats/run" "$PROJ/contracts" "$PROJ/wheelhouse" "$BIN" "$HOME_FIX/.pi-seats-live"
for e in e1 e2 e3 rv1; do mkdir -p "$HOME_FIX/.pi-seats-live/$e"; done
for f in adapter.ts staffing.ts jev.ts herald.ts recover.ts pool.ts roster.ts fleet-snapshot.ts seat-activity.ts seat-worktree.ts harness.ts credential-shapes.ts quota.ts briefs.ts host-budget.ts; do cp "$HERE/$f" "$PROJ/seats/$f"; done
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
cat > "$BIN/pi" <<'JS'
#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const agent = process.env.PI_CODING_AGENT_DIR || '';
if (!agent) { process.stderr.write('stub pi: no PI_CODING_AGENT_DIR\n'); process.exit(1); }
fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
const args = process.argv.slice(2);
let sessionFile, sessionId;
const si = args.indexOf('--session');
if (si !== -1 && args[si + 1]) { sessionFile = args[si + 1]; sessionId = path.basename(sessionFile, '.jsonl'); fs.appendFileSync(sessionFile, JSON.stringify({type:'resumed', cwd:process.cwd()})+'\n'); }
else { sessionId = crypto.randomUUID(); sessionFile = path.join(agent, 'sessions', sessionId + '.jsonl'); fs.writeFileSync(sessionFile, JSON.stringify({type:'session-start', cwd:process.cwd()})+'\n'); }
fs.appendFileSync(process.env.LIVE_ENV_LOG, JSON.stringify({pid:process.pid, argv:args, PI_CODING_AGENT_DIR:agent, HOME:process.env.HOME||'', cwd:process.cwd()})+'\n');
let streaming = false;
function out(o){ process.stdout.write(JSON.stringify(o)+'\n'); }
function handle(cmd){
  const id = cmd.id;
  if (cmd.type === 'get_state') out({id, type:'response', command:'get_state', success:true, data:{isStreaming:streaming, sessionId, sessionFile, messageCount:0}});
  else if (cmd.type === 'prompt') { streaming = true; out({id, type:'response', command:'prompt', success:true, data:{delivered:true}}); fs.appendFileSync(sessionFile, JSON.stringify({type:'prompt', message:cmd.message, cwd:process.cwd()})+'\n'); out({type:'agent_end', messages:[]}); streaming = false; }
  else out({id, type:'response', command:cmd.type, success:true});
}
let buf='';
process.stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0,i); buf = buf.slice(i+1); if (!line.trim()) continue; try { handle(JSON.parse(line)); } catch (e) { process.stderr.write(String(e)+'\n'); } } });
process.stdin.resume();
JS
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
if python3 - "$FIX/env.jsonl" "$PROJ/seats/state.json" "$PROJ/seats/staffing.json" "$PROJ/seats/pool.json" <<'PY'
import json, os, subprocess, sys
rows=[json.loads(l) for l in open(sys.argv[1])]
by_pid={int(r['pid']):r for r in rows}
state=json.load(open(sys.argv[2]))['seats']
staff=json.load(open(sys.argv[3]))['seats']
pool=json.load(open(sys.argv[4]))['entries']
checked=[]
for seat in sorted(k for k in staff if k.startswith('worker-')):
    entry=staff[seat]['entry']; pid=int(state[seat]['pid']); expected=os.path.realpath(os.path.expanduser(pool[entry]['account']['dir']))
    row=by_pid.get(pid)
    assert row, f'missing env row for pid {pid} seat {seat}'
    actual=os.path.realpath(os.path.expanduser(row['PI_CODING_AGENT_DIR']))
    assert actual == expected, f'{seat} pid {pid} account {actual} != {expected}'
    lsof=subprocess.run(['lsof','-Fn','-p',str(pid)], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert lsof.returncode == 0 and f'n{state[seat]["fifo"]}' in lsof.stdout, f'{seat} pid {pid} does not hold fifo {state[seat]["fifo"]}'
    checked.append(f'{seat} pid={pid} entry={entry} dir={actual}')
assert len(checked)==3, checked
print('\n'.join(checked))
PY
then pass "live harness processes use their pool entry dirs"; else fail "process/entry table failed: env=$(cat "$FIX/env.jsonl" 2>/dev/null) state=$(cat "$PROJ/seats/state.json" 2>/dev/null)"; fi
if [ "${WHEELHOUSE_SKIP_REAL_PI:-}" = 1 ]; then
  skip "real-pi leg: WHEELHOUSE_SKIP_REAL_PI=1"
elif [ -z "$REAL_PI" ]; then
  skip "real-pi leg: pi not found on PATH"
else
  REAL_ROOT="$FIX/real-pi-root"; REAL_HOME="$REAL_ROOT/home"; REAL_RUN="$REAL_ROOT/run"; mkdir -p "$REAL_HOME/.pi-seats-live/real-e1" "$REAL_HOME/.pi-seats-live/real-e2" "$REAL_RUN"
  REAL_PIDS=""
  ok_real=1
  for entry in real-e1 real-e2; do
    agent="$REAL_HOME/.pi-seats-live/$entry"; fifo="$REAL_RUN/$entry.stdin"; mkfifo "$fifo"
    env HOME="$REAL_HOME" PI_CODING_AGENT_DIR="$agent" ANTHROPIC_API_KEY="sk-selftest-dummy" WHEELHOUSE_TMUX_SOCKET="staffing-live-real-$$" WHEELHOUSE_HERALD_ROOT="$REAL_ROOT" "$REAL_PI" --mode rpc --provider anthropic 0<> "$fifo" >> "$REAL_RUN/$entry.log" 2>> "$REAL_RUN/$entry.err" &
    pid=$!; REAL_PIDS="$REAL_PIDS $pid"
    seen=""
    for _ in $(seq 1 40); do seen="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/ *$//')"; [ "$seen" = pi ] && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if ! kill -0 "$pid" 2>/dev/null || [ "$seen" != pi ] || ! lsof -Fn -p "$pid" 2>/dev/null | grep -qF "n$fifo"; then ok_real=0; echo "real-pi probe failed for $entry pid=$pid ps=$seen err=$(tail -c 200 "$REAL_RUN/$entry.err" 2>/dev/null)" >&2; fi
  done
  for pid in $REAL_PIDS; do kill -9 "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  [ "$ok_real" = 1 ] && pass "real pi starts in scratch login-free RPC state and each process holds its entry FIFO" || fail "real-pi scratch process/account probe failed"
fi
for s in worker-e1 worker-e2 worker-e3; do
  (cd "$PROJ" && bun seats/adapter.ts dispatch "$s" "task-$s" "synthetic dispatch") > "$FIX/dispatch-$s.out" 2>&1
  rc=$?
  [ $rc -eq 0 ] || fail "dispatch precondition failed for $s rc=$rc: $(cat "$FIX/dispatch-$s.out")"
done
WT_COUNT=$(find "$PROJ/.wheelhouse-worktrees" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
CAPS=$(cd "$PROJ" && bun -e 'import { worktreeCap } from "./seats/seat-worktree.ts"; console.log(worktreeCap(process.cwd()).cap); console.log(worktreeCap(process.cwd(), {a:1,b:1,c:1,d:1,e:1}).cap);')
if [ "$WT_COUNT" = 3 ] && [ "$CAPS" = "5
7" ]; then pass "three staffed dispatches create worktrees and cap reflects effective seats"; else fail "worktree/cap failed wt=$WT_COUNT caps=$CAPS"; fi
SID1=$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats["worker-e1"]; if(!s.sessionId) process.exit(2); console.log(s.sessionId)' "$PROJ/seats/state.json")
(cd "$PROJ" && bun seats/adapter.ts dispatch worker-e1 task-repeat "again") > "$FIX/repeat.out" 2>&1
REPEAT_RC=$?
SID2=$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats["worker-e1"]; if(!s.sessionId) process.exit(2); console.log(s.sessionId)' "$PROJ/seats/state.json")
[ $REPEAT_RC -eq 0 ] && [ "$SID1" = "$SID2" ] && pass "repeat dispatch preserves staffed seat sessionId" || fail "repeat dispatch/session failed rc=$REPEAT_RC $SID1 -> $SID2 out=$(cat "$FIX/repeat.out")"
(cd "$PROJ" && bun seats/adapter.ts dispatch worker-e2 shared-task "claimed here") > "$FIX/claim1.out" 2>&1
CLAIM1_RC=$?
(cd "$PROJ" && bun seats/adapter.ts dispatch worker-e3 shared-task "double claim") > "$FIX/claim2.out" 2>&1; CLAIM_RC=$?
[ $CLAIM1_RC -eq 0 ] && [ $CLAIM_RC -ne 0 ] && grep -q 'already assigned\|already has\|already checked out\|refusing' "$FIX/claim2.out" && pass "same task dispatched to second staffed seat is refused" || fail "double dispatch precondition/refusal wrong rc1=$CLAIM1_RC rc2=$CLAIM_RC first=$(cat "$FIX/claim1.out") second=$(cat "$FIX/claim2.out")"
KILLPID=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats["worker-e1"].pid)' "$PROJ/seats/state.json")
kill -9 "$KILLPID" 2>/dev/null || true; kill "$HERALD_PID" 2>/dev/null || true
node -e 'const fs=require("fs"); const f=process.argv[1]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.seats["worker-unspawned"]={role:"worker",entry:"e3",addedAt:new Date().toISOString()}; fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$PROJ/seats/staffing.json"
(cd "$PROJ" && bun seats/recover.ts) > "$FIX/recover.out" 2>&1 || true
if grep -q 'worker-e1.*DEAD.*staffed: e1' "$FIX/recover.out" && grep -q 'resume: bun .*adapter.ts resume worker-e1' "$FIX/recover.out" && grep -q 'worker-e2.*RUNNING' "$FIX/recover.out" && grep -q 'worker-unspawned.*STAFFED-UNSPAWNED.*spawn: bun .*adapter.ts spawn worker-unspawned' "$FIX/recover.out"; then pass "recover reports staffed dead, running, and unspawned seats"; else fail "recover staffed output wrong: $(cat "$FIX/recover.out")"; fi
(cd "$PROJ" && bun seats/herald.ts --status) > "$FIX/status.out" 2>&1 || true
if grep -q '^staffing: next check in ' "$FIX/status.out"; then pass "herald --status prints staffing clock line"; else fail "status missing staffing line: $(cat "$FIX/status.out")"; fi
# Canary: break the real herald staffing launch path, then assert leg (a)'s
# growth precondition does NOT happen. If this passes with growth, the suite no
# longer proves herald is what launches staffing.
CAN="$FIX/canary-herald"; cp -R "$PROJ" "$CAN"; rm -f "$CAN/seats/staffing.json" "$CAN/seats/state.json"; rm -rf "$CAN/.wheelhouse-worktrees"; mkdir -p "$CAN/.wheelhouse-worktrees"
python3 - "$CAN/seats/herald.ts" <<'PY'
from pathlib import Path
p=Path(__import__('sys').argv[1]); s=p.read_text()
s=s.replace('const launched = launchDetached("staffing", ["bun", "seats/staffing.ts", "check"], 0, STAFFING_OUT_LOG);', 'const launched = false; // canary disables real staffing launch')
p.write_text(s)
PY
(cd "$CAN" && HOME="$HOME_FIX" PATH="$BIN:$PATH" OPENAI_API_KEY=fixture-key LIVE_ENV_LOG="$FIX/canary-env.jsonl" WHEELHOUSE_CLEANUP=0 WHEELHOUSE_HERALD_ROOT="$CAN" WHEELHOUSE_HERALD_INTERVAL_MS=50 WHEELHOUSE_STAFFING_INTERVAL_MS=50 bun seats/herald.ts) > "$FIX/canary-herald.out" 2> "$FIX/canary-herald.err" & CAN_PID=$!
for _ in $(seq 1 20); do [ -f "$CAN/seats/state.json" ] && break; sleep 0.1; done
kill "$CAN_PID" 2>/dev/null || true
CAN_STATE_COUNT=$(node -e 'const fs=require("fs"); try{console.log(Object.values(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).seats||{}).filter(r=>r.pid).length)}catch{console.log(0)}' "$CAN/seats/state.json")
[ "$CAN_STATE_COUNT" = 0 ] && pass "canary: disabling herald staffing launch makes the no-commander growth leg fail" || fail "canary broken herald still grew workers state=$CAN_STATE_COUNT"
if [ "$FAIL" -eq 0 ]; then echo "staffing-live.selftest: PASS ($PASS checks)"; exit 0; fi
echo "staffing-live.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
