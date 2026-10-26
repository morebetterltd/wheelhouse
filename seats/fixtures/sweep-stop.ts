// Real runner, two suites, TERM while the first is live. The broken copy only
// acknowledges TERM: releasing its first suite must expose the forbidden START.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { completedCommand } from '../completed-command';
import conditions from './wait-for-condition.cjs';
const { waitForCondition } = conditions;
const [here, allocation] = process.argv.slice(2);
assert(fs.statSync(path.join(allocation, '.wheelhouse-selftest-fixture')).isFile());
const root = path.join(allocation, 'stop-cases'); fs.mkdirSync(root);
const project = path.join(root, 'runtime');
const setup = completedCommand('bash', ['-c', `. "$1" || exit 2
selftest_copy_seat_runtime "$2" "$3" || exit 2
git -C "$2" init -q -b main || exit 2
git -C "$2" add seats || exit 2
`, 'sweep-stop-setup', path.join(here, 'selftest-lib.sh'), project, here]);
assert(!setup.error && !setup.signal); assert.equal(setup.status, 0, setup.stderr);
const runner = path.join(project, 'seats/selftest-sweep.sh'), original = fs.readFileSync(runner, 'utf8');
const anchor = "trap 'interrupt_sweep 143' TERM"; assert.equal(original.split(anchor).length, 2);
const evidence = process.env.WHEELHOUSE_SWEEP_STOP_EVIDENCE || root;
fs.mkdirSync(evidence, { recursive: true });
const alive = (pid: number) => { assert(pid > 1); try { process.kill(pid, 0); return true; } catch (e: any) { if (e.code === 'ESRCH') return false; throw e; } };
function nativeIdentity(pid: number) {
  const r = completedCommand('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], { env: { ...process.env, LC_ALL: 'C' } });
  assert(!r.error && !r.signal); assert.equal(r.status, 0); assert.equal(r.stderr, '');
  // Field layout captured from the real ps producer before this fixture.
  const fields = r.stdout.trim().split(/\s+/); assert.equal(Number(fields[0]), pid); assert(fields.length >= 9);
  return { pid, pgid: Number(fields[2]), birth: fields.slice(3, 8).join(' '), command: fields.slice(8).join(' '), native: r };
}
const records: any[] = [];
for (const broken of [false, true]) {
  const name = broken ? 'removed' : 'fixed', dir = path.join(root, name); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'tmp'));
  const first = path.join(dir, '01-first.selftest.sh'), second = path.join(dir, '02-later.selftest.sh');
  const fifo = path.join(dir, 'release');
  const mkfifo = completedCommand('mkfifo', [fifo]); assert.equal(mkfifo.status, 0); assert(!mkfifo.error && !mkfifo.signal);
  const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  fs.writeFileSync(first, `#!/usr/bin/env bash
set -eu
sleep 600 & keeper=$!
trap 'kill "$keeper" 2>/dev/null || true; wait "$keeper" 2>/dev/null || true; exit 143' TERM
printf '%s\\n' "$keeper" > "$STOP_CASE/keeper.pid"
printf '%s\\n' "$$" > "$STOP_CASE/first.pid"
IFS= read -r release < "$STOP_CASE/release"
kill "$keeper"; wait "$keeper" 2>/dev/null || true
`);
  fs.writeFileSync(second, 'printf "later\\n" > "$STOP_CASE/later"\n');
  const callback = broken ? ':' : 'interrupt_sweep 143';
  fs.writeFileSync(runner, original.replace(anchor, `trap 'printf "TERM\\n" >> "$STOP_CASE/ack"; ${callback}' TERM`));
  const env = { ...process.env, STOP_CASE: dir, TMPDIR: path.join(dir, 'tmp'), WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(dir, '*.selftest.sh'), WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: '1' };
  // Inherit the real admitted host FIFO; no per-install lock override.
  const child = spawn('bash', [runner], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const owner = nativeIdentity(child.pid!); assert.equal(owner.pgid, child.pid);
  let stdout = '', stderr = '', ended = false;
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const close = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  const observe = (file: string) => waitForCondition({ site: 'sweep-stop.publication', paths: [dir], predicate: () => {
    if (fs.existsSync(file)) return true;
    assert(!ended, `runner exited before ${path.basename(file)}`); return false;
  } });
  const ready = observe(path.join(dir, 'first.pid')); let firstOwner: ReturnType<typeof nativeIdentity> | undefined;
  let keeper = 0; const record: any = { name, broken, source: fs.readFileSync(runner, 'utf8'), setup, owner };
  try {
    await ready.promise;
    const pid = Number(fs.readFileSync(path.join(dir, 'first.pid'), 'utf8')); firstOwner = nativeIdentity(pid);
    keeper = Number(fs.readFileSync(path.join(dir, 'keeper.pid'), 'utf8')); assert(alive(pid) && alive(keeper)); assert.equal(firstOwner.pgid, pid);
    record.first = firstOwner; record.keeper = keeper;
    const ack = observe(path.join(dir, 'ack'));
    try { assert(child.kill('SIGTERM')); await ack.promise; } finally { ack.cancel(); }
    record.ack = fs.readFileSync(path.join(dir, 'ack'), 'utf8'); assert.equal(record.ack, 'TERM\n');
    // No scheduling sleep: the real trap acknowledged TERM before release.
    fs.writeSync(fd, 'finish\n');
    record.result = await close; record.stdoutEOF = child.stdout.readableEnded; record.stderrEOF = child.stderr.readableEnded;
    assert(record.stdoutEOF && record.stderrEOF); assert.equal(record.result.signal, null);
    record.later = fs.existsSync(path.join(dir, 'later')); record.laterStart = stdout.includes('selftest-sweep: START ' + second);
    record.survivors = [firstOwner.pid, keeper].filter(alive);
    assert.deepEqual(record.survivors, []); assert(stderr.includes('selftest-sweep: CLEAN ' + first));
    if (broken) {
      assert([0, 1].includes(record.result.code), 'control did not complete the ordinary suite loop'); assert(record.later && record.laterStart, 'removed stop handler did not expose next-suite START');
      let caught: any; try { assert(!record.laterStart, 'SWEEP_TERM_CONTINUED: later suite START after acknowledged TERM'); } catch (e) { caught = e; }
      assert(caught?.message.includes('SWEEP_TERM_CONTINUED')); record.detected = caught.message;
      console.log('CONTROL sweep TERM: ' + record.detected);
    } else {
      assert.equal(record.result.code, 143); assert(!record.later && !record.laterStart, 'SWEEP_TERM_CONTINUED: later suite START after TERM');
    }
    console.log(`PASS sweep TERM ${name}: native${record.result.code}, both EOFs, next START=${record.laterStart}, first survivors=0`);
  } finally {
    ready.cancel(); fs.closeSync(fd); record.stdout = stdout; record.stderr = stderr;
    // Direct launcher group + its suite group, pinned before signaling. Never
    // discover or adopt a host PID by name. These guards run only on failure.
    for (const known of [firstOwner, owner]) if (known && alive(known.pid)) {
      const now = nativeIdentity(known.pid); assert.equal(now.pgid, known.pgid); assert.equal(now.birth, known.birth); assert.equal(now.command, known.command);
      assert.equal(now.pgid, now.pid); process.kill(-now.pgid, 'SIGKILL');
    }
    await close;
    fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(record, null, 2)); records.push(record);
  }
}
fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(records, null, 2));
