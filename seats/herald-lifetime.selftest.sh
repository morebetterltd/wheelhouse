#!/usr/bin/env bash
# Native daemon/signal regressions, isolated roots, no providers or installed services.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
. "$HERE/selftest-herald.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-herald-lifetime.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_bind_herald_owner "$FIX"
trap 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Recorded child, but NOT a herald: a stale/unrelated PID must not be signaled.
sleep 60 & NON_HERALD=$!
selftest_stop_herald_child "$NON_HERALD"
if kill -0 "$NON_HERALD" 2>/dev/null; then
  echo 'ok - teardown refuses an unrelated direct child PID'
  kill "$NON_HERALD"; wait "$NON_HERALD" 2>/dev/null || true
else
  echo 'not ok - teardown signaled an unrelated direct child PID' >&2; exit 1
fi
cat > "$FIX/owner.sh" <<'SH'
#!/usr/bin/env bash
set -eu
HERE="$1"; BASE="$2"; MODE="$3"
. "$HERE/selftest-lib.sh"
. "$HERE/selftest-herald.sh"
OWN="$(selftest_make_fixture_dir "$BASE/owner-$MODE.XXXXXX")" || exit 2
selftest_isolate_git "$OWN" || exit 2
selftest_bind_herald_owner "$OWN"
PROJ="$OWN/project"; mkdir -p "$PROJ/seats/run" "$PROJ/seats/logs"
printf '%s\n' '{"logs":{},"seen":[],"alerts":{"lastCheckAt":"2999-01-01T00:00:00Z"},"staffing":{"lastCheckAt":"2999-01-01T00:00:00Z"}}' > "$PROJ/seats/herald.state.json"
(cd "$PROJ" && WHEELHOUSE_HERALD_ROOT="$PROJ" WHEELHOUSE_HERALD_INTERVAL_MS=50 exec bun "$HERE/herald.ts") > "$OWN/herald.out" 2> "$OWN/herald.err" & CHILD=$!
# KEEP the root in every leg: deletion must not make the SIGKILL proof pass.
trap 'selftest_stop_herald_child "$CHILD"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n%s\n' "$PROJ" "$CHILD" > "$BASE/$MODE.record"
while [ ! -e "$BASE/$MODE.go" ]; do sleep 0.05; done
[ "$MODE" != failure ] || exit 23
SH
bun - "$HERE" "$FIX" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const [here,rawBase]=process.argv.slice(2),base=fs.realpathSync(rawBase);
const failures=[],children=[],detached=[];
const read=p=>fs.readFileSync(p,'utf8');
const pidFile=p=>path.join(p,'seats/run/herald.pid');
function check(ok,text) {
  console.log((ok?'ok - ':'not ok - ')+text);
  if(!ok) failures.push(text);
}
function alive(pid) {
  const r=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'});
  return r.status===0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z');
}
async function until(fn,seconds=4) {
  const end=performance.now()+seconds*1000;
  while(performance.now()<end) { if(await fn()) return true; await Bun.sleep(50); }
  return Boolean(await fn());
}
async function wait(child,seconds) {
  let timer;
  try { return await Promise.race([child.exited,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('child '+child.pid+' exceeded '+seconds+'s')),seconds*1000);
  })]); } finally { clearTimeout(timer); }
}
const status=(child,code)=>child.signalCode ? -os.constants.signals[child.signalCode] : code;
// Record fresh native identity at allocation, then compare again before signals.
// Never adopt an unrelated PID from a stale record or clean another run's root.
function identity(pid,cwd,script,direct) {
  assert.ok(cwd===base || cwd.startsWith(base+path.sep),'owned scratch cwd');
  const r=spawnSync('ps',['-p',String(pid),'-o','pid=,ppid=,uid=,lstart=,stat=,command='],{encoding:'utf8'});
  fs.appendFileSync(path.join(base,'process-identities.jsonl'),JSON.stringify({pid,cwd,script,direct,status:r.status,stdout:r.stdout,stderr:r.stderr})+'\n');
  if(r.status===1 && !r.stdout.trim()) return null;
  assert.equal(r.status,0,r.stderr);
  const fields=r.stdout.trim().split(/\s+/);
  if(fields[8]?.startsWith('Z')) return null;
  assert.equal(Number(fields[0]),pid); assert.equal(Number(fields[2]),process.getuid());
  if(direct) assert.equal(Number(fields[1]),process.pid,'direct child');
  assert.ok(fields.slice(9).includes(script),'exact expected script argument: '+JSON.stringify({script,stdout:r.stdout}));
  const opened=spawnSync('lsof',['-a','-p',String(pid),'-d','cwd','-Fpcn'],{encoding:'utf8'});
  if(opened.status!==0 && !alive(pid)) return null;
  assert.equal(opened.status,0,opened.stderr);
  const dirs=opened.stdout.split('\n').filter(s=>s.startsWith('n')).map(s=>s.slice(1));
  assert.deepEqual(dirs.map(p=>fs.realpathSync(p)),[cwd]);
  // An owned herald may be reparented to init when its test owner exits.
  // Still record the fresh parent above; generation/cwd/argv must not change.
  return JSON.stringify({pid:fields[0],parent:direct?fields[1]:null,uid:fields[2],start:fields.slice(3,8),argv:fields.slice(9)});
}
function remember(pid,cwd,script,direct) {
  const rec={pid,cwd:fs.realpathSync(cwd),script,direct};
  rec.generation=identity(pid,rec.cwd,script,direct);
  return rec;
}
function signal(rec,sig) {
  if(!alive(rec.pid)) return;
  assert.ok(rec.generation,'identity captured while allocated');
  assert.equal(identity(rec.pid,rec.cwd,rec.script,rec.direct),rec.generation,'same PID generation before signal');
  process.kill(rec.pid,sig);
}
async function spawn(args,options,script) {
  // A detached launcher must not keep a captured pipe's EOF pending. Capture
  // private files instead; exit deadlines and all stdout/stderr checks remain.
  const sinks={...options},files={},fds=[];
  for(const key of ['stdout','stderr']) if(sinks[key]==='pipe') {
    files[key]=path.join(base,'child-'+children.length+'.'+key);
    sinks[key]=fs.openSync(files[key],'w'); fds.push(sinks[key]);
  }
  let child;
  try { child=Bun.spawn(args,{stdin:'ignore',...sinks}); } finally { for(const fd of fds) fs.closeSync(fd); }
  const rec={pid:child.pid,cwd:fs.realpathSync(options.cwd),script,direct:true,generation:null,child,
    output:()=>files.stdout?read(files.stdout).replace(/\r\n?/g,'\n'):'',
    errors:()=>files.stderr?read(files.stderr).replace(/\r\n?/g,'\n'):''};
  children.push(rec);
  try { rec.generation=identity(rec.pid,rec.cwd,script,true); }
  catch(error) {
    // A fast child may finish while ps/lsof is sampling it. Dispatch completion
    // before deciding: an exited child needs no signal; live mismatches STOP.
    await Bun.sleep(0);
    if(child.exitCode===null && child.signalCode===null) throw error;
  }
  return rec;
}
function root(name) {
  const p=path.join(base,name);
  fs.mkdirSync(path.join(p,'seats/run'),{recursive:true}); fs.mkdirSync(path.join(p,'seats/logs'));
  fs.writeFileSync(path.join(p,'seats/herald.state.json'),JSON.stringify({logs:{},seen:[],alerts:{lastCheckAt:'2999-01-01T00:00:00Z'},staffing:{lastCheckAt:'2999-01-01T00:00:00Z'}}));
  return p;
}
const env=p=>({...process.env,WHEELHOUSE_HERALD_ROOT:p,WHEELHOUSE_HERALD_INTERVAL_MS:'50'});
async function launch(p) {
  const log=fs.openSync(path.join(base,path.basename(p)+'.err'),'a'); let rec;
  try { rec=await spawn(['bun',path.join(here,'herald.ts')],{cwd:p,env:env(p),stdout:'ignore',stderr:log},path.join(here,'herald.ts')); }
  finally { fs.closeSync(log); }
  assert.ok(await until(()=>fs.existsSync(pidFile(p)) && read(pidFile(p)).trim()===String(rec.pid)),'daemon did not publish its own PID');
  return rec;
}
try {
  const p=root('singleton'),first=await launch(p);
  const second=await spawn(['bun',path.join(here,'herald.ts')],{cwd:p,env:env(p),stdout:'pipe',stderr:'pipe'},path.join(here,'herald.ts'));
  let refused=false,secondCode;
  try { secondCode=await wait(second.child,2); const out=second.output(),err=second.errors();
    const lines=err.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/); if(lines.at(-1)==='') lines.pop();
    refused=secondCode!==0 && !out && lines.length===1 && err.includes('herald already running');
  } catch(error) {
    if(!String(error).includes('exceeded 2s')) throw error;
    signal(second,'SIGTERM'); secondCode=await wait(second.child,3);
  }
  console.log('singleton refusal: rc='+status(second.child,secondCode)+' stdout='+JSON.stringify(second.output())+' stderr='+JSON.stringify(second.errors()));
  check(refused && alive(first.pid) && read(pidFile(p)).trim()===String(first.pid),'second same-root daemon refuses in one line, leaves first and its PID intact');
  let other=null;
  try { other=await launch(root('different-root')); } catch(error) { if(!(error instanceof assert.AssertionError)) throw error; }
  check(other!==null && alive(first.pid) && alive(other.pid),'independent root can run its own herald');
  if(other!==null) { signal(other,'SIGTERM'); await wait(other.child,3); }
  // Native launch helper, including a stale lock left by SIGKILL.
  signal(first,'SIGKILL'); await wait(first.child,3);
  const seats=path.join(p,'seats'); fs.symlinkSync(path.join(here,'herald.ts'),path.join(seats,'herald.ts'));
  const restart=await spawn(['bash','-c','source "$1"; start_herald','fixture',path.join(here,'daemons.sh')],{cwd:p,env:{...process.env,WHEELHOUSE_DAEMONS_ROOT:p,WHEELHOUSE_HERALD_INTERVAL_MS:'50'},stdout:'pipe',stderr:'pipe'},path.join(here,'daemons.sh'));
  const restarted=await wait(restart.child,8);
  const next=Number(read(pidFile(p)).trim()); assert.ok(Number.isSafeInteger(next) && next>0,'valid published restart PID');
  const replacement=remember(next,p,path.join(seats,'herald.ts'),false); detached.push(replacement);
  console.log('dead restart: rc='+status(restart.child,restarted)+' '+restart.output().trim());
  check(restarted===0 && next!==first.pid && alive(next),'daemons.sh restarts a dead herald with a stale singleton lock');
  signal(replacement,'SIGTERM'); assert.ok(await until(()=>!alive(next)),'restarted herald stopped');
  for(const [mode,sig,expected] of [['normal',null,0],['failure',null,23],['term','SIGTERM',143],['int','SIGINT',130],['kill','SIGKILL',-9]]) {
    // Native Bun.spawn resets SIGINT for this fresh child even when the sweep's
    // async Bash launch inherited SIG_IGN (verified with child trap -p INT).
    const ownerScript=path.join(base,'owner.sh');
    const owner=await spawn(['bash',ownerScript,here,base,mode],{cwd:base,stdout:'ignore',stderr:'pipe'},ownerScript);
    const record=path.join(base,mode+'.record');
    assert.ok(await until(()=>fs.existsSync(record)),'owner allocation record missing');
    const [proj,pidText]=read(record).trimEnd().split('\n'),pid=Number(pidText);
    assert.ok(Number.isSafeInteger(pid) && pid>0,'valid allocated owner child PID');
    assert.ok(await until(()=>fs.existsSync(pidFile(proj))),'owned herald never started');
    detached.push(remember(pid,proj,path.join(here,'herald.ts'),false));
    if(sig) signal(owner,sig); else fs.closeSync(fs.openSync(path.join(base,mode+'.go'),'a'));
    const code=status(owner.child,await wait(owner.child,5)),stopped=await until(()=>!alive(pid),4);
    console.log('owner '+mode+': rc='+code+' heraldAlive='+Number(alive(pid))+' rootExists='+Number(fs.existsSync(proj))+' stderr='+JSON.stringify(owner.errors()));
    check(code===expected && stopped && fs.existsSync(proj),'fixture herald stops after owner '+mode+' with root retained');
  }
} finally {
  for(const rec of children) signal(rec,'SIGTERM');
  for(const rec of children) {
    try { await wait(rec.child,3); } catch { signal(rec,'SIGKILL'); await rec.child.exited; }
  }
  for(const rec of detached) if(alive(rec.pid)) { signal(rec,'SIGTERM'); await until(()=>!alive(rec.pid)); }
}
if(failures.length) { console.log('herald-lifetime.selftest: FAIL ('+failures.length+' checks)'); process.exit(1); }
console.log('herald-lifetime.selftest: PASS (9 checks)');
JS
