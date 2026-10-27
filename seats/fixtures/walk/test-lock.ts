// No bd invocation/writes. Synthetic approval is only a validated precondition;
// these cases prove walk timing using the actual lock owner/queue/helper.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { completedCommand } from '../../completed-command';
const [fleet,agent,contract,peer] = process.argv.slice(2);
const evidence=process.env.WHEELHOUSE_WALK_LOCK_EVIDENCE;
if(evidence)fs.mkdirSync(evidence,{recursive:true});
const records:any[]=[]; let serial=0,failed=0;
const save=()=>{if(evidence)fs.writeFileSync(path.join(evidence,'test-lock.json'),JSON.stringify({source:fs.readFileSync(fleet+'/seats/walk.ts','utf8'),observer:fs.readFileSync(fleet+'/seats/walk-test-lock.ts','utf8'),records},null,2)+'\n');};
function git(args:string[]) {const r=completedCommand('git',args,{cwd:fleet});assert(!r.error&&r.signal===null&&r.status===0,r.stderr);return r.stdout.trim();}
fs.writeFileSync(fleet+'/README.md','Fixture surface\n');git(['add','README.md']);git(['-c','user.name=selftest','-c','user.email=selftest@local','commit','-qm','lock walk surface']);
const tip=git(['rev-parse','HEAD']),roster=JSON.parse(fs.readFileSync(fleet+'/seats/seats.json','utf8'));
const author=path.join(path.dirname(agent),'author'),reviewer=path.join(path.dirname(agent),'reviewer'); fs.mkdirSync(author);fs.mkdirSync(reviewer);
roster.seats.author={role:'worker',account:{dir:author}};roster.seats.reviewer={role:'reviewer',account:{dir:reviewer}};fs.writeFileSync(fleet+'/seats/seats.json',JSON.stringify(roster));
fs.mkdirSync(fleet+'/seats/verdicts',{recursive:true});
fs.writeFileSync(fleet+'/seats/verdicts/fixture-work.md',`# Verdict — bead fixture-work\n- bead: fixture-work\n- branch: main\n- tip: ${tip}\n- verdict: APPROVE\n- push: NOT CONSIDERED\n- at: ${new Date().toISOString()}\n- verifier-seat: reviewer (${reviewer})\n`);
const {readReviewRecord}=await import(fleet+'/seats/verify.ts');assert.equal(readReviewRecord(fleet,'fixture-work')?.tip,tip,'SETUP synthetic approval must parse before any timing test');
const bin=path.dirname(process.env.WALK_LOCK_PEER_BIN!); assert(fs.statSync(bin).isDirectory());
fs.copyFileSync(peer,bin+'/pi'); fs.chmodSync(bin+'/pi',0o755);
// An accidental graph invocation cannot mutate the install or a handmade graph.
fs.writeFileSync(bin+'/bd','#!/bin/sh\necho "SETUP: this fixture must not invoke bd" >&2\nexit 99\n',{mode:0o755});
const reply='OUTCOME: O1 PASS — fixture result\nOUTCOME: O2 PASS — fixture guide\nOUTCOME: O3 PASS — fixture command\nVERDICT: WALKED-DONE\n';
function start(file:string,args:string[],env:any=process.env) {
 const p=spawn(file,args,{cwd:fleet,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',error:any;let stdoutEOF=false,stderrEOF=false;
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.stdout.on('end',()=>stdoutEOF=true);p.stderr.on('end',()=>stderrEOF=true);p.once('error',e=>error=e);
 const done=new Promise<any>(resolve=>p.once('close',(status,signal)=>resolve({pid:p.pid,status,signal,error:error?.message,stdout,stderr,stdoutEOF,stderrEOF})));
 return {p,done};
}
async function until(predicate:()=>boolean,actors:ReturnType<typeof start>[],label:string) {
 while(!predicate()){if(actors.some(a=>a.p.exitCode!==null||a.p.signalCode!==null))throw new Error('SETUP child ended before '+label);await Bun.sleep(10);}
}
function gate(r:any){if(r.error||r.signal||!r.stdoutEOF||!r.stderrEOF)throw new Error('NATIVE_GATE '+JSON.stringify(r));}
async function holder(lock:string) {
 const env={...process.env,WHEELHOUSE_HEAVY_TEST_PAUSE:path.join(fleet,'no-fixture-pause')};
 const h=start('bun',[fleet+'/seats/selftest-sweep-lock.ts','supervise',lock,'bash','-c','exec sleep 4','holder'],env);
 await until(()=>fs.existsSync(lock+'/wheelhouse-selftest-sweep'),[h],'real holder publication');
 const marker=JSON.parse(fs.readFileSync(lock+'/wheelhouse-selftest-sweep','utf8'));return {h,marker};
}
async function runCase(mode:'initial'|'queue'|'unrelated') {
 const dir=path.join(fleet,'lock-case-'+(++serial));fs.mkdirSync(dir);const lock=dir+'/test.lock',out=dir+'/out',budget=mode==='initial'?900:2200;
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_CONTRACT_FIXTURE:contract,WHEELHOUSE_WALK_TIMEOUT_MS:String(budget),WHEELHOUSE_SELFTEST_SWEEP_LOCK:lock,WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:fleet+'/seats/selftest-sweep-lock.ts',WHEELHOUSE_HEAVY_TEST_PAUSE:dir+'/no-pause',WALK_LOCK_CASE:dir,WALK_LOCK_MODE:mode,WALK_LOCK_HEAVY:fleet+'/seats/heavy-test.sh',STUB_REPLY:reply};
 let h:Awaited<ReturnType<typeof holder>>|undefined,other:ReturnType<typeof start>|undefined,w:ReturnType<typeof start>|undefined;
 let queuedBefore: any;
 try {
  if(mode==='initial')h=await holder(lock);
  w=start('bun',['seats/walk.ts','--work','fixture-work','--branch','main','--author','author','--out',out],env);
  if(mode==='initial') {
   const joined=await h!.h.done;gate(joined);assert.equal(joined.status,0,joined.stderr);
   fs.writeFileSync(dir+'/holder-joined','yes');
  } else {
   await until(()=>fs.existsSync(dir+'/launched.json'),[w],'verifier launch before holder');
   h=await holder(lock);
   if(mode==='unrelated')other=start('bash',[fleet+'/seats/heavy-test.sh','/bin/true'],env);
   fs.writeFileSync(dir+'/start-suite','yes');
   await until(()=>fs.readdirSync(lock+'.queue').filter(n=>/^[0-9]{20}\./.test(n)).length===2,[w,h.h,...(other?[other]:[])],'real queued suite ticket');
   queuedBefore=fs.readdirSync(lock+'.queue').filter(n=>/^[0-9]{20}\./.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(lock+'.queue',n),'utf8')));
  }
  const r=await w.done;gate(r);
  const metadata=JSON.parse(fs.readFileSync(out+'/walk.json','utf8')),launch=JSON.parse(fs.readFileSync(dir+'/launched.json','utf8'));
  const record={mode,budget,lock,holder:h!.marker,launch,native:r,metadata,queuedBefore,holderStillPresent:fs.existsSync(lock),queue:fs.existsSync(lock+'.queue')?fs.readdirSync(lock+'.queue'):[]};records.push(record);save();
  const holderResult=await h!.h.done;gate(holderResult);if(holderResult.status!==0)throw new Error('SETUP original holder failed: '+holderResult.stderr); Object.assign(record,{holderNative:holderResult});
  if(other){const joined=await other.done;gate(joined);if(joined.status!==0)throw new Error('SETUP unrelated waiter failed: '+joined.stderr);Object.assign(record,{otherNative:joined});}
  save();return record;
 } finally {
  // Always join original handles. Only these newly spawned fixture processes
  // may receive cancellation if setup failed; never a discovered numeric pid.
  for(const actor of [w,other,h?.h])if(actor){if(actor.p.exitCode===null&&actor.p.signalCode===null)actor.p.kill('SIGTERM');await actor.done;}
 }
}
for(const [mode,name] of [['initial','work walk waits for a test lock held before it began'],['queue','work walk timeout names the test-lock holder'],['unrelated','work walk timeout without its own queued suite retains its phase']] as const){
 let row:any;
 try {row=await runCase(mode);}catch(e){throw e;} // setup/native failures are not rejection credit
 try {
  if(mode==='initial'){
   assert.equal(row.native.status,0,row.native.stdout+row.native.stderr);assert(row.native.stdout.includes('VERDICT: WALKED-DONE'));
   assert(!row.launch.holderLive,'verifier launched before initial holder released');
   assert(row.native.stderr.includes(row.lock)&&row.native.stderr.includes(`pid=${row.holder.pid}`)&&row.native.stderr.includes('verifier clock has not started'));
   assert(4000>row.budget);
  } else {
   assert.equal(row.native.status,3,row.native.stdout+row.native.stderr);
   const line=row.native.stdout.split('\n').find((s:string)=>s.startsWith('VERDICT:'));
   if(mode==='queue'){
    for(const text of ['queued for the test lock',row.lock,`pid=${row.holder.pid}`]){assert(line.includes(text),'verdict omits '+text);assert(row.metadata.reason.includes(text),'walk.json reason omits '+text);}
   } else {assert.equal(row.metadata.reason,`dispatcher timed out after ${row.budget}ms during run verifier walk`);assert(!line.includes('queued for the test lock'));}
  }
  console.log('  ok    '+name);
 } catch(e:any){failed++;console.error('FAIL '+name+': '+e.message);}
}
save();if(failed)process.exitCode=1;
