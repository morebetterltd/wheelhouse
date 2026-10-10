#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-staffing.XXXXXX")" || exit 2
PIDS=""
cleanup(){ [ -n "$PIDS" ] && kill $PIDS >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; exit 1; }
ROOT="$FIX/proj"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"; mkdir -p "$ROOT/seats/logs" "$ROOT/seats/run" "$ROOT/wheelhouse" "$ROOT/.wheelhouse-worktrees" "$BIN" "$HOME_FIX/.pi-seats-staff"
printf 'namespace=staff\n' > "$ROOT/wheelhouse/.template-source"
for e in e1 e2 e3 e4 rv1; do mkdir -p "$HOME_FIX/.pi-seats-staff/$e"; done
cp "$HERE/staffing.ts" "$ROOT/seats/staffing.ts"; cp "$HERE/pool.ts" "$ROOT/seats/pool.ts"; cp "$HERE/roster.ts" "$ROOT/seats/roster.ts"; cp "$HERE/fleet-snapshot.ts" "$ROOT/seats/fleet-snapshot.ts"; cp "$HERE/seat-activity.ts" "$ROOT/seats/seat-activity.ts"; cp "$HERE/seat-worktree.ts" "$ROOT/seats/seat-worktree.ts"; cp "$HERE/harness.ts" "$ROOT/seats/harness.ts"; cp "$HERE/credential-shapes.ts" "$ROOT/seats/credential-shapes.ts"; cp "$HERE/quota.ts" "$ROOT/seats/quota.ts"
cat > "$ROOT/seats/seats.json" <<'JSON'
{"version":1,"seats":{}}
JSON
cat > "$ROOT/seats/pool.json" <<'JSON'
{"version":1,"idle_drop_minutes":30,"entries":{"e1":{"harness":"codex","provider":"openai","models":["m1"],"account":{"dir":"~/.pi-seats-staff/e1","authRoute":"env"}},"e2":{"harness":"codex","provider":"openai","models":["m2"],"account":{"dir":"~/.pi-seats-staff/e2","authRoute":"env"}},"e3":{"harness":"codex","provider":"openai","models":["m3"],"account":{"dir":"~/.pi-seats-staff/e3","authRoute":"env"}},"e4":{"harness":"codex","provider":"openai","models":["m4"],"account":{"dir":"~/.pi-seats-staff/e4","authRoute":"env"}},"rv1":{"harness":"codex","provider":"openai","models":["vr"],"account":{"dir":"~/.pi-seats-staff/rv1","authRoute":"env"}}},"roles":{"workers":{"min":1,"max":4,"entries":["e1","e2","e3","e4"],"model":{"e1":"m1","e2":"m2","e3":"m3","e4":"m4"}},"reviewers":{"min":0,"max":1,"entries":["rv1"],"model":"vr"}}}
JSON
( cd "$ROOT" && git init -q -b main && git config user.email selftest@example.invalid && git config user.name selftest && git add seats wheelhouse && git commit -q -m base )
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
ready_count="${BD_READY_COUNT:-0}"
if [ "$1 $2" = "ready --json" ]; then
  python3 - "$ready_count" <<'PY'
import json,sys
n=int(sys.argv[1]); print(json.dumps([{"id":f"ready-{i}","title":f"Synthetic ready {i}","status":"open","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0} for i in range(n)]))
PY
  exit 0
fi
if [ "$1" = list ]; then
  if [ "${BD_REVIEW:-0}" = 1 ]; then
    cat <<'JSON'
[{"id":"busy-bead","title":"Synthetic busy","status":"in_progress","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0},{"id":"review-bead","title":"Synthetic review","status":"open","labels":["needs-review"],"assignee":"worker-e1","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0}]
JSON
  else
    cat <<'JSON'
[{"id":"busy-bead","title":"Synthetic busy","status":"in_progress","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependency_count":0,"dependent_count":0}]
JSON
  fi
  exit 0
fi
echo unexpected bd "$@" >&2; exit 9
SH
chmod +x "$BIN/bd"
cat > "$ROOT/seats/adapter.ts" <<'BUN'
#!/usr/bin/env bun
import * as fs from "node:fs"; import * as path from "node:path"; import { spawnSync, spawn } from "node:child_process";
const root=path.resolve(import.meta.dir,".."); const [cmd,...args]=process.argv.slice(2); const log=path.join(root,"adapter-argv.log"); fs.appendFileSync(log, JSON.stringify(process.argv.slice(2))+"\n");
function read(file:string){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return {seats:{}}}}
function write(file:string,j:any){fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(j,null,2)+"\n")}
function pool(){return JSON.parse(fs.readFileSync(path.join(root,"seats/pool.json"),"utf8"))}
function modelFor(seat:string){const p=pool(); const ent=seat.replace(/^worker-/,'').replace(/^verifier-/,''); const r=p.roles.workers.entries.includes(ent)?p.roles.workers:p.roles.reviewers; return typeof r.model==='string'?r.model:r.model[ent]}
if(cmd==='spawn'){
 const seat=args[0]; const fifo=path.join(root,"seats/run",`${seat}.stdin`); try{fs.mkfifoSync(fifo)}catch{spawnSync("mkfifo",[fifo])}
 const child=spawn("bash",["-c",`exec 3<>${JSON.stringify(fifo)}; sleep 1000`],{detached:true,stdio:"ignore"}); child.unref();
 const wt=path.join(root,".wheelhouse-worktrees",seat); spawnSync("git",["-C",root,"worktree","add","--detach",wt,"HEAD"],{stdio:"ignore"});
 const st=read(path.join(root,"seats/state.json")); st.seats[seat]={pid:child.pid,startedAt:new Date().toISOString(),fifo,log:path.join(root,"seats/logs",`${seat}.jsonl`),cwd:wt}; write(path.join(root,"seats/state.json"),st);
 fs.writeFileSync(path.join(root,"seats/logs",`${seat}.jsonl`),'{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}\n');
 fs.appendFileSync(path.join(root,"spawn-models.log"),`${seat} ${modelFor(seat)}\n`); process.exit(0);
}
if(cmd==='stop') { const seat=args[0]; const st=read(path.join(root,"seats/state.json")); const rec=st.seats[seat]; if(rec?.pid) { try{process.kill(rec.pid,"SIGTERM")}catch{} rec.pid=null; rec.stoppedAt=new Date().toISOString(); write(path.join(root,"seats/state.json"),st); } console.log(`seat ${seat} stopped`); process.exit(0); }
if(cmd==='probe') { console.log('OK'); process.exit(0); }
process.exit(0);
BUN
run(){ RC=0; OUT="$(cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" "$@" 2>&1)" || RC=$?; }
json(){ node -e "$1" <<EOF
$OUT
EOF
}
# Fixture shape note: bd ready/list rows above were built after capturing real `bd ready --json` and `bd list --json`; ids/titles are synthetic.
run env BD_READY_COUNT=1 bun seats/staffing.ts check
[ $RC -eq 0 ] && grep -q 'decision=add-worker' <<<"$OUT" && grep -q 'seat=worker-e1' <<<"$OUT" && grep -q 'worker-e1 m1' "$ROOT/spawn-models.log" && pass 'G4-15 add-worker places first listed free entry with role model' || fail "add-worker failed rc=$RC out=$OUT"
run env BD_READY_COUNT=3 bun seats/staffing.ts check
[ $RC -eq 0 ] && grep -q 'decision=nothing' <<<"$OUT" && grep -q 'reason="nothing to do"' <<<"$OUT" && pass 'G4-15 free worker exists with ready work -> nothing' || fail "free-worker row failed: $OUT"
python3 - <<PY
import json; p='$ROOT/seats/state.json'; j=json.load(open(p)); j['seats']['worker-e1']['lastBead']='busy-bead'; json.dump(j,open(p,'w'))
PY
run env BD_READY_COUNT=6 bun seats/staffing.ts check; grep -q 'seat=worker-e2' <<<"$OUT" || fail "second add did not use e2: $OUT"
python3 - <<PY
import json; p='$ROOT/seats/state.json'; j=json.load(open(p)); j['seats']['worker-e2']['lastBead']='busy-bead'; json.dump(j,open(p,'w'))
PY
run env BD_READY_COUNT=6 bun seats/staffing.ts check; grep -q 'seat=worker-e3' <<<"$OUT" || fail "third add did not use e3: $OUT"
python3 - <<PY
import json; p='$ROOT/seats/state.json'; j=json.load(open(p)); j['seats']['worker-e3']['lastBead']='busy-bead'; json.dump(j,open(p,'w'))
PY
run env BD_READY_COUNT=6 bun seats/staffing.ts check; grep -q 'seat=worker-e4' <<<"$OUT" || fail "fourth add did not use e4: $OUT"
run env BD_READY_COUNT=6 bun seats/staffing.ts check --decision add-worker
[ $RC -eq 0 ] && grep -q 'reason="at limit: workers 4/4"' <<<"$OUT" && pass 'G4-18/G4-23 burst grows 1→4 then G4-16 clamps at max' || fail "at max clamp failed: $OUT"
rm -f "$ROOT/seats/staffing.json" "$ROOT/seats/state.json" "$ROOT/spawn-models.log"; rm -rf "$ROOT/.wheelhouse-worktrees"; mkdir -p "$ROOT/.wheelhouse-worktrees"
run bun seats/staffing.ts flag e1 --reason synthetic-limit; run env BD_READY_COUNT=1 bun seats/staffing.ts check
[ $RC -eq 0 ] && grep -q 'seat=worker-e2' <<<"$OUT" && pass 'G4-24 rate-limited entry is skipped' || fail "rate limit skip failed: $OUT"
run bun seats/staffing.ts probe e1 >/dev/null; run env BD_READY_COUNT=1 bun seats/staffing.ts check --decision add-worker
[ $RC -eq 0 ] && grep -q 'seat=worker-e1' <<<"$OUT" && pass 'G4-24 probe OK clears rate limit for next add' || fail "probe clear failed: $OUT"
# No free subscription while under max: staffing records occupy every entry.
python3 - <<PY
import json, pathlib
p=pathlib.Path('$ROOT/seats/staffing.json'); j=json.load(open(p)); j['seats']={f'worker-e{i}':{'role':'worker','entry':f'e{i}'} for i in range(1,5)}; json.dump(j,open(p,'w'))
PY
run env BD_READY_COUNT=1 bun seats/staffing.ts check --dry-run --decision add-worker
[ $RC -eq 0 ] && grep -q 'reason="no free subscription for workers"' <<<"$OUT" && pass 'G4-26 all entries occupied -> no free subscription' || fail "no-free-subscription failed: $OUT"

# Prepare shrink: e1/e2/e3 live and old idle; min=1 means successive checks drop to min.
python3 - <<PY
import json, pathlib
p=pathlib.Path('$ROOT/seats/staffing.json'); j=json.load(open(p)); j['seats']={'worker-e1':{'role':'worker','entry':'e1'},'worker-e2':{'role':'worker','entry':'e2'},'worker-e3':{'role':'worker','entry':'e3'}}; json.dump(j,open(p,'w'))
PY
(cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" bun seats/adapter.ts spawn worker-e3 >/dev/null 2>&1)
run env BD_READY_COUNT=0 bun seats/staffing.ts check
if python3 - <<PY
import json; assert 'worker-e1' not in json.load(open('$ROOT/seats/state.json'))['seats']
PY
then STATE_REMOVED=1; else STATE_REMOVED=0; fi
[ $RC -eq 0 ] && grep -q 'decision=drop-seat' <<<"$OUT" && grep -q 'seat=worker-e1' <<<"$OUT" && [ ! -d "$ROOT/.wheelhouse-worktrees/worker-e1" ] && [ "$STATE_REMOVED" = 1 ] && pass 'G4-20/G4-30 first idle shrink removes pid/state/worktree and frees entry' || fail "first drop failed: $OUT state=$(cat "$ROOT/seats/state.json" 2>/dev/null)"
run env BD_READY_COUNT=0 bun seats/staffing.ts check
[ $RC -eq 0 ] && grep -q 'decision=drop-seat' <<<"$OUT" && grep -q 'seat=worker-e2' <<<"$OUT" && pass 'G4-20 successive checks keep dropping oldest idle until min' || fail "second drop failed: $OUT"
run env BD_READY_COUNT=0 bun seats/staffing.ts drop worker-e3
[ $RC -eq 0 ] && grep -q 'reason="at minimum: workers 1/1"' <<<"$OUT" && pass 'G4-31 drop clamp refuses below minimum' || fail "min clamp failed: $OUT"
run env BD_READY_COUNT=0 bun seats/staffing.ts check --decision drop-seat
[ $RC -eq 0 ] && grep -q 'reason="drop needs a seat"' <<<"$OUT" && pass 'drop-seat decision without a seat logs nothing' || fail "drop-seat without seat failed: $OUT"
run env BD_READY_COUNT=1 bun seats/staffing.ts check --decision add-worker
[ $RC -eq 0 ] && grep -q 'seat=worker-e1' <<<"$OUT" && pass 'G4-30 next add reuses the freed entry' || fail "freed entry was not reused: $OUT"
# Busy seat protected; idle extra goes.
run env BD_READY_COUNT=1 bun seats/staffing.ts check >/dev/null
python3 - <<PY
import json, pathlib
st=pathlib.Path('$ROOT/seats/state.json'); j=json.load(open(st));
for seat,rec in j['seats'].items():
 rec['lastBead']='busy-bead' if seat=='worker-e2' else 'closed-bead'
json.dump(j,open(st,'w'))
PY
run env BD_READY_COUNT=0 bun seats/staffing.ts check
[ $RC -eq 0 ] && grep -q 'decision=drop-seat' <<<"$OUT" && ! grep -q 'seat=worker-e2' <<<"$OUT" && pass 'G4-29 busy in-progress seat is not dropped' || fail "busy drop guard failed: $OUT"
# Concurrency: two simultaneous checks on one need add exactly one seat.
rm -f "$ROOT/seats/staffing.json" "$ROOT/seats/state.json"; rm -rf "$ROOT/.wheelhouse-worktrees"; mkdir -p "$ROOT/.wheelhouse-worktrees"
(cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" BD_READY_COUNT=1 bun seats/staffing.ts check > "$FIX/c1.out" 2>&1) & p1=$!
(cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" BD_READY_COUNT=1 bun seats/staffing.ts check > "$FIX/c2.out" 2>&1) & p2=$!
wait $p1; r1=$?; wait $p2; r2=$?
COUNT=$(python3 - <<PY
import json; print(len(json.load(open('$ROOT/seats/staffing.json'))['seats']))
PY
)
[ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ "$COUNT" = 1 ] && pass 'G4-37 concurrent checks add exactly one seat' || fail "concurrency failed r=$r1/$r2 count=$COUNT outs=$(cat "$FIX/c1.out" "$FIX/c2.out")"
# min=max pins role.
python3 - <<PY
import json
p='$ROOT/seats/pool.json'; j=json.load(open(p)); j['roles']['workers']['min']=j['roles']['workers']['max']=1; json.dump(j,open(p,'w'))
PY
run env BD_READY_COUNT=6 bun seats/staffing.ts check --decision add-worker
[ $RC -eq 0 ] && grep -q 'at limit: workers 1/1' <<<"$OUT" && pass 'G4-5 min=max pins worker scale-out' || fail "min=max failed: $OUT"
run env BD_READY_COUNT=0 bun seats/staffing.ts check
[ $RC -eq 0 ] && grep -q 'decision=nothing' <<<"$OUT" && ! grep -q 'decision=drop-seat' <<<"$OUT" && pass 'G4-5 min=max pins empty queue against drop' || fail "min=max empty queue failed: $OUT"
run env BD_READY_COUNT=0 bun seats/staffing.ts check --decision add-reviewer
[ $RC -eq 0 ] && grep -q 'reason="reviewers: not yet scalable"' <<<"$OUT" && pass 'add-reviewer decision is clamped to not-yet-scalable in this bead' || fail "add-reviewer clamp failed: $OUT"
# Safe worktree removal refusals used by drop.
git -C "$ROOT" worktree add --detach "$ROOT/.wheelhouse-worktrees/worker-dirty" HEAD >/dev/null 2>&1
printf 'dirty\n' > "$ROOT/.wheelhouse-worktrees/worker-dirty/local.txt"
if (cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" bun -e 'import { removeSeatWorktree } from "./seats/seat-worktree.ts"; try { removeSeatWorktree(process.cwd(), "worker-dirty"); process.exit(1); } catch (e) { if (!String(e.message).includes("real changes")) process.exit(2); }'); then pass 'drop worktree removal refuses dirty worktrees'; else fail 'dirty worktree refusal failed'; fi
git -C "$ROOT/.wheelhouse-worktrees/worker-dirty" reset --hard >/dev/null 2>&1; git -C "$ROOT" worktree remove --force "$ROOT/.wheelhouse-worktrees/worker-dirty" >/dev/null 2>&1
git -C "$ROOT" worktree add --detach "$ROOT/.wheelhouse-worktrees/worker-unpushed" HEAD >/dev/null 2>&1
if (cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_SEAT_PUSH=on bun -e 'import { removeSeatWorktree } from "./seats/seat-worktree.ts"; try { removeSeatWorktree(process.cwd(), "worker-unpushed"); process.exit(1); } catch (e) { if (!String(e.message).includes("not on a remote")) process.exit(2); }'); then pass 'drop worktree removal refuses unpushed tips when seat_push=on'; else fail 'unpushed-tip refusal failed'; fi
git -C "$ROOT" worktree remove --force "$ROOT/.wheelhouse-worktrees/worker-unpushed" >/dev/null 2>&1
# log line fields/reasons.
LOG_LINES=$(wc -l < "$ROOT/seats/logs/staffing.log" | tr -d ' ')
awk 'NF{line=$0} END{print line}' "$ROOT/seats/logs/staffing.log" | grep -Eq 'decision=.* decider=rule conf=0.00 ready=[0-9]+ chained=[0-9]+ overlap=[0-9]+ backlog=[0-9]+ workers=[0-9]+/[0-9]+\.\.[0-9]+ reviewers=[0-9]+/[0-9]+\.\.[0-9]+ seat=.* entry=.* reason="[^"]+"' && [ "$LOG_LINES" -ge 12 ] && pass 'G4-39/G4-40 decision log has one parseable plain-English line per check' || fail "log shape/count failed lines=$LOG_LINES"
# no pool touches nothing.
NOPOOL="$FIX/nopool"; mkdir -p "$NOPOOL/seats" "$NOPOOL/wheelhouse"; for f in staffing.ts pool.ts roster.ts fleet-snapshot.ts seat-activity.ts seat-worktree.ts harness.ts credential-shapes.ts quota.ts; do cp "$HERE/$f" "$NOPOOL/seats/$f"; done; before=$(find "$NOPOOL/seats" -maxdepth 1 -type f -print | sort)
OUT="$(cd "$NOPOOL" && HOME="$HOME_FIX" PATH="$BIN:$PATH" bun seats/staffing.ts check 2>&1)"; RC=$?; after=$(find "$NOPOOL/seats" -maxdepth 1 -type f -print | sort)
[ $RC -eq 0 ] && grep -q 'staffing: no pool (fixed roster)' <<<"$OUT" && [ "$before" = "$after" ] && pass 'no pool exits 0 and touches nothing' || fail "no-pool failed rc=$RC out=$OUT"
# Canary: removing clamp makes at-max leg fail.
cp "$ROOT/seats/staffing.ts" "$ROOT/seats/staffing-broken.ts"
python3 - <<PY
from pathlib import Path
p=Path('$ROOT/seats/staffing-broken.ts')
s=p.read_text().replace('let d: Decision;','let d: Decision; const clamp = (x: any) => x;')
p.write_text(s)
PY
BROKEN_OUT="$(cd "$ROOT" && HOME="$HOME_FIX" PATH="$BIN:$PATH" BD_READY_COUNT=6 bun -e 'import { main } from "./seats/staffing-broken.ts"; await main(["check", "--decision", "add-worker"], process.cwd());' 2>&1)"; BROKEN_RC=$?
if [ $BROKEN_RC -eq 0 ] && ! grep -q 'at limit: workers 1/1' <<<"$BROKEN_OUT"; then pass 'canary: removing clamp makes the at-max leg fail'; else fail "canary did not prove clamp coverage rc=$BROKEN_RC out=$BROKEN_OUT"; fi
echo 'staffing.selftest.sh works on this machine.'
