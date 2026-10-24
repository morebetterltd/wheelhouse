import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync as nativeSpawnSync } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
import { createInterface } from 'node:readline';

// Proxy the real lock helper, recording actual releases, not idempotent results.
if (['release', 'acquire', 'inherited'].includes(process.argv[2])) {
  const args = process.argv.slice(2);
  if (args[0] === 'release') fs.appendFileSync(process.env.SIGNAL_RELEASES!, 'release\n');
  const r = nativeSpawnSync('bun', [process.env.SIGNAL_REAL_LOCK_HELPER!, ...args], { stdio: 'inherit' });
  if (r.error) throw r.error;
  process.exit(r.status ?? 2);
}

const [here, root, ...args] = process.argv.slice(2);
assert(fs.statSync(here).isDirectory());
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const selected = args.find(x => x.startsWith('--case='))?.slice(7);
const old = args.includes('--old-trap');
const runner = process.env.SIGNAL_TEST_SWEEP ?? path.join(here, 'selftest-sweep.sh');
const lib = process.env.SIGNAL_TEST_LIB ?? path.join(here, 'selftest-lib.sh');
const fixture = path.join(here, 'fixtures/selftest-signal-suite.sh');
for (const file of [runner, lib, fixture]) assert(fs.statSync(file).isFile(), file);

// Every shipped suite uses the same registration; do not silently cover only
// scripts that already installed an INT/TERM trap. Include driver standalones.
const suites = fs.readdirSync(here).filter(x => x.endsWith('.selftest.sh')).map(x => path.join(here, x));
for (const driver of ['codex', 'claude-code']) suites.push(path.join(here, 'drivers', driver, 'selftest.sh'));
assert(suites.length > 50);
for (const file of suites) {
  const src = fs.readFileSync(file, 'utf8');
  assert(/^selftest_install_cleanup_traps /m.test(src), `${path.relative(here, file)}: missing signal-exiting cleanup registration`);
  const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
console.log(`PASS signal cleanup registration and shell syntax (${suites.length} suites)`);

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { if (e.code === 'ESRCH') return false; throw e; }
}
const cases = ['normal-0', 'normal-23', 'suite-TERM', 'suite-INT', 'sweep-TERM', 'sweep-INT'];
assert(!selected || cases.includes(selected), 'unknown signal case');
let failures = 0;
for (const name of cases.filter(x => !selected || x === selected)) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
  const events = path.join(dir, 'events'), releases = path.join(dir, 'releases'), cleanups = path.join(dir, 'sweep-cleanups');
  fs.writeFileSync(events, ''); fs.writeFileSync(releases, ''); fs.writeFileSync(cleanups, '');
  const sweep = name.startsWith('sweep-');
  const normal = name.startsWith('normal-');
  const signal = name.endsWith('INT') ? 'SIGINT' : 'SIGTERM';
  const expected = normal ? Number(name.slice(7)) : signal === 'SIGINT' ? 130 : 143;
  const lock = path.join(dir, 'host.lock');
  const env = { ...process.env, TMPDIR: tmp, SELFTEST_SIGNAL_LIB: lib,
    SIGNAL_EVENTS: events, SIGNAL_OLD_TRAP: old ? '1' : '0',
    SIGNAL_NORMAL: normal ? String(expected) : '', SIGNAL_REENTER: '1',
    SIGNAL_RELEASES: releases, SIGNAL_SWEEP_CLEANUPS: cleanups, SIGNAL_REAL_LOCK_HELPER: path.join(here, 'selftest-sweep-lock.ts'),
    WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: path.join(here, 'fixtures/selftest-signals.ts'),
    WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(dir, '*.selftest.sh') };
  fs.copyFileSync(fixture, path.join(dir, 'one.selftest.sh'));
  fs.writeFileSync(path.join(dir, 'two.selftest.sh'), 'printf "LATER\\n" >> "$SIGNAL_EVENTS"\n');
  let testRunner = runner;
  if (sweep) {
    // One observer at release_lock's entry distinguishes cleanup invocation
    // from the helper's idempotent no-op on an already released lock.
    const src = fs.readFileSync(runner, 'utf8'), anchor = 'release_lock(){\n';
    assert.equal(src.split(anchor).length, 2);
    const project = path.join(dir, 'runner');
    // Main's runner audits a real tracked runtime before START. Copy the full
    // shared runtime under our owned fixture, not an isolated sweep script.
    const setup = spawnSync('bash', ['-c', String.raw`. "$1"
selftest_copy_seat_runtime "$2" "$3" || exit 2
git -C "$2" init -q -b main || exit 2
[ "$(git -C "$2" rev-parse --show-toplevel)" = "$2" ] || exit 2
git -C "$2" add seats || exit 2
`, 'signal-runner-setup', path.join(here, 'selftest-lib.sh'), project, here], {env: {...process.env}, encoding: 'utf8'});
    console.log('CAPTURE signal runner setup ' + JSON.stringify({name, status: setup.status, signal: setup.signal, error: setup.error?.message ?? null, stdout: setup.stdout, stderr: setup.stderr}));
    assert.ifError(setup.error); assert.equal(setup.signal, null); assert.equal(setup.status, 0, setup.stderr);
    testRunner = path.join(project, 'seats/selftest-sweep.sh');
    fs.writeFileSync(testRunner, src.replace(anchor, anchor + '  printf "cleanup\\n" >> "$SIGNAL_SWEEP_CLEANUPS"\n'));
  }
  const child = spawn('bash', [sweep ? testRunner : path.join(dir, 'one.selftest.sh')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', childPid = 0, fixtureDir = '', exited = false, continuedAlive = false;
  child.stdout.on('data', b => stdout += b);
  child.stderr.on('data', b => stderr += b);
  child.stdin.on('error', e => { if ((e as any).code !== 'EPIPE') throw e; });
  const exit = new Promise<{code: number | null; signal: string | null}>(resolve => child.once('close', (code, signal) => { exited = true; resolve({code, signal}); }));
  child.once('error', e => { throw e; });
  const ready = new Promise<void>(resolve => createInterface({ input: child.stdout }).on('line', line => {
    if (line === 'SIGNAL_CONTINUED') {
      continuedAlive = alive(child.pid!);
      // The old standalone trap is now blocked in its next leg, still alive
      // after removing its fixture. Release that owned control without KILL.
      child.stdin.end('release old continuation\n');
    }
    if (!line.startsWith('SIGNAL_READY ')) return;
    const parts = line.split(' '); fixtureDir = parts[1]; childPid = Number(parts[2]); resolve();
  }));
  // Native READY/early exit decides; the containing sweep owns containment.
  console.error(`FIXTURE_WAIT selftest signals: ${name} READY, child=${child.pid}`);
  try {
    await Promise.race([ready, exit.then(r => { throw new Error(`exit before READY: ${JSON.stringify(r)} ${stderr}`); })]);
    assert(fs.statSync(path.join(fixtureDir, '.wheelhouse-selftest-fixture')).isFile());
    assert(childPid > 1 && alive(childPid), 'fixture child must exist before signaling');
    if (normal) child.stdin.end('finish\n');
    else assert(child.kill(signal), 'signal delivery failed');
    console.error(`FIXTURE_WAIT selftest signals: ${name} native exit and both EOFs, child=${child.pid}`);
    const result = await exit;
    const log = fs.readFileSync(events, 'utf8');
    // Collect every observation before asserting, so old-trap failures retain
    // their continuation, cleanup-count and child-exit evidence together.
    console.log(JSON.stringify({name, old, ...result, expected, continuedAlive, events: log.trim().split('\n'), fixtureGone: !fs.existsSync(fixtureDir), childAlive: alive(childPid), releases: fs.readFileSync(releases, 'utf8').trim().split('\n').filter(Boolean).length, sweepCleanups: fs.readFileSync(cleanups, 'utf8').trim().split('\n').filter(Boolean).length}));
    assert.equal(result.code, expected, 'signal status (old trap continued instead of exiting)');
    assert.equal(result.signal, null);
    assert.equal(log, 'cleanup\n', 'cleanup must run exactly once; no continuation or later suite');
    assert(!stdout.includes('SIGNAL_CONTINUED'), 'suite continued after cleanup');
    assert(!fs.existsSync(fixtureDir), 'fixture survived cleanup');
    assert(!alive(childPid), 'fixture child survived or was not reaped');
    if (sweep) {
      assert(!fs.existsSync(lock), 'sweep lock survived');
      assert(!fs.existsSync(lock + '.queue'), 'sweep waiter survived');
      assert.equal(fs.readFileSync(releases, 'utf8'), 'release\n', 'sweep teardown released more than once');
      assert.equal(fs.readFileSync(cleanups, 'utf8'), 'cleanup\n', 'sweep teardown invoked cleanup more than once');
      assert(!stdout.includes('START ' + path.join(dir, 'two.selftest.sh')), 'later suite started');
    }
    console.log(`PASS ${name}: cleanup once, exit ${expected}, fixture gone, child reaped${sweep ? ', no later suite, one release' : ''}`);
  } catch (e) {
    failures++; console.error(`FAIL ${name}: ${e}\nCAPTURE stdout:\n${stdout}\nCAPTURE stderr:\n${stderr}`);
  } finally {
    if (!exited) {
      // Only our freshly spawned child, never host sweeps or their lock owners.
      child.stdin.end('release\n'); child.kill('SIGTERM');
      const emergency = setTimeout(() => { console.error(`FAIL ${name}: emergency SIGKILL of owned test child`); child.kill('SIGKILL'); }, 5000);
      await exit; clearTimeout(emergency);
    }
    fs.writeFileSync(path.join(dir, 'stdout'), stdout); fs.writeFileSync(path.join(dir, 'stderr'), stderr);
    // Fail rather than quietly leaving a stopped case's sleeper behind.
    if (childPid && alive(childPid)) throw new Error(`${name}: fixture child ${childPid} still alive`);
  }
}
assert.equal(failures, 0, `${failures} signal check(s) failed`);
console.log('selftest-signals.selftest: PASS');
