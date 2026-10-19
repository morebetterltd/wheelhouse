// Real adapter launches, real FIFOs/native writes, inert Node LF framer.
// Instrumentation is applied ONLY to a copied runtime and observes real calls.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const sha=(b:Uint8Array)=>crypto.createHash('sha256').update(b).digest('hex');
function trace(event:object){fs.appendFileSync(path.join(process.env.WHEELHOUSE_FRAMING_TRACE!,'events.jsonl'),JSON.stringify({role:process.env.WHEELHOUSE_FRAMING_ROLE,pid:process.pid,...event})+'\n');}
export function traceWrite(rec:any,obj:any,line:Buffer,offset:number,write:()=>number):number{
 const dir=process.env.WHEELHOUSE_FRAMING_TRACE!,role=process.env.WHEELHOUSE_FRAMING_ROLE!;
 const expected=path.join(dir,obj.id+'.command');if(!fs.existsSync(expected))fs.writeFileSync(expected,line);
 let n:number;
 try { n=write(); }
 catch(e:any) { trace({event:'write-error',id:obj.id,command:obj.type,offset,bytes:line.length,error:e.code??e.message});throw e; }
 const part=obj.id+'.'+offset+'.part';
 if(n>0)fs.writeFileSync(path.join(dir,part),line.subarray(offset,offset+n));
 trace({event:'write',id:obj.id,command:obj.type,offset,n,bytes:line.length,sha256:sha(line),part:n>0?part:null});
 // The actual partial syscall completed. Stall ONLY its caller, never alter
 // bytes, counts, errno, the FIFO, or the reader's newline framing.
 if(role==='A'&&obj.type==='prompt'&&offset===0&&n>0&&n<line.length){
  fs.writeFileSync(path.join(dir,'A.paused'),'native partial write completed\n');
  while(!fs.existsSync(path.join(dir,'A.release')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
 return n;
}
export function traceLock(acquired:number|null){if(acquired===null)trace({event:'lock-contended'});}
export function tracePoll(lines:string[]){for(const line of lines){let o:any;try{o=JSON.parse(line);}catch{continue;}if(o.type==='response'&&o.command==='parse'&&o.success===false)trace({event:'parse-ignored',error:o.error});}}
// Polling cadence only: assertions depend on observed events, never elapsed time.
async function until(test:()=>boolean,closed:()=>boolean=()=>false){while(!test()){if(closed())throw new Error('fixture exited before its signal');await Bun.sleep(10);}}

async function main(){
 const root=path.resolve(process.argv[2]),runtime=path.join(root,'runtime/seats');
 let source=fs.readFileSync(path.join(runtime,'adapter.ts'),'utf8');
 const sourceSha256=sha(Buffer.from(source));console.log('SOURCE adapter-framing sha256='+sourceSha256);
 const replace=(a:string,b:string)=>{assert.equal(source.split(a).length,2,a);source=source.replace(a,b);};
 replace('const n = fs.writeSync(fd, line, offset, line.length - offset);','const n = fixtureWrite(rec, obj, line, offset, () => fs.writeSync(fd, line, offset, line.length - offset));');
 replace('    assertRpcReader(rec, phase);','    fixturePoll(r.lines);\n    assertRpcReader(rec, phase);');
 // New mutex observation is optional so the EXACT old source is a control.
 if(source.includes('const acquired = acquirePidLock(lock); // fifo-command-lock'))replace('const acquired = acquirePidLock(lock); // fifo-command-lock','const acquired = acquirePidLock(lock); fixtureLock(acquired); // fifo-command-lock');
 const at=source.startsWith('#!')?source.indexOf('\n')+1:0;
 source=source.slice(0,at)+`import {traceWrite as fixtureWrite,traceLock as fixtureLock,tracePoll as fixturePoll} from ${JSON.stringify(import.meta.path)};\n`+source.slice(at);
 const results:any[]=[];
 for(const kind of ['framing','parse-dispatch','parse-steer-idle','parse-steer-streaming']){
  const dir=path.join(root,kind),project=path.join(dir,'project'),account=path.join(dir,'account'),bin=path.join(dir,'bin'),td=path.join(dir,'trace');
  for(const d of[project,account,bin,td,path.join(project,'contracts')])fs.mkdirSync(d,{recursive:true});
  fs.cpSync(runtime,path.join(project,'seats'),{recursive:true});fs.writeFileSync(path.join(project,'seats/adapter.ts'),source);
  fs.writeFileSync(path.join(project,'contracts/REVIEWER.md'),'Inert framing reviewer fixture.\n');fs.writeFileSync(path.join(account,'auth.json'),'{"fixture":true}\n');
  fs.writeFileSync(path.join(project,'seats/seats.json'),JSON.stringify({seats:{'verifier-1':{role:'reviewer',harness:'pi',worktree:false,model:'fixture',account:{dir:account}}}}));
  fs.writeFileSync(path.join(bin,'pi'),'#!/usr/bin/env bash\nexec node "$WHEELHOUSE_FRAMING_PEER" "$@"\n',{mode:0o755});
  fs.writeFileSync(path.join(td,'events.jsonl'),'');fs.writeFileSync(path.join(dir,'input.bytes'),'');process.chdir(dir);
  const events:any[]=[],invocations:any[]=[];let peer:any,closed=false;
  const token=crypto.randomUUID();const server=net.createServer(socket=>{let text='';socket.on('data',b=>{text+=b;let at;while((at=text.indexOf('\n'))>=0){const m=JSON.parse(text.slice(0,at));text=text.slice(at+1);if(m.type==='ready'){assert.equal(m.token,token);assert.equal(m.uid,process.getuid!());assert.equal(m.cwd,project);peer={...m,socket};}events.push(m);fs.appendFileSync(path.join(dir,'peer-events.jsonl'),JSON.stringify(m)+'\n');}});socket.on('end',()=>{closed=true;socket.destroy();});socket.on('close',()=>{closed=true;});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen('control.sock',resolve);});
  // Supply data to the real contract gate; SKIP_BD already isolates this fixture.
  const contract=path.join(dir,'dispatch-contract.md');
  fs.writeFileSync(contract,`Trace: Native FIFO framing and parse-error regression fixture
Signal: isa-gap: K1
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Keep commands intact when two callers write to the same running seat, and make rejected input visible to the caller. A failed request must not be reported as a successful delivery or silently restart the seat.

Outcomes:
- O1 The adapter reports the observed command delivery or parse failure accurately.
  consumer: machine — the native framing fixture controller
  surface: FIFO bytes, peer frames, adapter exit status and stderr, and recorded seat identity
  check: run — compare native writes with complete peer frames, or require a parse-error refusal with the same live seat
`);
  const env={...process.env,HOME:path.join(dir,'home'),PATH:bin+path.delimiter+process.env.PATH,WHEELHOUSE_CONTRACT_FIXTURE:contract,WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_CLEANUP:'0',WHEELHOUSE_FRAMING_CASE:dir,WHEELHOUSE_FRAMING_TRACE:td,WHEELHOUSE_FRAMING_SOCKET:'../control.sock',WHEELHOUSE_FRAMING_TOKEN:token,WHEELHOUSE_FRAMING_PEER:path.join(import.meta.dir,'adapter-framing-peer.mjs')};
  const requests:any[]=[];function cli(args:string[],role:string){const child=Bun.spawn(['bun',path.join(project,'seats/adapter.ts'),...args],{env:{...env,WHEELHOUSE_FRAMING_ROLE:role},stdin:'ignore',stdout:'pipe',stderr:'pipe'});let ended=false;const finished=Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]).then(([rc,out,err])=>{ended=true;const value={args,role,rc,out,err};invocations.push(value);return value;});const value={finished,ended:()=>ended};requests.push(value);return value;}
  const send=(type:string,extra:object={})=>peer.socket.write(JSON.stringify({type,...extra})+'\n');
  const traces=()=>fs.readFileSync(path.join(td,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const eventCount=(type:string)=>events.filter(x=>x.type===type).length;
  async function control(type:string,ack:string,extra:object={}){const count=eventCount(ack);send(type,extra);await until(()=>eventCount(ack)>count,()=>closed);}
  const frames=()=>events.filter(x=>x.type==='frame');let failure:any,measurement:any={};
  try{
   const start=await cli(['spawn','verifier-1'],'spawn').finished;assert.equal(start.rc,0,start.err);assert(peer);
   const sf=path.join(project,'seats/state.json'),state=JSON.parse(fs.readFileSync(sf,'utf8')),pid=state.seats['verifier-1'].pid;assert.equal(pid,peer.pid);
   const fifo=state.seats['verifier-1'].fifo,st=fs.statSync(fifo);assert(peer.fd0.fifo&&peer.fd0.dev===st.dev&&peer.fd0.ino===st.ino,'real 0<> holder fd0 must be this FIFO');
   const pc=spawnSync('getconf',['PIPE_BUF',fifo],{encoding:'utf8'});fs.writeFileSync(path.join(dir,'pipe-buf.json'),JSON.stringify({command:['getconf','PIPE_BUF',fifo],status:pc.status,stdout:pc.stdout,stderr:pc.stderr}));assert.equal(pc.status,0,pc.stderr);const pipeBuf=Number(pc.stdout.trim());assert(pipeBuf>0);
   if(kind==='framing'){
    const large='meridian-frame '+ 'M'.repeat(128*1024)+'\u2028line-separator\u2029paragraph-separator\nJSON newline stays escaped';assert(Buffer.byteLength(large)>pipeBuf);
    await control('pause-after-state','armed');let fc=frames().length;const single=cli(['steer','verifier-1',large],'single');
    await until(()=>traces().some(x=>x.role==='single'&&x.event==='write'&&x.command==='prompt'&&x.n>0),single.ended);await control('drain','draining');const sr=await single.finished;assert.equal(sr.rc,0,sr.err);
    const sw=traces().filter(x=>x.role==='single'&&x.event==='write'&&x.command==='prompt'&&x.n>0),singleFrames=frames().slice(fc).filter(x=>x.command==='prompt');assert(sw.length>1,'native long write must actually be chunked');assert.equal(singleFrames.length,1);assert(singleFrames[0].valid);assert.equal(singleFrames[0].sha256,sw[0].sha256);
    measurement.single={pipeBuf,commandBytes:sw[0].bytes,nativeWriteSizes:sw.map(x=>x.n),readerFrames:singleFrames.length,valid:true,exactHash:true};
    const previous=JSON.parse(fs.readFileSync(sf,'utf8'));previous.seats['verifier-1'].lastBead='old-bead';fs.writeFileSync(sf,JSON.stringify(previous));
    await control('pause-after-state','armed');fc=frames().length;const rawOffset=fs.statSync(path.join(dir,'input.bytes')).size;
    const a=cli(['dispatch','verifier-1','fixture-bead',large],'A');await until(()=>fs.existsSync(path.join(td,'A.paused')),a.ended);
    const b=cli(['steer','verifier-1','concurrent short command'],'B');await until(()=>traces().some(x=>x.role==='B'&&(x.event==='lock-contended'||x.event==='write-error'||(x.event==='write'&&x.n>0))),b.ended);
    const mutex=traces().some(x=>x.role==='B'&&x.event==='lock-contended');
    await control('drain','draining');
    if(!mutex)await until(()=>traces().some(x=>x.role==='B'&&x.event==='write'&&x.n>0),b.ended);
    fs.writeFileSync(path.join(td,'A.release'),'release native writer\n');
    if(!mutex){await until(()=>traces().some(x=>x.role==='A'&&x.command==='prompt'&&x.event==='write'&&x.offset+x.n===x.bytes),a.ended);await until(()=>frames().length>=fc+3,()=>closed);send('exit');}
    const ar=await a.finished,br=await b.finished;
    const tx=traces().filter(x=>['A','B'].includes(x.role)&&x.event==='write'&&x.n>0),actual=fs.readFileSync(path.join(dir,'input.bytes')).subarray(rawOffset),native=Buffer.concat(tx.map(x=>fs.readFileSync(path.join(td,x.part))));
    assert(actual.equals(native),'holder/framer raw input must equal ordered real native-write bytes');
    const rf=frames().slice(fc),expected=new Set(tx.map(x=>x.sha256));
    const ai=tx.findIndex(x=>x.role==='A'&&x.command==='prompt'),ae=tx.findLastIndex(x=>x.role==='A'&&x.command==='prompt');const interleaved=tx.some((x,i)=>x.role==='B'&&i>ai&&i<ae);
    measurement.concurrent={pipeBuf,mutexObserved:mutex,nativeWrites:tx.map(({role,command,offset,n,bytes})=>({role,command,offset,n,bytes})),interleaved,rawBytesEqualNativeWrites:true,expectedCommands:expected.size,frames:rf,adapterExits:[ar.rc,br.rc],holder:'piLaunch exec with fd0 0<> FIFO; no relay',samePid:JSON.parse(fs.readFileSync(sf,'utf8')).seats['verifier-1'].pid===pid};
    assert(!interleaved,'adapter command writes interleaved before pi framing');assert(rf.every(x=>x.valid&&expected.has(x.sha256)));assert.equal(rf.length,expected.size);assert.equal(ar.rc,0,ar.err);assert.equal(br.rc,0,br.err);assert(measurement.concurrent.samePid);
   }else{
    await control('streaming','streaming',{value:kind==='parse-steer-streaming'});await control('reject','reject-armed');
    const args=kind==='parse-dispatch'?['dispatch','verifier-1','fixture-bead','reject this dispatch']:['steer','verifier-1','reject this steer'];const request=cli(args,'reject');
    await until(()=>eventCount('rejected')===1,request.ended);
    let ignored=false;await until(()=>request.ended()||(ignored=traces().some(x=>x.event==='parse-ignored')));
    const rejected=events.find(x=>x.type==='rejected').response;
    if(ignored)send('exit'); // Fix-removed cleanup only; not a timeout verdict.
    const result=await request.finished;const after=JSON.parse(fs.readFileSync(sf,'utf8')).seats['verifier-1'];
    const target=frames().find(x=>x.command==='prompt'||x.command==='steer');assert(target);
    const acknowledged=events.some(x=>x.type==='out'&&x.response.id===target.id);
    measurement={response:rejected,ignored,acknowledged,rc:result.rc,err:result.err,peerStillLive:!closed,pidUnchanged:after.pid===pid,sessionUnchanged:after.sessionFile===state.seats['verifier-1'].sessionFile,launches:eventCount('ready')};
    assert(!ignored,'parse failure was consumed then ignored while waiting for an ack');assert(!acknowledged);assert.doesNotThrow(()=>process.kill(pid,0));assert.notEqual(result.rc,0);assert(result.err.includes('PI_PARSE_ERROR')&&result.err.includes(`seat "verifier-1" (pid ${pid})`)&&result.err.includes(rejected.error),result.err);
    assert(result.err.includes('adapter.ts stop verifier-1 && adapter.ts resume verifier-1'));assert(!/timed out|process died|pipe closed/.test(result.err));assert(measurement.peerStillLive&&measurement.pidUnchanged&&measurement.sessionUnchanged&&measurement.launches===1,'parse STOP must not restart/stop the seat');
   }
   console.log('MEASUREMENT '+kind+' '+JSON.stringify(measurement));console.log('PASS '+kind);
  }catch(e:any){failure=e.stack??String(e);console.log('MEASUREMENT '+kind+' '+JSON.stringify(measurement));console.error('FAIL '+kind+': '+e.message);}
  finally{
   fs.writeFileSync(path.join(td,'A.release'),'cleanup release\n');if(peer&&!closed)send('exit');await Promise.all(requests.map(x=>x.finished));if(peer)await until(()=>closed);server.close();
   const result={kind,sourceSha256,failure:failure??null,measurement,events,invocations};fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');results.push(result);
  }
 }
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2)+'\n');
 const dest=process.env.WHEELHOUSE_FRAMING_EVIDENCE_DIR;if(dest){assert(path.isAbsolute(dest));fs.mkdirSync(dest,{recursive:true});for(const r of results){fs.mkdirSync(path.join(dest,r.kind));for(const n of['result.json','input.bytes','pipe-buf.json','peer-events.jsonl'])fs.copyFileSync(path.join(root,r.kind,n),path.join(dest,r.kind,n));fs.cpSync(path.join(root,r.kind,'trace'),path.join(dest,r.kind,'trace'),{recursive:true});}fs.copyFileSync(path.join(root,'results.json'),path.join(dest,'results.json'));}
 const failed=results.filter(x=>x.failure).length;console.log(`adapter-framing.selftest: ${results.length} checks, ${failed} failures`);process.exitCode=failed?1:0;
}
if(import.meta.main)main().catch(e=>{console.error(e);process.exitCode=1;});
