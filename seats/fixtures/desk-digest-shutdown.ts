// Real parent termination must not strand the detached read-only job tree.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const [file,mode,record]=process.argv.slice(2);assert(['exit','signal','SIGINT','SIGHUP'].includes(mode));const signal=mode==='exit'?null:mode==='signal'?'SIGTERM':mode;
const root=path.dirname(path.dirname(file)),fixture=path.dirname(root);
assert(fs.lstatSync(path.join(fixture,'.wheelhouse-selftest-fixture')).isFile());assert(record.startsWith(root+path.sep));
const base=record+'.fixture';fs.mkdirSync(base);
const marker=path.join(base,'tree.json'),grandchildFile=path.join(base,'grandchild.ts'),fault=path.join(base,'digest.ts'),driver=path.join(base,'parent.ts');
fs.writeFileSync(grandchildFile,'setInterval(()=>{},1000);\n');
fs.writeFileSync(fault,`import fs from 'node:fs';const c=Bun.spawn([process.execPath,${JSON.stringify(grandchildFile)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({child:process.pid,grandchild:c.pid}));setInterval(()=>{},1000);\n`);
fs.writeFileSync(driver,`import fs from 'node:fs';process.env.WHEELHOUSE_DESK_DIGEST_TIMEOUT_MS='60000';const spawn=Bun.spawn.bind(Bun);Bun.spawn=((o)=>spawn({...o,cmd:[o.cmd[0],${JSON.stringify(fault)},...o.cmd.slice(2)]}));const d=await import(${JSON.stringify(file)});d.scheduleDigestRefresh();while(!fs.existsSync(${JSON.stringify(marker)}))await Bun.sleep(1);${mode==='exit'?'process.exit(0);':'setInterval(()=>{},1000);'}\n`);
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
const parent=Bun.spawn([process.execPath,driver],{env:{...process.env,WHEELHOUSE_DESK_ROOT:root,WHEELHOUSE_NEEDS_ROOT:root},stdin:'ignore',stdout:'ignore',stderr:'pipe',detached:true});let tree:any;
try{
  const until=performance.now()+5000;while(!fs.existsSync(marker)&&performance.now()<until)await Bun.sleep(1);
  assert(fs.statSync(marker).isFile(),'job tree must really exist');tree=JSON.parse(fs.readFileSync(marker,'utf8'));assert(tree.child>0&&tree.grandchild>0);
  if(signal)parent.kill(signal as any);
  let timer:any;const code=await Promise.race([parent.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('parent did not exit')),5000);})]).finally(()=>clearTimeout(timer));
  const reap=performance.now()+1000;while((alive(tree.child)||alive(tree.grandchild))&&performance.now()<reap)await Bun.sleep(1);
  const childAlive=alive(tree.child),grandchildAlive=alive(tree.grandchild),success=code===(signal?128+({SIGTERM:15,SIGINT:2,SIGHUP:1} as any)[signal]:0)&&parent.signalCode===signal&&!childAlive&&!grandchildAlive;
  fs.writeFileSync(record,JSON.stringify({mode,parentCode:code,parentSignal:parent.signalCode,childAlive,grandchildAlive,success})+'\n');
  assert(success,'DAEMON_MEMORY_ORACLE: parent '+mode+' orphaned its digest tree');console.log('PASS parent '+mode+' releases digest tree');
}finally{
  if(tree){try{process.kill(-tree.child,'SIGKILL');}catch{}for(const pid of [tree.child,tree.grandchild])if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}}
  if(parent.exitCode===null)parent.kill('SIGKILL');await parent.exited;await new Response(parent.stderr).text();
}
