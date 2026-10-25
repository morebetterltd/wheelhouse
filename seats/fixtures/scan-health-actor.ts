// Owned idle service producer. Time and completed-work inputs are injected;
// no sleep advances an assertion. The watcher is only an IPC/exit handle.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn}from'node:child_process';import {completedCommand}from'../completed-command';import conditions from'./wait-for-condition.cjs';
const{waitForCondition}=conditions;const[mode,root,role='herald']=process.argv.slice(2),run=path.join(root,'seats/run');assert(['herald','alerts'].includes(role));let allocation=root;while(allocation!=='/'&&!fs.existsSync(path.join(allocation,'.wheelhouse-selftest-fixture')))allocation=path.dirname(allocation);assert(fs.statSync(path.join(allocation,'.wheelhouse-selftest-fixture')).isFile());fs.mkdirSync(run,{recursive:true});
const pidFile=path.join(run,role==='herald'?'herald.pid':'alerts.lock');
if(mode==='launch'){
 const child=spawn('bun',[import.meta.path,'serve',root,role],{cwd:root,env:process.env,detached:true,stdio:'ignore'});let ended=false;child.once('exit',()=>ended=true);child.once('error',()=>ended=true);child.unref();
 const ready=waitForCondition({site:'scan-health-actor.ready',paths:[run],predicate:()=>{if(fs.existsSync(pidFile)&&Number(fs.readFileSync(pidFile,'utf8'))===child.pid)return true;assert(!ended,'owned service exited before ready');return false;}});try{await ready.promise;}finally{ready.cancel();}console.log(`${role} started: pid ${child.pid}`);
}else if(mode==='serve'){
 const native=completedCommand('ps',['-p',String(process.pid),'-o','pid=,ppid=,pgid=,stat=,lstart=,command='],{env:{...process.env,LC_ALL:'C'}});assert.equal(native.status,0);assert(!native.error&&!native.signal);assert.equal(native.stderr,'');const cols=native.stdout.trim().split(/\s+/);assert.equal(Number(cols[0]),process.pid);assert.equal(Number(cols[2]),process.pid);
 fs.appendFileSync(path.join(run,'actors.jsonl'),JSON.stringify({pid:process.pid,role,birth:cols.slice(4,9).join(' '),command:cols.slice(9).join(' '),native})+'\n');
 const trace=(phase:string,data:any={})=>{if(process.env.SCAN_HEALTH_TRACE)fs.appendFileSync(process.env.SCAN_HEALTH_TRACE,JSON.stringify({phase,pid:process.pid,role,...data})+'\n');};
 const startedAt=process.env.WHEELHOUSE_SUPERVISOR_NOW||new Date().toISOString();let version='';
 const publish=(data:any={})=>{if(role==='herald'){const f=path.join(run,'herald.heartbeat.json'),tmp=f+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,startedAt,at:startedAt,scanCount:1,inboxBytes:0,drainCursor:0,undrainedRows:0,lastPoke:null,alertsLastLaunchAt:null,...data})+'\n');fs.renameSync(tmp,f);}};
 process.on('SIGTERM',()=>{fs.appendFileSync(path.join(run,'actor-signals.jsonl'),JSON.stringify({pid:process.pid,signal:'SIGTERM'})+'\n');if(process.env.SCAN_ACTOR_IGNORE_TERM!=='1')process.exit(0);});
 const watcher=fs.watch(run,()=>{
  if(fs.existsSync(path.join(run,`${role}.${process.pid}.stop`))){watcher.close();process.exit(0);}
  const f=path.join(run,'herald-control.json');if(role!=='herald'||!fs.existsSync(f))return;let c:any;try{c=JSON.parse(fs.readFileSync(f,'utf8'));}catch{return;}if(c.version===version)return;version=c.version;trace('actor-refresh',{version});publish(c.facts);fs.writeFileSync(path.join(run,'herald-refreshed.json'),JSON.stringify({version,pid:process.pid})+'\n');
 });
 publish();fs.writeFileSync(pidFile,String(process.pid)+'\n');trace('actor-ready');
}else throw Error('unknown owned service mode');
