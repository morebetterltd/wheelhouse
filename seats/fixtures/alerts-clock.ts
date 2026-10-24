// Observe native scan completion while its own alerts child is held. No clock
// deadline decides non-blocking, and the negative executes a real FIFO read.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
const [fixture,source,bin,home,clockPath,selected='all']=process.argv.slice(2);
let allocation=fs.realpathSync(fixture);while(allocation!=='/'&&!fs.existsSync(path.join(allocation,'.wheelhouse-selftest-fixture')))allocation=path.dirname(allocation);assert(fs.statSync(path.join(allocation,'.wheelhouse-selftest-fixture')).isFile());assert(fs.readFileSync(path.join(allocation,'.wheelhouse-selftest-fixture'),'utf8').includes('root='+allocation+'\n'));assert(fs.readFileSync(path.join(allocation,'.wheelhouse-selftest-fixture'),'utf8').includes('nonce='+process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE+'\n'));assert(fs.statSync(path.join(source,'seats/herald.ts')).isFile());
const base=path.join(fixture,'clock-protocol');fs.mkdirSync(base,{recursive:true});
const {completedCommand}=await import(path.join(source,'seats/completed-command.ts'));
const pause=()=>Bun.sleep(20);const readJSON=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
function check(ok:any,code:string,message:string):asserts ok{if(!ok)throw Object.assign(new Error(message),{code});}
function native(dir:string,label:string,cmd:string,args:string[]){const r=completedCommand(cmd,args);fs.writeFileSync(path.join(dir,label+'.json'),JSON.stringify({cmd,args,...r},null,2)+'\n');return r;}
function ps(dir:string,pid:number,label:string){const r=native(dir,label,'ps',['-ww','-p',String(pid),'-o','pid=,ppid=,pgid=,uid=,ni=,stat=,lstart=,command=']);if(r.status===1){assert.equal(r.stdout,'');assert.equal(r.stderr,'');return false;}assert.equal(r.status,0);assert.equal(r.stderr,'');return !r.stdout.trim().split(/\s+/)[5].startsWith('Z');}
async function waitChild(dir:string,pid:number,predicate:()=>boolean,label:string){while(!predicate()){check(ps(dir,pid,'wait-'+label),'CHILD_EXITED','alerts child exited before '+label);await pause();}}
const observer=path.join(base,'observe-spawn.ts');fs.writeFileSync(observer,`import fs from 'node:fs';import path from 'node:path';import * as cp from 'node:child_process';import {mock} from 'bun:test';const original={...cp};mock.module('node:child_process',()=>({...original,spawn(file,args,options){const child=original.spawn(file,args,options);if(args?.[0]==='seats/alerts.ts')fs.writeFileSync(path.join(process.env.WHEELHOUSE_CLOCK_CASE,'launch.json'),JSON.stringify({pid:child.pid,parent:process.pid,file,args,cwd:options.cwd})+'\\n');return child;}}));\n`);
const held=String.raw`import fs from 'node:fs';import path from 'node:path';
const dir=process.env.WHEELHOUSE_CLOCK_CASE,fifo=path.join(dir,'done.fifo'),st=fs.statSync(fifo);if(!st.isFIFO())throw Error('missing owned completion FIFO');
fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({pid:process.pid,cwd:process.cwd(),dev:st.dev,ino:st.ino}));
while(true){
 if(fs.existsSync(path.join(dir,'release'))){fs.writeFileSync(path.join(dir,'complete'),'released after scan completion\n');break;}
 let fd;try{fd=fs.openSync(fifo,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);}catch(e){if(e.code!=='ENXIO')throw e;await Bun.sleep(20);continue;}
 // A native writer cannot connect until a real reader opened this FIFO. The
 // child remains held, with no EOF/data, until the controller captures that FD.
 fs.writeFileSync(path.join(dir,'blocked.json'),JSON.stringify({pid:process.pid,dev:st.dev,ino:st.ino,reason:'native completion FIFO reader connected'}));
 while(!fs.existsSync(path.join(dir,'ack-reader')))await Bun.sleep(20);
 fs.writeFileSync(path.join(dir,'complete'),'completed to release blocking scan\n');fs.writeSync(fd,'alerts child completed\n');fs.closeSync(fd);break;
}
`;
async function probe(kind:string){
 const dir=path.join(base,'case-'+kind),root=path.join(dir,'project');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'ambient.json'),JSON.stringify({load:os.loadavg(),cores:os.cpus().length,nice:os.getPriority(0)})+'\n');fs.cpSync(source,root,{recursive:true});
 for(const file of['seats/herald.state.json','seats/run/herald.pid','seats/run/fleet-snapshot.json'])fs.rmSync(path.join(root,file),{force:true});assert(!fs.existsSync(path.join(root,'seats/pool.json')),'staffing must not short-circuit alerts');
 const fifo=path.join(dir,'done.fifo'),mk=native(dir,'mkfifo','mkfifo',[fifo]);assert.equal(mk.status,0);assert.equal(mk.stderr,'');const identity=fs.statSync(fifo);assert(identity.isFIFO());
 if(kind==='held'||kind==='blocked')fs.writeFileSync(path.join(root,'seats/alerts.ts'),held);
 if(kind==='blocked'){const f=path.join(root,'seats/herald.ts'),s=fs.readFileSync(f,'utf8'),needle='  child.unref();';assert.equal(s.split(needle).length,2);fs.writeFileSync(f,s.replace(needle,needle+`\n  if (name === "alerts") { const bytes = fs.readFileSync(process.env.WHEELHOUSE_CLOCK_DONE!, "utf8"); fs.writeFileSync(process.env.WHEELHOUSE_CLOCK_RETURNED!, bytes); }`));}
 if(kind==='no-clock'){const f=path.join(root,'seats/herald.ts'),s=fs.readFileSync(f,'utf8'),needle='const clocked = runStaffingClock(state) || runAlertsClock(state);';assert.equal(s.split(needle).length,2);fs.writeFileSync(f,s.replace(needle,'const clocked = runStaffingClock(state);'));}
 const env={...process.env,HOME:home,PATH:clockPath,WHEELHOUSE_HERALD_ROOT:root,WHEELHOUSE_ALERTS_ROOT:root,WHEELHOUSE_ALERT_INTERVAL_MS:'200',WHEELHOUSE_HERALD_TMUX_PANE:'',WHEELHOUSE_CLOCK_CASE:dir,WHEELHOUSE_CLOCK_DONE:fifo,WHEELHOUSE_CLOCK_RETURNED:path.join(dir,'read-returned')};
 const child=spawn('bun',['--preload',observer,'seats/herald.ts','--once'],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',ended:any=null;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const closed=new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{ended={code,signal};resolve(ended);});});
 let result:any;try{
  while(!ended&&!fs.existsSync(path.join(dir,'blocked.json')))await pause();
  const blocked=fs.existsSync(path.join(dir,'blocked.json'));
  if(blocked){
   check(!ended,'BLOCK_NOT_HELD','scan must still be blocked before native reader acknowledgement');
   const row=readJSON(path.join(dir,'blocked.json'));assert.equal(row.dev,identity.dev);assert.equal(row.ino,identity.ino);
   const fd=native(dir,'blocked-reader','lsof',['-nP','-a','-p',String(child.pid),'-Fpcfan']);assert.equal(fd.status,0);assert.equal(fd.stderr,'');let access='',found=false;for(const line of fd.stdout.split('\n')){if(line.startsWith('f'))access='';if(line.startsWith('a'))access=line.slice(1);if(line==='n'+fifo&&access==='r')found=true;}check(found,'NO_NATIVE_READER','held child witness must match herald native read FD');
   assert(ps(dir,child.pid!,'blocked-herald'));assert(!fs.existsSync(path.join(dir,'complete')));fs.writeFileSync(path.join(dir,'ack-reader'),'native reader observed\n');
  }
  const status=await closed;fs.writeFileSync(path.join(dir,'sut.json'),JSON.stringify({...status,stdout,stderr},null,2)+'\n');assert.equal(status.code,0,stderr);assert.equal(status.signal,null);
  const launched=fs.existsSync(path.join(dir,'launch.json'));check(launched,'CLOCK_NOT_LAUNCHED','alerts clock did not launch during the completed scan');const launch=readJSON(path.join(dir,'launch.json'));assert(launch.pid>0);assert.equal(launch.parent,child.pid);
  if(kind==='real'||kind==='no-clock'){
   const snapshot=path.join(root,'seats/run/fleet-snapshot.json');await waitChild(dir,launch.pid,()=>fs.existsSync(snapshot),'snapshot');const value=readJSON(snapshot);assert(value.at&&value.alerts);while(ps(dir,launch.pid,'real-child-exit'))await pause();result={kind,code:0,signal:null,scanCompleted:true,snapshot:true,childExitCodeMeasured:false};
  }else{
   await waitChild(dir,launch.pid,()=>fs.existsSync(path.join(dir,'ready.json')),'ready');assert.equal(readJSON(path.join(dir,'ready.json')).pid,launch.pid);
   if(blocked){assert.equal(fs.readFileSync(path.join(dir,'read-returned'),'utf8'),'alerts child completed\n');assert(fs.existsSync(path.join(dir,'complete')));}
   else{assert(ps(dir,launch.pid,'held-at-scan-exit'));assert(!fs.existsSync(path.join(dir,'complete')));assert(!fs.existsSync(path.join(dir,'release')));fs.writeFileSync(path.join(dir,'release'),'scan already completed\n');}
   while(!fs.existsSync(path.join(dir,'complete')))await pause();while(ps(dir,launch.pid,'held-child-exit'))await pause();
   check(!blocked,'SCAN_BLOCKED','scan blocked on its alerts child: native completion FIFO read observed while child was held');
   result={kind,code:0,signal:null,scanCompletedBeforeRelease:true,childHeldAtScanExit:true,blocked:false,childExitCodeMeasured:false};
  }
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({verdict:'PASS',...result},null,2)+'\n');console.log('MEASUREMENT alerts-clock '+JSON.stringify(result));
 }catch(error:any){fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({verdict:'FAIL',code:error.code??'SETUP',message:error.message,sut:ended,blocked:fs.existsSync(path.join(dir,'blocked.json'))},null,2)+'\n');throw error;
 }finally{
  fs.writeFileSync(path.join(dir,'release'),'fixture cleanup release\n');fs.writeFileSync(path.join(dir,'ack-reader'),'fixture cleanup acknowledgement\n');await closed;
  fs.writeFileSync(path.join(dir,'sut.stdout'),stdout);fs.writeFileSync(path.join(dir,'sut.stderr'),stderr);
  if(fs.existsSync(path.join(dir,'launch.json'))){const p=readJSON(path.join(dir,'launch.json')).pid;while(ps(dir,p,'cleanup-child-exit'))await pause();}
  const evidence=process.env.WHEELHOUSE_ALERTS_CLOCK_EVIDENCE;if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.cpSync(dir,path.join(evidence,path.basename(dir)),{recursive:true,filter:p=>!fs.lstatSync(p).isFIFO()});}
 }
}
if(selected!=='all')await probe(selected);
else{
 await probe('real');await probe(process.env.WHEELHOUSE_ALERTS_SCAN_MODE==='blocked'?'blocked':'held');
 for(const [kind,code]of[['blocked','SCAN_BLOCKED'],['no-clock','CLOCK_NOT_LAUNCHED']]){
  // New marked case root: controls execute the actual copied herald, not an
  // observer double. Native child1 and machine-readable own assertion required.
  const control=path.join(fixture,'control-'+kind);fs.mkdirSync(control);
  const child=spawn('bun',[import.meta.path,control,source,bin,home,clockPath,kind],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const status=await new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(exit,signal)=>resolve({code:exit,signal}));});
  const verdict=readJSON(path.join(control,'clock-protocol','case-'+kind,'result.json'));assert.equal(status.code,1);assert.equal(status.signal,null);assert.equal(verdict.verdict,'FAIL');assert.equal(verdict.code,code,'unrelated setup failure cannot grade as a blocking/removal control');
  const record={kind,...status,verdict};fs.writeFileSync(path.join(base,kind+'-control.json'),JSON.stringify(record,null,2)+'\n');const evidence=process.env.WHEELHOUSE_ALERTS_CLOCK_EVIDENCE;if(evidence){fs.writeFileSync(path.join(evidence,kind+'-control.json'),JSON.stringify(record,null,2)+'\n');fs.writeFileSync(path.join(evidence,kind+'-control.stdout'),stdout);fs.writeFileSync(path.join(evidence,kind+'-control.stderr'),stderr);}console.log('PASS alerts-clock removal '+kind+': native1 at '+code);
 }
 console.log('alerts-clock: PASS (scan closes with child held; native blocking and missing-clock controls rejected)');
}
