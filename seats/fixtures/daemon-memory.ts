// Natural footprint drift plus GC-normalized retained-memory checks of real cycles.
// CLI entrypoints alone are omitted in owned runtime copies; no installed daemon
// is imported, signalled or restarted. bd is an external-boundary fixture.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { heapStats } from 'bun:jsc';
import { resolveObjectURL } from 'node:buffer';
import { completedCommand } from '../completed-command';
import { withPerRefreshWorkers } from './desk-legacy-worker';
const [kind, seats, fixture, control = 'fixed'] = process.argv.slice(2);
assert(['herald','desk'].includes(kind));
assert((kind==='herald'?['fixed','no-log-prune','no-pane-trim','no-seen-reuse','no-seen-cap']:['fixed','per-refresh-workers','no-refresh-cap']).includes(control));
assert(fs.lstatSync(path.join(fixture,'.wheelhouse-selftest-fixture')).isFile());
const stub=process.env.WHEELHOUSE_MEMORY_BD_STUB;
assert(stub&&fs.lstatSync(stub).isFile(),'launch through daemon-memory.sh before Bun caches executable discovery');
assert(fs.realpathSync(stub).startsWith(fs.realpathSync(fixture)+path.sep));
assert.equal(Bun.which('bd'),stub,'bd must resolve to the startup-owned fixture stub');
const root = path.join(fixture, 'memory-' + kind + '-' + control);
assert(!fs.existsSync(root)); fs.mkdirSync(root);
for (const dir of ['seats/logs','seats/run','wheelhouse','bin']) fs.mkdirSync(path.join(root,dir),{recursive:true});
for (const file of fs.readdirSync(seats)) if(file.endsWith('.ts')) fs.copyFileSync(path.join(seats,file),path.join(root,'seats',file));
process.env.GIT_CEILING_DIRECTORIES = root + path.delimiter + fixture;
process.env.WHEELHOUSE_HERALD_ROOT = root;
process.env.WHEELHOUSE_DESK_ROOT = root;
process.env.WHEELHOUSE_NEEDS_ROOT = root;
// Disable the external herald clocks, not its scan/cursor/heartbeat functions.
process.env.WHEELHOUSE_ALERT_INTERVAL_MS = '1000000000000000';
process.env.WHEELHOUSE_STAFFING_INTERVAL_MS = '1000000000000000';
delete process.env.WHEELHOUSE_HERALD_MAX_SEEN;
fs.writeFileSync(path.join(root,'wheelhouse/.template-source'),'namespace=memoryfixture\n');
fs.writeFileSync(path.join(root,'seats/seats.json'),'{"seats":{}}\n');
// Exercise the exact async spawn boundary before importing either daemon.
const boundary=Bun.spawn({cmd:['bd','--memory-fixture-probe'],cwd:root,stdout:'pipe',stderr:'pipe'});
const [boundaryOut,boundaryErr,boundaryCode]=await Promise.all([new Response(boundary.stdout).text(),new Response(boundary.stderr).text(),boundary.exited]);
assert.equal(boundaryCode,0,boundaryErr);assert.equal(boundaryOut.trim(),'memory-fixture-bd');
assert(fs.statSync(process.env.WHEELHOUSE_MEMORY_BD_CALLS!).isFile(),'the owned stub must actually receive the subprocess');
const realDate = Date; let clock = Date.UTC(2026,0,1);
globalThis.Date = class extends realDate { constructor(...args:any[]){ if(args.length) super(...args as [any]); else super(clock); } static now(){ return clock; } } as DateConstructor;
let physical = () => process.memoryUsage().rss;
let metric = 'rss (non-Darwin fallback)';
if(process.platform === 'darwin') {
  // SDK sys/resource.h rusage_info_v2: 16-byte UUID, then u64 fields;
  // ri_phys_footprint is at byte 72, size 160. Includes compressed pages,
  // unlike RSS alone. Query only this process, never a production PID.
  const {dlopen,FFIType,ptr} = await import('bun:ffi');
  const lib = dlopen('/usr/lib/libproc.dylib',{proc_pid_rusage:{args:[FFIType.i32,FFIType.i32,FFIType.ptr],returns:FFIType.i32}});
  const buffer = Buffer.alloc(160);
  physical = () => { assert.equal(lib.symbols.proc_pid_rusage(process.pid,2,ptr(buffer)),0,'native self footprint unavailable'); const n=Number(buffer.readBigUInt64LE(72)); assert(n>0); return n; };
  metric = 'Darwin ri_phys_footprint (includes compressed pages)';
}
let peakRawFootprint=0,rawSamples=0;
function observeRaw(){const n=physical();peakRawFootprint=Math.max(peakRawFootprint,n);rawSamples++;return n;}
async function memory() { const rawFootprint=physical();await Bun.sleep(0); Bun.gc(true); await Bun.sleep(0); Bun.gc(true); const m=process.memoryUsage(), j=heapStats(); return {rawFootprint,footprint:physical(),rss:m.rss,heapUsed:m.heapUsed,jscHeap:j.heapSize}; }
const FOOTPRINT_LIMIT = 32*1024*1024, HEAP_LIMIT = 8*1024*1024;
const oracle = (ok:unknown, reason:string) => { if(!ok)fs.writeFileSync(path.join(root,'oracle-rejection.json'),JSON.stringify({kind,control,reason})+'\n'); assert(ok,'DAEMON_MEMORY_ORACLE: '+reason); };
function safety(){ if(physical()>256*1024*1024){Bun.gc(true);const footprint=physical();if(footprint>512*1024*1024){console.log('DAEMON_MEMORY_SAFETY '+JSON.stringify({kind,control,footprint,limit:512*1024*1024}));oracle(false,'probe exceeded its 512 MiB safety cap');}} }
const file = path.join(root,'seats',kind+'.ts'); let source=fs.readFileSync(file,'utf8');
function replace(old:string,next:string){ assert.equal(source.split(old).length,2,'fixture mutation anchor '+old); source=source.replace(old,next); }
function checkSeenHorizon(){
  const probe=path.join(root,'cap-probe.ts');fs.writeFileSync(probe,'const mod=await import(process.argv[2]); console.log(mod.MAX_SEEN);\n');
  for(const [value,expected] of [['0',5000],['0.5',5000],['-1',5000],['Infinity',5000],['bad',5000],['2',2],['2.9',2],['10000',10000]] as const){
    const r=completedCommand('bun',[probe,file],{env:{...process.env,WHEELHOUSE_HERALD_MAX_SEEN:value}});
    assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);
    oracle(Number(r.stdout.trim())===expected,'invalid seen horizon disabled its cap: '+value+' -> '+r.stdout.trim());
  }
  console.log('PASS herald seen horizon: zero/negative/infinite/invalid fall back; finite tiny horizon preserved');
}
let warm:any, end:any, facts:any;
if(kind==='herald') {
  if(control==='no-log-prune') replace('if (!present.has(rel)) { delete state.logs[rel]; stateDirty = true; }','if (false) { delete state.logs[rel]; stateDirty = true; }');
  if(control==='no-pane-trim') { const old='trimPaneHistory(state);'; assert.equal(source.split(old).length,3); source=source.replaceAll(old,'false;'); }
  if(control==='no-seen-reuse') replace('const seen = seenIds;','const seen = new Set(state.seen);');
  if(control==='no-seen-cap') replace('const MAX_SEEN = Number.isFinite(RAW_MAX_SEEN) && RAW_MAX_SEEN >= 1 ? Math.floor(RAW_MAX_SEEN) : 5000;','const MAX_SEEN = RAW_MAX_SEEN;');
  const entry='if (args.includes("--hook"))'; assert.equal(source.split(entry).length,2);
  source=source.slice(0,source.indexOf(entry))+'\nexport {scanOnce,readState,writeState,currentSeen,MAX_SEEN};\n';
  fs.writeFileSync(file,source);
  if(control==='no-seen-cap')checkSeenHorizon(); // fail its own component oracle before unrelated soak variation
  const ids=Array.from({length:5000},(_,i)=>'memory-seed-'+i);
  const inbox=ids.map(id=>JSON.stringify({id})).join('\n')+'\n'; fs.writeFileSync(path.join(root,'seats/inbox.jsonl'),inbox);
  // Existing inbox already poked: this avoids all real tmux activity. Streaming
  // deltas do not create wakes. Wake/drain correctness stays in the parent suite.
  fs.writeFileSync(path.join(root,'seats/herald.state.json'),JSON.stringify({logs:{},lastPokedInboxSize:Buffer.byteLength(inbox)}));
  fs.writeFileSync(path.join(root,'seats/run/herald.target.json'),JSON.stringify({target:'%current'}));
  const NativeSet=globalThis.Set; let seenTableCopies=0;
  globalThis.Set = class<T> extends NativeSet<T> { constructor(values?:Iterable<T>){ super(values); if(Array.isArray(values)&&values.length===5000&&values[0]==='memory-seed-0')seenTableCopies++; } } as SetConstructor;
  const h=await import(file);
  oracle(h.currentSeen.length===5000,'seeded horizon must exist before measuring');
  let active='', minute=0, polls=0, events=0;
  const delta=JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'x'.repeat(1600)}})+'\n';
  async function drive(ticks:number) {
    for(let i=0;i<ticks;i++) {
      clock+=1000;
      if(i%60===0){
        if(active)fs.unlinkSync(active); active=path.join(root,'seats/logs','retired-'+minute+'.jsonl'); fs.writeFileSync(active,'');
        h.scanOnce(); polls++; // cursorless adoption before the next minute's batch
        fs.appendFileSync(active,delta.repeat(60));events+=60;
        const state=h.readState(),pane='%retired-'+minute++;
        for(const field of ['lastPokedByPane','firstDeferredAtByPane','firstDeferredInboxSizeByPane'])state[field]={...(state[field]??{}),[pane]:field==='firstDeferredInboxSizeByPane'?1:clock};
        state.firstDeferredAtByPane['%current']=1;
        h.writeState(state);
      }
      h.scanOnce();polls++;
      if(i%512===0)await Bun.sleep(0);
      if(control==='no-seen-reuse'&&polls>=256)oracle(seenTableCopies===1,'seen table copies allocated on empty polls: '+seenTableCopies);
      if(i%3600===3599){if(warm)observeRaw();safety();}
    }
  }
  await drive(3600);warm=await memory();peakRawFootprint=warm.rawFootprint;rawSamples=1;
  await drive(control==='fixed'?86400:10800);end=await memory();
  const state=h.readState();assert(fs.statSync(active).isFile());
  const liveLogFiles=fs.readdirSync(path.join(root,'seats/logs')).filter(name=>name.endsWith('.jsonl')).length;
  facts={polls,events,liveLogFiles,retainedLogOffsets:Object.keys(state.logs).length,paneSizes:['lastPokedByPane','firstDeferredAtByPane','firstDeferredInboxSizeByPane'].map(f=>Object.keys(state[f]??{}).length),seenIds:h.currentSeen.length,seenTableCopies,currentPaneRetained:state.firstDeferredAtByPane['%current']===1};
  globalThis.Set=NativeSet;
} else {
  if(control==='per-refresh-workers')source=withPerRefreshWorkers(source);
  if(control==='no-refresh-cap') replace(' || digestRefreshing.size >= DIGEST_REFRESH_MAX','');
  const entry='const args=process.argv.slice(2);';assert.equal(source.split(entry).length,2);
  source=source.slice(0,source.indexOf(entry))+'\nexport {refreshBoard,digestWindow,digestFor,scheduleDigestRefresh,digestRefreshing,digestCache,bdCache,handle};\n';fs.writeFileSync(file,source);
  fs.writeFileSync(path.join(root,'seats/needs.jsonl'),JSON.stringify({type:'opened',id:'need-memory',at:new Date().toISOString(),kind:'question',title:'Memory fixture question',body:'Fixed input across cycles',options:[],machine:{}})+'\n');
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),NativeWorker=Worker,nativeSpawn=Bun.spawn.bind(Bun);
  let created=0,revoked=0,lastURL='',createdWorkers=0,createdProcesses=0,exitedProcesses=0,aliveProcesses=0,peakProcesses=0;
  URL.createObjectURL=(blob)=>{created++;return lastURL=create(blob);};URL.revokeObjectURL=(url)=>{revoked++;return revoke(url);};
  globalThis.Worker=class extends NativeWorker{constructor(...args:any[]){super(...args as [any,any]);createdWorkers++;}} as typeof Worker;
  Bun.spawn=((cmd:any,opts?:any)=>{const p=opts===undefined?nativeSpawn(cmd):nativeSpawn(cmd,opts);if(!Array.isArray(cmd)&&cmd.cmd?.[1]===path.join(root,'seats/digest.ts')){createdProcesses++;aliveProcesses++;peakProcesses=Math.max(peakProcesses,aliveProcesses);const done=()=>{exitedProcesses++;aliveProcesses--;};p.exited.then(done,done);}return p;}) as typeof Bun.spawn;
  const d=await import(file);
  // The set is filled synchronously, before zero-delay jobs start. A removed
  // admission cap is rejected here without launching a pressure-inducing burst.
  for(let i=0;i<32;i++) d.scheduleDigestRefresh(d.digestWindow(new URL('http://127.0.0.1/digest?hours='+(24+i))));
  const peakPending=d.digestRefreshing.size;
  oracle(peakPending<=2,'digest refresh admission is unbounded: '+peakPending);
  while(d.digestRefreshing.size)await Bun.sleep(1);
  oracle(d.digestCache.size===peakPending,'real digest jobs must complete successfully');
  let boardCycles=0,digestCycles=peakPending;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:(req)=>d.handle(req)});
  const base='http://127.0.0.1:'+server.port;
  try {
  async function drive(minutes:number) {
    for(let minute=0;minute<minutes;minute++) {
      for(let step=0;step<12;step++){clock+=5000;await d.refreshBoard();boardCycles++;}
      const query=minute%2?'?until='+encodeURIComponent(new Date().toISOString()):'';
      const url=base+'/api/digest.json'+query;
      const kickoff=await fetch(url);oracle(kickoff.status===200,'real digest HTTP kickoff');await kickoff.text();
      while(d.digestRefreshing.size)await Bun.sleep(1);digestCycles++;
      const response=await fetch(url),result=await response.json() as any;
      oracle(response.status===200&&result.blocked.some((row:any)=>row.title==='Memory fixture question'),'digest must contain real fixture data, not only an empty/error fallback');
      const needs=await fetch(base+'/needs');oracle(needs.status===200&&(await needs.text()).includes('Memory fixture question'),'needs still responds during the drive');
      if(minute%32===31){if(warm)observeRaw();safety();}
    }
  }
  await drive(control==='fixed'?48:2);warm=await memory();peakRawFootprint=warm.rawFootprint;rawSamples=1;await drive(control==='fixed'?1440:16);end=await memory();
  facts={boardCycles,digestCycles,peakPending,createdWorkers,createdProcesses,exitedProcesses,aliveProcesses,peakProcesses,httpRequests:(digestCycles-peakPending)*3,createdBlobURLs:created,revokedBlobURLs:revoked,unreleasedBlobURLs:created-revoked,lastBlobStillResolves:!!resolveObjectURL(lastURL),digestCache:d.digestCache.size,inFlight:d.digestRefreshing.size,bdCache:d.bdCache.size};
  } finally { server.stop(true); URL.createObjectURL=create;URL.revokeObjectURL=revoke;globalThis.Worker=NativeWorker;Bun.spawn=nativeSpawn; }
}
peakRawFootprint=Math.max(peakRawFootprint,end.rawFootprint);rawSamples++;
const result={kind,control,bdBoundaryVerified:true,bun:Bun.version,bunRevision:Bun.revision,platform:process.platform,arch:process.arch,metric,peakRawFootprint,rawSamples,rawFootprintGrowth:peakRawFootprint-warm.rawFootprint,equivalentHoursAfterWarmup:control==='fixed'?24:kind==='herald'?3:16/60,warm,end,footprintGrowth:end.footprint-warm.footprint,heapMetric:'bun:jsc heapStats().heapSize (main VM)',reportedHeapUsedGrowth:end.heapUsed-warm.heapUsed,heapGrowth:end.jscHeap-warm.jscHeap,thresholdBytes:{footprint:FOOTPRINT_LIMIT,heap:HEAP_LIMIT},facts};
console.log('DAEMON_MEMORY_RESULT '+JSON.stringify(result));
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
if(kind==='herald'){
  oracle(facts.retainedLogOffsets<=facts.liveLogFiles,'retired log offsets retained: '+facts.retainedLogOffsets);
  oracle(facts.paneSizes.every((n:number)=>n<=128)&&facts.currentPaneRetained,'pane histories are unbounded or lost the current deferred episode');
  oracle(facts.seenIds<=5000&&facts.seenTableCopies===1,'seen table copies allocated on empty polls: '+facts.seenTableCopies);
}else{
  oracle(facts.createdWorkers<=2,'per-refresh Worker runtime allocations exceed the lifetime budget: '+facts.createdWorkers);
  oracle(facts.createdProcesses===facts.exitedProcesses&&facts.aliveProcesses===0&&facts.peakProcesses<=2,'digest process lifetime/concurrency exceeds the budget');
  oracle(facts.unreleasedBlobURLs===0&&!facts.lastBlobStillResolves,'Blob URL registry retained completed worker sources');
  oracle(facts.digestCache<=16&&facts.inFlight===0&&facts.bdCache<=5,'desk caches/refreshes exceed their bounds');
}
oracle(result.rawFootprintGrowth<=FOOTPRINT_LIMIT,'natural physical footprint grew beyond 32 MiB after warm-up');
oracle(result.footprintGrowth<=FOOTPRINT_LIMIT,'retained physical footprint grew beyond 32 MiB after warm-up');
oracle(result.heapGrowth<=HEAP_LIMIT,'heap grew beyond 8 MiB after warm-up');
console.log('PASS '+kind+' retained memory: warm='+warm.footprint+' end='+end.footprint+' naturalPeak='+peakRawFootprint+' threshold='+FOOTPRINT_LIMIT+' bytes; '+result.equivalentHoursAfterWarmup+'h-equivalent');
if(kind==='herald' && control==='fixed')checkSeenHorizon();
if(control==='fixed'&&kind==='desk'){
  const lifetime=path.join(seats,'fixtures/desk-digest-lifetime.ts'),broken=path.join(root,'seats/desk-slot-retained.ts'),noGroup=path.join(root,'seats/desk-no-group.ts');
  const src=fs.readFileSync(file,'utf8'),release='digestRefreshing.delete(win.key);',group='process.kill(-child.pid, "SIGKILL")';assert.equal(src.split(release).length,2);assert.equal(src.split(group).length,2);
  fs.writeFileSync(broken,src.replace(release,'/* fix removed: refresh slot remains retained */'));
  fs.writeFileSync(noGroup,src.replace(group,'child.kill("SIGKILL")'));
  const cases=['spawn','error','malformed','read','timeout'].flatMap(mode=>[[mode,file,0],[mode,broken,1]] as const);cases.push(['timeout',noGroup,1]);
  for(const [mode,candidate,expected] of cases){
    const record=path.join(root,'lifetime-'+mode+'-'+path.basename(candidate)+'.json');
    const r=completedCommand('bun',[lifetime,candidate,mode,record]);assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,expected,r.stderr);
    assert(fs.statSync(record).isFile(),'fault probe must actually reach its measured cleanup');
    const measured=JSON.parse(fs.readFileSync(record,'utf8'));assert.equal(measured.mode,mode);assert.equal(measured.success,expected===0);
    console.log('DIGEST_LIFETIME '+JSON.stringify({candidate:path.basename(candidate),nativeCode:r.status,...measured}));
    console.log((expected?'EXPECTED_REJECTION ':'PASS ')+'desk digest '+mode+' native_rc='+r.status+(expected?' cleanup removed':''));
  }
}
if(control==='fixed'){
  const controls=kind==='herald'?['no-log-prune','no-pane-trim','no-seen-reuse','no-seen-cap']:['per-refresh-workers','no-refresh-cap'];
  for(const change of controls){
    const r=completedCommand('bun',[import.meta.path,kind,seats,fixture,change]);
    assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,1,r.stderr);
    const record=path.join(fixture,'memory-'+kind+'-'+change,'oracle-rejection.json');
    assert(fs.statSync(record).isFile(),'control must reach the retention oracle, not fail fixture setup');
    const rejected=JSON.parse(fs.readFileSync(record,'utf8'));assert.equal(rejected.kind,kind);assert.equal(rejected.control,change);
    const reasons:Record<string,string>={'no-log-prune':'retired log offsets','no-pane-trim':'pane histories','no-seen-reuse':'seen table copies','no-seen-cap':'invalid seen horizon','per-refresh-workers':'per-refresh Worker runtime allocations','no-refresh-cap':'digest refresh admission'};
    assert(rejected.reason.startsWith(reasons[change]),'control must reject its own removed fix: '+rejected.reason);
    fs.writeFileSync(path.join(root,change+'.stdout'),r.stdout);fs.writeFileSync(path.join(root,change+'.stderr'),r.stderr);
    const stats=path.join(path.dirname(record),'result.json');
    console.log('REMOVAL_CONTROL '+JSON.stringify({kind,change,nativeCode:r.status,reason:rejected.reason,...(fs.existsSync(stats)?{facts:JSON.parse(fs.readFileSync(stats,'utf8')).facts}:{})}));
    console.log('EXPECTED_REJECTION '+kind+'/'+change+' native_rc=1 retention oracle failed with fix removed');
  }
}
