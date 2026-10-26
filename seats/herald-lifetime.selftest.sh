#!/usr/bin/env bash
export WHEELHOUSE_FIXTURE_COMMAND_MODULE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/fixtures/fixture-command.cjs"
# Native daemon/signal regressions, isolated roots, no providers or installed services.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
. "$HERE/selftest-herald.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-herald-lifetime.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_bind_herald_owner "$FIX"
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
bun "$HERE/fixtures/herald-child-identity-tests.ts" "$FIX"
# Recorded child, but NOT a herald: a stale/unrelated PID must not be signaled.
perl -e 'sleep while 1' "$FIX/non-herald-canary" & NON_HERALD=$!
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
selftest_install_cleanup_traps 'selftest_stop_herald_child "$CHILD"'
RECORD_TMP="$BASE/$MODE.record.tmp.$$"
printf '%s\n' "$PROJ" > "$RECORD_TMP"
if [ "$MODE" = delayed ]; then
  : > "$BASE/$MODE.partial"
  while [ ! -e "$BASE/$MODE.publish" ]; do sleep 0.01; done
fi
printf '%s\n' "$CHILD" >> "$RECORD_TMP"
mv -f "$RECORD_TMP" "$BASE/$MODE.record"
while [ ! -e "$BASE/$MODE.go" ]; do sleep 0.05; done
[ "$MODE" != failure ] || exit 23
SH
# Optional reader implementation is a test-only removed-fix control.
bun - "$HERE" "$FIX" "${1:-$HERE/fixtures/herald-allocation-record.ts}" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const { spawnSync } = await import(process.env.WHEELHOUSE_FIXTURE_COMMAND_MODULE);
const [here,rawBase,recordReader]=process.argv.slice(2),base=fs.realpathSync(rawBase);
const {waitForOwnerAllocationRecord}=await import(recordReader);
const {captureAllocation,signalObservedChild}=await import(path.join(here,'fixtures/herald-child-identity.ts'));
const failures=[],children=[],detached=[];
let checks=1; // The unrelated-child refusal above is also a check.
const read=p=>fs.readFileSync(p,'utf8');
const pidFile=p=>path.join(p,'seats/run/herald.pid');
function check(ok,text) {
  checks++;
  console.log((ok?'ok - ':'not ok - ')+text);
  if(!ok) failures.push(text);
}
function alive(pid) {
  const r=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'});
  assert.ifError(r.error); assert.equal(r.signal??null,null); assert.equal(r.stderr,'');
  if(r.status===1 && !r.stdout.trim()) return false;
  assert.equal(r.status,0); assert.ok(r.stdout.trim(),'native ps must return a state or explicit absence');
  return !r.stdout.trim().startsWith('Z');
}
async function until(fn,label) {
  console.error('FIXTURE_WAIT herald lifetime: '+label);
  while(!await fn()) await Bun.sleep(50);
  return true;
}
// Keep the existing cleanup escalation policy; never a startup verdict.
const HERALD_TERM_GRACE_SECONDS=3;
async function wait(child,termGraceSeconds) {
  console.error('FIXTURE_WAIT herald lifetime: native exit pid='+child.pid);
  if(termGraceSeconds===undefined) return await child.exited;
  let timer;
  try { return await Promise.race([child.exited,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('owned child '+child.pid+' TERM grace expired; last exit='+child.exitCode+' signal='+child.signalCode)),termGraceSeconds*1000);
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
function signal(rec,sig) { signalObservedChild(rec,sig,alive,identity); }
async function spawn(args,options,script) {
  // A detached launcher must not keep a captured pipe's EOF pending. Capture
  // private files instead; native exits and all stdout/stderr checks remain.
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
  rec.generation=await captureAllocation(child,()=>identity(rec.pid,rec.cwd,script,true));
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
  assert.ok(await until(()=>{ assert.equal(rec.child.exitCode,null,'daemon exited before publishing PID'); assert.equal(rec.child.signalCode,null); return fs.existsSync(pidFile(p)) && read(pidFile(p)).trim()===String(rec.pid); },'daemon PID publication '+rec.pid),'daemon did not publish its own PID');
  return rec;
}
try {
  // Model a legacy/non-atomic producer: publication of the path is not enough.
  // Start the reader while only the project line exists, then release the PID
  // after a turn of the event loop. No success depends on a host-speed sleep.
  const delayed=path.join(base,'delayed-reader.record'),proj=path.join(base,'reader-project');
  fs.writeFileSync(delayed,proj+'\n');
  let settled=false;
  const pending=waitForOwnerAllocationRecord(delayed).then(value=>({value}),error=>({error}));
  pending.then(()=>{ settled=true; });
  await Bun.sleep(0);
  const waitedForPid=!settled;
  fs.appendFileSync(delayed,String(process.pid)+'\n');
  const received=await pending;
  check(waitedForPid && received.value?.proj===proj && received.value?.pid===process.pid,'allocation reader waits for a delayed PID line');
  for(const [name,text] of [['missing-pid',proj+'\n'],['zero-pid',proj+'\n0\n'],['fractional-pid',proj+'\n1.5\n'],['partial-pid',proj+'\n12']]) {
    const file=path.join(base,name+'.record'); fs.writeFileSync(file,text);
    let reason='';
    try { await waitForOwnerAllocationRecord(file,150); } catch(error) { reason=String(error.message); }
    console.log(name+' refusal: '+reason);
    check(reason.includes('owner allocation record incomplete after 150ms:') && reason.includes('positive integer PID'),'allocation reader bounds/refuses '+name+' with a clear error');
  }
  const p=root('singleton'),first=await launch(p);
  const second=await spawn(['bun',path.join(here,'herald.ts')],{cwd:p,env:env(p),stdout:'pipe',stderr:'pipe'},path.join(here,'herald.ts'));
  let refused=false,secondCode;
  secondCode=await wait(second.child); const out=second.output(),err=second.errors();
  const lines=err.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/); if(lines.at(-1)==='') lines.pop();
  refused=secondCode!==0 && !out && lines.length===1 && err.includes('herald already running');
  console.log('singleton refusal: rc='+status(second.child,secondCode)+' stdout='+JSON.stringify(second.output())+' stderr='+JSON.stringify(second.errors()));
  check(refused && alive(first.pid) && read(pidFile(p)).trim()===String(first.pid),'second same-root daemon refuses in one line, leaves first and its PID intact');
  let other=null;
  try { other=await launch(root('different-root')); } catch(error) { if(!(error instanceof assert.AssertionError)) throw error; }
  check(other!==null && alive(first.pid) && alive(other.pid),'independent root can run its own herald');
  if(other!==null) { signal(other,'SIGTERM'); await wait(other.child); }
  // Native launch helper, including a stale lock left by SIGKILL.
  signal(first,'SIGKILL'); await wait(first.child);
  const seats=path.join(p,'seats'); fs.symlinkSync(path.join(here,'herald.ts'),path.join(seats,'herald.ts'));
  const restart=await spawn(['bash','-c','source "$1"; start_herald','fixture',path.join(here,'daemons.sh')],{cwd:p,env:{...process.env,WHEELHOUSE_DAEMONS_ROOT:p,WHEELHOUSE_HERALD_INTERVAL_MS:'50'},stdout:'pipe',stderr:'pipe'},path.join(here,'daemons.sh'));
  const restarted=await wait(restart.child);
  const next=Number(read(pidFile(p)).trim()); assert.ok(Number.isSafeInteger(next) && next>0,'valid published restart PID');
  const replacement=remember(next,p,path.join(seats,'herald.ts'),false); detached.push(replacement);
  console.log('dead restart: rc='+status(restart.child,restarted)+' '+restart.output().trim());
  check(restarted===0 && next!==first.pid && alive(next),'daemons.sh restarts a dead herald with a stale singleton lock');
  signal(replacement,'SIGTERM'); assert.ok(await until(()=>!alive(next),'restarted herald absence '+next),'restarted herald stopped');
  for(const [mode,sig,expected] of [['delayed',null,0],['normal',null,0],['failure',null,23],['term','SIGTERM',143],['int','SIGINT',130],['kill','SIGKILL',-9]]) {
    // Native Bun.spawn resets SIGINT for this fresh child even when the sweep's
    // async Bash launch inherited SIG_IGN (verified with child trap -p INT).
    const ownerScript=path.join(base,'owner.sh');
    const owner=await spawn(['bash',ownerScript,here,base,mode],{cwd:base,stdout:'ignore',stderr:'pipe'},ownerScript);
    const record=path.join(base,mode+'.record');
    if(mode==='delayed') {
      assert.ok(await until(()=>{ assert.equal(owner.child.exitCode,null,'owner exited before partial publication'); assert.equal(owner.child.signalCode,null); return fs.existsSync(path.join(base,mode+'.partial')); },'partial owner allocation '+mode),'owner did not reach partial allocation publication');
      check(!fs.existsSync(record),'owner publishes no allocation record before its PID line is ready');
      fs.closeSync(fs.openSync(path.join(base,mode+'.publish'),'a'));
    }
    const {proj,pid}=await waitForOwnerAllocationRecord(record,undefined,()=>owner.child.exitCode!==null || owner.child.signalCode!==null);
    assert.ok(await until(()=>{ assert.equal(owner.child.exitCode,null,'owner exited before daemon PID publication'); assert.equal(owner.child.signalCode,null); return fs.existsSync(pidFile(proj)); },'owned herald PID publication '+mode),'owned herald never started');
    detached.push(remember(pid,proj,path.join(here,'herald.ts'),false));
    if(sig) signal(owner,sig); else fs.closeSync(fs.openSync(path.join(base,mode+'.go'),'a'));
    const code=status(owner.child,await wait(owner.child)),stopped=await until(()=>!alive(pid),'herald absence after owner '+mode);
    console.log('owner '+mode+': rc='+code+' heraldAlive='+Number(alive(pid))+' rootExists='+Number(fs.existsSync(proj))+' stderr='+JSON.stringify(owner.errors()));
    check(code===expected && stopped && fs.existsSync(proj),'fixture herald stops after owner '+mode+' with root retained');
  }
} finally {
  for(const rec of children) signal(rec,'SIGTERM');
  for(const rec of children) {
    try { await wait(rec.child,HERALD_TERM_GRACE_SECONDS); } catch { signal(rec,'SIGKILL'); await rec.child.exited; }
  }
  for(const rec of detached) if(alive(rec.pid)) { signal(rec,'SIGTERM'); await until(()=>!alive(rec.pid),'detached herald cleanup '+rec.pid); }
}
if(failures.length) { console.log('herald-lifetime.selftest: FAIL ('+failures.length+' checks)'); process.exit(1); }
console.log('herald-lifetime.selftest: PASS ('+checks+' checks)');
JS
