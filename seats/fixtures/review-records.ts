import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import { completedCommand } from '../completed-command';import { reviewFixture } from './review-record-template';
const [proj, home, runPath, source, seedFile, seedOnly] = process.argv.slice(2);
const api = await import(path.join(proj,'seats/verify.ts'));
const evidence=process.env.WHEELHOUSE_REVIEW_RECORD_EVIDENCE;if(evidence)fs.mkdirSync(evidence,{recursive:true});
const results:any[]=[];let i=0;const save=(n:string,x:unknown)=>{if(evidence)fs.writeFileSync(evidence+'/'+n+'.json',JSON.stringify(x,null,2),{flag:'wx'});};
function cli(label:string, verdict:string, extra:string[]=[], env:Record<string,string>={}) {
  const bead='record-'+label,reply=path.join(proj,label+'.reply');fs.writeFileSync(reply,'VERDICT: '+verdict+'\nPUSH: NOT CONSIDERED\n');
  const r=completedCommand('bun',['seats/verify.ts',bead,'fleet/bead-1','worker-1','reviewer',...extra],{cwd:proj,env:{...process.env,HOME:home,PATH:runPath,STUB_REPLY_FILE:reply,STUB_SWEEP_PROMPT_CHECK:'1',STUB_SWEEP_VERDICT:verdict,...env}});
  const file=proj+'/seats/verdicts/'+bead+'.md',text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  const row={bead,status:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout,stderr:r.stderr,text};save(label+'-native',row);assert.equal(row.error,null);assert.equal(row.signal,null);assert(!/Cannot find module|ModuleNotFound|SyntaxError/.test(row.stderr),'INCOMPLETE runtime setup');return row;
}
const pin=completedCommand('git',['rev-parse','fleet/bead-1'],{cwd:proj});assert.equal(pin.status,0);const tip=pin.stdout.trim();
const approved=cli('approve','APPROVE');assert.equal(approved.status,0,approved.stderr+approved.stdout);assert(approved.text);
// Capture and persist real writer output BEFORE constructing any format fixtures.
fs.writeFileSync(seedFile,approved.text);if(evidence)fs.writeFileSync(evidence+'/actual-approve.md',approved.text,{flag:'wx'});
if(seedOnly==='1'){console.log('PASS real verify writer approval sample captured');process.exit(0);}
const legs:any[]=[];function leg(name:string,fn:()=>void){let error=null;try{fn();}catch(e:any){error=String(e.message??e);}legs.push({name,error});console.log((error?'FAIL ':'PASS ')+name+(error?': '+error:''));}
leg('review reader APPROVE and resolved identity',()=>{const r=api.readReviewRecord(proj,approved.bead);assert(r);assert.equal(r.verdict,'APPROVE');assert.equal(r.tip,tip);const declared=JSON.parse(fs.readFileSync(proj+'/seats/seats.json','utf8')).seats.reviewer.account.dir;assert.equal(r.reviewerDir,fs.realpathSync(declared.replace(/^~/,home)));assert.equal(r.reviewerSeat,'reviewer');assert.equal(r.bead,approved.bead);assert(r.at);});
for(const [label,verdict,code] of [['bounce','BOUNCE',2],['discover','DISCOVER',3]] as const)leg('review reader '+verdict,()=>{const r=cli(label,verdict);assert.equal(r.status,code,r.stderr);assert.equal(api.readReviewRecord(proj,r.bead)?.verdict,verdict);});
leg('review reader malformed and refused output null',()=>{const file=proj+'/malformed.stream';fs.writeFileSync(file,JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'VERDICT: APPROVE\nVERDICT: BOUNCE\nPUSH: NOT CONSIDERED'}]}})+'\n');const r=cli('malformed','APPROVE',[],{STUB_STREAM_FILE:file,STUB_SWEEP_PROMPT_CHECK:'0'});assert.equal(r.status,1);assert.equal(api.readReviewRecord(proj,r.bead),null);});
leg('review reader failed APPROVE floor null',()=>{const r=cli('floor','APPROVE',['--evidence','evidence/missing.png']);assert.equal(r.status,1);assert.equal(api.readReviewRecord(proj,r.bead),null);});
leg('review reader completed no-verdict null',()=>{const file=proj+'/no-verdict.stream';fs.writeFileSync(file,JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'I have not delivered a judgment.'}]}})+'\n'+JSON.stringify({type:'agent_end',willRetry:false,messages:[]})+'\n');const r=cli('no-verdict','APPROVE',[],{STUB_STREAM_FILE:file,STUB_SWEEP_PROMPT_CHECK:'0'});assert.equal(r.status,5,r.stderr);assert.equal(api.readReviewRecord(proj,r.bead),null);});
leg('review reader branch move keeps pinned tip',()=>{const r=cli('moved','APPROVE — at pinned tip __PINNED__; branch has since moved to __MOVED__ (1 commits appended, history unrewritten)',[],{STUB_MOVE_BRANCH_REPO:proj,STUB_MOVE_BRANCH:'fleet/bead-1',STUB_SWEEP_PROMPT_CHECK:'0'});assert.equal(r.status,0,r.stderr);const moved=completedCommand('git',['rev-parse','fleet/bead-1'],{cwd:proj});assert.equal(moved.status,0);assert.notEqual(moved.stdout.trim(),tip);const parsed=api.readReviewRecord(proj,r.bead);assert.equal(parsed.tip,tip);assert.equal(parsed.verdict,'APPROVE');assert(r.text?.includes('branch has since moved'));});
const dir=proj+'/seats/verdicts';function generated(bead:string,text:string){fs.writeFileSync(dir+'/'+bead+'.md',text);return api.readReviewRecord(proj,bead);}
leg('review reader annotated APPROVE and both seat labels',()=>{for(const annotation of ['APPROVE — NOT BENCHED: fixture surface','APPROVE — at pinned tip '+tip+'; branch has since moved to '+ 'f'.repeat(40)]){const bead='record-annotated-'+(++i);const text=reviewFixture(approved.text!,bead,{'verdict':annotation});assert.equal(generated(bead,text)?.verdict,'APPROVE');const renamed='record-renamed-'+i;const next=reviewFixture(approved.text!,renamed,{'verdict':annotation}).replace('- verifier-seat:','- reviewer-seat:');assert.equal(generated(renamed,next)?.reviewerSeat,'reviewer');}});
leg('review reader only canonical header and completed file',()=>{
  const bead='record-header';const text=reviewFixture(approved.text!,bead);fs.writeFileSync(dir+'/'+bead+'.partial.md',text);fs.writeFileSync(dir+'/'+bead+'.interim.md',text);fs.writeFileSync(dir+'/'+bead+'.no-verdict.fixture.md',text);fs.writeFileSync(dir+'/'+bead+'.refused.json',JSON.stringify({stdout:text}));assert.equal(api.readReviewRecord(proj,bead),null);
  for(const field of ['tip','verdict','verifier-seat']){const malformed=text.replace(new RegExp('^- '+field+': .+\\n','m'),'');assert.equal(generated(bead,malformed),null,field+' absent from header cannot be supplied by later sections');}
  assert.equal(generated(bead,text.replace('# Verdict — bead '+bead,'# No-verdict — '+bead)),null);
  assert.equal(generated(bead,reviewFixture(approved.text!,bead,{'verdict':'REFUSED'})),null);
});
save('results',{legs,tip,sourceSha256:createHash('sha256').update(fs.readFileSync(source)).digest('hex')});if(legs.some(x=>x.error))process.exitCode=1;
