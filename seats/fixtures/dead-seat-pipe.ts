import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

// Private process-boundary fixture: the peer exits AFTER the nonblocking
// reader probe succeeds, BEFORE liveness examines the pathname. No elapsed
// time decides whether the command passed. Native mode captures the old hang;
// guard mode rejects the dangerous syscall before entering it.
const [source, scratch, mode = 'guard'] = process.argv.slice(2);
assert.ok(source && scratch && ['guard', 'native'].includes(mode));
assert.ok(fs.statSync(path.join(source, 'seats', 'adapter.ts')).isFile());
fs.mkdirSync(scratch, { recursive: true });
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `
const fs=require('fs'),root=process.env.B8BY_CASE,pipe=process.env.B8BY_PIPE;
const open=fs.openSync,realpath=fs.realpathSync;let armed=true;
function unsafe(kind,p){fs.appendFileSync(root+'/unsafe',kind+' '+p+'\\n');
 if(process.env.B8BY_NATIVE==='1')return;
 throw Object.assign(new Error('B8BY_BLOCKING_PIPE_LOOKUP'),{code:'B8BY_BLOCKING_PIPE_LOOKUP'});}
fs.openSync=function(p,flags,...args){
 if(String(p)===pipe && (typeof flags!=='number'||!(flags&fs.constants.O_NONBLOCK)))unsafe('blocking open',p);
 const fd=open.call(fs,p,flags,...args);
 if(armed&&String(p)===pipe&&typeof flags==='number'&&(flags&fs.constants.O_NONBLOCK)){
  armed=false;fs.writeFileSync(root+'/probe-opened','1');
  while(!fs.existsSync(root+'/peer-exited'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
 return fd;
};
fs.realpathSync=function(p,...args){if(String(p)===pipe||(process.env.B8BY_METADATA_GUARD==='1'&&fs.existsSync(p)&&fs.statSync(p).isFIFO())){unsafe('realpath final FIFO',p);fs.writeFileSync(root+'/canonical-entered','1');}return realpath.call(fs,p,...args);};
`);
function closed(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
}
function published(file: string): { promise: Promise<void>; cancel(): void } {
  let watcher: fs.FSWatcher;
  const promise = new Promise<void>((resolve) => {
    const check = () => { if (fs.existsSync(file)) { watcher.close(); resolve(); } };
    watcher = fs.watch(path.dirname(file), check); check();
  });
  return { promise, cancel: () => watcher.close() };
}
const failures: string[] = [];
for (const command of ['stop', 'dispatch']) {
  const root = path.join(scratch, command), project = path.join(root, 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(project, 'seats'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(source, 'seats'), { withFileTypes: true })) {
    const from = path.join(source, 'seats', entry.name), to = path.join(project, 'seats', entry.name);
    if ((entry.isFile() && /\.(ts|sh)$/.test(entry.name) && !entry.name.endsWith('.selftest.sh')) || ['drivers', 'transports'].includes(entry.name)) fs.cpSync(from, to, { recursive: true });
  }
  const account = path.join(root, 'account'), bin = path.join(root, 'bin');
  for (const d of [account, bin, path.join(project, 'contracts'), path.join(project, 'seats/run'), path.join(project, 'seats/logs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(project, 'contracts/WORKER.md'), 'Fixture worker; no real provider.\n');
  fs.writeFileSync(path.join(account, 'auth.json'), '{"stub":true}');
  fs.writeFileSync(path.join(account, 'trust.json'), JSON.stringify({ [project]: true }));
  fs.writeFileSync(path.join(project, 'seats/seats.json'), JSON.stringify({ namespace: 'b8by', seats: { 'worker-1': { role: 'worker', worktree: false, provider: 'anthropic', model: 'stub-model-1:high', account: { dir: account } } } }));
  fs.writeFileSync(path.join(bin, 'pi'), `#!/usr/bin/env node
const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const c=JSON.parse(l);console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,sessionId:'fixture-new',sessionFile:null}}));if(c.type==='prompt')console.log(JSON.stringify({type:'agent_end'}));});
`, { mode: 0o755 });
  const fifo = path.join(project, 'seats/run/worker-1.stdin'), log = path.join(project, 'seats/logs/worker-1.jsonl');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  fs.writeFileSync(log, '{"type":"agent_end"}\n');
  const ready = published(path.join(root, 'peer-ready'));
  const peer = spawn('node', ['-e', `const fs=require('fs');const fd=fs.openSync(process.argv[1],fs.constants.O_RDWR|fs.constants.O_NONBLOCK);fs.writeFileSync(process.argv[2],'1');setInterval(()=>{},1000);`, fifo, path.join(root, 'peer-ready')], { cwd: project, stdio: 'ignore' });
  const peerExit = closed(peer);
  let cli: ChildProcess | undefined, cliExit: ReturnType<typeof closed> | undefined;
  let cleanupPid: number | null = null;
  try {
    await Promise.race([ready.promise, peerExit.then(x => { throw Error('peer exited before ready: ' + JSON.stringify(x)); })]);
    const started = spawnSync('ps', ['-p', String(peer.pid), '-o', 'lstart='], { encoding: 'utf8' });
    assert.equal(started.status, 0);
    const stateFile = path.join(project, 'seats/state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ seats: { 'worker-1': { pid: peer.pid, startedAt: new Date(Date.parse(started.stdout.trim())).toISOString(), accountDir: account, role: 'worker', roleBrief: 'fixture', cwd: project, fifo, log, sessionId: 'fixture-old', sessionFile: null, lastBead: 'dead-pipe-bead' } } }));
    const env = { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH, WHEELHOUSE_SKIP_BD: '1', B8BY_CASE: root, B8BY_PIPE: fifo, B8BY_NATIVE: mode === 'native' ? '1' : '0' };
    const args = ['--preload', preload, path.join(project, 'seats/adapter.ts'), command, 'worker-1', ...(command === 'dispatch' ? ['dead-pipe-bead', 'fixture prompt'] : [])];
    const probe = published(path.join(root, 'probe-opened'));
    cli = spawn('bun', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    cliExit = closed(cli);
    let out = '', err = '';
    cli.stdout!.on('data', b => out += b); cli.stderr!.on('data', b => err += b);
    await Promise.race([probe.promise, cliExit.then(x => { throw Error('CLI exited before controlled reader-probe: ' + JSON.stringify(x) + err); })]);
    probe.cancel(); peer.kill('SIGTERM'); await peerExit;
    assert.ok(fs.statSync(fifo).isFIFO(), 'dead peer leaves actual FIFO');
    fs.writeFileSync(path.join(root, 'peer-exited'), '1');
    if (mode === 'native') {
      const entered = published(path.join(root, 'canonical-entered'));
      await Promise.race([entered.promise, cliExit.then(() => { throw Error('native command returned instead of entering final FIFO realpath'); })]); entered.cancel();
      const identity = spawnSync('ps', ['-p', String(cli.pid), '-o', 'pid=,ppid=,uid=,lstart=,command='], { encoding: 'utf8' });
      const open = spawnSync('lsof', ['-nP', '-p', String(cli.pid), '-Fpcfn'], { encoding: 'utf8' });
      fs.writeFileSync(path.join(root, 'native-identity'), identity.stdout + identity.stderr);
      fs.writeFileSync(path.join(root, 'native-open-files'), open.stdout);
      fs.writeFileSync(path.join(root, 'native-open-files.err'), open.stderr);
      const sample = spawnSync('sample', [String(cli.pid), '1', '1', '-file', path.join(root, 'native.sample')], { encoding: 'utf8' });
      fs.writeFileSync(path.join(root, 'sample-result.json'), JSON.stringify(sample));
      assert.equal(sample.status, 0); assert.match(fs.readFileSync(path.join(root, 'native.sample'), 'utf8'), /openat.*NOCANCEL|__openat_nocancel/);
      assert.ok(!open.stdout.split('\n').includes('n' + fifo), 'blocked before obtaining FIFO descriptor');
      assert.equal(Number(identity.stdout.trim().split(/\s+/)[1]), process.pid, 'recorded direct child');
      cli.kill('SIGKILL'); const result = await cliExit;
      console.log(`${command}: native main openat captured; peer exited; no FIFO fd; owned CLI terminated ${result.signal}`);
    } else {
      const result = await cliExit;
      fs.writeFileSync(path.join(root, 'stdout'), out); fs.writeFileSync(path.join(root, 'stderr'), err);
      const unsafe = fs.existsSync(path.join(root, 'unsafe')) ? fs.readFileSync(path.join(root, 'unsafe'), 'utf8') : '';
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).seats['worker-1'];
      cleanupPid = state.pid && state.pid !== peer.pid ? state.pid : null;
      assert.equal(result.code, 0, err);
      assert.match(out, command === 'stop' ? /seat worker-1 is not running/ : /seat worker-1: not running; spawning/);
      if (unsafe || (command === 'stop' && state.pid !== null)) {
        const failure = `${command}: unsafe=${JSON.stringify(unsafe)} deadRecordCleared=${state.pid === null}`;
        failures.push(failure); console.error('not ok - ' + failure);
      } else console.log(`${command}: peer exited at reader-probe handshake; returned ${result.code}; named dead-seat result; no blocking pipe lookup`);
    }
  } finally {
    ready.cancel();
    if (peer.exitCode === null && peer.signalCode === null) { peer.kill('SIGKILL'); await peerExit; }
    if (cli && cli.exitCode === null && cli.signalCode === null) { cli.kill('SIGKILL'); await cliExit; }
    // Freshly launched fake pi is detached by the real adapter. Stop through
    // the same owned project's CLI; never select host pi by title.
    if (cleanupPid) {
      // Mutant runtimes can hit the SAME race during teardown. Keep the
      // syscall guard on for cleanup too (after the verdict was captured).
      const cleanup = spawnSync('bun', ['--preload', preload, path.join(project, 'seats/adapter.ts'), 'stop', 'worker-1'], { cwd: project, env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH, WHEELHOUSE_SKIP_BD: '1', B8BY_CASE: root, B8BY_PIPE: fifo, B8BY_NATIVE: '0' }, encoding: 'utf8' });
      assert.equal(cleanup.status, 0, cleanup.stderr);
    }
  }
}
if (mode === 'guard') {
  const root = path.join(scratch, 'metadata'); fs.mkdirSync(root, { recursive: true });
  const fifo = path.join(root, 'seat.stdin'), other = path.join(root, 'other.stdin');
  assert.equal(spawnSync('mkfifo', [fifo, other]).status, 0);
  fs.symlinkSync(fifo, path.join(root, 'leaf.stdin'));
  fs.symlinkSync(root, path.join(root, 'dir-alias'));
  fs.linkSync(fifo, path.join(root, 'hardlink.stdin'));
  const check = spawnSync('bun', ['--preload', preload, '-e', `
import assert from 'node:assert/strict';
import path from 'node:path';
const {openPathsMatch}=await import(process.argv[1]);const root=process.argv[2],fifo=path.join(root,'seat.stdin');
for(const alias of [fifo,path.join(root,'leaf.stdin'),path.join(root,'dir-alias/seat.stdin'),path.join(root,'hardlink.stdin')])assert.equal(openPathsMatch([fifo],alias),true,alias);
assert.equal(openPathsMatch([fifo],path.join(root,'other.stdin')),false);
console.log('metadata: literal, final symlink, directory symlink, hardlink preserved; distinct inode refused');
`, path.join(source, 'seats/seat-activity.ts'), root], { env: { ...process.env, B8BY_CASE: root, B8BY_PIPE: fifo, B8BY_METADATA_GUARD: '1' }, encoding: 'utf8' });
  const unsafe = fs.existsSync(path.join(root, 'unsafe'));
  if (check.status !== 0 || unsafe) { failures.push('metadata alias matching used unsafe lookup or lost identity: '+check.stderr); console.error('not ok - metadata alias matching'); }
  else process.stdout.write(check.stdout);
}
assert.deepEqual(failures, [], 'dead-seat pipe regressions');
console.log('dead-seat-pipe: PASS (both commands; metadata aliases; syscall/exit handshakes, no time-budget verdict)');
