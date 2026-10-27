// Exercise real digest child failures and inspect native exit, not a fake cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const [file,mode,record]=process.argv.slice(2);
const root=path.dirname(path.dirname(file)),fixture=path.dirname(root);
assert(fs.lstatSync(path.join(fixture,'.wheelhouse-selftest-fixture')).isFile());
assert(record.startsWith(root+path.sep));
process.env.WHEELHOUSE_DESK_ROOT=root;process.env.WHEELHOUSE_NEEDS_ROOT=root;
process.env.WHEELHOUSE_DESK_DIGEST_TIMEOUT_MS='500';
// Host-load containment only, not a digest refresh SLA.
const REFRESH_CONTAINMENT_MS=60000;
let started=performance.now(),written=false;
const fault=path.join(root,'fault-'+mode+'.ts'),grandchildFile=path.join(root,'fault-grandchild.ts'),pidFile=record+'.pid';
const nativeSpawn=Bun.spawn.bind(Bun);let injected=false,readRefused=false,child:any,exitCode:number|null=null;
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
let grandchild=0;
try{
assert(['spawn','error','malformed','read','timeout'].includes(mode));
assert(!fs.readFileSync(file,'utf8').includes('const args=process.argv.slice(2);'));
fs.writeFileSync(grandchildFile,'setInterval(()=>{},1000);\n');
fs.writeFileSync(fault,mode==='error'?'process.exit(7);\n':mode==='malformed'?'console.log(JSON.stringify({bad:true}));\n':mode==='timeout'?`import fs from 'node:fs';const child=Bun.spawn([process.execPath,${JSON.stringify(grandchildFile)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);\n`:'setInterval(()=>{},1000);\n');
Bun.spawn=((options:any)=>{
  injected=true;
  const opts={...options,cmd:mode==='spawn'?[path.join(root,'missing-executable')]:[options.cmd[0],fault,...options.cmd.slice(2)]};
  child=nativeSpawn(opts);child.exited.then((code:number)=>{exitCode=code;});
  if(mode==='read')return new Proxy(child,{get(target,key){if(key==='stdout'){readRefused=true;return new ReadableStream({start(controller){controller.error(Error('fixture stdout refusal'));}});}const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  return child;
}) as typeof Bun.spawn;
  const d=await import(file);d.scheduleDigestRefresh();assert.equal(d.digestRefreshing.size,1,'pending slot must actually exist');
  // Observe operation completion separately from the slot-release oracle: the
  // retained-slot removal control must still reach that oracle and exit 1.
  const refreshing=()=>d.digestRefreshing.size&&(!injected||d.digestStops.size);
  started=performance.now();const until=started+REFRESH_CONTAINMENT_MS;while(refreshing()&&performance.now()<until)await Bun.sleep(1);
  if(refreshing())throw Error('refresh wait expired');
  if(fs.existsSync(pidFile)){grandchild=Number(fs.readFileSync(pidFile,'utf8'));const reap=performance.now()+500;while(alive(grandchild)&&performance.now()<reap)await Bun.sleep(1);}
  const childAlive=!!child&&alive(child.pid),grandchildAlive=grandchild>0&&alive(grandchild);
  const intended=mode==='error'?exitCode===7:mode==='malformed'?exitCode===0:mode==='read'?readRefused:mode==='timeout'?grandchild>0:true;
  const success=intended&&injected&&d.digestRefreshing.size===0&&d.digestCache.size===0&&(!child||exitCode!==null)&&!childAlive&&!grandchildAlive&&(mode!=='timeout'||grandchild>0);
  fs.writeFileSync(record,JSON.stringify({mode,injected,readRefused,intended,exitCode,inFlight:d.digestRefreshing.size,cache:d.digestCache.size,childAlive,grandchildStarted:grandchild>0,grandchildAlive,success})+'\n');written=true;
  assert(success,'DAEMON_MEMORY_ORACLE: digest '+mode+' did not release its slot/process tree or published invalid output');
  console.log('PASS digest '+mode+' native exit observed, no cached error, slot/process tree released');
}catch(error){
  if(written)throw error; // The unchanged cleanup oracle rejects with native exit 1.
  fs.writeFileSync(record,JSON.stringify({mode,setup:'refresh',elapsedMs:performance.now()-started,success:false})+'\n');
  console.error('fixture setup incomplete: refresh wait; '+String(error));process.exitCode=2;
}finally{
  if(!grandchild&&fs.existsSync(pidFile))grandchild=Number(fs.readFileSync(pidFile,'utf8'));
  // Fault-removal controls may deliberately leave their owned process tree alive.
  if(child){try{process.kill(-child.pid,'SIGKILL');}catch{}try{child.kill('SIGKILL');}catch{}}
  if(grandchild&&alive(grandchild))try{process.kill(grandchild,'SIGKILL');}catch{}
}
