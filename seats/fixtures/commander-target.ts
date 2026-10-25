// Real herald CLIs against the suite's fake tmux. Pane marks have no default.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {completedCommand as command} from '../completed-command';
const [here,base,fake,kind,mutation='none']=process.argv.slice(2);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const save=(p:string,x:any)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
let owned=false;for(let d=path.resolve(base);;d=path.dirname(d)){if(fs.existsSync(path.join(d,'.wheelhouse-selftest-fixture'))){owned=true;break;}if(path.dirname(d)===d)break;}assert(owned);
const oracle=(k:string)=>'COMMANDER_TARGET_ORACLE '+k;
if(!kind){
 fs.mkdirSync(base);const records:any[]=[];
 for(const [k,m] of [['file-none','none'],['env-none','none'],['file-other','none'],['reused','none'],['scan','none'],['namespace','none'],['file-none','no-validation'],['env-none','no-validation'],['file-other','no-validation'],['scan','no-scan'],['scan','no-scan-or-validation']]){
  const dir=path.join(base,k+'-'+m),x=command('bun',[import.meta.path,here,dir,fake,k,m]);
  fs.writeFileSync(dir+'.stdout',x.stdout);fs.writeFileSync(dir+'.stderr',x.stderr);
  if(process.env.WHEELHOUSE_QJGW_EVIDENCE){const out=path.join(process.env.WHEELHOUSE_QJGW_EVIDENCE,'target-attempts');fs.mkdirSync(out,{recursive:true});save(path.join(out,k+'-'+m+'.native.json'),{status:x.status,signal:x.signal,error:x.error?.message??null,stdout:x.stdout,stderr:x.stderr});if(fs.existsSync(path.join(dir,'runs.json')))fs.copyFileSync(path.join(dir,'runs.json'),path.join(out,k+'-'+m+'.runs.json'));}
  assert.equal(x.signal,null);assert(!x.error);assert(fs.existsSync(path.join(dir,'result.json')),x.stdout+x.stderr);const rec=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));rec.caseNative={status:x.status,signal:x.signal,error:x.error?.message??null};records.push(rec);
  assert(rec.runs.every((r:any)=>r.status===(r.args[0]==='--status'?1:0)&&!r.signal&&!r.error),'setup and actual CLI completions required');
  console.log('CAPTURE commander '+JSON.stringify(rec));
  if(m==='none')assert.equal(x.status,0,x.stderr);else{
   assert.equal(x.status,1,x.stderr);assert(x.stderr.includes('AssertionError')&&x.stderr.includes(oracle(k)),x.stderr);assert.notEqual(rec.beforeHash,rec.afterHash);
   if(m==='no-scan'){assert.equal(rec.target.status,'not-commander');assert.equal(rec.sends,'');}
   else assert.equal(rec.sends,`-t ${k==='scan'?'%10':'%12'} check the fleet inbox Enter\n`);
   console.log(`REJECT commander ${k}/${m}: actual CLI0; case1 at ${oracle(k)}`);
  }
 }
 save(path.join(base,'result.json'),records);
 if(process.env.WHEELHOUSE_QJGW_EVIDENCE){const out=path.join(process.env.WHEELHOUSE_QJGW_EVIDENCE,'targets');fs.mkdirSync(out,{recursive:true});for(const ent of fs.readdirSync(base,{withFileTypes:true})){if(ent.isFile())fs.copyFileSync(path.join(base,ent.name),path.join(out,ent.name));else fs.copyFileSync(path.join(base,ent.name,'result.json'),path.join(out,ent.name+'.json'));}}
 console.log('commander-target: PASS (6 cases; 5 actual guard controls; scan re-validation retained)');
}else{
 fs.mkdirSync(base);const root=path.join(base,'project'),bin=path.join(base,'bin');fs.mkdirSync(bin);fs.copyFileSync(fake,path.join(bin,'tmux'));fs.chmodSync(path.join(bin,'tmux'),0o700);
 const copy=command('bash',['-c','. "$1/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1"','copy',here,root]);assert.equal(copy.status,0,copy.stderr);assert(!copy.error&&!copy.signal);
 const file=path.join(root,'seats/herald.ts'),before=fs.readFileSync(file,'utf8');let after=before;
 function remove(needle:string){assert.equal(after.split(needle).length,2,'unique real source guard');after=after.replace(needle,'');}
 if(mutation==='no-validation'||mutation==='no-scan-or-validation')remove('    if (mark !== realpathMaybe(ROOT)) return { target, resolvedBy, status: "not-commander", reason: `not-commander mark=${mark || "-"}`, checkedAt };\n');
 if(mutation==='no-scan'||mutation==='no-scan-or-validation')remove('r[2] === realpathMaybe(ROOT) && ');
 assert(['none','no-validation','no-scan','no-scan-or-validation'].includes(mutation));fs.writeFileSync(file,after);
 for(const d of ['seats/run','seats/logs','wheelhouse'])fs.mkdirSync(path.join(root,d),{recursive:true});
 // These cases judge targeting, not scheduling: leave both optional clocks
 // not due so a copied alerts.ts cannot launch incidental graph/tool reads.
 fs.writeFileSync(path.join(root,'seats/logs/worker.jsonl'),'{"type":"agent_end","messages":["identity fixture new event"]}\n');fs.writeFileSync(path.join(root,'seats/herald.state.json'),JSON.stringify({logs:{'seats/logs/worker.jsonl':{offset:0}},alerts:{lastCheckAt:'2999-01-01T00:00:00Z'},staffing:{lastCheckAt:'2999-01-01T00:00:00Z'}}));
 const record=['file-none','file-other','reused'].includes(kind);if(record)save(path.join(root,'seats/run/commander-pane.json'),{paneId:'%12',root});
 let panes='',stamps='',expected='%22';
 if(['reused','scan','env-none'].includes(kind)){
  // %10 is the unmarked bridge.0; %22 is a commander in window index2.
  // The real list format deliberately has no positional columns.
  panes=`%10\twh-project\t\t${root}\n%22\twh-project\t${root}\t${root}\n%33\twh-project\t/other\t${root}`;stamps=`%22\t${root}\n%33\t/other`;
 }else if(kind==='namespace'){
  fs.writeFileSync(path.join(root,'wheelhouse/.template-source'),'namespace=fixture-ns\n');panes=`%20\twh-project\t${root}\t${root}\n%21\twh-Fixture-NS\t${root}\t${root}`;stamps=`%20\t${root}\n%21\t${root}`;expected='%21';
 }else if(kind==='file-other')stamps='%12\t/other';
 const send=path.join(base,'send.log'),env={...process.env,WHEELHOUSE_HERALD_ROOT:root,PATH:bin+path.delimiter+process.env.PATH,FAKE_TMUX_PANE_STAMPS:stamps,FAKE_TMUX_PANES:panes,FAKE_TMUX_COMMAND:'bun',FAKE_TMUX_CAPTURE_FILE:path.join(here,'fixtures/herald-panes/idle.txt'),FAKE_TMUX_SEND_LOG:send,WHEELHOUSE_HERALD_POKE_STABILITY_MS:'0',WHEELHOUSE_HERALD_POKE_COOLDOWN_MS:'0'};
 delete env.WHEELHOUSE_HERALD_TMUX_SESSION;delete env.WHEELHOUSE_HERALD_TMUX_PANE;delete env.FAKE_TMUX_PANE_PATHS;delete env.FAKE_TMUX_MISSING_PANES;
 if(kind==='env-none')env.WHEELHOUSE_HERALD_TMUX_PANE='%12';
 const runs:any[]=[];function run(args:string[]){const x=command('bun',[file,...args],{cwd:root,env}),rec={args,status:x.status,signal:x.signal??null,error:x.error?.message??null,stdout:x.stdout,stderr:x.stderr};runs.push(rec);save(path.join(base,'runs.json'),runs);assert.equal(x.status,args[0]==='--status'?1:0,x.stderr);assert(!x.signal&&!x.error);return x.stdout;}
 run(['--once']);run(['--once']);
 const target=JSON.parse(fs.readFileSync(path.join(root,'seats/run/herald.target.json'),'utf8')),state=JSON.parse(fs.readFileSync(path.join(root,'seats/herald.state.json'),'utf8')),inbox=fs.readFileSync(path.join(root,'seats/inbox.jsonl'),'utf8').trim().split('\n').map(JSON.parse),log=fs.existsSync(path.join(root,'seats/logs/herald.out.log'))?fs.readFileSync(path.join(root,'seats/logs/herald.out.log'),'utf8'):'';
 const status=run(['--status']),drain=run(['--drain']),again=run(['--drain']),sends=fs.existsSync(send)?fs.readFileSync(send,'utf8'):'';
 const rec={kind,mutation,beforeHash:hash(before),afterHash:hash(after),runs,target,state,sends,log,status,inbox,drain,again};save(path.join(base,'result.json'),rec);
 assert.equal(inbox.length,1,'new seat event collected once before grading identity');assert.deepEqual(drain.trim().split('\n').map(JSON.parse),inbox,'headless drain delivers actual collected row');assert.equal(again,'');
 const refused=['file-none','env-none','file-other'].includes(kind);
 if(refused){
  assert.equal(target.status,'not-commander',oracle(kind));assert.equal(target.target,'%12',oracle(kind));assert.equal(target.resolvedBy,kind==='env-none'?'env':'cockpit-file',oracle(kind));assert.equal(sends,'',oracle(kind));assert.equal(state.lastPokedInboxSize,undefined,oracle(kind));
  const refusals=log.split('\n').filter(l=>l.includes('poke refused reason=not-commander'));assert.equal(refusals.length,1,oracle(kind));assert(refusals[0].includes('target=%12'),oracle(kind));assert(target.reason.includes(kind==='file-other'?'mark=/other':'mark=-'),oracle(kind));assert(status.includes(`target not-commander %12 resolvedBy=${target.resolvedBy} reason=not-commander`),oracle(kind));
 }else{
  assert.equal(target.status,'ok',oracle(kind));assert.equal(target.target,expected,oracle(kind));assert.equal(target.resolvedBy,'scan',oracle(kind));assert.equal(sends,`-t ${expected} check the fleet inbox Enter\n`,oracle(kind));
 }
}
