// Exercise the actual cockpit suite's EXIT traps, not a copied cleanup model.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';

const [source, fixture] = process.argv.slice(2);
assert(fs.statSync(fixture + '/.wheelhouse-selftest-fixture').isFile());
const realTmux = Bun.which('tmux'); assert(realTmux);
const modes = ['pass', 'fail', 'TERM', 'INT', 'HUP', 'preexisting'];
const selected = process.env.WHEELHOUSE_COCKPIT_CLEANUP_CASES?.split(',') ?? modes;
assert(selected.length && selected.every(x => modes.includes(x)));
const root = fixture + '/cockpit-cleanup'; fs.mkdirSync(root);
const sourceBytes = fs.readFileSync(source + '/seats/cockpit.selftest.sh');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
// Native pid output format was captured from real cockpit-attachment commands.
// This adapter preserves real tmux argv/results, then holds only the return of
// a successfully created client server until its owning test explicitly acts.
const wrapper = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),dir=process.env.COCKPIT_CLEANUP_OBSERVER,args=process.argv.slice(2);
// These global options precede the command in captured real tmux invocations.
// qjgw's short relative -S endpoints must not disappear behind an -L-only spy.
let at=0,socketName='';
while(at<args.length){
 if(args[at]==='-L'){socketName=args[at+1];at+=2;}
 else if(args[at]==='-S'){socketName=path.basename(args[at+1]);at+=2;}
 else if(args[at]==='-f')at+=2;
 else break;
}
const nativeCommand=args[at];
const out=dir+'/commands/'+process.pid+'.stdout',err=dir+'/commands/'+process.pid+'.stderr';
const fds=[fs.openSync(out,'wx'),fs.openSync(err,'wx')];
const r=cp.spawnSync(process.env.COCKPIT_CLEANUP_REAL_TMUX,args,{stdio:['inherit',...fds]});
for(const fd of fds)fs.closeSync(fd);
const data={args,cwd:process.cwd(),socketName,nativeCommand,code:r.status,signal:r.signal,error:r.error?String(r.error):null,stdout:fs.readFileSync(out,'utf8'),stderr:fs.readFileSync(err,'utf8')};
fs.writeFileSync(dir+'/commands/'+process.pid+'.json',JSON.stringify(data));
process.stdout.write(data.stdout);process.stderr.write(data.stderr);
function finish(){if(r.error||r.signal||r.status===null)process.exit(2);process.exit(r.status);}
if(/^wheelhouse-cockpit-selftest\.[0-9]+-client$/.test(socketName)&&nativeCommand==='new-session'&&r.status===0){
 const mark=dir+'/client-up.json',temp=mark+'.'+process.pid;
 fs.writeFileSync(temp,JSON.stringify({wrapperPid:process.pid,native:data}));fs.renameSync(temp,mark);
 const poll=setInterval(()=>{if(fs.existsSync(dir+'/release-client')){clearInterval(poll);if(process.env.COCKPIT_CLEANUP_ACTION==='fail'){process.stderr.write('fixture: client command failed AFTER real server creation\n');process.exit(23);}finish();}},25);
}else finish();
`;
function command(args: string[], cwd = root) {
  const r = completedCommand(args[0], args.slice(1), { cwd });
  const row = { args, cwd, code: r.status, signal: r.signal, error: r.error ? String(r.error) : null, stdout: r.stdout, stderr: r.stderr };
  fs.appendFileSync(root + '/observer-commands.jsonl', JSON.stringify(row) + '\n');
  return row;
}
const socketRoots = new Map<string, string>();
function socketRoot(sock: string) { const dir=socketRoots.get(sock); assert(dir, 'owned socket address registered before inspection'); return dir; }
function tmux(sock: string, args: string[]) { return command([realTmux!, '-f', '/dev/null', '-S', './' + sock, ...args], socketRoot(sock)); }
function endpoint(sock: string) { return path.join(socketRoot(sock), sock); }
function socketState(file: string) {
  try { const s = fs.lstatSync(file); return { exists: true, socket: s.isSocket(), symlink: s.isSymbolicLink(), dev: s.dev, ino: s.ino, uid: s.uid }; }
  catch (e: any) { if (e.code === 'ENOENT') return { exists: false }; throw e; }
}
function live(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { if (e.code === 'ESRCH') return false; throw e; } }
function snapshot(sock: string) {
  const display = tmux(sock, ['display-message', '-p', '#{pid}']);
  assert.equal(display.code, 0, 'real server must answer before grading cleanup');
  assert.equal(display.signal, null); assert.equal(display.error, null); assert(/^[1-9][0-9]*\n$/.test(display.stdout));
  const pid = Number(display.stdout.trim()), file = endpoint(sock), state = socketState(file);
  assert(state.exists && state.socket && !state.symlink); assert.equal(state.uid, process.getuid!()); assert(live(pid));
  const identity = command(['ps', '-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,command=']); assert.equal(identity.code, 0);
  return { sock, file, pid, state, identity };
}
function copyRuntime(dest: string) {
  fs.mkdirSync(dest + '/seats', { recursive: true });
  for (const item of fs.readdirSync(source + '/seats', { withFileTypes: true })) {
    if (item.isFile() && /\.(ts|sh)$/.test(item.name)) fs.copyFileSync(source + '/seats/' + item.name, dest + '/seats/' + item.name);
    else if (item.isDirectory() && ['fixtures', 'drivers', 'transports'].includes(item.name)) fs.cpSync(source + '/seats/' + item.name, dest + '/seats/' + item.name, { recursive: true });
  }
}
function actor(dir: string, action: string, foreign = '', defer = false) {
  fs.mkdirSync(dir); for (const sub of ['bin', 'commands', 'tmp', 'home']) fs.mkdirSync(dir + '/' + sub);
  copyRuntime(dir + '/runtime');
  const program = dir + '/runtime/seats/cockpit.selftest.sh';
  // A private planted omission/wrong-scope subject may replace only this file.
  if (process.env.WHEELHOUSE_COCKPIT_CLEANUP_SUBJECT && action !== 'foreign') fs.copyFileSync(process.env.WHEELHOUSE_COCKPIT_CLEANUP_SUBJECT, program);
  const executedSha256 = sha(fs.readFileSync(program));
  fs.writeFileSync(dir + '/bin/tmux', wrapper, { mode: 0o755 });
  const stdout = fs.openSync(dir + '/stdout', 'wx'), stderr = fs.openSync(dir + '/stderr', 'wx');
  const env = { ...process.env, PATH: dir + '/bin:' + process.env.PATH, TMPDIR: dir + '/tmp', HOME: dir + '/home', XDG_CONFIG_HOME: dir + '/home/.config', SHELL: '/bin/bash', COCKPIT_CLEANUP_OBSERVER: dir, COCKPIT_CLEANUP_REAL_TMUX: realTmux!, COCKPIT_CLEANUP_ACTION: action, COCKPIT_CLEANUP_FOREIGN: foreign };
  delete env.TMUX; delete env.TMUX_PANE;
  // Keep the exec PID stable, but establish both names were absent before the
  // real suite can create anything. Never adopt another run's stale endpoint.
  const child = spawn('/bin/bash', ['-c', 'IFS= read -r release || exit 2; exec /bin/bash "$1"', 'cockpit-cleanup-owner', program], { cwd: dir, env, stdio: ['pipe', stdout, stderr] });
  assert(child.pid && child.pid > 1); const sock = 'wheelhouse-cockpit-selftest.' + child.pid;
  const socketDir = path.join(dir, 'tmp', 'wheelhouse-cockpit-sockets.' + child.pid);
  socketRoots.set(sock, socketDir); socketRoots.set(sock + '-client', socketDir);
  if (socketState(endpoint(sock)).exists || socketState(endpoint(sock + '-client')).exists) {
    child.once('close', () => { fs.closeSync(stdout); fs.closeSync(stderr); });
    child.stdin!.end(); // allocation refused before exec; do not adopt/delete it
    throw Error('INCOMPLETE allocation met a preexisting endpoint: ' + sock);
  }
  const authorize = () => child.stdin!.end('owner authorizes suite execution\n');
  if (!defer) authorize();
  let closed: any = null;
  const exited = new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = { code, signal }; resolve(closed); }); });
  return { dir, child, sock, socketDir, executedSha256, exited, authorize, get closed() { return closed; }, release() { fs.writeFileSync(dir + '/release-client', 'owner releases real client return\n'); }, closeDescriptors() { fs.closeSync(stdout); fs.closeSync(stderr); } };
}
type Actor = ReturnType<typeof actor>;
async function until(a: Actor, label: string, check: () => any): Promise<any> {
  let previous = '';
  for (;;) {
    const result = check(); if (result) return result;
    const last = JSON.stringify({ label, pid: a.child.pid, closed: a.closed, clientCreated: fs.existsSync(a.dir + '/client-up.json'), containment: 'canonical suite resource limit, not a throughput verdict' });
    if (last !== previous) { console.error('COCKPIT_CLEANUP_WAIT ' + last); previous = last; }
    if (a.closed) throw Error('INCOMPLETE original suite exited before ' + label + ': ' + last);
    await Bun.sleep(25);
  }
}
async function ready(a: Actor) {
  await until(a, 'real client server creation', () => fs.existsSync(a.dir + '/client-up.json'));
  const marker = JSON.parse(fs.readFileSync(a.dir + '/client-up.json', 'utf8'));
  assert.equal(marker.native.code, 0); assert.equal(marker.native.socketName, a.sock + '-client');
  assert.equal(marker.native.nativeCommand, 'new-session');
  assert.equal(fs.realpathSync(marker.native.cwd), fs.realpathSync(a.socketDir), 'measurement must address this actor, not another private server');
  const endpoints = [snapshot(a.sock), snapshot(a.sock + '-client')];
  await until(a, 'actual native client attach', () => {
    const r = tmux(a.sock, ['list-clients', '-F', '#{client_pid}']); assert.equal(r.code, 0); return r.stdout.trim() !== '';
  });
  return endpoints;
}
async function stop(a: Actor) {
  if (!a.closed) { a.child.kill('SIGTERM'); a.release(); }
  const r = await a.exited; a.closeDescriptors(); return r;
}
const results: any[] = [];
for (const mode of modes.filter(x => selected.includes(x) && x !== 'preexisting')) {
  const dir = root + '/' + mode; fs.mkdirSync(dir);
  let other: Actor | null = null, subject: Actor | null = null;
  const owned: any[] = [], result: any = { mode, sourceSha256: sha(sourceBytes), failure: null };
  try {
    other = actor(dir + '/foreign', 'foreign'); result.foreignBefore = await ready(other); owned.push(...result.foreignBefore);
    subject = actor(dir + '/subject', mode, other.sock); result.executedSha256 = subject.executedSha256;
    result.subjectBefore = await ready(subject); owned.push(...result.subjectBefore);
    assert.notEqual(subject.sock, other.sock); assert(other.child.pid && live(other.child.pid));
    result.subjectIdentityBeforeExit = command(['ps', '-p', String(subject.child.pid), '-o', 'pid=,ppid=,uid=,lstart=,command=']); assert.equal(result.subjectIdentityBeforeExit.code, 0);
    if (['TERM', 'INT', 'HUP'].includes(mode)) assert(subject.child.kill(('SIG' + mode) as NodeJS.Signals));
    subject.release(); result.subjectExit = await subject.exited;
    assert.equal(result.subjectExit.signal, null);
    assert.equal(result.subjectExit.code, ({ pass: 0, fail: 1, TERM: 143, INT: 130, HUP: 129 } as any)[mode], 'original suite must reach the intended normal/failure/signal exit');
    result.stdout = fs.readFileSync(subject.dir + '/stdout', 'utf8'); result.stderr = fs.readFileSync(subject.dir + '/stderr', 'utf8');
    if (mode === 'pass') assert.match(result.stdout, /cockpit\.selftest: PASS/);
    if (mode === 'fail') assert.match(result.stderr, /could not create known-size attached tmux client/);
    // Inspect BOTH worlds before rescue; neither missing setup nor a later
    // harness cleanup may be mistaken for the suite satisfying this contract.
    result.foreignAfter = result.foreignBefore.map((x: any) => ({ sock: x.sock, pid: x.pid, alive: live(x.pid), state: socketState(x.file), native: tmux(x.sock, ['has-session']) }));
    result.subjectAfter = result.subjectBefore.map((x: any) => ({ sock: x.sock, pid: x.pid, alive: live(x.pid), state: socketState(x.file) }));
    assert(!other.closed && live(other.child.pid!), 'foreign run owner must still be live');
    for (let i = 0; i < result.foreignAfter.length; i++) { const x = result.foreignAfter[i], before = result.foreignBefore[i]; assert(x.alive && x.native.code === 0, 'FOREIGN_SERVER_CHANGED'); assert.deepEqual(x.state, before.state, 'FOREIGN_SOCKET_CHANGED'); }
    assert(result.subjectAfter.every((x: any) => !x.alive), 'OWN_SERVER_REMAINS');
    assert(result.subjectAfter.every((x: any) => !x.state.exists), 'OWN_SOCKET_REMAINS');
  } catch (error: any) {
    result.failure = { kind: error instanceof assert.AssertionError ? 'behavior' : 'incomplete', message: String(error?.message ?? error) };
    console.error('COCKPIT_CLEANUP_BEFORE_RESCUE ' + JSON.stringify(result));
  } finally {
    if (subject) result.subjectJoin = await stop(subject);
    if (other) result.foreignJoin = await stop(other);
    // Only endpoints created and inode-recorded by this test are rescue-owned.
    // Never glob /tmp/tmux-UID or adopt historical sockets from other runs.
    result.rescue = [];
    // Early setup failure can precede ready() returning its ledger. Names were
    // exclusively absent before these still-owned actors were released.
    for (const a of [subject, other].filter(Boolean) as Actor[]) for (const sock of [a.sock, a.sock + '-client']) {
      if (!owned.some(x => x.sock === sock)) { const state = socketState(endpoint(sock)); if (state.exists) { assert(state.socket && !state.symlink); const r = tmux(sock, ['display-message', '-p', '#{pid}']); owned.push({ sock, file: endpoint(sock), state, pid: r.code === 0 && /^[1-9][0-9]*\n$/.test(r.stdout) ? Number(r.stdout.trim()) : 0 }); } }
    }
    for (const x of owned) {
      const alreadyClean = !socketState(x.file).exists && !live(x.pid);
      const kill = alreadyClean ? { skipped: 'owned endpoint and original server already absent' } : tmux(x.sock, ['kill-server']);
      const state = socketState(x.file);
      if (state.exists) { assert.equal(state.dev, x.state.dev); assert.equal(state.ino, x.state.ino, 'refuse replacement endpoint'); assert(state.socket && !state.symlink); fs.unlinkSync(x.file); }
      if (x.pid > 1) while (live(x.pid)) await Bun.sleep(25);
      result.rescue.push({ sock: x.sock, kill, after: socketState(x.file), originalServerAlive: x.pid > 1 && live(x.pid) });
    }
    for (const a of [subject, other].filter(Boolean) as Actor[]) {
      const files = fs.readdirSync(a.dir + '/commands').filter(x => x.endsWith('.json'));
      result[a === subject ? 'subjectCommands' : 'foreignCommands'] = files.map(x => JSON.parse(fs.readFileSync(a.dir + '/commands/' + x, 'utf8')));
    }
    const evidence = process.env.WHEELHOUSE_COCKPIT_CLEANUP_EVIDENCE;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(evidence + '/' + mode + '.json', JSON.stringify(result, null, 2)); }
    results.push(result); console.log('COCKPIT_CLEANUP_RESULT ' + JSON.stringify(result));
  }
}
if (selected.includes('preexisting')) {
  const dir = root + '/preexisting'; fs.mkdirSync(dir);
  const result: any = { mode: 'preexisting', sourceSha256: sha(sourceBytes), failure: null };
  let subject: Actor | null = null; const owned: any[] = [];
  try {
    subject = actor(dir + '/subject', 'preexisting', '', true); result.executedSha256 = subject.executedSha256;
    // This endpoint belongs to a separate native setup, NOT to the suite
    // whose still-live exec PID appears in its name (e.g. PID recycling).
    // Plant at the exact address the actual suite will inspect after exec.
    fs.mkdirSync(subject.socketDir);
    for (const sock of [subject.sock]) {
      const r = tmux(sock, ['new-session', '-d', '-s', 'preexisting', '-c', dir, 'exec tail -f /dev/null']); assert.equal(r.code, 0);
      owned.push(snapshot(sock));
    }
    result.foreignBefore = [...owned];
    subject.authorize();
    await until(subject, 'preexisting endpoint refusal or native adoption', () => subject!.closed || fs.existsSync(subject!.dir + '/client-up.json'));
    result.adopted = fs.existsSync(subject.dir + '/client-up.json');
    result.foreignAfter = owned.map(x => ({ sock: x.sock, state: socketState(x.file), alive: live(x.pid), native: tmux(x.sock, ['has-session']) }));
    // The old subject may adopt the primary and then create its own client.
    // Record that new inode BEFORE stopping it; never adopt a replacement of
    // the foreign setup's inode merely to make rescue succeed.
    if (result.adopted) owned.push(snapshot(subject.sock + '-client'));
    assert.equal(result.adopted, false, 'PREEXISTING_ENDPOINT_ADOPTED');
    result.subjectExit = await subject.exited; assert.deepEqual(result.subjectExit, { code: 2, signal: null });
    result.stderr = fs.readFileSync(subject.dir + '/stderr', 'utf8'); assert.match(result.stderr, /refuses preexisting tmux endpoint/);
    for (let i = 0; i < owned.length; i++) { assert(result.foreignAfter[i].alive && result.foreignAfter[i].native.code === 0, 'PREEXISTING_SERVER_CHANGED'); assert.deepEqual(result.foreignAfter[i].state, owned[i].state, 'PREEXISTING_SOCKET_CHANGED'); }
  } catch (error: any) {
    result.failure = { kind: error instanceof assert.AssertionError ? 'behavior' : 'incomplete', message: String(error?.message ?? error) };
    console.error('COCKPIT_CLEANUP_BEFORE_RESCUE ' + JSON.stringify(result));
  } finally {
    if (subject) { result.subjectJoin = await stop(subject); result.stdout = fs.readFileSync(subject.dir + '/stdout', 'utf8'); result.stderr = fs.readFileSync(subject.dir + '/stderr', 'utf8'); }
    result.rescue = [];
    for (const x of owned) {
      const kill = tmux(x.sock, ['kill-server']), state = socketState(x.file);
      if (state.exists) { assert.equal(state.dev, x.state.dev); assert.equal(state.ino, x.state.ino); assert(state.socket && !state.symlink); fs.unlinkSync(x.file); }
      while (live(x.pid)) await Bun.sleep(25);
      result.rescue.push({ sock: x.sock, kill, after: socketState(x.file), originalServerAlive: live(x.pid) });
    }
    if (subject) result.subjectCommands = fs.readdirSync(subject.dir + '/commands').filter(x => x.endsWith('.json')).map(x => JSON.parse(fs.readFileSync(subject!.dir + '/commands/' + x, 'utf8')));
    const evidence = process.env.WHEELHOUSE_COCKPIT_CLEANUP_EVIDENCE;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(evidence + '/preexisting.json', JSON.stringify(result, null, 2)); }
    results.push(result); console.log('COCKPIT_CLEANUP_RESULT ' + JSON.stringify(result));
  }
}
const failed = results.filter(x => x.failure).length;
console.log(`cockpit-cleanup: ${results.length - failed}/${results.length} native pass/failure/interruption cases; concurrent foreign-run endpoints checked before rescue`);
if (failed) process.exitCode = 1;
