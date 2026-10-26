import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
import conditionWait from './wait-for-condition.cjs';
const {waitForCondition} = conditionWait;

const [source,root]=process.argv.slice(2);
assert(fs.statSync(path.join(source,"seats/recover.ts")).isFile());
assert(fs.statSync(path.join(root,".wheelhouse-selftest-fixture")).isFile());
const project=path.join(root,"project"),seats=path.join(project,"seats"),fifo=path.join(seats,"run/worker-dead.stdin");
fs.mkdirSync(path.dirname(fifo),{recursive:true});
for(const file of ["recover.ts","seat-activity.ts","native-command.ts","completed-command.ts"])fs.copyFileSync(path.join(source,"seats",file),path.join(seats,file));
const preload=path.join(root,"guard.mjs");
fs.writeFileSync(preload,`
import * as nativeFs from 'node:fs';
import {mock} from 'bun:test';
const fs={...nativeFs},pipe=process.env.WGJ1_PIPE,mark=process.env.WGJ1_UNSAFE;
function unsafe(kind,p){fs.appendFileSync(mark,kind+' '+p+'\\n');
 if(process.env.WGJ1_EXIT_ON_UNSAFE==='1'){console.error('WGJ1_BLOCKING_FIFO_LOOKUP: '+kind+' '+p);process.exit(86);}
 throw Object.assign(new Error('WGJ1_BLOCKING_FIFO_LOOKUP'),{code:'WGJ1_BLOCKING_FIFO_LOOKUP'});}
const hooks={realpathSync(p,...args){if(String(p)===pipe)unsafe('realpath final FIFO',p);return fs.realpathSync(p,...args);},
openSync(p,flags,...args){if(String(p)===pipe&&(typeof flags!=='number'||!(flags&fs.constants.O_NONBLOCK)))unsafe('blocking open',p);return fs.openSync(p,flags,...args);}};
mock.module('node:fs',()=>({...fs,...hooks,default:{...fs.default,...hooks}}));
`);
// Calibrate namespace interception on a REGULAR file first. A broken hook
// cannot accidentally send the negative control into a native blocking FIFO.
const calibration=path.join(root,"regular-probe"),probe=path.join(root,"probe.mjs"),probeMark=path.join(root,"probe-unsafe");
fs.writeFileSync(calibration,"regular\n");
fs.writeFileSync(probe,`import * as fs from 'node:fs';import assert from 'node:assert/strict';
for(const call of [()=>fs.realpathSync(process.env.WGJ1_PIPE),()=>fs.openSync(process.env.WGJ1_PIPE,'r')])assert.throws(call,{code:'WGJ1_BLOCKING_FIFO_LOOKUP'});
console.log('PASS ESM guard calibrated: namespace realpath and blocking open intercepted on regular file');\n`);
const calibrated=spawnSync("bun",["--preload",preload,probe],{encoding:"utf8",env:{...process.env,WGJ1_PIPE:calibration,WGJ1_UNSAFE:probeMark,WGJ1_EXIT_ON_UNSAFE:"0"}});
assert.equal(calibrated.status,0,calibrated.stdout+calibrated.stderr);assert.equal(fs.readFileSync(probeMark,"utf8").trim().split("\n").length,2);process.stdout.write(calibrated.stdout);
const made=spawnSync("mkfifo",[fifo],{encoding:"utf8"});assert.equal(made.status,0,made.stderr);assert(fs.statSync(fifo).isFIFO());
const helper=path.join(root,"peer.mjs");
fs.writeFileSync(helper,`import fs from 'node:fs';const[role,pipe,ready]=process.argv.slice(2);
if(role==='reader')fs.openSync(pipe,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
fs.writeFileSync(ready,String(process.pid));setInterval(()=>{},1000); // hold only; no timing verdict
`);
function exited(child:ChildProcess){return new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});}
function published(file:string){return waitForCondition({site:'recover-dead-pipe.published',paths:[path.dirname(file)],predicate:()=>fs.existsSync(file)});}
function capture(name:string,command:string,args:string[]){const r=spawnSync(command,args,{encoding:"utf8",env:{...process.env,LC_ALL:"C"}});fs.writeFileSync(path.join(root,name+".json"),JSON.stringify({command:[command,...args],exit:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr})+"\n");assert(!r.error);return r;}
function identity(child:ChildProcess,expected:string){
  const p=capture(`identity-${child.pid}`,"ps",["-p",String(child.pid),"-o","pid=,ppid=,lstart=,command="]);
  assert.equal(p.status,0,p.stderr);assert.equal(Number(p.stdout.trim().split(/\s+/)[1]),process.pid,"fresh owned direct child");assert(p.stdout.includes(expected));
  const c=capture(`cwd-${child.pid}`,"lsof",["-a","-p",String(child.pid),"-d","cwd","-Fn"]);
  assert.equal(c.status,0,c.stderr);assert(c.stdout.split("\n").includes("n"+project),"fresh fixture cwd");
  return p.stdout;
}
async function stop(child:ChildProcess,done:ReturnType<typeof exited>,expected:string,baseline?:string){
  if(child.exitCode===null&&child.signalCode===null){const now=identity(child,expected);if(baseline)assert.equal(now,baseline,"native pid/parent/start/argv unchanged before signal");child.kill("SIGTERM");}
  return await done;
}
const readerReady=published(path.join(root,"reader-ready")),foreignReady=published(path.join(root,"foreign-ready"));
const reader=spawn("node",[helper,"reader",fifo,path.join(root,"reader-ready")],{cwd:project,stdio:"ignore"}),readerExit=exited(reader);
const foreign=spawn("node",[helper,"foreign",fifo,path.join(root,"foreign-ready")],{cwd:project,stdio:"ignore"}),foreignExit=exited(foreign);
let cli:ChildProcess|undefined,cliExit:ReturnType<typeof exited>|undefined,foreignIdentity:string|undefined;
try {
  for(const[ready,done]of [[readerReady,readerExit],[foreignReady,foreignExit]] as const)await Promise.race([ready.promise,done.then(r=>{throw Error("helper exited before readiness: "+JSON.stringify(r));})]);
  assert.equal(fs.readFileSync(path.join(root,"reader-ready"),"utf8"),String(reader.pid));
  assert.equal(fs.readFileSync(path.join(root,"foreign-ready"),"utf8"),String(foreign.pid));
  const readerIdentity=identity(reader,helper);foreignIdentity=identity(foreign,helper);
  const held=capture("reader-open-files","lsof",["-Fn","-p",String(reader.pid)]);assert.equal(held.status,0,held.stderr);assert(held.stdout.split("\n").includes("n"+fifo),"actual peer holds actual FIFO");
  const dead=await stop(reader,readerExit,helper,readerIdentity);assert.equal(dead.signal,"SIGTERM");
  assert.throws(()=>fs.openSync(fifo,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK),{code:"ENXIO"},"confirmed dead-seat FIFO has no reader");
  const foreignFiles=capture("foreign-open-files","lsof",["-Fn","-p",String(foreign.pid)]);assert.equal(foreignFiles.status,0,foreignFiles.stderr);assert(!foreignFiles.stdout.split("\n").includes("n"+fifo));
  console.log(`peer ${reader.pid}: process exit ${dead.signal}; dead FIFO writer probe ENXIO; owned foreign pid ${foreign.pid} holds no FIFO`);
  // A truly dead recorded PID bypasses pidHoldsPath entirely. Model PID reuse
  // with an owned live foreign process so the dangerous comparison MUST run.
  const session=path.join(root,"session.jsonl"),state=path.join(seats,"state.json");fs.writeFileSync(session,'{"type":"session-start"}\n');
  const stateBytes=JSON.stringify({seats:{"worker-dead":{pid:foreign.pid,fifo,sessionFile:session,lastBead:"wgj1-dead-pipe"}}})+"\n";fs.writeFileSync(state,stateBytes);
  // Fatal mode makes the recover process exit decide the unsafe-call case,
  // even when the old realpath try/catch would otherwise hide a thrown guard.
  const unsafe=path.join(root,"unsafe");
  cli=spawn("bun",["--preload",preload,path.join(seats,"recover.ts")],{cwd:project,env:{...process.env,HOME:root,WGJ1_PIPE:fifo,WGJ1_UNSAFE:unsafe,WGJ1_EXIT_ON_UNSAFE:"1"},stdio:["ignore","pipe","pipe"]});cliExit=exited(cli);
  let out="",err="";cli.stdout!.on("data",b=>out+=b);cli.stderr!.on("data",b=>err+=b);
  const result=await cliExit;fs.writeFileSync(path.join(root,"recover-result.json"),JSON.stringify({...result,stdout:out,stderr:err})+"\n");
  process.stdout.write(out);process.stderr.write(err);console.log(`recover process exit=${result.code} signal=${result.signal}`);
  assert.equal(result.code,0,err);assert.equal(result.signal,null);assert.match(out,/^worker-dead\s+DEAD\s+pid \d+ alive but not holding this seat's FIFO/m);assert(out.includes("resume worker-dead"));
  assert.equal(fs.readFileSync(state,"utf8"),stateBytes,"recover does not alter state");assert(!fs.existsSync(fifo),"dead-seat FIFO janitor completed");
  const attempted=fs.existsSync(unsafe)?fs.readFileSync(unsafe,"utf8"):"";assert.equal(attempted,"","recover used a blocking FIFO lookup (even if its catch hid the guard error): "+attempted);
  console.log("PASS recover: named DEAD classification; state unchanged; orphan FIFO removed; no blocking lookup; process exit decides (no wall-clock verdict)");
} finally {
  readerReady.cancel();foreignReady.cancel();
  if(cli&&cliExit)await stop(cli,cliExit,path.join(seats,"recover.ts"));
  await stop(reader,readerExit,helper);
  await stop(foreign,foreignExit,helper,foreignIdentity);
}
