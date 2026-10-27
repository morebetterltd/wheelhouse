// Exercise the existing adapter suite/stub/builders, not production seats.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
const [here, root, evidence, sweepSource] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
fs.mkdirSync(evidence, { recursive: true });
let sequence = 0;
function native(file: string, args: string[], options: object = {}) {
  const prefix = path.join(evidence, `native-${++sequence}`);
  const out = fs.openSync(prefix + '.stdout', 'wx', 0o600), err = fs.openSync(prefix + '.stderr', 'wx', 0o600);
  let r;
  try { r = spawnSync(file, args, { ...options, env: { ...process.env, LC_ALL: 'C' }, timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const result = { command: [file, ...args], status: r.status, signal: r.signal, error: r.error?.message ?? null,
    stdout: fs.readFileSync(prefix + '.stdout', 'utf8'), stderr: fs.readFileSync(prefix + '.stderr', 'utf8') };
  fs.writeFileSync(prefix + '.json', JSON.stringify(result));
  assert.equal(result.error, null); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  return result;
}
type Row = { pid: number; ppid: number; pgid: number; state: string; birth: string; command: string };
function snapshot(): Row[] {
  // Native schema captured with ps -ww -axo pid=,ppid=,pgid=,stat=,lstart=,command=.
  const raw = native('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command=']).stdout;
  const rows = raw.trim().split('\n').map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/s.exec(line);
    assert(m, 'unrecognized native process row');
    return { pid: +m[1], ppid: +m[2], pgid: +m[3], state: m[4], birth: m[5], command: m[6] };
  });
  assert(rows.some(r => r.pid === process.pid), 'native census omitted controller');
  return rows;
}
const identity = (r: Row) => JSON.stringify([r.pid, r.pgid, r.birth, r.command]);
async function until(predicate: () => boolean, seconds: number, message: string) {
  const deadline = performance.now() + seconds * 1000;
  for (;;) {
    if (predicate()) return;
    assert(performance.now() < deadline, message);
    await Bun.sleep(25);
  }
}
function joined(child: ChildProcess) {
  let closed = false;
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  return { done, closed: () => closed };
}
const project = path.join(root, 'runtime'), seats = path.join(project, 'seats');
native('bash', ['-c', '. "$1" || exit 2; selftest_copy_seat_runtime "$2" "$3" || exit 2', 'interrupt-setup', path.join(here, 'selftest-lib.sh'), project, here]);
fs.cpSync(path.join(here, 'fixtures'), path.join(seats, 'fixtures'), { recursive: true });
fs.copyFileSync(sweepSource, path.join(seats, 'selftest-sweep.sh'));
const suite = path.join(seats, 'adapter.selftest.sh'), original = fs.readFileSync(path.join(here, 'adapter.selftest.sh'), 'utf8');
const anchor = 'if [ -n "${WHEELHOUSE_ADAPTER_LIFETIME_CHILD:-}" ]; then';
assert.equal(original.split(anchor).length, 2);
// Only select a real live stub checkpoint before unrelated suite phases.
// The actual fixture EXIT/signal traps and native sweep containment are intact.
const checkpoint = `if [ "\${WHEELHOUSE_ADAPTER_INTERRUPT_CHILD:-0}" = 1 ]; then
  RC=0
  perl -e 'alarm 30; exec @ARGV or die "exec: $!\\n"' env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 > "$ADAPTER_INTERRUPT_CASE/spawn.stdout" 2> "$ADAPTER_INTERRUPT_CASE/spawn.stderr" || RC=$?
  [ "$RC" = 0 ] || exit 2
  printf '%s\\n%s\\n' "$$" "$FIX" > "$ADAPTER_INTERRUPT_CASE/ready"
  until [ -f "$ADAPTER_INTERRUPT_CASE/release" ]; do sleep 0.02; done
  exit 0
fi
`;
fs.writeFileSync(suite, original.replace(anchor, () => checkpoint + anchor));
native('git', ['-C', project, 'init', '-q', '-b', 'main']); native('git', ['-C', project, 'add', 'seats']);
// The ONLY readers of these two FIFOs live in this separate bounded process.
// The controller/runner keep no read descriptors. O_RDWR avoids setup deadlock;
// its extra writer endpoints go away with that reader too.
const readerScript = path.join(root, 'reader.cjs');
fs.writeFileSync(readerScript, `const fs=require('fs'); const [a,b,out,err,ready]=process.argv.slice(2); const fds=[a,b].map(f=>fs.openSync(f,fs.constants.O_RDWR)); for(let i=0;i<2;i++) fs.createReadStream(null,{fd:fds[i]}).on('data',bytes=>fs.appendFileSync(i?err:out,bytes)); fs.writeFileSync(ready,'ready');`);
const selected = process.env.WHEELHOUSE_ADAPTER_INTERRUPT_CASE;
assert(!selected || ['normal', 'interrupt', 'reader-loss'].includes(selected));
let failures = 0;
for (const name of ['normal', 'interrupt', 'reader-loss']) {
  if (selected && name !== selected) continue;
  const dir = path.join(root, name), retained = path.join(evidence, name); fs.mkdirSync(dir); fs.mkdirSync(retained);
  fs.mkdirSync(path.join(dir, 'tmp'));
  const pipes = ['stdout', 'stderr'].map(n => path.join(dir, n + '.fifo'));
  native('mkfifo', pipes);
  const out = path.join(retained, 'sweep.stdout'), err = path.join(retained, 'sweep.stderr'), readerReady = path.join(dir, 'reader.ready');
  fs.writeFileSync(out, ''); fs.writeFileSync(err, '');
  const reader = spawn('node', [readerScript, ...pipes, out, err, readerReady], { stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' });
  const readerJoin = joined(reader);
  let runner: ChildProcess | undefined, runnerJoin: ReturnType<typeof joined> | undefined;
  let known: Row[] = [], suitePid = 0, stateDir = '', interruptedAt = 0, exitAt = 0;
  const record: any = { name, before: [], guardian: [] };
  try {
    await until(() => fs.existsSync(readerReady), 10, 'output reader failed to start');
    const descriptors = pipes.map(f => fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    try {
      // Explicitly exercise a normal/default SIGPIPE caller, independent of
      // this controller runtime's own ignored-signal inheritance policy.
      runner = spawn('perl', ['-e', '$SIG{PIPE}="DEFAULT"; exec @ARGV or die "exec: $!\\n"', 'bash', path.join(seats, 'selftest-sweep.sh')], { cwd: project, detached: true,
        env: { ...process.env, TMPDIR: path.join(dir, 'tmp'), WHEELHOUSE_ADAPTER_LIFETIME_ONLY: '1', WHEELHOUSE_ADAPTER_INTERRUPT_CHILD: '1', ADAPTER_INTERRUPT_CASE: dir,
          WHEELHOUSE_SKIP_REAL_PI: '1', WHEELHOUSE_SELFTEST_SWEEP_PATTERN: suite, WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S: '60', WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: '5' },
        stdio: ['ignore', ...descriptors], timeout: 60_000, killSignal: 'SIGKILL' });
    } finally { descriptors.forEach(fd => fs.closeSync(fd)); }
    runnerJoin = joined(runner); runner.once('exit', () => { exitAt = performance.now(); });
    const ready = path.join(dir, 'ready');
    await until(() => { assert(!runnerJoin!.closed(), 'sweep exited before live seat'); return fs.existsSync(ready) && fs.readFileSync(err, 'utf8').includes('suite timeout='); }, 40, 'live seat checkpoint deadline');
    const [pid, fixture] = fs.readFileSync(ready, 'utf8').trim().split('\n'); suitePid = Number(pid);
    const claim = JSON.parse(fs.readFileSync(path.join(fixture, 'proj/seats/state.json'), 'utf8')).seats['worker-1'];
    const rows = snapshot(), pi = rows.find(r => r.pid === claim.pid);
    assert(pi && pi.ppid === 1 && pi.pgid === pi.pid && pi.command.includes('--mode rpc'), 'real detached RPC stub required');
    known = rows.filter(r => r.pgid === pi.pgid || r.pid === suitePid);
    assert(known.some(r => r.command.includes('seat-event-log.ts')) && known.some(r => r.command.startsWith('bash -c exec pi')), 'live bash/event-log cohort required');
    record.before = known; record.suitePid = suitePid; record.fixture = fixture;
    assert(known.some(r => r.pid === suitePid && r.pgid === suitePid), 'suite receipt must identify its native group leader');
    stateDir = path.dirname(path.dirname(fixture));
    const ownerFile = path.join(stateDir, 'owner'); assert(fs.statSync(ownerFile).isFile());
    assert.deepEqual(fs.readFileSync(ownerFile, 'utf8').trim().split(/\s+/).slice(0, 2), [String(suitePid), String(suitePid)], 'deadline directory must belong to this live suite');
    record.before = known; record.stateDir = stateDir;
    console.log(`LIVE adapter interrupt ${name}: ` + JSON.stringify(known));
    if (name === 'normal') fs.writeFileSync(path.join(dir, 'release'), 'normal completion\n');
    else {
      if (name === 'reader-loss') {
        reader.kill('SIGTERM'); await until(readerJoin.closed, 5, 'reader did not exit'); record.readerExit = await readerJoin.done;
        // Opening a nonblocking writer succeeds only while a reader exists.
        for (const pipe of pipes) assert.throws(() => fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK), { code: 'ENXIO' }, 'output FIFO still has a reader');
      }
      interruptedAt = performance.now(); runner.kill('SIGTERM');
    }
    await until(runnerJoin.closed, 30, 'sweep runner did not exit within 30s of ending');
    record.result = await runnerJoin.done; record.exitAfterMs = interruptedAt ? exitAt - interruptedAt : null;
    assert.equal(record.result.signal, null); assert.equal(record.result.code, name === 'normal' ? 0 : 143);
    if (interruptedAt) assert(record.exitAfterMs <= 30_000, 'interrupt exceeded 30s');
    await until(() => {
      const post = snapshot();
      record.survivors = post.filter(r => known.some(k => identity(k) === identity(r)) || r.command.includes(stateDir + '/tmp/'));
      return !record.survivors.length;
    }, 5, 'recorded suite/RPC process survived sweep completion');
    record.stateRemoved = !fs.existsSync(stateDir); assert(record.stateRemoved, 'suite-deadline directory survived');
    console.log(`PASS adapter interrupt ${name}: native${record.result.code}, survivors=0, state=removed, interruptMs=${record.exitAfterMs ?? 'normal'}`);
  } catch (error: any) {
    failures++; record.failure = error.stack ?? error.message;
    console.error(`FAIL adapter interrupt ${name}: ${record.failure}`);
  } finally {
    // A failed regression must not leak. Direct runner group is ours. Suite
    // groups come from its owner receipt; detached groups require the exact
    // captured identity or an argv under this case's unique private TMPDIR.
    const rows = snapshot(), groups = new Set<number>(), ownerGroups = new Set<number>();
    if (runner?.pid) groups.add(runner.pid);
    if (suitePid) groups.add(suitePid);
    // Also rescue setup failures before the live-seat receipt was published.
    for (const leaf of fs.readdirSync(path.join(dir, 'tmp'))) {
      const owner = path.join(dir, 'tmp', leaf, 'owner');
      if (!leaf.startsWith('wheelhouse-suite-deadline.') || !fs.existsSync(owner)) continue;
      const [pid, group, ...birth] = fs.readFileSync(owner, 'utf8').trim().split(/\s+/);
      const leader = rows.find(r => r.pid === Number(pid));
      if (leader && leader.pid === Number(group) && leader.pgid === leader.pid && leader.birth.replace(/\s+/g, ' ') === birth.join(' ')) {
        groups.add(leader.pgid); ownerGroups.add(leader.pgid);
      }
    }
    for (const r of rows) if (known.some(k => identity(k) === identity(r)) || r.command.includes(path.join(dir, 'tmp') + '/')) groups.add(r.pgid);
    const caller = rows.find(r => r.pid === process.pid)!.pgid;
    for (const group of groups) {
      assert(group > 1 && group !== caller, 'refuse controller group');
      const members = rows.filter(r => r.pgid === group);
      if (!members.length) continue;
      // Never transfer a stale numeric group claim to a recycled identity.
      const proven = ownerGroups.has(group) || members.some(r => known.some(k => identity(k) === identity(r)) ||
        r.command.includes(path.join(dir, 'tmp') + '/') || (group === runner?.pid && r.command.includes(path.join(seats, 'selftest-sweep.sh'))));
      if (!proven) { (record.unownedGroups ??= []).push(group); continue; }
      try { process.kill(-group, 'SIGKILL'); record.guardian.push(group); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
    }
    if (runnerJoin) { await until(runnerJoin.closed, 5, 'runner guardian join failed'); await runnerJoin.done; }
    if (!readerJoin.closed()) reader.kill('SIGKILL');
    await until(readerJoin.closed, 5, 'reader guardian join failed'); await readerJoin.done;
    await until(() => !snapshot().some(r => known.some(k => identity(k) === identity(r)) || r.command.includes(path.join(dir, 'tmp') + '/')), 5, 'guardian left a fixture process');
    record.retired = true;
    fs.writeFileSync(path.join(retained, 'result.json'), JSON.stringify(record, null, 2));
  }
}
assert.equal(failures, 0, `${failures} adapter interrupt case(s) failed`);
console.log('adapter-interrupt: PASS; every recorded actor retired');
