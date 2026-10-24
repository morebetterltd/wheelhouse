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
 let result:any;
 async function wait(label:string,fn:()=>any){let previous='';for(;;){const v=fn();if(v)return v;const last={kind,broken,label,pid:child.pid,closed,normalized:lines(log).at(-1)??null,stub:lines(path.join(dir,'stub-events.jsonl')).at(-1)??null,clock:lines(path.join(dir,'clock.jsonl')).at(-1)??null,stdoutLastBytes:stdout.slice(-4096),stderrLastBytes:stderr.slice(-4096),outer:'canonical suite resource containment (default3600s)'};const snapshot=JSON.stringify(last);if(snapshot!==previous){console.error('DRIVER_WAIT_LAST_STATE '+snapshot);previous=snapshot;}if(closed)throw Error('INCOMPLETE original shim closed before observation; last_state='+snapshot);await new Promise(r=>setTimeout(r,10));}}
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
 }finally{if(!closed)child.kill('SIGTERM');const nativeClose=await close;fs.writeFileSync(path.join(dir,'child.out'),stdout);fs.writeFileSync(path.join(dir,'child.err'),stderr);fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({...result,nativeClose,stdout,stderr},null,2)+'\n');console.log('DRIVER_CHILD '+JSON.stringify({kind,...nativeClose,stdout,stderr}));}
}
// A diagnostic-only observer remains runnable while descriptor capture blocks
// this JS thread. No local kill/SLA: canonical suite containment owns expiry,
// and its retained stderr includes the last observed native command bytes.
const commandState=path.join(root,'active-command.json');
const diagnostics=spawn(process.execPath,['-e',String.raw`
const fs=require('node:fs'),path=require('node:path'),root=process.argv[1];let previous='';
function scan(){try{const file=path.join(root,'active-command.json');if(!fs.existsSync(file))return;const input=JSON.parse(fs.readFileSync(file,'utf8'));const last={...input,stdoutLastBytes:fs.readFileSync(input.stdoutFile,'utf8').slice(-4096),stderrLastBytes:fs.readFileSync(input.stderrFile,'utf8').slice(-4096)};const text=JSON.stringify(last);if(text!==previous){console.error('DRIVER_COMMAND_LAST_STATE '+text);previous=text;}}catch(e){console.error('DRIVER_COMMAND_LAST_STATE_UNVERIFIED '+String(e));}}
const poll=setInterval(scan,100);scan();process.stdin.resume();process.stdin.on('end',()=>{scan();clearInterval(poll);process.exit(0);});
`,root],{cwd:root,stdio:['pipe','inherit','inherit']});
const diagnosticsClosed=new Promise<any>((resolve,reject)=>{diagnostics.once('error',reject);diagnostics.once('close',(code,signal)=>resolve({code,signal}));});
// Exercise the actual shell test gates, not a model of their assertions.
function command(name:string,args:string[],cwd:string,env:any){
 const out=path.join(root,name+'.out'),err=path.join(root,name+'.err');const a=fs.openSync(out,'wx',0o600),b=fs.openSync(err,'wx',0o600);
 const active={name,args,cwd,stdoutFile:out,stderrFile:err,outer:'canonical suite resource containment (default3600s)'};fs.writeFileSync(commandState+'.next',JSON.stringify(active));fs.renameSync(commandState+'.next',commandState);console.error('DRIVER_COMMAND_BEGIN '+JSON.stringify(active));
 let p;try{p=spawnSync('bash',args,{cwd,env,stdio:['ignore',a,b]});}finally{fs.closeSync(a);fs.closeSync(b);}
 const result={code:p.status,stdout:fs.readFileSync(out,'utf8'),stderr:fs.readFileSync(err,'utf8')};
 console.log('DRIVER_NATIVE_COMMAND '+JSON.stringify({name,args,signal:p.signal,error:p.error?.message??null,...result}));
 assert.equal(p.error,undefined,'INCOMPLETE native fixture invocation');assert.equal(p.signal,null);
 return result;
}
try{
for(const kind of['claude','codex'])for(const broken of[false,true]){
 const name='gate-'+kind+(broken?'-removed':'-fixed'),dir=path.join(root,name),project=path.join(dir,'project');
 fs.mkdirSync(path.join(project,'seats/fixtures'),{recursive:true});fs.mkdirSync(path.join(dir,'tmp'));fs.mkdirSync(path.join(dir,'home'));
 const copied=command('copy-'+name,['-c','set -e; . "$1/seats/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1/seats"; cp -f "$1/seats/fixtures/driver-readiness.sh" "$2/seats/fixtures/driver-readiness.sh"','runtime-copy',source,project],dir,process.env);
 assert.equal(copied.code,0,'INCOMPLETE actual runtime-copy helper');
 const script=path.join(project,'seats/drivers',kind==='claude'?'claude-code':'codex','selftest.sh'),original=fs.readFileSync(script,'utf8');let body=original;
 const gate=kind==='claude'?"const release=setInterval(()=>{if(fs.existsSync(path.join(acct,'rate-release'))){clearInterval(release);finish();}},10);":"const release=setInterval(()=>{if(fs.existsSync(path.join(home,'turn-release'))){clearInterval(release);complete(msg);}},10);";
 assert.equal(body.split(gate).length,2);if(broken){
  body=body.replace(gate,()=>kind==='claude'?'finish();':'complete(msg);');
  // Removing a producer gate does not schedule the receiver. Observe the
  // resulting completion BEFORE asking for midstate, not after a guessed turn.
  const mid=kind==='claude'?`printf '{"id":"state","type":"get_state"}\\n' >&4`:`printf '{"id":"mid","type":"get_state"}\\n' >&4`;
  const file=kind==='claude'?'$FIX/logs/rate.jsonl':'$TMP/log.jsonl',owner=kind==='claude'?'$rpid':'$pid',release=kind==='claude'?'$FIX/account/rate-release':'$TMP/home/codex/turn-release';
  assert.equal(body.split(mid).length,2,'unique actual midstate request');
  const fence=`driver_wait_record "${file}" type agent_end "${owner}" || exit 2\n[ ! -e "${release}" ] || { echo 'INCOMPLETE early-completion premise: release already exists' >&2; exit 2; }\nprintf 'OBSERVED_DRIVER_EARLY_COMPLETION {"kind":"${kind}","releaseExists":false}\\n'\n`;
  body=body.replace(mid,()=>fence+mid);
 }fs.writeFileSync(script,body);
 const native=command(name,[script],project,{...process.env,HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),WHEELHOUSE_SCRATCH_COLLISION_CHILD:'1'});
 const records=native.stdout.split('\n').filter(x=>x.startsWith('OBSERVED_DRIVER_RECORD ')).map(x=>JSON.parse(x.slice(23))),mid=records.find(x=>x.id===(kind==='claude'?'state':'mid')),terminal=records.filter(x=>x.type==='agent_end');
 assert(mid&&typeof mid.data?.isStreaming==='boolean'&&terminal.length>0,'INCOMPLETE real midstate/terminal input');
 const output=native.stdout.split('\n'),fenceIndex=output.findIndex(x=>x.startsWith('OBSERVED_DRIVER_EARLY_COMPLETION '));let earlyCompletion:any=null;
 if(broken){
  assert(fenceIndex>=0,'INCOMPLETE missing early-completion observation fence');
  earlyCompletion=JSON.parse(output[fenceIndex].slice('OBSERVED_DRIVER_EARLY_COMPLETION '.length));
  const previous=output.slice(0,fenceIndex).filter(x=>x.startsWith('OBSERVED_DRIVER_RECORD ')).at(-1);
  assert(previous&&JSON.parse(previous.slice(23)).type==='agent_end','actual normalized terminal observed before fence');
  const midIndex=output.findIndex(x=>x.startsWith('OBSERVED_DRIVER_RECORD ')&&JSON.parse(x.slice(23)).id===(kind==='claude'?'state':'mid'));
  assert(midIndex>fenceIndex,'terminal observation happens before actual midstate request/response');
  assert.equal(earlyCompletion.kind,kind);assert.equal(earlyCompletion.releaseExists,false);
  assert.equal(native.code,1,'planted break must FAIL the actual shell gate, not setup');
  assert(native.stderr.includes('FAIL driver turn completed before explicit release'),'rejection must be the observed early terminal, not a state/steer race');
 }else assert.equal(fenceIndex,-1,'real gate is not scheduled by the planted-break fence');
 let rejection:string|null=null;try{assert.equal(native.code,0,'real test assertions must pass');assert.equal(mid.data.isStreaming,true,'state/steer observation precedes explicit release');}catch(e){if(!(e instanceof assert.AssertionError))throw e;rejection=String(e.message);}
 assert.equal(Boolean(rejection),broken);
 if(!broken)assert.equal(mid.data.isStreaming,true,'real gate retains a held turn');
 // The removed gate is rejected by its OBSERVED terminal before owner release.
 // Keep midstate as evidence, but never use its scheduling-dependent value as
 // proof of early completion (a reply continuation may still report streaming).
 console.log((broken?'EXPECTED_REJECTION':'PASS')+' DRIVER_GATE '+JSON.stringify({kind,broken,inputComplete:true,sourceSha256:createHash('sha256').update(body).digest('hex'),checkerAccepted:!rejection,rejection,earlyCompletion,mid,terminalCount:terminal.length,...native}));
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
}finally{diagnostics.stdin!.end();const nativeClose=await diagnosticsClosed;console.log('DRIVER_DIAGNOSTICS_EXIT '+JSON.stringify(nativeClose));assert.equal(nativeClose.signal,null);assert.equal(nativeClose.code,0,'INCOMPLETE diagnostic observer lifetime');}
console.log('driver-observation: 7 fixed observations, 7 meaningful removal rejections (session, RPC, two test gates, three record boundaries)');
