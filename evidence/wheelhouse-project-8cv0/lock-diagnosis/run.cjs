// Controlled contention, NOT a claim to reproduce the historical scheduling.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const root=__dirname, source=process.cwd()+'/seats';
const original=fs.readFileSync(source+'/adapter.ts','utf8'), legacy=fs.readFileSync(root+'/pre-su88-adapter.ts','utf8');
const start='function acquireStateLock(): number {',end='function writeState(state: State): void {';
const block=s=>s.slice(s.indexOf(start),s.indexOf(end));
assert(block(original).includes('acquirePidLock')); assert(!block(legacy).includes('acquirePidLock'));
function child(args,env) {
  const p=spawn('bun',args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  const done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  return {p,done,get stdout(){return stdout;}};
}
(async()=>{
const results=[];
for(const mode of ['shared-current','legacy-functions-only']) {
  const dir=path.join(root,mode), seats=path.join(dir,'project/seats');fs.mkdirSync(seats,{recursive:true});
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    if(entry.isFile()&&entry.name.endsWith('.ts')) fs.copyFileSync(source+'/'+entry.name,seats+'/'+entry.name);
    if(entry.isDirectory()&&['drivers','transports'].includes(entry.name)) fs.cpSync(source+'/'+entry.name,seats+'/'+entry.name,{recursive:true});
  }
  let text=mode==='shared-current'?original:original.replace(block(original),block(legacy));
  const hook='  const fd = acquireStateLock();';assert.equal(text.split(hook).length,2);
  text=text.replace(hook,hook+`\n  if (process.env.WHEELHOUSE_DIAG_GATE) {\n    const gate = fs.openSync(process.env.WHEELHOUSE_DIAG_GATE, "r+");\n    fs.writeSync(1, JSON.stringify({held:true,pid:process.pid})+"\\n");\n    fs.readSync(gate, Buffer.alloc(1), 0, 1, null); fs.closeSync(gate);\n  }`);
  fs.writeFileSync(seats+'/adapter.ts',text);
  const state=seats+'/state.json',lock=seats+'/state.lock',gate=dir+'/release.fifo';
  fs.writeFileSync(state,JSON.stringify({seats:{'worker-a':{pid:null,cwd:dir},'worker-b':{pid:null,cwd:dir}}}));
  const fifo=spawnSync('mkfifo',[gate],{encoding:'utf8'});fs.writeFileSync(dir+'/mkfifo.json',JSON.stringify({code:fifo.status,stdout:fifo.stdout,stderr:fifo.stderr}));assert.equal(fifo.status,0);
  const env={...process.env,HOME:dir+'/home',TMPDIR:dir,WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_STATE_WRITE_DELAY_MS:'300'};
  fs.mkdirSync(env.HOME);delete env.WHEELHOUSE_STATE_LOCK_TIMEOUT_MS;
  const holder=child([seats+'/adapter.ts','stop','worker-a'],{...env,WHEELHOUSE_DIAG_GATE:gate});
  const held=await new Promise((resolve,reject)=>{
    let data='';holder.p.stdout.on('data',b=>{data+=b;const line=data.split('\n').find(x=>x.startsWith('{"held":'));if(line)resolve(JSON.parse(line));});
    holder.p.once('error',reject);holder.p.once('close',()=>reject(Error('holder exited before gate: '+holder.stdout)));
  });
  assert.equal(held.pid,holder.p.pid);assert.equal(fs.readFileSync(lock,'utf8'),holder.p.pid+'\n');
  let released=false;
  const release=()=>{if(released)return;const fd=fs.openSync(gate,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);try{fs.writeSync(fd,'r');released=true;}finally{fs.closeSync(fd);}};
  try {
  const before=fs.readFileSync(state,'utf8');
  const waiter=await child([seats+'/adapter.ts','stop','worker-b'],env).done;
  fs.writeFileSync(dir+'/waiter.json',JSON.stringify(waiter,null,2)+'\n');
  assert.equal(waiter.code,1);assert.match(waiter.stderr,/timed out waiting for .*state\.lock/);assert.equal(fs.readFileSync(state,'utf8'),before);
  assert.equal(fs.readFileSync(lock,'utf8'),holder.p.pid+'\n');
  release();
  const owner=await holder.done;assert.equal(owner.code,0,JSON.stringify(owner));assert(!fs.existsSync(lock));
  const retry=await child([seats+'/adapter.ts','stop','worker-b'],env).done;assert.equal(retry.code,0,JSON.stringify(retry));assert(!fs.existsSync(lock));
  const result={mode,holderPid:held.pid,owner,waiter,retry,timeoutConfiguration:'production default 5000ms unchanged; 300ms write delay unchanged',gate:'waiter close event releases owned FIFO; no guessed timing',historicalCause:'UNKNOWN'};
  fs.writeFileSync(dir+'/result.json',JSON.stringify(result,null,2)+'\n');results.push(result);
  console.log(mode+': real CLI waiter exit=1/state.lock timeout; holder exit=0; post-release retry exit=0');
  } finally { if(!released) { try {release();} catch {holder.p.kill('SIGTERM');} await holder.done; } }
}
fs.writeFileSync(root+'/results.json',JSON.stringify(results,null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
