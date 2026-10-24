import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
const [base,source,peer,selected='all',variant='fixed']=process.argv.slice(2);
assert(fs.statSync(path.join(base,'.wheelhouse-selftest-fixture')).isFile());
const folder=path.join(base,'resume-cases');fs.mkdirSync(folder,{recursive:true});
async function runCase(kind:string,broken:string){
 const dir=fs.mkdtempSync(path.join(folder,kind+'-'+broken+'-')),root=path.join(dir,'project'),home=path.join(dir,'home'),account=path.join(dir,'account'),bin=path.join(dir,'bin');
 fs.mkdirSync(root);fs.cpSync(path.join(source,'seats'),path.join(root,'seats'),{recursive:true});for(const d of[home,account,bin,path.join(root,'contracts')])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(path.join(root,'contracts/WORKER.md'),'Owned resume protocol fixture\n');fs.writeFileSync(path.join(account,'auth.json'),'{"fixture":{"type":"api_key","key":"fixture-only"}}\n');
 fs.writeFileSync(path.join(bin,'pi'),'#!/usr/bin/env bash\nexec bun '+JSON.stringify(peer)+' "$@"\n',{mode:0o700});
 fs.writeFileSync(path.join(root,'seats/seats.json'),JSON.stringify({seats:{'worker-1':{role:'worker',harness:'pi',provider:'fixture',model:'fixture-model',account:{dir:account}}}}));
 const adapter=path.join(root,'seats/adapter.ts');let text=fs.readFileSync(adapter,'utf8');
 const edits:Record<string,[string,string]>={
  'no-continuation':['  if (interrupted) await continueResumedTurn(name);','  // removed automatic continuation'],
  'raw-steer':['  await cmdSteer(name, "[adapter resume]','  await driverForRunningSeat(name, "removed idle-aware routing").steer(rec, "[adapter resume]'],
  'no-pending-status':['const stalled = Boolean(rec.resumeContinuation) ||','const stalled = false ||'],
  'no-message-update':['message_start|message_update|message_end','message_start|message_end'],
  'wake-settled':['const interrupted = !rec.lastCapacityEvent && logHasInterruptedTurn(rec.log);','const interrupted = true;'],
 };
 if(broken!=='fixed'){const edit=edits[broken];assert(edit,'unknown variant');assert.equal(text.split(edit[0]).length,2,'unique actual adapter removal '+broken);text=text.replace(edit[0],()=>edit[1]);fs.writeFileSync(adapter,text);}
 const env={...process.env,HOME:home,PATH:bin+path.delimiter+process.env.PATH};let calls=0,active=false;
 async function cli(...args:string[]){const child=spawn('bun',['seats/adapter.ts',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const r=await new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});fs.writeFileSync(path.join(dir,++calls+'-'+args[0]+'.json'),JSON.stringify({args,...r},null,2)+'\n');assert.equal(r.code,0,r.stderr);assert.equal(r.signal,null);return r;}
 const log=path.join(root,'seats/logs/worker-1.jsonl'),state=()=>JSON.parse(fs.readFileSync(path.join(root,'seats/state.json'),'utf8')).seats['worker-1'];
 const events=()=>fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(s=>{try{return JSON.parse(s);}catch{return null;}}).filter(Boolean);
 async function until(predicate:()=>boolean,label:string){const limit=performance.now()+60000;while(!predicate()){if(performance.now()>=limit)throw Error('INCOMPLETE resume fixture resource guard: '+label);await Bun.sleep(10);}}
 let observation:any;
 try{
  await cli('spawn','worker-1');active=true;await cli('steer','worker-1','WARM');await until(()=>events().some(e=>e.type==='agent_settled'),'warm settlement');
  if(kind!=='settled'){await cli('steer','worker-1',kind==='thinking'?'CUT_THINKING':'CUT_TOOL');await until(()=>fs.existsSync(path.join(account,'cutoff-ready'))&&events().some(e=>e.type==='message_update'),'peer cutoff emitted AND observed in the real log');}
  const before=state();await cli('stop','worker-1');active=false;
  if(kind!=='settled'){
   // Exercise a bounded-tail shape using the peer's actual last emitted row,
   // not a duplicate detector. No earlier turn_start can hide missing support.
   const last=events().filter(e=>e.type==='message_update').at(-1);assert(last);fs.writeFileSync(path.join(dir,'pre-trim-events.json'),JSON.stringify(events())+'\n');fs.writeFileSync(log,JSON.stringify(last)+'\n');
  }
  await cli('resume','worker-1');active=true;const resumed=state();assert.equal(resumed.sessionFile,before.sessionFile);assert.equal(resumed.cwd,before.cwd);assert.notEqual(resumed.pid,before.pid);
  const wake=path.join(account,'wake.json');
  if(kind==='settled'){
   assert(!fs.existsSync(wake),'CASE_ASSERTION settled: completed turn must remain settled without a new automatic prompt');
   const status=await cli('status');assert.match(status.stdout,/^worker-1\s+worker\s+SETTLED\b/m);assert(!state().resumeContinuation);observation={kind,broken,continued:false,settled:true};
  }else{
   assert(fs.existsSync(wake),'CASE_ASSERTION continuation: resume left the cut-off turn idle; raw steer/ack alone cannot start it');
   const request=JSON.parse(fs.readFileSync(wake,'utf8'));assert.equal(request.type,'prompt');assert(request.message.startsWith('[adapter resume]'));assert(request.message.includes('do not blindly repeat'));
   const status=await cli('status');fs.writeFileSync(path.join(dir,'pending-status.txt'),status.stdout);
   assert.match(status.stdout,/^worker-1\s+worker\s+STALLED\b/m,'CASE_ASSERTION pending: resumed ack/replayed starts must not read plain RUNNING');
   assert(state().resumeContinuation,'checkpoint must persist until actual own progress');assert(!fs.existsSync(path.join(account,'continued')));
   // A fixture input release is NOT an outside adapter steer. The controller
   // issues only status/stop after resume; only the adapter supplies the prompt.
   fs.writeFileSync(path.join(account,'release'),'release actual progress\n');
   await until(()=>events().some(e=>e.type==='tool_execution_end'),'tool completion past replayed start');assert.equal(fs.readFileSync(path.join(account,'continued'),'utf8'),'continued');
   const done=await cli('status');assert.doesNotMatch(done.stdout,/^worker-1\s+worker\s+STALLED\b/m);assert(!state().resumeContinuation,'actual own progress clears the process-bound checkpoint');
   observation={kind,broken,continued:true,ackOnlyWasStalled:true,sameSession:true,sameCwd:true,afterStatus:done.stdout};
  }
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(observation,null,2)+'\n');console.log('PASS resume '+JSON.stringify(observation));
 }finally{
  if(active)await cli('stop','worker-1');
  const external=process.env.WHEELHOUSE_RESUME_EVIDENCE;if(external){fs.mkdirSync(external,{recursive:true});fs.cpSync(dir,path.join(external,path.basename(dir)),{recursive:true,filter:p=>{try{return !fs.lstatSync(p).isFIFO();}catch{return false;}}});}
 }
}
if(selected!=='all'){await runCase(selected,variant);}
else{
 for(const kind of['tool','thinking','settled'])await runCase(kind,'fixed');
 for(const [kind,broken,assertion]of[['tool','no-continuation','CASE_ASSERTION continuation'],['tool','raw-steer','CASE_ASSERTION continuation'],['tool','no-pending-status','CASE_ASSERTION pending'],['thinking','no-message-update','CASE_ASSERTION continuation'],['settled','wake-settled','CASE_ASSERTION settled']]){
  const child=spawn('bun',[import.meta.path,base,source,peer,kind,broken],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const r=await new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  fs.writeFileSync(path.join(folder,broken+'.stdout'),out);fs.writeFileSync(path.join(folder,broken+'.stderr'),err);fs.writeFileSync(path.join(folder,broken+'.native.json'),JSON.stringify(r)+'\n');
  assert.equal(r.code,1,broken+': removal must fail');assert.equal(r.signal,null);assert(err.includes(assertion),'removal failed outside its own assertion: '+err);console.log('PASS resume removal '+broken+': native1 at '+assertion);
 }
 console.log('adapter-resume: PASS (3 cases, 5 rejecting removals; no outside steer after resume)');
}
