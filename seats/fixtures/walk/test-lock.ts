// No bd invocation/writes. Synthetic approval is only a validated precondition;
// ordering uses the real lock/queue and explicit release/clock events.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { completedCommand } from '../../completed-command';
import { instrumentWorkLock } from './readiness';
const [fleet,agent,contract,peer] = process.argv.slice(2);
const INITIAL_CONTAINMENT_MS = 30_000;
const evidence=process.env.WHEELHOUSE_WALK_LOCK_EVIDENCE;
if(evidence)fs.mkdirSync(evidence,{recursive:true});
const observer=fs.readFileSync(fleet+'/seats/walk-test-lock.ts','utf8');
const records:any[]=[]; let serial=0,failed=0;
const save=()=>{if(evidence)fs.writeFileSync(path.join(evidence,'test-lock.json'),JSON.stringify({source:fs.readFileSync(fleet+'/seats/walk.ts','utf8'),observer,records},null,2)+'\n');};
function git(args:string[]) {const r=completedCommand('git',args,{cwd:fleet});assert(!r.error&&r.signal===null&&r.status===0,r.stderr);return r.stdout.trim();}
function start(file:string,args:string[],env:any=process.env) {
 const p=spawn(file,args,{cwd:fleet,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',error:any;let stdoutEOF=false,stderrEOF=false;
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.stdout.on('end',()=>stdoutEOF=true);p.stderr.on('end',()=>stderrEOF=true);p.once('error',e=>error=e);
 const done=new Promise<any>(resolve=>p.once('close',(status,signal)=>resolve({pid:p.pid,status,signal,error:error?.message,stdout,stderr,stdoutEOF,stderrEOF})));
 return {p,done,stderr:()=>stderr};
}
async function until(predicate:()=>boolean,actors:ReturnType<typeof start>[],label:string) {
 while(!predicate()){if(actors.some(a=>a.p.exitCode!==null||a.p.signalCode!==null))throw new Error('SETUP child ended before '+label);await Bun.sleep(10);}
}
function gate(r:any){if(r.error||r.signal||!r.stdoutEOF||!r.stderrEOF)throw new Error('NATIVE_GATE '+JSON.stringify(r));}
function queue(lock:string) {return fs.existsSync(lock+'.queue')?fs.readdirSync(lock+'.queue').filter(n=>/^[0-9]{20}\./.test(n)):[];}
function report(row:any,error:any) {
 const record={mode:row.mode,budget:row.budget,status:row.native?.status??null,signal:row.native?.signal??null,
  stdoutEOF:row.native?.stdoutEOF??false,stderrEOF:row.native?.stderrEOF??false,
  stderrTail:(row.native?.stderr??'').split(/\r?\n/).filter((line:string,i:number,lines:string[])=>i!==lines.length-1||line!=='').slice(-20),reason:row.metadata?.reason??null,
  lock:row.lock??null,holderPid:row.holder?.pid??null,queue:row.queue??[],queuedBefore:row.queuedBefore?.map((t:any)=>({pid:t.pid,kind:t.kind}))??null,delayStarted:row.delayStarted??false,failure:String(error.message??error)};
 console.error('TEST_LOCK_CASE '+JSON.stringify(record));
 const file=process.env.WHEELHOUSE_WALK_LOCK_FAILURE_MODE_FILE;
 if(file)fs.appendFileSync(file,row.mode+'\n');
 console.error(error.stack??String(error));
}
async function holder(lock:string,dir:string,owned:ReturnType<typeof start>[]) {
 const env={...process.env,WHEELHOUSE_HEAVY_TEST_PAUSE:path.join(fleet,'no-fixture-pause')};
 const payload = ['node', peer, '--holder', dir];
 const h=start('bun',[fleet+'/seats/selftest-sweep-lock.ts','supervise',lock,...payload],env);owned.push(h);
 await until(()=>fs.existsSync(lock+'/wheelhouse-selftest-sweep'),[h],'real holder publication');
 const marker=JSON.parse(fs.readFileSync(lock+'/wheelhouse-selftest-sweep','utf8'));return {h,marker};
}
async function runCase(mode:'initial'|'queue'|'unrelated',reply:string) {
 const dir=path.join(fleet,'lock-case-'+(++serial));fs.mkdirSync(dir);
 const lock=dir+'/test.lock',out=dir+'/out',clock=dir+'/clock',budget=mode==='initial'?INITIAL_CONTAINMENT_MS:2200;fs.mkdirSync(clock);
 // Only verifier runtime in queue cases is virtual. The initial case uses a
 // named >=30s containment setting, never an ordering/performance threshold.
 const env={...process.env,PATH:path.dirname(process.env.WALK_LOCK_PEER_BIN!)+path.delimiter+process.env.PATH,WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_CONTRACT_FIXTURE:contract,WHEELHOUSE_WALK_TIMEOUT_MS:String(budget),WHEELHOUSE_SELFTEST_SWEEP_LOCK:lock,WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:fleet+'/seats/selftest-sweep-lock.ts',WHEELHOUSE_HEAVY_TEST_PAUSE:dir+'/no-pause',WALK_LOCK_CASE:dir,WALK_LOCK_MODE:mode,WALK_LOCK_HEAVY:fleet+'/seats/heavy-test.sh',STUB_REPLY:reply,STUB_WALK_CLOCK_DIR:clock};
 let h:Awaited<ReturnType<typeof holder>>|undefined,other:ReturnType<typeof start>|undefined,w:ReturnType<typeof start>|undefined,failure:any;
 const row:any={mode,budget,lock};const holderActors:ReturnType<typeof start>[]=[];
 try {
  fs.writeFileSync(fleet+'/seats/walk-test-lock.ts',mode==='initial'?observer:instrumentWorkLock(observer));
  if(mode==='initial')h=await holder(lock,dir,holderActors);
  w=start('bun',['seats/walk.ts','--work','fixture-work','--branch','main','--author','author','--out',out],env);
  if(mode==='initial') {
   await until(()=>{
    assert(!fs.existsSync(dir+'/launched.json'),'verifier launched before initial wait report/release');
    return w!.stderr().includes('work walk: waiting for test lock ')&&w!.stderr().includes('verifier clock has not started');
   },[w,h!.h],'initial lock wait report');
   row.waitObservedBeforeRelease=true;
   fs.writeFileSync(dir+'/holder-release','release');
   const joined=await h!.h.done;gate(joined);assert.equal(joined.status,0,joined.stderr);
   row.holderNative=joined;fs.writeFileSync(dir+'/holder-joined','yes');
  } else {
   await until(()=>fs.existsSync(dir+'/launched.json')&&fs.existsSync(clock+'/armed'),[w],'verifier launch and armed clock before holder');
   h=await holder(lock,dir,holderActors);
   if(mode==='unrelated')other=start('bash',[fleet+'/seats/heavy-test.sh','true'],env);
   fs.writeFileSync(dir+'/start-suite','yes');
   await until(()=>queue(lock).length===2,[w,h.h,...(other?[other]:[])],'real queued suite ticket');
   row.queuedBefore=queue(lock).map(n=>JSON.parse(fs.readFileSync(path.join(lock+'.queue',n),'utf8')));
   row.armed=JSON.parse(fs.readFileSync(clock+'/armed','utf8'));assert.equal(row.armed.budget,budget);assert.equal(row.armed.kind,'work');
   fs.writeFileSync(clock+'/expire','explicit policy expiry');
  }
  row.native=await w.done;gate(row.native);
  row.metadata=JSON.parse(fs.readFileSync(out+'/walk.json','utf8'));row.launch=JSON.parse(fs.readFileSync(dir+'/launched.json','utf8'));
  row.holder=h!.marker;row.holderStillPresent=fs.existsSync(lock);row.queue=queue(lock);row.delayStarted=fs.existsSync(dir+'/verifier-delay-started');
  if(mode==='initial') {
   assert.equal(row.native.status,0,row.native.stdout+row.native.stderr);assert(row.native.stdout.includes('VERDICT: WALKED-DONE'));
   assert(!row.launch.holderLive,'verifier launched before initial holder released');
   assert(row.native.stderr.includes(lock)&&row.native.stderr.includes(`pid=${h!.marker.pid}`)&&row.native.stderr.includes('verifier clock has not started'));
   assert(row.waitObservedBeforeRelease);assert(budget>=30_000,'initial budget is named containment, not a subsecond startup assertion');
  } else {
   assert(row.holderStillPresent,'holder must remain held until the walk has exited');assert.equal(row.queuedBefore.length,2);
   assert(fs.existsSync(clock+'/expired'),'expiry must be a controller event, not elapsed time');
   assert.equal(row.native.status,3,row.native.stdout+row.native.stderr);
   const line=row.native.stdout.split('\n').find((s:string)=>s.startsWith('VERDICT:'));
   if(mode==='queue')for(const text of ['queued for the test lock',lock,`pid=${h!.marker.pid}`]){assert(line.includes(text),'verdict omits '+text);assert(row.metadata.reason.includes(text),'walk.json reason omits '+text);}
   else {assert.equal(row.metadata.reason,`dispatcher timed out after ${budget}ms during run verifier walk`);assert(!line.includes('queued for the test lock'));}
  }
 } catch(error) {failure=error;}
 finally {
  // Cooperatively release our holder even on failure, then join original
  // handles. Cancellation applies only to processes this fixture spawned.
  try {
   fs.writeFileSync(dir+'/holder-release','release');
   for(const actor of [w,other])if(actor){if(failure&&actor.p.exitCode===null&&actor.p.signalCode===null)actor.p.kill('SIGTERM');const result=await actor.done;if(actor===w)row.native=result;else row.otherNative=result;}
   for(const actor of holderActors)row.holderNative=await actor.done;
   if(h)row.holder=h.marker;
   if(!failure&&row.holderNative){gate(row.holderNative);assert.equal(row.holderNative.status,0,row.holderNative.stderr);if(row.otherNative){gate(row.otherNative);assert.equal(row.otherNative.status,0,row.otherNative.stderr);}}
   row.delayStarted=fs.existsSync(dir+'/verifier-delay-started');
   if(!row.queue)row.queue=queue(lock);
   if(!row.metadata&&fs.existsSync(out+'/walk.json'))row.metadata=JSON.parse(fs.readFileSync(out+'/walk.json','utf8'));
  } catch(error){failure??=error;row.cleanupFailure=String(error);}
  fs.writeFileSync(fleet+'/seats/walk-test-lock.ts',observer);
 }
 row.failure=failure?String(failure):null;records.push(row);save();
 if(failure){report(row,failure);return false;}return true;
}
async function main(){
 fs.writeFileSync(fleet+'/README.md','Fixture surface\n');git(['add','README.md']);git(['-c','user.name=selftest','-c','user.email=selftest@local','commit','-qm','lock walk surface']);
 const tip=git(['rev-parse','HEAD']),roster=JSON.parse(fs.readFileSync(fleet+'/seats/seats.json','utf8'));
 const author=path.join(path.dirname(agent),'author'),reviewer=path.join(path.dirname(agent),'reviewer');fs.mkdirSync(author);fs.mkdirSync(reviewer);
 roster.seats.author={role:'worker',account:{dir:author}};roster.seats.reviewer={role:'reviewer',account:{dir:reviewer}};fs.writeFileSync(fleet+'/seats/seats.json',JSON.stringify(roster));
 fs.mkdirSync(fleet+'/seats/verdicts',{recursive:true});
 fs.writeFileSync(fleet+'/seats/verdicts/fixture-work.md',`# Verdict — bead fixture-work\n- bead: fixture-work\n- branch: main\n- tip: ${tip}\n- verdict: APPROVE\n- push: NOT CONSIDERED\n- at: ${new Date().toISOString()}\n- verifier-seat: reviewer (${reviewer})\n`);
 const {readReviewRecord}=await import(fleet+'/seats/verify.ts');assert.equal(readReviewRecord(fleet,'fixture-work')?.tip,tip,'SETUP synthetic approval must parse before any timing test');
 const bin=path.dirname(process.env.WALK_LOCK_PEER_BIN!);assert(fs.statSync(bin).isDirectory());fs.copyFileSync(peer,bin+'/pi');fs.chmodSync(bin+'/pi',0o755);
 fs.writeFileSync(bin+'/bd','#!/bin/sh\necho "SETUP: this fixture must not invoke bd" >&2\nexit 99\n',{mode:0o755});
 const reply='OUTCOME: O1 PASS — fixture result\nOUTCOME: O2 PASS — fixture guide\nVERDICT: WALKED-DONE\n';
 for(const [mode,name] of [['initial','work walk waits for a test lock held before it began'],['queue','work walk timeout names the test-lock holder'],['unrelated','work walk timeout without its own queued suite retains its phase']] as const){
  if(process.env.WHEELHOUSE_WALK_LOCK_CASE&&process.env.WHEELHOUSE_WALK_LOCK_CASE!==mode)continue;
  if(await runCase(mode,reply))console.log('  ok    '+name);else failed++;
 }
 save();if(failed)process.exitCode=1;
}
main().catch(error=>{report({mode:'setup',budget:null},error);process.exitCode=1;});
