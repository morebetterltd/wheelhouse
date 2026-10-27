// Real parent termination must not strand the detached read-only job tree.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const [file,mode,record]=process.argv.slice(2);const signal=mode==='exit'?null:mode==='signal'?'SIGTERM':mode;
const root=path.dirname(path.dirname(file)),fixture=path.dirname(root);
assert(fs.lstatSync(path.join(fixture,'.wheelhouse-selftest-fixture')).isFile());assert(record.startsWith(root+path.sep));
// Host-load containment only, not a startup or shutdown SLA.
const MARKER_CONTAINMENT_MS=60000, PARENT_EXIT_CONTAINMENT_MS=60000;
let setup='marker',started=performance.now(),written=false,parent:any,tree:any;
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
const base=record+'.fixture';
try{
assert(['exit','signal','SIGINT','SIGHUP'].includes(mode));
fs.mkdirSync(base);
const marker=path.join(base,'tree.json'),grandchildFile=path.join(base,'grandchild.ts'),fault=path.join(base,'digest.ts'),driver=path.join(base,'parent.ts');
fs.writeFileSync(grandchildFile,'setInterval(()=>{},1000);\n');
fs.writeFileSync(fault,`import fs from 'node:fs';const c=Bun.spawn([process.execPath,${JSON.stringify(grandchildFile)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({child:process.pid,grandchild:c.pid}));setInterval(()=>{},1000);\n`);
const ending=mode==='exit'?'process.exit(0);':'setInterval(()=>{},1000);';
fs.writeFileSync(driver,`import fs from 'node:fs';process.env.WHEELHOUSE_DESK_DIGEST_TIMEOUT_MS='60000';const spawn=Bun.spawn.bind(Bun);Bun.spawn=((o)=>spawn({...o,cmd:[o.cmd[0],${JSON.stringify(fault)},...o.cmd.slice(2)]}));const d=await import(${JSON.stringify(file)});d.scheduleDigestRefresh();while(!fs.existsSync(${JSON.stringify(marker)}))await Bun.sleep(1);${ending}\n`);
parent=Bun.spawn([process.execPath,driver],{env:{...process.env,WHEELHOUSE_DESK_ROOT:root,WHEELHOUSE_NEEDS_ROOT:root},stdin:'ignore',stdout:'ignore',stderr:'pipe',detached:true});
  started=performance.now();const until=started+MARKER_CONTAINMENT_MS;while(!fs.existsSync(marker)&&performance.now()<until)await Bun.sleep(1);
  if(!fs.existsSync(marker))throw Error('marker wait expired');
  assert(fs.statSync(marker).isFile(),'job tree must really exist');tree=JSON.parse(fs.readFileSync(marker,'utf8'));assert(tree.child>0&&tree.grandchild>0);
  setup='parent-exit';started=performance.now();
  if(signal)parent.kill(signal as any);
  let timer:any;const code=await Promise.race([parent.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('parent-exit wait expired')),PARENT_EXIT_CONTAINMENT_MS);})]).finally(()=>clearTimeout(timer));
  const reap=performance.now()+1000;while((alive(tree.child)||alive(tree.grandchild))&&performance.now()<reap)await Bun.sleep(1);
  const childAlive=alive(tree.child),grandchildAlive=alive(tree.grandchild),success=code===(signal?128+({SIGTERM:15,SIGINT:2,SIGHUP:1} as any)[signal]:0)&&parent.signalCode===signal&&!childAlive&&!grandchildAlive;
  fs.writeFileSync(record,JSON.stringify({mode,parentCode:code,parentSignal:parent.signalCode,childAlive,grandchildAlive,success})+'\n');written=true;
  assert(success,'DAEMON_MEMORY_ORACLE: parent '+mode+' orphaned its digest tree');console.log('PASS parent '+mode+' releases digest tree');
}catch(error){
  if(written)throw error; // The unchanged cleanup oracle rejects with native exit 1.
  fs.writeFileSync(record,JSON.stringify({mode,setup,elapsedMs:performance.now()-started,success:false})+'\n');
  console.error('fixture setup incomplete: '+setup+' wait; '+String(error));process.exitCode=2;
}finally{
  if(parent){if(parent.exitCode===null)parent.kill('SIGKILL');await parent.exited;const stderr=await new Response(parent.stderr).text();if(stderr)console.error(stderr);}
  const marker=path.join(base,'tree.json');
  if(!tree&&fs.existsSync(marker))tree=JSON.parse(fs.readFileSync(marker,'utf8'));
  if(tree){try{process.kill(-tree.child,'SIGKILL');}catch{}for(const pid of [tree.child,tree.grandchild])if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}}
}
