import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{spawn,spawnSync}from'node:child_process';import{createHash}from'node:crypto';
const[source,parent]=process.argv.slice(2);assert(fs.statSync(path.join(parent,'.wheelhouse-selftest-fixture')).isFile());
const root=path.join(parent,'driver-observation');fs.mkdirSync(root);
const stub=String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=process.env.DRIVER_CASE,kind=process.env.DRIVER_KIND,home=process.env.CLAUDE_CONFIG_DIR||process.env.CODEX_HOME;let input='',held=null,published=false;
const session=path.join(home,'projects','native-actual-folder','held-session.jsonl');
function send(x){console.log(JSON.stringify(x));}function record(x){fs.appendFileSync(path.join(root,'stub-events.jsonl'),JSON.stringify(x)+'\n');}
record({kind:'entered',pid:process.pid});const pulse=setInterval(()=>{if(held&&fs.existsSync(path.join(root,'release'))){if(kind==='claude'){fs.mkdirSync(path.dirname(session),{recursive:true});fs.writeFileSync(session,'{"session":"held-session"}\n');record({kind:'published',session});send({type:'result',subtype:'success',result:'OK',session_id:'held-session'});}else{send({jsonrpc:'2.0',id:held.id,result:{turn:{id:'held-turn',status:'inProgress'}}});send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'held-thread',turn:{id:'held-turn',status:'completed'}}});record({kind:'replied',id:held.id});}held=null;}},10);
process.stdin.on('end',()=>{clearInterval(pulse);process.exit(0)});process.stdin.on('data',b=>{input+=b;let i;while((i=input.indexOf('\n'))>=0){const l=input.slice(0,i);input=input.slice(i+1);if(!l)continue;const x=JSON.parse(l);if(kind==='claude'){held=x;send({type:'system',subtype:'init',session_id:'held-session',model:'fixture'});record({kind:'init-sent'});}else{record({kind:'rpc',id:x.id,method:x.method});if(x.method==='initialize')send({jsonrpc:'2.0',id:x.id,result:{}});if(x.method==='thread/start')send({jsonrpc:'2.0',id:x.id,result:{thread:{id:'held-thread',path:path.join(home,'held-thread.jsonl')}}});if(x.method==='turn/start')held=x;}}});
`;
function lines(file:string){try{const s=fs.readFileSync(file,'utf8');return s.slice(0,s.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(e:any){if(e.code==='ENOENT')return[];throw e;}}
for(const kind of['claude','codex'])for(const broken of[false,true]){
 const dir=path.join(root,kind+(broken?'-removed':'-fixed'));fs.mkdirSync(dir);for(const x of['bin','home','account','cwd'])fs.mkdirSync(path.join(dir,x));fs.writeFileSync(path.join(dir,'brief'),'fixture brief');fs.writeFileSync(path.join(dir,'bin',kind==='claude'?'claude':'codex'),stub,{mode:0o755});
 const original=fs.readFileSync(path.join(source,'seats/drivers',kind==='claude'?'claude-code':'codex','shim.ts'),'utf8');let body=original;
 if(broken){
  const anchor=kind==='claude'?'if (sessionFile) {':'rpcPending.set(id, resolve);';assert.equal(body.split(anchor).length,2);
  body=body.replace(anchor,()=>kind==='claude'?'if (sessionId) {':anchor+' setTimeout(() => { if (rpcPending.has(id)) { rpcPending.delete(id); resolve({ error: { message: `timeout ${method}` } }); } }, 120000);');
 }
 if(kind==='codex'){
 const anchor='const piPending: any[] = [];';assert.equal(body.split(anchor).length,2);
 body=body.replace(anchor,()=>anchor+String.raw`
const fixtureCallbacks: Function[]=[];const fixtureTimeout=globalThis.setTimeout;
globalThis.setTimeout=((callback:any,ms:any,...args:any[])=>{if(ms===120000){fixtureCallbacks.push(()=>callback(...args));fs.appendFileSync(process.env.DRIVER_CASE+'/clock.jsonl',JSON.stringify({kind:'registered',ms})+'\n');return {unref(){}};}return fixtureTimeout(callback,ms,...args);}) as any;
let fixturePulsed=false;setInterval(()=>{if(!fixturePulsed&&fs.existsSync(process.env.DRIVER_CASE+'/pulse')){fixturePulsed=true;for(const callback of fixtureCallbacks)callback();fs.appendFileSync(process.env.DRIVER_CASE+'/clock.jsonl',JSON.stringify({kind:'pulsed',pending:rpcPending.size,registered:fixtureCallbacks.length})+'\n');}},10);
`);
 const ready='rpcPending.set(id, resolve);';assert.equal(body.split(ready).length,2);body=body.replace(ready,()=>ready+` setImmediate(()=>fs.appendFileSync(process.env.DRIVER_CASE+'/clock.jsonl',JSON.stringify({kind:'map-turn-complete',id})+'\\n'));`);
 }
 const shim=path.join(dir,'shim.ts');fs.writeFileSync(shim,body);const input={kind,broken,sourceSha256:createHash('sha256').update(original).digest('hex'),executedSha256:createHash('sha256').update(body).digest('hex'),scenario:kind==='claude'?'session publication held until independent get_state response':'real app-server reply held; deterministically pulse captured original120000ms callbacks after registration turn completes',policy:'no natural-load causality or actual120second elapsed claim'};fs.writeFileSync(path.join(dir,'input.json'),JSON.stringify(input,null,2)+'\n');
 const log=path.join(dir,'log.jsonl'),env={...process.env,HOME:path.join(dir,'home'),CLAUDE_CONFIG_DIR:kind==='claude'?path.join(dir,'account'):undefined,DRIVER_CASE:dir,DRIVER_KIND:kind,PATH:path.join(dir,'bin')+':'+process.env.PATH};const child=spawn(process.execPath,[shim,'--log',log,'--raw-log',path.join(dir,'raw.jsonl'),'--err-log',path.join(dir,'err.log'),'--account-dir',path.join(dir,'account'),'--brief',path.join(dir,'brief'),'--model','fixture','--cwd',path.join(dir,'cwd'),'--actor','fixture'],{cwd:dir,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',closed=false;child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);const close=new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal})});});
 const resource=setTimeout(()=>child.kill('SIGTERM'),60000);let result:any;
 async function wait(label:string,fn:()=>any){for(;;){const v=fn();if(v)return v;if(closed)throw Error('INCOMPLETE '+label+' original shim closed '+stderr);await new Promise(r=>setTimeout(r,10));}}
 const write=(x:any)=>child.stdin!.write(JSON.stringify(x)+'\n');
 try{
 write({id:'initial',type:'get_state'});await wait('initial state',()=>lines(log).find(x=>x.id==='initial'));write({id:'prompt',type:'prompt',message:'held turn'});
 let state:any,pulse:any;
 if(kind==='claude'){
 await wait('native init sent',()=>lines(path.join(dir,'stub-events.jsonl')).find(x=>x.kind==='init-sent'));write({id:'during',type:'get_state'});state=await wait('get_state while publication held',()=>lines(log).find(x=>x.id==='during'));assert.equal(state.data.isStreaming,true);assert.equal(state.data.sessionFile,null);assert(!fs.existsSync(path.join(dir,'release')));fs.writeFileSync(path.join(dir,'release'),'publish\n');
 }else{
 const rpc=await wait('native held turn request',()=>lines(path.join(dir,'stub-events.jsonl')).find(x=>x.method==='turn/start'));await wait('map registration turn complete',()=>lines(path.join(dir,'clock.jsonl')).find(x=>x.kind==='map-turn-complete'&&x.id===rpc.id));fs.writeFileSync(path.join(dir,'pulse'),'pulse\n');pulse=await wait('deterministic deadline pulse',()=>lines(path.join(dir,'clock.jsonl')).find(x=>x.kind==='pulsed'));assert(!fs.existsSync(path.join(dir,'release')));fs.writeFileSync(path.join(dir,'release'),'reply\n');
 }
 const reply=await wait('prompt response',()=>lines(log).find(x=>x.id==='prompt'));await wait('native terminal event',()=>lines(log).find(x=>x.type==='agent_end'));const complete=true;
 let rejection:string|null=null;try{assert.equal(reply.success,true,'live RPC must not timeout before matching native reply');if(kind==='claude'){assert.equal(typeof reply.data.sessionFile,'string','prompt ack must retain the actually published continuity file');assert(fs.statSync(reply.data.sessionFile).isFile());}else assert.equal(pulse.pending,1,'outstanding RPC stays pending through clock pulse');}catch(e){if(!(e instanceof assert.AssertionError))throw e;rejection=String(e.message);}
 assert.equal(Boolean(rejection),broken,'same behavioural assertion must accept fixed and reject removed guard');
 result={...input,complete,checkerAccepted:!rejection,rejection,reply,state,pulse,events:lines(path.join(dir,'stub-events.jsonl')),clock:lines(path.join(dir,'clock.jsonl')),normalized:lines(log)};console.log((broken?'EXPECTED_REJECTION':'PASS')+' DRIVER_OBSERVATION '+JSON.stringify(result));
 }finally{clearTimeout(resource);if(!closed)child.kill('SIGTERM');const nativeClose=await close;fs.writeFileSync(path.join(dir,'child.out'),stdout);fs.writeFileSync(path.join(dir,'child.err'),stderr);fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({...result,nativeClose,stdout,stderr},null,2)+'\n');console.log('DRIVER_CHILD '+JSON.stringify({kind,...nativeClose,stdout,stderr}));}
}
// Exercise the actual shell test gates, not a model of their assertions.
function command(name:string,args:string[],cwd:string,env:any){
 const out=path.join(root,name+'.out'),err=path.join(root,name+'.err');const a=fs.openSync(out,'wx',0o600),b=fs.openSync(err,'wx',0o600);
 let p;try{p=spawnSync('bash',args,{cwd,env,stdio:['ignore',a,b],timeout:60000});}finally{fs.closeSync(a);fs.closeSync(b);}
 assert.equal(p.error,undefined,'INCOMPLETE native fixture invocation');assert.equal(p.signal,null);
 return{code:p.status,stdout:fs.readFileSync(out,'utf8'),stderr:fs.readFileSync(err,'utf8')};
}
for(const kind of['claude','codex'])for(const broken of[false,true]){
 const name='gate-'+kind+(broken?'-removed':'-fixed'),dir=path.join(root,name),project=path.join(dir,'project');
 fs.mkdirSync(path.join(project,'seats/fixtures'),{recursive:true});fs.mkdirSync(path.join(dir,'tmp'));fs.mkdirSync(path.join(dir,'home'));
 fs.cpSync(path.join(source,'seats/drivers'),path.join(project,'seats/drivers'),{recursive:true});
 for(const file of['selftest-lib.sh','fixtures/driver-readiness.sh'])fs.copyFileSync(path.join(source,'seats',file),path.join(project,'seats',file));
 const script=path.join(project,'seats/drivers',kind==='claude'?'claude-code':'codex','selftest.sh'),original=fs.readFileSync(script,'utf8');let body=original;
 const gate=kind==='claude'?"const release=setInterval(()=>{if(fs.existsSync(path.join(acct,'rate-release'))){clearInterval(release);finish();}},10);":"const release=setInterval(()=>{if(fs.existsSync(path.join(home,'turn-release'))){clearInterval(release);complete(msg);}},10);";
 assert.equal(body.split(gate).length,2);if(broken)body=body.replace(gate,()=>kind==='claude'?'finish();':'complete(msg);');fs.writeFileSync(script,body);
 const native=command(name,[script],project,{...process.env,HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),WHEELHOUSE_SCRATCH_COLLISION_CHILD:'1'});
 const records=native.stdout.split('\n').filter(x=>x.startsWith('OBSERVED_DRIVER_RECORD ')).map(x=>JSON.parse(x.slice(23))),mid=records.find(x=>x.id===(kind==='claude'?'state':'mid')),terminal=records.filter(x=>x.type==='agent_end');
 assert(mid&&typeof mid.data?.isStreaming==='boolean'&&terminal.length>0,'INCOMPLETE real midstate/terminal input');
 let rejection:string|null=null;try{assert.equal(native.code,0,'real test assertions must pass');assert.equal(mid.data.isStreaming,true,'state/steer observation precedes explicit release');}catch(e){if(!(e instanceof assert.AssertionError))throw e;rejection=String(e.message);}
 assert.equal(Boolean(rejection),broken);assert.equal(mid.data.isStreaming,!broken,'rejection is the intended early-completion fault, not setup');
 console.log((broken?'EXPECTED_REJECTION':'PASS')+' DRIVER_GATE '+JSON.stringify({kind,broken,inputComplete:true,sourceSha256:createHash('sha256').update(body).digest('hex'),checkerAccepted:!rejection,rejection,mid,terminalCount:terminal.length,...native}));
}
// Complete JSONL is a fixture input boundary, not a short polling window.
const reader=fs.readFileSync(path.join(source,'seats/fixtures/driver-readiness.sh'),'utf8');
for(const mode of['complete','partial','malformed'])for(const broken of[false,true]){
 const name='reader-'+mode+(broken?'-removed':'-fixed'),file=path.join(root,name+'.jsonl'),script=path.join(root,name+'.sh');
 fs.writeFileSync(file,mode==='complete'?'\u007b"type":"agent_end"\u007d\n':mode==='partial'?'\u007b"type":"agent_end"\u007d':'not JSON\n');let body=reader;
 if(broken){const anchor=mode==='complete'?'if(String(found)===value)':mode==='partial'?'text.slice(0,text.lastIndexOf("\\n")+1)':'process.exit(2);';assert.equal(body.split(anchor).length,2);body=body.replace(anchor,()=>mode==='complete'?'if(false)':mode==='partial'?'text':'process.exit(0);');}
 fs.writeFileSync(script,body);const native=command(name,['-c','. "$1"; driver_read_record "$2" type agent_end','reader',script,file],root,process.env),expected=mode==='complete'?0:mode==='partial'?1:2;
 assert(fs.statSync(file).size>0);const rejected=native.code!==expected;assert.equal(rejected,broken,'same record-boundary checker rejects removed guard');
 console.log((broken?'EXPECTED_REJECTION':'PASS')+' DRIVER_READER '+JSON.stringify({mode,broken,inputComplete:true,expected,checkerAccepted:!rejected,sourceSha256:createHash('sha256').update(body).digest('hex'),...native}));
}
console.log('driver-observation: 7 fixed observations, 7 meaningful removal rejections (session, RPC, two test gates, three record boundaries)');
