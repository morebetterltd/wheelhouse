import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {completedSpawnSync} from '../native-command';
const [here,fix,source]=process.argv.slice(2),factory=fix+'/factory',product=fix+'/five-features',agent=fix+'/agent',bin=fix+'/bin';
const evidence=process.env.WHEELHOUSE_MANUAL_CHECK_EVIDENCE;if(evidence)fs.mkdirSync(evidence,{recursive:true});
const records:any[]=[],legs:any[]=[];
function cmd(file:string,args:string[],cwd=product,env:NodeJS.ProcessEnv=process.env){const r=completedSpawnSync(file,args,{cwd,env,encoding:'utf8',policyTimeoutMs:20000});assert(!r.error&&r.signal===null,'NATIVE setup/helper failed: '+JSON.stringify(r));return r;}
function git(...args:string[]){const r=cmd('git',args);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
for(const d of [factory+'/seats',agent,bin])fs.mkdirSync(d,{recursive:true});
fs.cpSync(here+'/fixtures/verification/five-features',product,{recursive:true,verbatimSymlinks:true});
for(const f of fs.readdirSync(here))if((f.endsWith('.ts')||f.endsWith('.sh'))&&!f.endsWith('.selftest.sh'))fs.copyFileSync(here+'/'+f,factory+'/seats/'+f);
for(const d of ['drivers','transports'])fs.cpSync(here+'/'+d,factory+'/seats/'+d,{recursive:true});
fs.mkdirSync(factory+'/.agents/skills',{recursive:true});fs.cpSync(path.join(here,'../.agents/skills/maintain-verification'),factory+'/.agents/skills/maintain-verification',{recursive:true});
fs.copyFileSync(source,factory+'/seats/manual-check.ts');fs.copyFileSync(path.join(path.dirname(source),'manual-check-child.ts'),factory+'/seats/manual-check-child.ts');
fs.writeFileSync(agent+'/auth.json','{"stub":true}');
const roster={seats:{verifier:{role:'verifier',harness:'pi',provider:'openai',model:'fixture',account:{dir:agent}}}};fs.writeFileSync(factory+'/seats/seats.json',JSON.stringify(roster));
const findings='FINDINGS:\n- drift — counter — The reach step returns 404 at /countr.\n- unmapped — /search — A recent hand commit adds an unmapped search route.\n- break — about — The mapped about endpoint returns HTTP 500.\n';
const stub=`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const argv=process.argv.slice(2),prompt=fs.readFileSync(0,'utf8');
const promptFile=path.join(path.dirname(process.env.EVIDENCE_DIR),'prompt.txt'),expected=fs.readFileSync(promptFile,'utf8');
let slot=null,slotLive=false;const marker=process.env.WHEELHOUSE_MANUAL_CHECK_ROOT+'/seats/run/walk.verifier.json';if(fs.existsSync(marker)){slot=JSON.parse(fs.readFileSync(marker,'utf8'));process.kill(slot.pid,0);slotLive=true;}fs.appendFileSync(process.env.MANUAL_CALLS,JSON.stringify({pid:process.pid,cwd:process.cwd(),slot,slotLive,argv,prompt,promptFile,expected})+'\\n');
assert(prompt.length>0,'manual-check stdin prompt is empty');
assert(!argv.includes(prompt),'manual-check prompt found in argv');
assert.equal(prompt,expected,'manual-check stdin differs from prompt.txt');
if(process.env.MANUAL_MODE==='edited')fs.writeFileSync('changed-by-stub','not allowed');
const reply=process.env.MANUAL_MODE==='none'?'FINDINGS: none\\n':process.env.MANUAL_MODE==='bad'?'not a findings block\\n':${JSON.stringify(findings)};
if(process.env.MANUAL_MODE==='utf8'){process.stdout.write(Buffer.concat([Buffer.from('FINDINGS:\\n- drift '),Buffer.from([0xe2])]));process.stderr.write(Buffer.from([0x63,0x61,0x66,0xc3]));setTimeout(()=>{process.stdout.write(Buffer.concat([Buffer.from([0x80,0x94]),Buffer.from(' counter — Split stream is intact.\\n')]));process.stderr.write(Buffer.from([0xa9,0x0a]));},400);}else if(process.env.MANUAL_MODE==='slow'){process.on('SIGTERM',()=>{});setTimeout(()=>{process.stdout.write('FINDINGS: none\\n');process.exit(0)},3000);}else process.stdout.write(reply);
`;
for(const name of ['pi','claude','codex'])fs.writeFileSync(bin+'/'+name,stub,{mode:0o755});
// An accidental graph invocation cannot affect either an installed or handmade graph.
fs.writeFileSync(bin+'/bd','#!/bin/sh\necho unexpected-bd-call >&2\nexit 99\n',{mode:0o755});
const init=cmd('git',['init','-q','-b','main']);assert.equal(init.status,0,init.stderr);git('-c','user.name=selftest','-c','user.email=selftest@local','commit','--allow-empty','-qm','empty default line');const legacy=git('rev-parse','HEAD');git('add','.');git('-c','user.name=selftest','-c','user.email=selftest@local','commit','-qm','reference manual fixture');
const counter=product+'/.agents/skills/verify-five-features/features/counter.md';let t=fs.readFileSync(counter,'utf8');assert(t.includes('/counter'));fs.writeFileSync(counter,t.replace('/counter','/countr'));
const app=product+'/server.ts';t=fs.readFileSync(app,'utf8');const old='case "/about": return page("About", "<p>A small verification fixture with five public features.</p>");';assert(t.includes(old));fs.writeFileSync(app,t.replace(old,'case "/search": return new Response("Search");\n        case "/about": return new Response("broken about", { status: 500 });'));
git('add','.');git('-c','user.name=selftest','-c','user.email=selftest@local','commit','-qm','Add search route and revise fixture interface');
const before=git('status','--porcelain'),branches=git('branch','--list'),tip=git('rev-parse','HEAD');assert.equal(before,'');
const calls=fix+'/calls.jsonl';fs.writeFileSync(calls,'');
if(process.env.WHEELHOUSE_MANUAL_CHECK_PREPARE_ONLY==='1'){console.log(JSON.stringify({factory,product,agent,bin,tip}));process.exit(0);}
const save=()=>{if(evidence){fs.writeFileSync(evidence+'/results.json',JSON.stringify({legs,records,tip,branches},null,2)+'\n');fs.writeFileSync(evidence+'/calls.jsonl',fs.readFileSync(calls));}};
function run(name:string,mode='three',extra:Record<string,string>={}){
 const ledger=factory+'/seats/intake.jsonl';const oldRows=fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).length:0;
 const out=fix+'/out-'+name;const args=[factory+'/seats/manual-check.ts','--repo',product,'--out',out];
 const r=cmd('bun',args,factory,{...process.env,PATH:bin+path.delimiter+process.env.PATH,WHEELHOUSE_MANUAL_CHECK_ROOT:factory,WHEELHOUSE_MANUAL_CHECK_TIMEOUT_MS:'5000',MANUAL_MODE:mode,MANUAL_CALLS:calls,...extra});
 const rows=fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 const inbox=fs.existsSync(factory+'/seats/inbox.jsonl')?fs.readFileSync(factory+'/seats/inbox.jsonl','utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 const artifacts:any={};if(fs.existsSync(out))for(const dir of fs.readdirSync(out)){const folder=path.join(out,dir);if(!/^[a-f0-9]{12}$/.test(dir)||!fs.statSync(folder).isDirectory())continue;for(const file of ['before.json','after.json','native.json'])if(fs.existsSync(path.join(folder,file)))artifacts[file]=JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));}
 const row={name,args,artifacts,status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr,rows,added:rows.length-oldRows,inbox,out,tree:git('status','--porcelain'),branches:git('branch','--list')};records.push(row);save();return row;
}
function leg(name:string,fn:()=>void){let error=null;try{fn();}catch(e:any){error=e.message;}legs.push({name,error});console.log((error?'FAIL ':'PASS ')+name+(error?': '+error:''));save();}
leg('manual check three rows, no branch, clean tree',()=>{const r=run('three');assert.equal(r.status,0,r.stderr);assert.equal(r.added,3);assert.deepEqual(r.rows.map(x=>x.source),['manual-check:drift:counter','manual-check:unmapped:/search','manual-check:break:about']);assert(r.rows.every(x=>x.kind==='finding'&&x.text.includes(tip)));assert.equal(r.tree,'');assert.equal(r.branches,branches);});
leg('manual check stdin prompt equals prompt.txt and pi tools are a standalone flag pair',()=>{
 for(const model of ['fixture',undefined]) {
  fs.writeFileSync(factory+'/seats/seats.json',JSON.stringify({seats:{verifier:{...roster.seats.verifier,model}}}));
  try {
   const r=run(model?'stdin-model':'stdin-no-model','none');assert.equal(r.status,0,r.stderr);
   const call=JSON.parse(fs.readFileSync(calls,'utf8').trim().split('\n').at(-1)!);
   assert(call.prompt.length>0);assert.equal(call.prompt,call.expected);assert(!call.argv.includes(call.prompt));
   assert.equal(call.argv.filter((x:string)=>x==='--tools').length,1);assert.equal(call.argv[call.argv.indexOf('--tools')+1],'read,bash');
   assert.equal(call.argv[call.argv.indexOf('--provider')+1],'openai');
   if(model)assert.equal(call.argv[call.argv.indexOf('--model')+1],model);else assert(!call.argv.includes('--model'));
   assert.equal(call.argv[call.argv.indexOf('--append-system-prompt')+1],path.join(path.dirname(call.promptFile),'maintain-brief.md'));
  } finally {fs.writeFileSync(factory+'/seats/seats.json',JSON.stringify(roster));}
 }
});
leg('manual check dedupe',()=>{const r=run('dedupe');assert.equal(r.status,0,r.stderr);assert.equal(r.added,0);assert.match(r.stdout,/deduped=3/);});
leg('manual check edited-tree refusal',()=>{const r=run('edited','edited');assert.equal(r.status,3,r.stderr);assert.equal(r.added,0);assert.equal(r.inbox.at(-1).class,'manual-check-failed');assert.match(r.stderr,/edited tree/);assert.equal(r.tree,'');});
leg('manual check none',()=>{const r=run('none','none');assert.equal(r.status,0,r.stderr);assert.equal(r.added,0);});
leg('manual check missing findings refused',()=>{const r=run('bad','bad');assert.equal(r.status,3,r.stderr);assert.equal(r.added,0);assert.match(r.stderr,/FINDINGS/);});
leg('manual check bounded helper',()=>{const r=run('slow','slow',{WHEELHOUSE_MANUAL_CHECK_TIMEOUT_MS:'200'});assert.equal(r.status,3,r.stderr);assert.equal(r.added,0);assert.match(r.stderr,/timed out/);});
leg('manual check UTF8 survives split stdout and stderr',()=>{const r=run('utf8','utf8');assert.equal(r.status,0,r.stderr);assert.equal(r.artifacts['native.json'].stderr,'café\n');assert.equal(r.added,0);});
leg('manual check verifier required',()=>{fs.writeFileSync(factory+'/seats/seats.json',JSON.stringify({seats:{reviewer:{...roster.seats.verifier,role:'reviewer'}}}));try{const r=run('no-seat');assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/verifier/);assert.equal(r.added,0);}finally{fs.writeFileSync(factory+'/seats/seats.json',JSON.stringify(roster));}});
leg('manual check occupies the shared verifier slot',()=>{const r=run('shared-slot','none');assert.equal(r.status,0,r.stderr);const call=JSON.parse(fs.readFileSync(calls,'utf8').trim().split('\n').at(-1)!);assert(call.slot&&call.slotLive,'verifier slot invisible to walk dispatch');assert.equal(call.slot.bead,'manual-check');});
leg('manual check default tip despite a checkout without manual',()=>{git('branch','legacy',legacy);git('switch','legacy');const oldBranches=git('branch','--list');try{const r=run('default-tip');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/checked=1/);assert.equal(r.artifacts['before.json'].tip,tip);assert.equal(r.branches,oldBranches);assert.equal(r.tree,'');}finally{git('switch','main');}});
save();if(legs.some(x=>x.error))process.exitCode=1;
