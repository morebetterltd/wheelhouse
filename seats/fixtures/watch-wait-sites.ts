// Unit probes of the COMMITTED call expressions, not copies of their predicates.
// Native suite coverage separately exercises their lifecycle/protocol owners.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import conditionWait from './wait-for-condition.cjs';

const [source, root, onlySite, onlyPhase] = process.argv.slice(2);
assert(fs.statSync(path.join(root,'.wheelhouse-selftest-fixture')).isFile());
const sites = [
  ['dead-seat-pipe.published','fixtures/dead-seat-pipe.ts','signal'],
  ['recover-dead-pipe.published','fixtures/recover-dead-pipe.ts','signal'],
  ['adapter-census.fileReady','fixtures/adapter-census.ts','signal'],
  ['adapter-rpc.fileSignal','fixtures/adapter-rpc.ts','signal'],
  ['adapter-state.barrier','fixtures/adapter-state.ts','signal'],
  ['adapter-state-peer.release','fixtures/adapter-state-peer.ts','release'],
  ['runtime-copy-source.ready','fixtures/runtime-copy-source.ts','signal'],
  ['adapter.stub.held','adapter.selftest.sh','release'],
  ['concurrency.stub.release','concurrency.selftest.sh','release'],
  ['concurrency.stub.unqueue','concurrency.selftest.sh','bead-a.finished'],
  ['concurrency-regression.serialized','fixtures/concurrency-barrier-regression.mjs','bead-a.finished'],
];
function calls(text:string):string[] {
  const result:string[]=[];
  for(const match of text.matchAll(/\bwaitForCondition\s*\(/g)) {
    const start=match.index!, opening=start+match[0].length-1;
    let depth=1,quote='',escape=false,end=opening+1;
    for(;end<text.length;end++) {
      const ch=text[end];
      if(quote){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch===quote)quote='';continue;}
      if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
      if(ch==='(')depth++;else if(ch===')'&&!--depth){end++;break;}
    }
    assert.equal(depth,0,'unclosed source call; source probe setup failed');
    result.push(text.slice(start,end));
  }
  return result;
}
process.env.WHEELHOUSE_CONDITION_DROP_WATCH='1';
const records:any[]=[];
assert(!onlySite||sites.some(([site])=>site===onlySite),'unknown site selector');
for(const [site,file,inputName] of sites.filter(([site])=>!onlySite||site===onlySite)) {
  const text=fs.readFileSync(path.join(source,file),'utf8');
  const matches=calls(text).filter(call=>new RegExp("site\\s*:\\s*['\"]"+site.replaceAll('.','\\.')+"['\"]").test(call));
  assert.equal(matches.length,1,`${site}: source call must exist exactly once`);
  for(const phase of ['already-held','after-initial-false'].filter(phase=>!onlyPhase||phase===onlyPhase)) {
    const dir=path.join(root,site+'-'+phase);fs.mkdirSync(dir);
    const input=path.join(dir,inputName),marker=path.join(dir,'marker');
    fs.writeFileSync(marker,'owned test marker\n');
    if(phase==='already-held')fs.writeFileSync(input,'owned publication\n');
    const initiallyHeld=fs.existsSync(input);assert.equal(initiallyHeld,phase==='already-held');
    if(initiallyHeld)assert.equal(fs.readFileSync(input,'utf8'),'owned publication\n');
    // Callback counters are unit seams, not manufactured RPC ACKs, sessions,
    // native command results or lifecycle records. All filesystem conditions
    // below are real; owner semantics remain covered by the native suites.
    const factory=new Function('waitForCondition','fs','path','dir','input','marker','site',`
      const file=input,name='signal',ready=site==='adapter-rpc.fileSignal'?()=>fs.existsSync(input)&&fs.readFileSync(input,'utf8')==='owned publication\\n':input;
      const release=input,barrier=dir,agentDir=dir;
      let queued=true,held=false,callbacks=0;
      const done=()=>callbacks++,finish=()=>callbacks++,start=()=>callbacks++,out=()=>callbacks++;
      return {observer:${matches[0]},callbacks:()=>callbacks};
    `);
    const {observer,callbacks}=factory(conditionWait.waitForCondition,fs,path,dir,input,marker,site);
    let resolved=false,observationError:unknown;observer.promise.then(()=>{resolved=true;},error=>{observationError=error;});
    try {
      if(phase==='after-initial-false') {
        assert(!fs.existsSync(input));await Promise.resolve();assert.equal(resolved,false);
        fs.writeFileSync(input,'owned publication\n');
        assert.equal(fs.readFileSync(input,'utf8'),'owned publication\n');
      }
      const setup={site,phase,file,initiallyHeld,sourceSha256:crypto.createHash('sha256').update(text).digest('hex'),
        call:matches[0],inputWasPublished:true,watchSuppressed:true};
      fs.writeFileSync(path.join(dir,'setup.json'),JSON.stringify(setup,null,2)+'\n');
      // Explicitly re-run the SAME registered predicate. No elapsed threshold
      // decides this assertion; the periodic backend is tested under Node/Bun.
      conditionWait.reconcileConditions();await Promise.resolve();
      assert.equal(observationError,undefined,`${site}: predicate/setup failure: ${observationError}`);
      assert(resolved,`${site}: actual held condition did not resolve with dropped watch notifications (${phase})`);
      const needsCallback=/^(?:adapter\.stub|concurrency\.stub|concurrency-regression)/.test(site);
      assert.equal(callbacks(),needsCallback?1:0,`${site}: source callback count`);
      const record={...setup,resolved,callbacks:callbacks()};records.push(record);
      fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(record,null,2)+'\n');
      console.log(`PASS source site ${site} ${phase}: actual condition resolved with watch callbacks suppressed`);
    } finally {observer.cancel();}
  }
}
assert(records.length>0,'no source subjects exercised');
fs.writeFileSync(path.join(root,'sites.json'),JSON.stringify(records,null,2)+'\n');
