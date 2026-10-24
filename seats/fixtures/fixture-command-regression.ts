// Compatibility assertions over real completed native commands, not fake CLI rows.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';
const require = createRequire(import.meta.url);
const root = process.argv[2];
assert(fs.statSync(root).isDirectory());
const moduleFile = path.join(import.meta.dir, 'fixture-command.cjs');
const source = fs.readFileSync(moduleFile, 'utf8'), adapter = require(moduleFile);
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
// Capture the native ps schema before using its bytes as large-output input.
const ps = completedCommand('ps', ['-p', String(process.pid), '-o', 'pid=,ppid=,uid=,command='], { encoding: null });
fs.writeFileSync(path.join(root, 'ps.stdout'), ps.stdout); fs.writeFileSync(path.join(root, 'ps.stderr'), ps.stderr);
console.log('CAPTURE fixture-command ps ' + JSON.stringify({ status: ps.status, signal: ps.signal, stdout: ps.stdout.toString(), stderr: ps.stderr.toString() }));
assert.equal(ps.status, 0); assert(!ps.error && !ps.signal); assert(ps.stdout.length > 0); assert.equal(ps.stderr.length, 0);
const payload = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), ps.stdout]);
const large = Buffer.alloc(2 * 1024 * 1024 + 73);
for (let at = 0; at < large.length; at += payload.length) payload.copy(large, at, 0, Math.min(payload.length, large.length - at));
const out = path.join(root, 'output'), err = path.join(root, 'error'), script = path.join(root, 'emit.sh');
fs.writeFileSync(out, large); fs.writeFileSync(err, payload);
fs.writeFileSync(script, 'cat "$1"\ncat "$2" >&2\nexit "$3"\n');
const args = (code: number) => [script, out, err, String(code)];
const refs: Record<string, any> = {};
for (const [name, file, argv, options] of [
  ['large', 'sh', args(0), {}], ['failure', 'sh', args(37), {}],
  ['signal', 'sh', ['-c', 'kill -TERM $$'], {}], ['missing', path.join(root, 'absent-command'), [], {}],
  ['stdin', 'cat', [], { input: Buffer.from('ff00fe', 'hex') }],
] as const) {
  if (name === 'missing') assert(!fs.existsSync(file));
  const r = completedCommand(file, [...argv], { ...options, encoding: null }); refs[name] = r;
  const native = { file, argv, status: r.status, signal: r.signal ?? null, error: r.error ? { code: r.error.code, message: r.error.message } : null, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length, stdoutSha256: hash(r.stdout), stderrSha256: hash(r.stderr) };
  fs.writeFileSync(path.join(root, name + '.native.json'), JSON.stringify(native, null, 2));
  fs.writeFileSync(path.join(root, name + '.stdout'), r.stdout); fs.writeFileSync(path.join(root, name + '.stderr'), r.stderr);
  console.log('CAPTURE fixture-command ' + JSON.stringify({ name, ...native }));
}
assert.equal(refs.large.status, 0); assert(refs.large.stdout.equals(large)); assert(refs.large.stderr.equals(payload));
assert.equal(refs.failure.status, 37); assert.equal(refs.signal.signal, 'SIGTERM'); assert.equal(refs.missing.error?.code, 'ENOENT');
const guard = 'if (result.error || result.signal || result.status !== 0) {';
const cases = [
  { name: 'default-buffer-large-complete', old: 'const stdout = output(result.stdout), stderr = output(result.stderr);', next: 'const stdout = String(output(result.stdout)), stderr = output(result.stderr);', check(m: any) { const b = m.execFileSync('sh', args(0)); assert(Buffer.isBuffer(b), 'omitted encoding returns Buffer'); assert(b.equals(large), 'large native output is complete'); } },
  { name: 'explicit-text', old: "const output = value => encoding && encoding !== 'buffer' ? value.toString(encoding) : value;", next: 'const output = value => value;', check(m: any) { const s = m.execFileSync('sh', args(0), { encoding: 'latin1' }); assert.equal(typeof s, 'string', 'explicit encoding returns text'); assert.equal(s, large.toString('latin1')); } },
  { name: 'string-stdin-encoding', old: "if (typeof rest.input === 'string' && encoding && encoding !== 'buffer') rest.input = Buffer.from(rest.input, encoding);", next: 'void 0;', check(m: any) { assert.equal(m.execFileSync('cat', [], { input: 'ff00fe', encoding: 'hex' }), refs.stdin.stdout.toString('hex'), 'caller encoding applies to string stdin'); } },
  ...['failure', 'signal', 'missing'].map(name => ({ name: 'throw-' + name, old: guard, next: 'if (false) {', check(m: any) { const ref = refs[name]; let caught: any; try { m.execFileSync(name === 'failure' ? 'sh' : name === 'signal' ? 'sh' : path.join(root, 'absent-command'), name === 'failure' ? args(37) : name === 'signal' ? ['-c', 'kill -TERM $$'] : []); } catch (e) { caught = e; } assert(caught, 'native ' + name + ' must throw, never empty success'); assert.equal(caught.status, ref.status); assert.equal(caught.signal ?? null, ref.signal ?? null); assert(caught.stdout.equals(ref.stdout)); assert(caught.stderr.equals(ref.stderr)); if (name === 'missing') assert.equal(caught.code, 'ENOENT'); } })),
  { name: 'explicit-byte-refusal-retains-output', old: guard, next: 'if (result.signal || result.status !== 0) {', check(m: any) { let caught: any; try { m.execFileSync('sh', args(0), { maxBuffer: 8 }); } catch (e) { caught = e; } assert(caught, 'explicit byte refusal must throw'); assert.equal(caught.code, 'ENOBUFS'); assert.equal(caught.status, 0, 'refusal must not invent native failure'); assert(caught.stdout.equals(large), 'refusal retains all stdout'); assert(caught.stderr.equals(payload)); } },
  { name: 'nonthrow-native-status-and-channels', old: 'return { ...result, stdout, stderr, output: [null, stdout, stderr] };', next: 'return { ...result, status: 0, stdout, stderr, output: [null, stdout, stderr] };', check(m: any) { const r = m.spawnSync('sh', args(37)); assert.equal(r.status, 37, 'intentional failure inspection preserves status'); assert(r.stdout.equals(refs.failure.stdout)); assert(r.stderr.equals(refs.failure.stderr)); } },
];
for (const c of cases) {
  console.log('AMBIENT fixture-command '+JSON.stringify({case:c.name,at:new Date().toISOString(),nice:os.getPriority(0),cores:os.cpus().length,load:os.loadavg(),platform:process.platform,bun:Bun.version}));
  c.check(adapter); console.log('PASS fixture-command ' + c.name);
  assert.equal(source.split(c.old).length, 2, 'unique removal anchor: ' + c.name);
  // Relocate only the dependency import; the helper and its source stay intact.
  const mutated = source.replace(c.old, c.next).replace("require('../completed-command.ts')", 'require(' + JSON.stringify(path.resolve(import.meta.dir, '../completed-command.ts')) + ')');
  const file = path.join(root, c.name + '.cjs'); fs.writeFileSync(file, mutated);
  assert.throws(() => c.check(require(file)), assert.AssertionError, 'removal must reach its intended compatibility assertion');
  console.log('REJECT fixture-command ' + c.name + ': intended assertion after real native setup');
}
// Capture the REAL Node default-pipe overflow before constructing its replay.
// Only this evidence probe uses native pipe capture; the adapter never does.
const entered=path.join(root,'truncation-entered'),meta=path.join(root,'truncation.json'),truncOut=path.join(root,'truncation.stdout'),truncErr=path.join(root,'truncation.stderr');
const childProgram=`const fs=require('fs');fs.writeFileSync(process.argv[2],'entered\\n');fs.writeSync(2,'native truncation stderr\\n');fs.writeFileSync(1,fs.readFileSync(process.argv[1]));`;
const probeProgram=`const fs=require('fs'),cp=require('child_process');const r=cp.spawnSync(process.execPath,['-e',${JSON.stringify(childProgram)},process.argv[1],process.argv[2]]);fs.writeFileSync(process.argv[3],r.stdout);fs.writeFileSync(process.argv[4],r.stderr);fs.writeFileSync(process.argv[5],JSON.stringify({status:r.status,signal:r.signal,pid:r.pid,error:r.error?{code:r.error.code,message:r.error.message}:null,stdoutBytes:r.stdout.length,stderrBytes:r.stderr.length}));`;
const probe=completedCommand('node',['-e',probeProgram,out,entered,truncOut,truncErr,meta]);
assert.equal(probe.status,0,probe.stderr);assert(!probe.error&&!probe.signal);assert.equal(fs.readFileSync(entered,'utf8'),'entered\n','real overflowing child reached its payload');
const captured=JSON.parse(fs.readFileSync(meta,'utf8'));console.log('CAPTURE native default pipe overflow '+JSON.stringify(captured));assert.equal(captured.error?.code,'ENOBUFS');assert(captured.stdoutBytes<large.length);assert(captured.stderrBytes>0);
const replay=`const fs=require('node:fs');const completedCommand=()=>{const r=JSON.parse(fs.readFileSync(${JSON.stringify(meta)},'utf8'));return {...r,error:Object.assign(new Error(r.error.message),r.error),stdout:fs.readFileSync(${JSON.stringify(truncOut)}),stderr:fs.readFileSync(${JSON.stringify(truncErr)})};};`;
const replaySource=source.replace("const { completedCommand } = require('../completed-command.ts');",replay);assert.notEqual(replaySource,source);
const replayFile=path.join(root,'native-truncation-replay.cjs');fs.writeFileSync(replayFile,replaySource);
const rejectTruncated=(m:any)=>{let caught:any;try{m.execFileSync('recorded-native-overflow',[]);}catch(e){caught=e;}assert(caught,'captured native truncation must throw, not return partial/empty success');assert.equal(caught.code,'ENOBUFS');assert.equal(caught.status,captured.status);assert.equal(caught.signal,captured.signal);assert(caught.stdout.equals(fs.readFileSync(truncOut)));assert(caught.stderr.equals(fs.readFileSync(truncErr)));};
rejectTruncated(require(replayFile));console.log('PASS fixture-command captured-native-truncation');
const removed=path.join(root,'native-truncation-removed.cjs');fs.writeFileSync(removed,replaySource.replace(guard,'if (false) {'));
assert.throws(()=>rejectTruncated(require(removed)),assert.AssertionError,'native truncation guard removal reaches its intended assertion');console.log('REJECT fixture-command captured-native-truncation: intended assertion after native overflow capture');
console.log(`fixture-command: PASS (${cases.length+1} compatibility cases, ${cases.length+1} meaningful removals)`);
