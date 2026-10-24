// Real isolated desk starts, a separate native polling reader, and owner-held
// create/partial-write gaps. A missing file is allowed; malformed bytes aren't.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const [fixture, template] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, '.wheelhouse-selftest-fixture')).isFile());
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return ''; throw e; } };
const jsonLines = (p: string) => { const s = read(p); return s.slice(0, s.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse); };
function actor(exe: string, args: string[], dir: string, name: string, env = process.env) {
  const files = ['out', 'err'].map(x => path.join(dir, name + '.' + x)), fds = files.map(x => fs.openSync(x, 'wx', 0o600));
  const child = spawn(exe, args, { cwd: dir, env, stdio: ['pipe', fds[0], fds[1]] });
  child.stdin!.on('error', e => { if ((e as any).code !== 'EPIPE') console.error('INCOMPLETE stdin: ' + e); });
  const state: any = { pid: child.pid, closed: false, code: null, signal: null, error: null };
  const done = new Promise<void>(resolve => { child.on('error', e => { state.error = String(e); }); child.on('close', (code, signal) => { Object.assign(state, { closed: true, code, signal }); fds.forEach(fd => fs.closeSync(fd)); resolve(); }); });
  return { child, state, done, files, stdout: () => read(files[0]), stderr: () => read(files[1]) };
}
async function until(label: string, test: () => any, children: ReturnType<typeof actor>[]) {
  let last = '';
  for (;;) {
    const value = test(); if (value) return value;
    const observed = JSON.stringify({ label, children: children.map(x => ({ ...x.state, stdout: x.stdout(), stderr: x.stderr() })), containment: 'canonical suite resource bound (default3600s), not readiness time' });
    if (last !== observed) { console.error('DESK_PORT_WAIT ' + observed); last = observed; }
    if (children.some(x => x.state.closed)) throw Error('INCOMPLETE actor exited before ' + label + ': ' + observed);
    await Bun.sleep(25); // Observation spacing, never a completion verdict.
  }
}
const original = fs.readFileSync(path.join(template, 'seats/desk.ts'), 'utf8');
const writeAnchor = 'fs.writeFileSync(temp, value, { flag: "wx", mode: 0o600 });';
const renameAnchor = 'fs.renameSync(temp, PORT_FILE);';
assert.equal(original.split(writeAnchor).length, 2); assert.equal(original.split(renameAnchor).length, 2);
for (const broken of [false, true]) {
  const root = path.join(fixture, broken ? 'port-direct' : 'port-atomic'), seats = path.join(root, 'seats'), run = path.join(seats, 'run');
  fs.mkdirSync(root); fs.cpSync(path.join(template, 'seats'), seats, { recursive: true }); fs.rmSync(run, { recursive: true, force: true }); fs.mkdirSync(run);
  fs.mkdirSync(path.join(root, 'bin')); fs.writeFileSync(path.join(root, 'bin/bd'), '#!/usr/bin/env bash\nprintf "[]\\n"\n', { mode: 0o755 });
  let source = original.replace(writeAnchor, `const target = ${broken ? 'PORT_FILE' : 'temp'};
    const fd = fs.openSync(target, "w", 0o600), bytes = Buffer.from(value), half = Math.floor(bytes.length / 2);
    const phase = (step: string) => { const file=path.join(RUN,"publication.phase"); fs.writeFileSync(file+".pending",JSON.stringify({step,value,target,pid:process.pid})); fs.renameSync(file+".pending",file); };
    phase("created"); fs.readSync(0,Buffer.alloc(1),0,1,null);
    fs.writeSync(fd,bytes,0,half); phase("partial"); fs.readSync(0,Buffer.alloc(1),0,1,null);
    fs.writeSync(fd,bytes,half,bytes.length-half); fs.closeSync(fd);`);
  if (broken) source = source.replace(renameAnchor, '// planted direct write: no rename');
  fs.writeFileSync(path.join(seats, 'desk.ts'), source);
  const result: any = { broken, sourceSha256: sha(original), executedSha256: sha(source), rounds: [], failure: null };
  const reader = actor('node', [path.join(template, 'seats/fixtures/desk-port-reader.mjs'), path.join(run, 'desk.port')], root, 'reader');
  let active: ReturnType<typeof actor> | undefined;
  async function sample(id: string) {
    if (reader.state.closed) return { closed: true, ...reader.state };
    reader.child.stdin!.write(JSON.stringify({ type: 'sample', id }) + '\n');
    return await until('native reader sample ' + id, () => jsonLines(reader.files[0]).find(x => x.id === id) || (reader.state.closed ? { closed: true, ...reader.state } : null), []);
  }
  try {
    const first = await sample('before-start'); assert(first.reads > 0 && first.missing > 0, 'native reader actually ran before first publication');
    let previous: string | null = null;
    for (let round = 0; round < (broken ? 1 : 8); round++) {
      fs.rmSync(path.join(run, 'publication.phase'), { force: true });
      active = actor(process.execPath, [path.join(seats, 'desk.ts')], root, 'desk-' + round, { ...process.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH, WHEELHOUSE_DESK_ROOT: root, WHEELHOUSE_NEEDS_ROOT: root, WHEELHOUSE_DESK_PORT: '0' });
      const phase = async (step: string) => await until('real publisher ' + step, () => { const text = read(path.join(run, 'publication.phase')); if (!text) return null; const x = JSON.parse(text); return x.step === step ? x : null; }, [active!]);
      const created = await phase('created'), atCreate = await sample('created-' + round);
      const heldBytes = fs.existsSync(path.join(run, 'desk.port')) ? fs.readFileSync(path.join(run, 'desk.port'), 'utf8') : null;
      if (!broken) { assert.equal(heldBytes, previous, 'unpublished create must leave missing/previous complete URL'); assert(!atCreate.closed, 'native reader must reject no atomic publication'); }
      else {
        await until('native reader rejects exposed empty file', () => reader.state.closed, []);
        assert.equal(reader.state.code, 1, 'planted direct-write reader native failure');
        assert(reader.stderr().includes('FAIL DESK_PORT_PARTIAL '), 'only malformed-byte rejection gets credit'); assert.equal(heldBytes, '', 'planted gap really exposes an empty public file');
      }
      active.child.stdin!.write('A'); const partial = await phase('partial'), atPartial = await sample('partial-' + round);
      const partialPublic = fs.existsSync(path.join(run, 'desk.port')) ? fs.readFileSync(path.join(run, 'desk.port'), 'utf8') : null;
      if (!broken) { assert.equal(partialPublic, previous, 'partial private temp must not replace public URL'); assert(!atPartial.closed); }
      else assert(partialPublic && partialPublic !== partial.value && !partialPublic.endsWith('\n'), 'held direct partial bytes really observable');
      active.child.stdin!.write('B');
      await until('actual desk publication announcement', () => active!.stdout().includes('desk started: '), [active]);
      const published = read(path.join(run, 'desk.port'));
      assert.equal(published, partial.value, 'complete published record after release');
      const response = await fetch(published.trim()); const body = await response.text(); assert.equal(response.status, 200); assert(body.includes('Wheelhouse desk'), 'real isolated listener serves its desk after both release gates');
      const after = await sample('published-' + round);
      if (!broken) { assert.equal(after.last, published); assert(after.valid > 0); }
      result.rounds.push({ round, previous, created, atCreate, heldBytes, partial, atPartial, partialPublic, published, after, httpStatus: response.status, livePublisher: { ...active.state } }); previous = published;
      active.child.kill('SIGTERM'); await active.done; result.rounds.at(-1).nativeClose = { ...active.state }; active = undefined;
      assert.equal(fs.readdirSync(run).filter(x => x.endsWith('.tmp')).length, 0, 'publisher removes private temps');
    }
    if (!broken) { reader.child.stdin!.write('{"type":"stop","id":"stop"}\n'); await reader.done; assert.equal(reader.state.code, 0); }
    assert.equal(reader.state.code, broken ? 1 : 0); result.assertionRejected = broken;
  } catch (error: any) {
    result.failure = { kind: error instanceof assert.AssertionError ? 'behavior' : 'incomplete', message: String(error.stack || error) };
    result.beforeCleanup = { phase: read(path.join(run, 'publication.phase')), public: read(path.join(run, 'desk.port')), reader: { ...reader.state }, readerOut: reader.stdout(), readerErr: reader.stderr(), publisher: active ? { ...active.state, stdout: active.stdout(), stderr: active.stderr() } : null };
    throw error;
  } finally {
    if (active && !active.state.closed) { active.child.stdin!.write('AB'); active.child.kill('SIGTERM'); await active.done; }
    if (!reader.state.closed) { reader.child.stdin!.write('{"type":"stop","id":"cleanup"}\n'); await reader.done; }
    result.reader = { ...reader.state, stdout: reader.stdout(), stderr: reader.stderr() };
    console.log('DESK_PORT_RESULT ' + JSON.stringify(result));
    if (process.env.WHEELHOUSE_DESK_PORT_EVIDENCE) { fs.mkdirSync(process.env.WHEELHOUSE_DESK_PORT_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.WHEELHOUSE_DESK_PORT_EVIDENCE, broken ? 'direct.json' : 'atomic.json'), JSON.stringify(result, null, 2)); }
  }
}
console.log('desk-port: 8 atomic real starts with native polling; held empty/partial direct-write control rejected');
