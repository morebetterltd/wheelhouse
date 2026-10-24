// Exercise the real default source resolver, not a second full adapter run.
// Success is native completion + complete bytes, never a throughput SLA.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
const [seats, fixture] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, '.wheelhouse-selftest-fixture')).isFile());
const cwd = path.join(fixture, 'unrelated-cwd');
fs.mkdirSync(cwd);
assert(!fs.existsSync(path.join(cwd, 'seats')));
function inventory(root: string, relative = ''): string[] {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const file = path.join(relative, name), stat = fs.lstatSync(path.join(root, file));
    return stat.isDirectory() ? inventory(root, file) : [file];
  });
}
const expected = fs.readdirSync(seats).filter(name => /\.(ts|sh)$/.test(name) && !name.endsWith('.selftest.sh') && fs.statSync(path.join(seats, name)).isFile());
for (const dir of ['drivers', 'transports']) if (fs.existsSync(path.join(seats, dir))) expected.push(...inventory(seats, dir));
expected.sort(); assert(expected.length > 0); assert(expected.includes('adapter.ts'));
const copies = ['empty-cwd-copy', 'planted-cwd-copy'];
function copiedSoFar() {
  return copies.map(name => {
    const root = path.join(fixture, name, 'seats');
    try { fs.lstatSync(root); }
    catch(error:any) { return error.code==='ENOENT' ? {name,state:'not created'} : {name,state:'unverified',error:String(error)}; }
    try { const files=inventory(root); return {name, state:'observed', count:files.length, files}; }
    catch(error) { return {name, state:'unverified', error:String(error)}; }
  });
}
// A delayed native input always crosses the retired5s rule. It is not a pass
// threshold: scheduling it later only holds the producer longer.
const gate = path.join(fixture, 'copy.release'), ready = path.join(fixture, 'copy.ready');
const fifo = spawnSync('mkfifo', [gate], {encoding:'utf8'}); assert.equal(fifo.status,0, fifo.stderr);
const gateFd = fs.openSync(gate, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
const outFile=path.join(fixture,'runtime-source.stdout'),errFile=path.join(fixture,'runtime-source.stderr');
const outFd=fs.openSync(outFile,'wx',0o600),errFd=fs.openSync(errFile,'wx',0o600);
const started = performance.now();
const child = spawn('bash', ['-c', String.raw`
set -eu
. "$1/selftest-lib.sh"
cd "$2"
[ ! -e seats ]
printf 'ready\n' > "$3/copy.ready"
IFS= read -r release < "$4"
[ "$release" = runtime-copy-release ]
printf 'input released\n'
rc=0; git rev-parse --show-toplevel > "$3/discovery.out" 2> "$3/discovery.err" || rc=$?
[ "$rc" = 128 ] || exit 2
[ ! -s "$3/discovery.out" ] || exit 2
selftest_copy_seat_runtime "$3/empty-cwd-copy"
mkdir seats
printf 'caller-owned sentinel\n' > seats/caller-only.ts
selftest_copy_seat_runtime "$3/planted-cwd-copy"
`, 'runtime-source', seats, cwd, fixture, gate], {cwd:fixture,detached:true,stdio:['ignore',outFd,errFd]});
let ended=false, inputReleased=false, containment: string | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
const completion = new Promise<{status:number|null,signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>ended=true);child.once('close',(status,signal)=>resolve({status,signal}));});
const stop = (reason: string) => {
  if(ended||containment)return;
  containment=reason;
  console.error('INCOMPLETE runtime-copy containment: '+JSON.stringify({reason,expected:expected.length,copiedSoFar:copiedSoFar()}));
  try { process.kill(-child.pid!,'SIGTERM'); } catch(error:any) { if(error.code!=='ESRCH')throw error; }
};
// Resource containment only, not correctness on elapsed time. The admitted
// suite also retains its normal3600s outer cohort containment.
const containmentMs = 30 * 60 * 1000;
const outer = setTimeout(()=>stop(`named runtime-copy outer bound ${containmentMs}ms`),containmentMs);
const cancellations = (['SIGTERM','SIGINT','SIGHUP','SIGQUIT'] as const).map(signal=>({signal,handler:()=>stop('outer supervisor '+signal)}));
for(const {signal,handler} of cancellations)process.on(signal,handler);
const watcher=fs.watch(fixture,()=>{if(fs.existsSync(ready))release();});
function release(){
  if(releaseTimer||ended)return;
  releaseTimer=setTimeout(()=>{if(!ended){fs.writeSync(gateFd,'runtime-copy-release\n');inputReleased=true;}},6000);
}
if(fs.existsSync(ready))release();
let result: {status:number|null,signal:NodeJS.Signals|null};
try { result=await completion; }
finally { clearTimeout(outer);if(releaseTimer)clearTimeout(releaseTimer);watcher.close();for(const {signal,handler} of cancellations)process.off(signal,handler);fs.closeSync(gateFd);fs.closeSync(outFd);fs.closeSync(errFd); }
const stdout=fs.readFileSync(outFile,'utf8'),stderr=fs.readFileSync(errFile,'utf8');
console.log('CAPTURE runtime source '+JSON.stringify({...result,stdout,stderr,inputReleased,containment:containment??null,copiedSoFar:copiedSoFar()}));
assert.equal(containment,undefined,'runtime-copy resource containment is INCOMPLETE, not proof of incorrect bytes');
assert.equal(result.signal,null);assert.equal(result.status,0);assert(inputReleased&&stdout.includes('input released'),'real delayed input must be released before a pass');
for (const name of copies) {
  const copied = path.join(fixture, name, 'seats');
  assert.deepEqual(inventory(copied), expected, name + ': complete runtime inventory');
  for (const file of expected) assert.deepEqual(fs.readFileSync(path.join(copied, file)), fs.readFileSync(path.join(seats, file)), file + ': exact bytes');
  assert(!fs.existsSync(path.join(copied, 'caller-only.ts')), name + ': caller sentinel never copied');
}
assert.equal(fs.readFileSync(path.join(cwd, 'seats/caller-only.ts'), 'utf8'), 'caller-owned sentinel\n');
console.log(`runtime source independence: PASS (empty and planted cwd; ${expected.length} exact runtime files each; native completion after delayed input; elapsed=${(performance.now()-started).toFixed(1)}ms is diagnostic only)`);
