import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {completedCommand} from '../completed-command';import conditions from './wait-for-condition.cjs';
const {waitForCondition}=conditions;const [allocation,here,mode='all']=process.argv.slice(2);assert(fs.statSync(path.join(allocation,'.wheelhouse-selftest-fixture')).isFile());
const dir=path.join(allocation,'heartbeat-'+mode),root=path.join(dir,'project'),bin=path.join(dir,'bin');fs.mkdirSync(bin,{recursive:true});
const setup=completedCommand('bash',['-c','. "$1"; selftest_copy_seat_runtime "$2" "$3"','heartbeat-setup',path.join(here,'selftest-lib.sh'),root,here]);assert.equal(setup.status,0,setup.stderr);assert(!setup.error&&!setup.signal);
fs.mkdirSync(path.join(root,'seats/run'),{recursive:true});fs.mkdirSync(path.join(root,'seats/logs'),{recursive:true});
const script=path.join(root,'seats/herald.ts');if(process.env.WHEELHOUSE_TEST_HEARTBEAT_SOURCE)fs.copyFileSync(process.env.WHEELHOUSE_TEST_HEARTBEAT_SOURCE,script);
const original=fs.readFileSync(script,'utf8'),needle='  heartbeat(state, args.includes("--once"));';
if(mode==='missing'){assert.equal(original.split(needle).length,2);fs.writeFileSync(script,original.replace(needle,'  // removed completed-scan heartbeat'));}
if(mode==='early'){const anchor='  pokeCommanderIfSafe(state);';assert.equal(original.split(anchor).length,2);fs.writeFileSync(script,original.replace(anchor,'  if (fs.existsSync(path.join(process.env.HEARTBEAT_CASE!, "hold"))) { heartbeatScanCount++; heartbeat(state, true); }\n'+anchor));}
const clock=path.join(dir,'clock.mjs');fs.writeFileSync(clock,`const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[Number(process.env.HB_NOW)]));}static now(){return Number(process.env.HB_NOW);}};`);
const fifo=path.join(dir,'release.fifo');assert.equal(completedCommand('mkfifo',[fifo]).status,0);const fd=fs.openSync(fifo,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
fs.writeFileSync(path.join(bin,'tmux'),`#!/usr/bin/env bash
set -eu
case "$1" in
 display-message) case "$*" in *'#{pane_current_path}'*) printf '%s\\t%s\\n' "$WHEELHOUSE_HERALD_ROOT" "$(cd "$WHEELHOUSE_HERALD_ROOT" && pwd -P)";; *) echo claude;; esac;;
 capture-pane)
  if [ -f "$HEARTBEAT_CASE/hold" ]; then
   exec 7< "$HEARTBEAT_CASE/release.fifo"
   rm -f "$HEARTBEAT_CASE/hold"
   printf '%s\\n' "$$" > "$HEARTBEAT_CASE/tmux-entered"
   IFS= read -r release <&7
  fi
  printf '✶ Working (esc to interrupt)\\n❯\\n';;
 *) exit 1;;
esac
`,{mode:0o755});
const rows=[{id:'drained',text:'雪'},{id:'pending-a',text:'α'},{id:'pending-b'}].map(r=>JSON.stringify(r)+'\n');
fs.writeFileSync(path.join(root,'seats/inbox.jsonl'),rows.join(''));fs.writeFileSync(path.join(root,'seats/inbox.cursor'),String(Buffer.byteLength(rows[0]))+'\n');
const heartbeat=path.join(root,'seats/run/herald.heartbeat.json'),records:any[]=[];let running:any;let failure:any;
function check(ok:any,code:string,message:string):asserts ok{if(!ok)throw Object.assign(new Error(message),{code});}
function start(now:number,daemon=false){
 const child=spawn('bun',['--preload',clock,script,...(daemon?[]:['--once'])],{cwd:root,env:{...process.env,HB_NOW:String(now),HEARTBEAT_CASE:dir,PATH:bin+path.delimiter+process.env.PATH,WHEELHOUSE_HERALD_ROOT:root,WHEELHOUSE_HERALD_TMUX_PANE:'%fixture',WHEELHOUSE_HERALD_POKE_STABILITY_MS:'0',WHEELHOUSE_ALERT_INTERVAL_MS:'1000000000000000'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='',ended=false;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const closed=new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{ended=true;const r={pid:child.pid,code,signal,stdout,stderr,stdoutEOF:child.stdout.readableEnded,stderrEOF:child.stderr.readableEnded};records.push(r);resolve(r);});});
 return {child,closed,get ended(){return ended;}};
}
function facts(run:any,now:number){check(fs.existsSync(heartbeat),'HEARTBEAT_MISSING','completed real --once wrote no heartbeat');const hb=JSON.parse(fs.readFileSync(heartbeat,'utf8'));assert.equal(hb.pid,run.pid);assert.equal(hb.scanCount,1);assert.equal(hb.startedAt,new Date(now).toISOString());assert.equal(hb.at,new Date(now).toISOString());assert.equal(hb.inboxBytes,Buffer.byteLength(rows.join('')));assert.equal(hb.drainCursor,Buffer.byteLength(rows[0]));assert.equal(hb.undrainedRows,2);assert.equal(hb.alertsLastLaunchAt,null);const last=fs.readFileSync(path.join(root,'seats/logs/herald.out.log'),'utf8').trim().split('\n').pop()!.match(/^(\S+) poke (\S+)/)!;assert.deepEqual(hb.lastPoke,{at:last[1],outcome:last[2]});assert.equal(hb.lastPoke.outcome,'deferred');return hb;}
try{
 const now=1760000000000;running=start(now);const first=await running.closed;assert.equal(first.code,0,first.stderr);assert.equal(first.signal,null);assert(first.stdoutEOF&&first.stderrEOF);facts(first,now);
 running=start(now+1000);const second=await running.closed;assert.equal(second.code,0,second.stderr);const prior=facts(second,now+1000);assert.notEqual(first.pid,second.pid);
 fs.writeFileSync(path.join(dir,'hold'),'hold real tmux FIFO read');running=start(now+2000);
 const entered=waitForCondition({site:'herald-heartbeat.tmux-entered',paths:[dir],predicate:()=>{if(fs.existsSync(path.join(dir,'tmux-entered')))return true;assert(!running.ended,'herald exited before tmux read');return false;}});
 try{await entered.promise;}finally{entered.cancel();}
 check(JSON.parse(fs.readFileSync(heartbeat,'utf8')).at===prior.at,'HEARTBEAT_EARLY','heartbeat advanced while synchronous tmux had not returned');
 // The actual stub has fd7 open on the owned FIFO and is still alive. There is
 // no elapsed delay deciding whether the scan finished before this release.
 process.kill(Number(fs.readFileSync(path.join(dir,'tmux-entered'),'utf8')),0);
 fs.rmSync(path.join(dir,'hold'),{force:true});fs.writeSync(fd,'release\n');const held=await running.closed;assert.equal(held.code,0,held.stderr);facts(held,now+2000);
 fs.rmSync(path.join(dir,'tmux-entered'));fs.writeFileSync(path.join(dir,'hold'),'daemon first scan held');running=start(now+3000,true);
 const startup=waitForCondition({site:'herald-heartbeat.startup',paths:[dir,path.dirname(heartbeat)],predicate:()=>{if(fs.existsSync(path.join(dir,'tmux-entered')))return true;assert(!running.ended);return false;}});try{await startup.promise;}finally{startup.cancel();}
 const initial=JSON.parse(fs.readFileSync(heartbeat,'utf8'));assert.equal(initial.pid,running.child.pid);assert.equal(initial.scanCount,0);assert.equal(initial.at,new Date(now+3000).toISOString());
 fs.rmSync(path.join(dir,'hold'),{force:true});fs.writeSync(fd,'release\n');running.child.kill('SIGTERM');const daemon=await running.closed;assert.equal(daemon.code,0,daemon.stderr);assert.equal(daemon.signal,null);
 console.log('PASS heartbeat: native --once0 twice, process-local facts/poke, real tmux FIFO cannot advance at, daemon startup scanCount0 before held scan');
 // Exercise the real rate limiter with an injected clock; no process timer.
 const helper=path.join(root,'seats/scan-health.ts'),source=fs.readFileSync(helper,'utf8');const limiter='  if (!force && prior?.pid === process.pid && age >= 0 && age < interval) return false;';
 if(mode==='budget-removed'){assert.equal(source.split(limiter).length,2);fs.writeFileSync(helper,source.replace(limiter,'  // removed heartbeat write budget'));}
 const api=await import(helper),before=Date.now;let injected=now+10000;Date.now=()=>injected;
 try{const f={startedAt:new Date(now).toISOString(),scanCount:1,lastPoke:null,alertsLastLaunchAt:null};assert(api.writeHeraldHeartbeat(root,f,false));const bytes=fs.readFileSync(heartbeat);injected+=9999;check(api.writeHeraldHeartbeat(root,{...f,scanCount:2},false)===false,'HEARTBEAT_BUDGET','heartbeat younger than default10s was rewritten');assert(fs.readFileSync(heartbeat).equals(bytes));injected++;assert(api.writeHeraldHeartbeat(root,{...f,scanCount:3},false));assert.equal(JSON.parse(fs.readFileSync(heartbeat,'utf8')).scanCount,3);assert(api.writeHeraldHeartbeat(root,f,true));}finally{Date.now=before;}
 console.log('PASS heartbeat write budget: same-pid9999ms skips bytes,10000ms writes, forced --once writes');
}catch(e:any){failure={code:e.code||'SETUP',message:e.message};throw e;}
finally{
 fs.rmSync(path.join(dir,'hold'),{force:true});try{fs.writeSync(fd,'release\n');}catch{}if(running&&!running.ended)running.child.kill('SIGTERM');if(running)await running.closed;fs.closeSync(fd);
 const result={mode,failure,records,heartbeat:fs.existsSync(heartbeat)?JSON.parse(fs.readFileSync(heartbeat,'utf8')):null};fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');const evidence=process.env.WHEELHOUSE_SCAN_HEALTH_EVIDENCE;if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.cpSync(dir,path.join(evidence,'heartbeat-'+mode),{recursive:true,filter:p=>!fs.lstatSync(p).isFIFO()});}
}
if(mode==='all')for(const [kind,code]of [['missing','HEARTBEAT_MISSING'],['early','HEARTBEAT_EARLY'],['budget-removed','HEARTBEAT_BUDGET']]){
 const child=spawn('bun',[import.meta.path,allocation,here,kind],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const status=await new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(exit,signal)=>resolve({code:exit,signal}));});const result=JSON.parse(fs.readFileSync(path.join(allocation,'heartbeat-'+kind,'result.json'),'utf8'));assert.equal(status.code,1,stderr);assert.equal(status.signal,null);assert.equal(result.failure.code,code,stderr);console.log(`PASS heartbeat removal ${kind}: native1 at ${code}`);
}
