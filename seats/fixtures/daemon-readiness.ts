// Fixture-only launch/readiness/exit observations. No installed services.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const [fixture,seats]=process.argv.slice(2);assert(fs.statSync(path.join(fixture,'.wheelhouse-selftest-fixture')).isFile());
const launcher=fs.readFileSync(path.join(seats,'daemon-start.ts'),'utf8'), daemons=fs.readFileSync(path.join(seats,'daemons.sh'),'utf8'), cockpit=fs.readFileSync(path.join(seats,'cockpit.sh'),'utf8');
function replace(source:string,old:string,value:string){assert.equal(source.split(old).length,2,'one measured mutation anchor');return source.replace(old,value);}
async function until(test:()=>boolean,label:string){const end=performance.now()+20000;while(!test()){if(performance.now()>=end)throw Error('INCOMPLETE '+label);await Bun.sleep(25);}}
async function join(child:ReturnType<typeof Bun.spawn>){let timer:any;try{return await Promise.race([child.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('INCOMPLETE original CLI child did not join')),20000);})]);}finally{clearTimeout(timer);}}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
type Mode='ready'|'pending'|'pending-repeat'|'exit';
const results:any[]=[];
for(const role of ['herald','desk','courier','supervisor'])for(const mode of ['ready','pending','pending-repeat','exit'] as Mode[])for(const broken of [false,true]){
 const name=[role,mode,broken?'removed':'fixed'].join('-'),root=path.join(fixture,name),run=path.join(root,'seats/run'),logs=path.join(root,'seats/logs');fs.mkdirSync(run,{recursive:true});fs.mkdirSync(logs);
 fs.writeFileSync(path.join(root,'seats/daemons.sh'),daemons);let source=launcher;
 if(broken){if(mode==='ready')source=replace(source,'${existing ? "already running" : "started"}','${existing ? "still starting" : "still starting"}');else if(mode==='pending')source=replace(source,'${name} still starting: pid','${name} started: pid');else if(mode==='pending-repeat')source=role==='desk'?replace(source,'existing = alive(prior)','existing = false'):replace(source,'pending = pid(startingFile)','pending = 0');else source=replace(source,'process.exitCode = 1; break;','process.exitCode = 0; break;');}
 fs.writeFileSync(path.join(root,'seats/daemon-start.ts'),source);
 const stub=path.join(root,'seats',role+'.ts');fs.writeFileSync(stub,`import fs from 'node:fs';\nconst run=${JSON.stringify(run)};\nfs.writeFileSync(run+'/entered',String(process.pid)+'\\n');fs.appendFileSync(run+'/allocated',String(process.pid)+'\\n');\n${mode==='exit'?"console.error('fixture startup error');process.exit(42);":''}\n${mode.startsWith('pending')?"while(!fs.existsSync(run+'/stop'))await Bun.sleep(25);process.exit(0);":''}\n${role==='desk'?"fs.writeFileSync(run+'/desk.port.'+process.pid+'.tmp','http://127.0.0.1:0/needs\\n');fs.renameSync(run+'/desk.port.'+process.pid+'.tmp',run+'/desk.port');":`fs.writeFileSync(run+'/${role}.pid',String(process.pid)+'\\n');`}\nfs.writeFileSync(run+'/ready','ready\\n');\nwhile(!fs.existsSync(run+'/stop'))await Bun.sleep(25);\n`);
 fs.writeFileSync(path.join(root,'seats/channels.json'),'{"channels":{"principal":{"audience":"principal"}}}\n');
 let command:string[];
 if(role==='supervisor'){
  fs.writeFileSync(path.join(root,'seats/supervisor.sh'),'#!/usr/bin/env bash\nexec bun '+JSON.stringify(stub)+'\n',{mode:0o755});const start=cockpit.indexOf('pid_alive() {'),end=cockpit.indexOf('\nusage() {',start);assert(start>=0&&end>start);const file=path.join(root,'launch.sh');fs.writeFileSync(file,'#!/usr/bin/env bash\nset -u\nHERE='+JSON.stringify(path.join(root,'seats'))+'\nROOT='+JSON.stringify(root)+'\n'+cockpit.slice(start,end)+'\nensure_supervisor\n',{mode:0o755});command=['bash',file];
 }else command=['bash','-c','. "$1"; start_'+role,'fixture',path.join(root,'seats/daemons.sh')];
 const input={name,command,mode,broken,observationCeiling:5000,launcherSha256:createHash('sha256').update(source).digest('hex')};fs.writeFileSync(path.join(root,'input.json'),JSON.stringify(input,null,2)+'\n');console.log('LAUNCH_INPUT '+JSON.stringify(input));
 const children:ReturnType<typeof Bun.spawn>[]=[],fds:number[]=[];let daemon=0,complete=false,semanticRejection:string|undefined;
 async function invoke(suffix:string,argv=command){const files=['out','err'].map(stream=>path.join(root,suffix+'.'+stream)),open=files.map(file=>fs.openSync(file,'wx',0o600));fds.push(...open);const child=Bun.spawn(argv,{cwd:root,env:{...process.env,WHEELHOUSE_DAEMONS_ROOT:root},stdin:'ignore',stdout:open[0],stderr:open[1]});children.push(child);const code=await join(child);return {code,signal:child.signalCode,stdout:fs.readFileSync(files[0],'utf8'),stderr:fs.readFileSync(files[1],'utf8')};}
 try{
  let value=await invoke('first');await until(()=>fs.existsSync(path.join(run,'entered')),'actual native stub entered '+name);daemon=Number(fs.readFileSync(path.join(run,'entered'),'utf8'));assert(Number.isSafeInteger(daemon)&&daemon>1);
  if(mode==='ready'){await until(()=>fs.existsSync(path.join(run,'ready')),'actual readiness '+name);assert(alive(daemon),'setup ready daemon alive');value=await invoke('again');}
  if(mode==='pending-repeat'){value=await invoke('again');const state=await invoke('starting-state',['bash','-c','. "$1"; daemon_starting "$2"','fixture',path.join(root,'seats/daemons.sh'),role]);assert.equal(state.code,0,'setup: actual shared starting-state query');console.log('STARTING_STATE '+JSON.stringify({name,...state}));}
  if(mode.startsWith('pending'))assert(alive(daemon),'setup original pending daemon alive');
  complete=true;
  try{
   if(mode==='ready'){assert.equal(value.code,0,'ready native status');assert(value.stdout.includes(role+' already running: pid '+daemon),'ready evidence must report running');}
   if(mode.startsWith('pending')){assert.equal(value.code,0,'pending native status');assert(value.stdout.includes(role+' still starting: pid '+daemon),'live pending child must say still starting');assert(!value.stdout.includes('failed')&&!value.stderr.includes('failed'),'pending is not failed');assert(!fs.existsSync(path.join(run,'ready')),'pending input has no readiness');assert(value.stdout.includes('observed pid-file='),'pending reports what was seen');}
   if(mode==='pending-repeat')assert.equal(Number(fs.readFileSync(path.join(run,'entered'),'utf8')),daemon,'a second call must not replace its live starting child');
   if(mode==='exit'){assert.equal(value.code,1,'observed exit must be failure');assert(value.stderr.includes('exited code 42'),'report actual original child exit code');}
  }catch(e:any){if(!(e instanceof assert.AssertionError))throw e;semanticRejection=e.message;}
  if(broken)assert(semanticRejection,'meaningful planted break was not rejected: '+name);else assert(!semanticRejection,semanticRejection);
  const row={name,mode,broken,complete,semanticRejection,daemonPid:daemon,cli:value};results.push(row);fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(row,null,2)+'\n');console.log((broken?'EXPECTED_REJECTION ':'PASS ')+name+' '+JSON.stringify({complete,semanticRejection,code:value.code,stdout:value.stdout,stderr:value.stderr}));
 }finally{
  fs.writeFileSync(path.join(run,'stop'),'stop\n');for(const allocated of (fs.existsSync(path.join(run,'allocated'))?fs.readFileSync(path.join(run,'allocated'),'utf8').trim().split('\n').map(Number):[]))await until(()=>!alive(allocated),'cooperative native daemon exit '+name);for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await join(child);}for(const fd of fds)fs.closeSync(fd);
 }
}
assert.equal(results.length,32);assert(results.every(x=>x.complete));assert.equal(results.filter(x=>x.broken&&x.semanticRejection).length,16);console.log('daemon-readiness: 16 observations, 16 meaningful removal rejections');
