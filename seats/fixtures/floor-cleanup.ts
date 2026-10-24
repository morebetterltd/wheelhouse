// Run the real floor suite and inspect its native endpoints BEFORE rescue.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';
const [source, fixture] = process.argv.slice(2);
assert(fs.statSync(fixture + '/.wheelhouse-selftest-fixture').isFile());
const realTmux = Bun.which('tmux'); assert(realTmux && Bun.which('expect'));
const modes = ['pass', 'fail', 'TERM', 'INT', 'HUP', 'preexisting'];
const selected = process.env.WHEELHOUSE_FLOOR_CLEANUP_CASES?.split(',') ?? modes;
assert(selected.length && selected.every(x => modes.includes(x)));
const evidence = process.env.WHEELHOUSE_FLOOR_CLEANUP_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const sha = (x: Buffer | string) => createHash('sha256').update(x).digest('hex');
const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// Only the address is translated: native -L canonicalizes long TMUX_TMPDIR
// paths past Darwin's AF_UNIX limit; relative -S names the SAME private file.
// Native argv/status/stdout/stderr are retained. No tmux response is emulated.
const wrapper = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),dir=process.env.FLOOR_CLEANUP_OBSERVER,args=process.argv.slice(2),native=[...args];
if(native[0]==='-L')native.splice(0,2,'-S','./tmux-'+process.getuid()+'/'+native[1]);
const fds=['stdout','stderr'].map(x=>fs.openSync(dir+'/commands/'+process.pid+'.'+x,'wx'));
const r=cp.spawnSync(process.env.FLOOR_CLEANUP_REAL_TMUX,native,{stdio:['ignore',...fds]});fds.forEach(fd=>fs.closeSync(fd));
const data={args,nativeArgs:native,code:r.status,signal:r.signal,error:r.error?String(r.error):null,stdout:fs.readFileSync(dir+'/commands/'+process.pid+'.stdout','utf8'),stderr:fs.readFileSync(dir+'/commands/'+process.pid+'.stderr','utf8')};
fs.writeFileSync(dir+'/commands/'+process.pid+'.json',JSON.stringify(data));process.stdout.write(data.stdout);process.stderr.write(data.stderr);
function finish(){process.exit(r.error||r.signal||r.status===null?2:r.status);}
if(args[0]==='-L'&&args[2]==='list-windows'&&r.status===0&&!fs.existsSync(dir+'/ready.json')){
 fs.writeFileSync(dir+'/ready.json.tmp',JSON.stringify(data));fs.renameSync(dir+'/ready.json.tmp',dir+'/ready.json');
 const timer=setInterval(()=>{if(fs.existsSync(dir+'/release')){clearInterval(timer);finish();}},25);
}else finish();
`;
function socket(file: string) { try { const s = fs.lstatSync(file); return { exists: true, socket: s.isSocket(), symlink: s.isSymbolicLink(), dev: s.dev, ino: s.ino, uid: s.uid }; } catch (e: any) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
function live(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { if (e.code === 'ESRCH') return false; throw e; } }
let world = '';
function command(file: string, args: string[]) { const r = completedCommand(file, args, { cwd: world }); const x = { file, args, code: r.status, signal: r.signal, error: r.error ? String(r.error) : null, stdout: r.stdout, stderr: r.stderr }; fs.appendFileSync(world + '/observer.jsonl', JSON.stringify(x) + '\n'); return x; }
function tmux(sock: string, args: string[]) { return command(realTmux!, ['-S', './tmux-' + process.getuid!() + '/' + sock, ...args]); }
const endpoint = (sock: string) => world + '/tmux-' + process.getuid!() + '/' + sock;
function identity(pid: number) { return command('ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,command=']); }
function snapshot(sock: string) { const r = tmux(sock, ['display-message', '-p', '#{pid}']); assert.equal(r.code, 0); assert.equal(r.signal, null); assert.equal(r.error, null); assert.match(r.stdout, /^[1-9][0-9]*\n$/); const pid = Number(r.stdout.trim()), state = socket(endpoint(sock)); assert(state.exists && state.socket && !state.symlink); assert.equal(state.uid, process.getuid!()); const nativeIdentity = identity(pid); assert.equal(nativeIdentity.code, 0); return { sock, file: endpoint(sock), pid, state, nativeIdentity }; }
function actor(tag: string, action: string, peer = '', defer = false) {
  const dir = world + '/' + tag; fs.mkdirSync(dir); for (const sub of ['runtime/seats', 'bin', 'commands', 'tmp', 'home']) fs.mkdirSync(dir + '/' + sub, { recursive: true });
  for (const item of fs.readdirSync(source + '/seats', { withFileTypes: true })) {
    const from = source + '/seats/' + item.name, to = dir + '/runtime/seats/' + item.name;
    if (item.isFile() && /\.(ts|sh)$/.test(item.name)) fs.copyFileSync(from, to);
    else if (item.isDirectory() && ['fixtures', 'drivers', 'transports'].includes(item.name)) fs.cpSync(from, to, { recursive: true });
  }
  const program = dir + '/runtime/seats/floor.selftest.sh';
  if (process.env.WHEELHOUSE_FLOOR_CLEANUP_SUBJECT && action !== 'peer') fs.copyFileSync(process.env.WHEELHOUSE_FLOOR_CLEANUP_SUBJECT, program);
  let body = fs.readFileSync(program, 'utf8');
  if (action === 'fail') { const anchor = '  WN="$(tmux -L "$SOCK" list-windows'; assert.equal(body.split(anchor).length, 2); body = body.replace(anchor, () => '  fail "fixture: planted floor feature assertion after real server setup"\n' + anchor); fs.writeFileSync(program, body); }
  fs.writeFileSync(dir + '/bin/tmux', wrapper, { mode: 0o755 });
  const out = fs.openSync(dir + '/stdout', 'wx'), err = fs.openSync(dir + '/stderr', 'wx');
  const env = { ...process.env, PATH: dir + '/bin:' + process.env.PATH, TMUX_TMPDIR: world, TMPDIR: dir + '/tmp', HOME: tag + '/home', XDG_CONFIG_HOME: dir + '/home/.config', SHELL: '/bin/bash', FLOOR_CLEANUP_OBSERVER: dir, FLOOR_CLEANUP_REAL_TMUX: realTmux!, FLOOR_CLEANUP_PEER: peer };
  delete env.TMUX; delete env.TMUX_PANE;
  const child = spawn('/bin/bash', ['-c', 'IFS= read -r permit || exit 2; exec /bin/bash ' + q(program)], { cwd: world, env, stdio: ['pipe', out, err] });
  assert(child.pid && child.pid > 1); const sock = 'whfloor' + child.pid; assert(!socket(endpoint(sock)).exists, 'INCOMPLETE: fixture allocation met a preexisting endpoint');
  let closed: any = null; const exited = new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = { code, signal }; fs.closeSync(out); fs.closeSync(err); resolve(closed); }); });
  const authorize = () => child.stdin!.end('owner authorizes execution\n'); if (!defer) authorize();
  return { child, dir, sock, programSha256: sha(body), exited, authorize, get closed() { return closed; }, release() { fs.writeFileSync(dir + '/release', 'release real native return\n'); } };
}
type Actor = ReturnType<typeof actor>;
async function until(a: Actor, label: string, predicate: () => boolean) { let last = ''; for (;;) { if (predicate()) return; const state = JSON.stringify({ label, pid: a.child.pid, closed: a.closed, ready: fs.existsSync(a.dir + '/ready.json') }); if (last !== state) { console.error('FLOOR_CLEANUP_WAIT ' + state); last = state; } assert(!a.closed, 'INCOMPLETE: original floor suite exited before ' + label); await Bun.sleep(25); } }
async function ready(a: Actor) { await until(a, 'native two-pane server', () => fs.existsSync(a.dir + '/ready.json')); const r = JSON.parse(fs.readFileSync(a.dir + '/ready.json', 'utf8')); assert.equal(r.code, 0); assert.equal(r.args[1], a.sock); const s = snapshot(a.sock), panes = tmux(a.sock, ['list-panes', '-t', 'wh-tfix:bridge', '-F', '#{pane_id}']); assert.equal(panes.code, 0); assert.equal(panes.stdout.trim().split('\n').length, 2); return s; }
async function stop(a: Actor) { if (!a.closed) { const before = identity(a.child.pid!); assert.equal(before.code, 0); assert(before.stdout.includes(a.dir + '/runtime/seats/floor.selftest.sh')); assert(a.child.kill('SIGTERM')); a.release(); } return a.exited; }
function commands(a: Actor) { return fs.readdirSync(a.dir + '/commands').filter(x => x.endsWith('.json')).map(x => JSON.parse(fs.readFileSync(a.dir + '/commands/' + x, 'utf8'))); }
const results: any[] = [];
for (const mode of modes.filter(m => selected.includes(m))) {
  world = fixture + '/' + mode; fs.mkdirSync(world); fs.mkdirSync(world + '/tmux-' + process.getuid!(), { mode: 0o700 });
  let peer: Actor | null = null, subject: Actor | null = null; const owned: any[] = []; const result: any = { mode, failure: null };
  try {
    peer = actor('peer', 'peer'); result.peerBefore = await ready(peer); owned.push(result.peerBefore);
    subject = actor('subject', mode, peer.sock, mode === 'preexisting'); result.programSha256 = subject.programSha256;
    if (mode === 'preexisting') { const native = tmux(subject.sock, ['new-session', '-d', '-s', 'foreign', '-c', world, 'exec sleep 3600']); assert.equal(native.code, 0); result.subjectBefore = snapshot(subject.sock); owned.push(result.subjectBefore); subject.authorize(); await until(subject, 'refusal or adoption', () => !!subject!.closed || fs.existsSync(subject!.dir + '/ready.json')); result.adopted = fs.existsSync(subject.dir + '/ready.json'); if (result.adopted) subject.release(); }
    else { result.subjectBefore = await ready(subject); owned.push(result.subjectBefore); result.ownerBefore = identity(subject.child.pid!); assert.equal(result.ownerBefore.code, 0); if (['TERM', 'INT', 'HUP'].includes(mode)) assert(subject.child.kill(('SIG' + mode) as NodeJS.Signals)); subject.release(); }
    result.exit = await subject.exited; result.stdout = fs.readFileSync(subject.dir + '/stdout', 'utf8'); result.stderr = fs.readFileSync(subject.dir + '/stderr', 'utf8');
    // Both worlds are inspected before any harness rescue, even for a red.
    result.peerAfter = { alive: live(result.peerBefore.pid), state: socket(result.peerBefore.file), native: tmux(peer.sock, ['has-session']), identity: identity(result.peerBefore.pid) };
    result.subjectAfter = { alive: live(result.subjectBefore.pid), state: socket(result.subjectBefore.file), native: tmux(subject.sock, ['has-session']), identity: identity(result.subjectBefore.pid) };
    assert(!peer.closed && live(peer.child.pid!), 'PEER_OWNER_CHANGED'); assert(result.peerAfter.alive && result.peerAfter.native.code === 0, 'PEER_SERVER_CHANGED'); assert.deepEqual(result.peerAfter.state, result.peerBefore.state, 'PEER_SOCKET_CHANGED'); assert.equal(result.peerAfter.identity.stdout, result.peerBefore.nativeIdentity.stdout, 'PEER_IDENTITY_CHANGED');
    if (mode === 'preexisting') { assert.equal(result.adopted, false, 'PREEXISTING_ENDPOINT_ADOPTED'); assert.deepEqual(result.exit, { code: 2, signal: null }); assert.match(result.stderr, /refuses preexisting tmux endpoint/); assert(result.subjectAfter.alive && result.subjectAfter.native.code === 0, 'PREEXISTING_SERVER_CHANGED'); assert.deepEqual(result.subjectAfter.state, result.subjectBefore.state, 'PREEXISTING_SOCKET_CHANGED'); }
    else { assert.deepEqual(result.exit, { code: ({ pass: 0, fail: 1, TERM: 143, INT: 130, HUP: 129 } as any)[mode], signal: null }); if (mode === 'pass') assert.match(result.stdout, /floor\.ts works on this machine\./); if (mode === 'fail') assert.match(result.stdout, /FAIL\s+fixture: planted floor feature assertion/); assert(!result.subjectAfter.alive && result.subjectAfter.native.code === 1, 'OWN_SERVER_REMAINS'); assert(!result.subjectAfter.state.exists, 'OWN_SOCKET_REMAINS'); }
  } catch (e: any) { result.failure = { kind: e instanceof assert.AssertionError ? 'behavior' : 'incomplete', message: String(e.message ?? e) }; console.error('FLOOR_CLEANUP_BEFORE_RESCUE ' + JSON.stringify(result)); }
  finally {
    if (subject) result.subjectJoin = await stop(subject); if (peer) result.peerJoin = await stop(peer);
    result.rescue = [];
    for (const x of owned) { const state = socket(x.file); if (state.exists) { assert.deepEqual(state, x.state, 'rescue refuses unknown replacement'); const kill = tmux(x.sock, ['kill-server']); const after = socket(x.file); if (after.exists) { assert.deepEqual(after, x.state); fs.unlinkSync(x.file); } result.rescue.push({ sock: x.sock, kill, exactInodeUnlinked: after.exists }); } while (live(x.pid)) await Bun.sleep(25); }
    if (subject) result.subjectCommands = commands(subject); if (peer) result.peerCommands = commands(peer);
    fs.writeFileSync(world + '/result.json', JSON.stringify(result, null, 2)); if (evidence) fs.writeFileSync(evidence + '/' + mode + '.json', JSON.stringify(result, null, 2), { flag: 'wx' }); results.push(result);
    console.log('FLOOR_CLEANUP_RESULT ' + JSON.stringify(result));
  }
}
console.log(`floor-cleanup: ${results.filter(x => !x.failure).length}/${results.length} native modes; peer and owned state checked before rescue`);
if (results.some(x => x.failure)) process.exitCode = 1;
