// Guard detached adapter-fixture pipelines across normal/deadline teardown.
// Exercise the existing adapter suite/stub under the sweep; never production seats.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { completedCommand } from '../completed-command';
import conditions from './wait-for-condition.cjs';
const { waitForCondition, reconcileConditions } = conditions;
const [mode, ...args] = process.argv.slice(2);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const psPattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;
type Row = { pid: number; ppid: number; pgid: number; stat: string; birth: string; command: string; cwd?: string };
type Receipt = { root: string; stateDir: string; leader: Row; suite: Row; publisher: Row; members: Row[]; launch: any };
function native(file: string, argv: string[], options: any = {}) {
  const r = completedCommand(file, argv, { ...options, env: { ...process.env, LC_ALL: 'C', ...options.env } });
  assert(!r.error && !r.signal, `${file}: unavailable observation`);
  assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  assert.equal(r.stderr, '', `${file}: unread diagnostic`);
  return r;
}
function snapshot() {
  // Schema captured from actual ps/lsof before this consumer was written.
  const ps = native('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command=']);
  const cwd = native('lsof', ['-d', 'cwd', '-Fpcn']);
  assert(ps.stdout.length && cwd.stdout.length, 'empty native inventory');
  const rows: Row[] = ps.stdout.trim().split('\n').map(line => {
    const m = psPattern.exec(line); assert(m, 'unknown native ps record');
    return { pid: +m[1], ppid: +m[2], pgid: +m[3], stat: m[4], birth: m[5], command: m[6] };
  });
  assert(rows.some(r => r.pid === process.pid), 'ps inventory omitted observer');
  const byPid = new Map(rows.map(row => [row.pid, row]));
  let pid = 0;
  for (const line of cwd.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    if (line[0] === 'n') { const row = byPid.get(pid); if (row) row.cwd = line.slice(1); }
  }
  assert(rows.find(r => r.pid === process.pid)?.cwd, 'cwd inventory omitted observer');
  return { rows, ps, cwd };
}
const under = (p: string | undefined, root: string) => p === root || p?.startsWith(root + '/');
const survivors = (rows: Row[], root: string) => rows.filter(r => r.pid !== process.pid &&
  (r.command.includes(root) || under(r.cwd, root)));
function sameIdentity(row: Row, before: Row) {
  for (const key of ['pid', 'pgid', 'birth', 'command'] as const) assert.equal(row[key], before[key], `UNVERIFIED identity ${key}`);
}
function signalGroup(before: Row, signal: NodeJS.Signals) {
  const s = snapshot(), row = s.rows.find(r => r.pid === before.pid);
  if (!row) return false;
  sameIdentity(row, before);
  assert(row.pid > 1 && row.pgid === row.pid, 'not an owned group leader');
  assert.notEqual(row.pgid, s.rows.find(r => r.pid === process.pid)!.pgid, 'refuse caller group');
  process.kill(-row.pgid, signal); return true;
}
function publication(file: string, producer?: number, eligible: () => boolean = () => true) {
  return waitForCondition({ site: 'adapter-lifetime.publication', paths: [path.dirname(file)], predicate: () => {
    if (fs.existsSync(file) && eligible()) return true;
    if (producer) { try { process.kill(producer, 0); } catch (e: any) { if (e.code === 'ESRCH') throw Error('producer exited before publication'); throw e; } }
    return false;
  } });
}
function noSurvivors(rows: Row[], root: string) {
  const hits = survivors(rows, root);
  assert.equal(hits.length, 0, `ADAPTER_LIFETIME_SURVIVOR ${JSON.stringify(hits)}`);
}
function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length, 2, 'mutation/instrumentation anchor must match exactly once');
  return text.replace(from, to);
}
if (mode === 'review') {
  // Run the REAL dispatcher sweep preparation, never a review/model, over a
  // scratch inventory containing exactly one selected adapter suite. The
  // admitted outer suite holds host admission throughout this child. Never
  // substitute a fixture lock for that validated inherited resource.
  const [here, adapterSource, root, evidence] = args;
  assert(!fs.existsSync(root)); fs.mkdirSync(root); fs.mkdirSync(evidence, { recursive: true });
  const lock = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK || '/tmp/wheelhouse-selftest-sweep.lock';
  const project = path.join(root, 'review-runtime');
  native('bash', ['-c', `. "$1" || exit 2
selftest_copy_seat_runtime "$2" "$3" || exit 2
cp -f "$3/adapter.selftest.sh" "$2/seats/adapter.selftest.sh" || exit 2
`, 'lifetime-review', path.join(here, 'selftest-lib.sh'), project, here]);
  const seats = path.join(project, 'seats'); fs.mkdirSync(path.join(seats, 'fixtures'));
  fs.copyFileSync(adapterSource, path.join(seats, 'adapter.ts'));
  let lifetime = fs.readFileSync(path.join(here, 'fixtures/adapter-lifetime.ts'), 'utf8');
  const setupLine = "    fs.mkdirSync(dir); " + "fs.mkdirSync(path.join(dir, 'tmp')); " + "fs.mkdirSync(path.join(dir, 'home'));";
  lifetime = replaceOnce(lifetime, setupLine,
    "    if (name === 'removal-normal') process.env.WHEELHOUSE_LIFETIME_HELD_OBSERVER = String(process.pid); else delete process.env.WHEELHOUSE_LIFETIME_HELD_OBSERVER;\n" + setupLine);
  fs.writeFileSync(path.join(seats, 'fixtures/adapter-lifetime.ts'), lifetime);
  // COPIED test observer only: adversarially hold receipt filesystem advisory
  // checks (including its initial turn) until a real owned IPC checkpoint.
  // No elapsed-time verdict or change to the shipped condition framework.
  const condition = replaceOnce(fs.readFileSync(path.join(here, 'fixtures/wait-for-condition.cjs'), 'utf8'),
    '    if (disposed || checking) return;',
    "    if (site === 'adapter-lifetime.publication' && process.env.WHEELHOUSE_LIFETIME_HELD_OBSERVER === String(process.pid) && origin !== 'checkpoint') { trace({ id, site, event: 'held-advisory', origin }); return; }\n    if (disposed || checking) return;");
  fs.writeFileSync(path.join(seats, 'fixtures/wait-for-condition.cjs'), condition);
  native('git', ['-C', project, 'init', '-q', '-b', 'main']);
  native('git', ['-C', project, 'add', 'seats']);
  native('git', ['-C', project, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'one adapter review-context suite']);
  const tip = native('git', ['-C', project, 'rev-parse', 'HEAD']).stdout.trim();
  const admission = native('bun', [path.join(seats, 'selftest-sweep-lock.ts'), 'inherited', lock]);
  const holder = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
  assert.notEqual(holder, String(process.pid));
  const bd = native('bash', ['-c', 'command -v bd']).stdout.trim();
  process.env.WHEELHOUSE_ADAPTER_LIFETIME_REVIEW_CHILD = '1';
  process.env.WHEELHOUSE_ADAPTER_LIFETIME_ONLY = '1';
  process.env.WHEELHOUSE_ADAPTER_LIFETIME_EVIDENCE = evidence;
  process.env.WHEELHOUSE_SKIP_REAL_PI = '1';
  const api = await import(path.join(seats, 'verify.ts'));
  const result = await api.runDispatcherFullSweep(project, tip, bd, process.env.PATH!, { tier: 'full', reason: 'one selected adapter fixture' });
  const log = fs.readFileSync(result.logPath!, 'utf8');
  fs.writeFileSync(path.join(evidence, 'review-context.json'), JSON.stringify({ tip, result, log, lock, holder, admission, heldAdvisoryCase: 'removal-normal' }, null, 2));
  const records = JSON.parse(fs.readFileSync(path.join(evidence, 'results.json'), 'utf8'));
  for (const r of records) console.log(`REVIEW adapter lifetime ${r.name}: ${r.failure ?? `native${r.result.code}; survivors=${r.survivors.length}; owned IPC=${r.readyCheckpoints}`}`);
  console.log(`REVIEW_CONTEXT adapter lifetime: sweep${result.rc}, suites=${result.timings?.suites.length}, inherited holder=${holder}, no reviewer/model`);
  assert.equal(result.error, undefined, log); assert.equal(result.rc, 0, log);
  assert.equal(result.timings?.suites.length, 1); assert.equal(records.length, 4);
} else if (mode === 'gate') {
  // Fixture-copy instrumentation ONLY: start the one-second real watchdog
  // after a real unrecorded seat is live. No production timeout policy change.
  const observer = publication(args[0], Number(args[1]));
  try { await observer.promise; } finally { observer.cancel(); }
} else if (mode === 'child') {
  const [root, project, ready, finish, suitePid] = args;
  assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
  const adapter = path.join(project, 'seats/adapter.ts');
  fs.writeFileSync(adapter, replaceOnce(fs.readFileSync(adapter, 'utf8'),
    '  await recordLaunchedSeat(name, record); // spawn-record', '  ; // existing state-write canary'));
  const launch = completedCommand('bun', [adapter, 'spawn', 'worker-1'], { cwd: project, env: { ...process.env, WHEELHOUSE_SKIP_BD: '1' } });
  fs.writeFileSync(ready + '.launch.json', JSON.stringify(launch, null, 2));
  assert(!launch.error && !launch.signal); assert.equal(launch.status, 0, launch.stderr);
  const account = path.join(process.env.HOME!, '.pi-seats-alpha/worker-1');
  const launches = fs.readFileSync(path.join(account, 'launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 1, 'fresh real stub launch required');
  const s = snapshot(), leader = s.rows.find(r => r.pid === launches[0].pid), suite = s.rows.find(r => r.pid === Number(suitePid));
  assert(leader && suite); assert.equal(leader.ppid, 1, 'seat did not survive launching shell');
  assert.equal(leader.pgid, leader.pid, 'production detach lost'); assert.equal(suite.pgid, suite.pid);
  assert.notEqual(leader.pgid, suite.pgid, 'stub must escape its launching suite group');
  assert(leader.command.includes(root) && under(leader.cwd, root));
  const members = s.rows.filter(r => r.pgid === leader.pgid);
  assert(members.length >= 2 && members.every(r => r.command.includes(root) || under(r.cwd, root)));
  const state = path.join(project, 'seats/state.json');
  assert(!fs.existsSync(state) || !JSON.parse(fs.readFileSync(state, 'utf8')).seats?.['worker-1'], 'canary unexpectedly recorded seat');
  const publisher = s.rows.find(r => r.pid === process.pid)!;
  assert(publisher && publisher.pgid === suite.pgid && (publisher.command.includes(root) || under(publisher.cwd, root)), JSON.stringify({ publisher, suite, root }));
  const receipt: Receipt = { root, stateDir: path.dirname(process.env.TMPDIR!), leader, suite, publisher, members, launch };
  const guardian = Number(process.env.WHEELHOUSE_ADAPTER_LIFETIME_GUARDIAN);
  assert(Number.isInteger(guardian) && guardian > 1);
  if (finish === 'deadline') process.on('SIGTERM', () => {});
  let notified = false;
  const acknowledge = () => { notified = true; reconcileConditions(); };
  process.on('SIGUSR1', acknowledge);
  const acknowledged = publication(ready + '.ack', guardian, () => notified);
  try {
    fs.writeFileSync(ready + '.native.json', JSON.stringify(s, null, 2));
    fs.writeFileSync(ready, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    console.log(`ADAPTER_LIFETIME_READY ${ready}`);
    await acknowledged.promise;
  } finally { acknowledged.cancel(); process.off('SIGUSR1', acknowledge); }
  fs.writeFileSync(ready + '.released', String(process.pid), { flag: 'wx', mode: 0o600 });
  if (finish === 'deadline') setInterval(() => {}, 1000); // real sweep deadline owns this deliberately idle fixture
} else if (mode === 'run') {
  const [here, adapterSource, root, evidence] = args;
  assert(!fs.existsSync(root)); fs.mkdirSync(root); fs.mkdirSync(evidence, { recursive: true });
  const project = path.join(root, 'runtime');
  const setup = native('bash', ['-c', `. "$1" || exit 2
selftest_copy_seat_runtime "$2" "$3" || exit 2
cp -f "$3/adapter.selftest.sh" "$2/seats/adapter.selftest.sh" || exit 2
git -C "$2" init -q -b main || exit 2
git -C "$2" add seats || exit 2
`, 'lifetime-setup', path.join(here, 'selftest-lib.sh'), project, here]);
  const childHere = path.join(project, 'seats'); fs.mkdirSync(path.join(childHere, 'fixtures'));
  fs.copyFileSync(adapterSource, path.join(childHere, 'adapter.ts'));
  for (const file of ['adapter-lifetime.ts', 'wait-for-condition.cjs']) fs.copyFileSync(path.join(here, 'fixtures', file), path.join(childHere, 'fixtures', file));
  native('git', ['-C', project, 'add', 'seats']);
  const suiteFile = path.join(childHere, 'adapter.selftest.sh'), runnerFile = path.join(childHere, 'selftest-sweep.sh');
  const suiteSource = fs.readFileSync(suiteFile, 'utf8'), runnerSource = fs.readFileSync(runnerFile, 'utf8');
  const helper = path.join(childHere, 'fixtures/adapter-lifetime.ts');
  const records: any[] = []; let failures = 0;
  const keep = (name: string, r: any) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(r, null, 2));
  keep('setup', setup);
  for (const broken of [false, true]) for (const finish of ['normal', 'deadline']) {
    const name = `${broken ? 'removal' : 'positive'}-${finish}`, dir = path.join(root, name), ready = path.join(dir, 'ready.json');
    fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'tmp')); fs.mkdirSync(path.join(dir, 'home'));
    let suite = suiteSource;
    if (broken) {
      suite = replaceOnce(suite, '  selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"', '  : # removal: suite process retirement disabled');
      suite = replaceOnce(suite, '  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null', '  : # removal: suite argv retirement disabled');
    }
    fs.writeFileSync(suiteFile, suite);
    let runner = replaceOnce(runnerSource, '  local deadline=$((SECONDS+SUITE_TIMEOUT_S)) remaining slice renewal_rc=0 poll_rc',
      `  bun ${quote(helper)} gate ${quote(ready + '.released')} "$root" || exit 2\n  local deadline=$((SECONDS+SUITE_TIMEOUT_S)) remaining slice renewal_rc=0 poll_rc`);
    if (broken) runner = replaceOnce(runner, 'signal_suite_tree(){', 'signal_suite_tree(){\n  SUITE_TREE_QUIESCENT=1; SUITE_SURVIVORS=0; return 0 # removal: ALL group/cwd containment disabled');
    fs.writeFileSync(runnerFile, runner);
    keep(name + '.sources', { suite, runner, readinessGateOnly: true, broken, finish });
    const env = { ...process.env, HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'),
      WHEELHOUSE_ADAPTER_LIFETIME_CHILD: finish, WHEELHOUSE_ADAPTER_LIFETIME_READY: ready,
      WHEELHOUSE_ADAPTER_LIFETIME_GUARDIAN: String(process.pid),
      // Normal completion keeps the canonical budget: teardown itself may
      // legitimately take >1s. Only the deadline case arms the short timer.
      WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S: finish === 'deadline' ? '1' : '3600', WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: '1',
      WHEELHOUSE_SELFTEST_SWEEP_PATTERN: suiteFile };
    // Only one selected suite, inherited real host admission. No private lock override.
    const child = spawn('bash', [runnerFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = ''; let readyCheckpoints = 0;
    child.stdout.on('data', b => {
      stdout += b; pending += b;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line === `ADAPTER_LIFETIME_READY ${ready}`) { readyCheckpoints++; reconcileConditions(); }
      }
    });
    child.stderr.on('data', b => stderr += b);
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const published = publication(ready, child.pid); let receipt: Receipt | undefined, result: any;
    const record: any = { name, broken, finish, foregroundControlSignals: [], guardianSignals: [] };
    try {
      await Promise.race([published.promise, closed.then(r => { throw Error('runner closed before live seat: ' + JSON.stringify(r)); })]);
      receipt = JSON.parse(fs.readFileSync(ready, 'utf8')); record.receipt = receipt;
      // Observe native live identities before allowing normal return or arming
      // the short watchdog. File notifications and recheck turns are hints.
      const live = snapshot();
      for (const actor of [receipt!.publisher, receipt!.leader]) {
        const current = live.rows.find(r => r.pid === actor.pid); assert(current, 'owned actor gone before acknowledgement');
        sameIdentity(current, actor); assert(current.command.includes(receipt!.root) || under(current.cwd, receipt!.root));
      }
      record.beforeAcknowledgement = live;
      fs.writeFileSync(ready + '.ack', 'observed live\n', { flag: 'wx', mode: 0o600 });
      process.kill(receipt!.publisher.pid, 'SIGUSR1'); record.acknowledgedPublisher = receipt!.publisher.pid;
      if (broken && finish === 'deadline') {
        // With ALL sweep containment removed, its wait(root) cannot complete.
        // Wait for the actual timeout marker, then end ONLY the foreground
        // suite group. The detached stub group is deliberately left for the
        // post-sweep assertion. This is test-driver containment, not a fix.
        const timed = publication(path.join(receipt!.stateDir, 'timed-out'), child.pid);
        try { await timed.promise; } finally { timed.cancel(); }
        assert(signalGroup(receipt!.suite, 'SIGKILL')); record.foregroundControlSignals.push(receipt!.suite.pid);
      }
      result = await closed; record.result = result; record.stdoutEOF = child.stdout.readableEnded; record.stderrEOF = child.stderr.readableEnded;
      assert(record.stdoutEOF && record.stderrEOF); assert.equal(readyCheckpoints, 1, 'one owned publication checkpoint required');
      assert.equal(fs.readFileSync(ready + '.released', 'utf8'), String(receipt!.publisher.pid), 'publisher must observe owner acknowledgement before return/deadline');
      assert.equal(result.signal, null); assert.equal(result.code, finish === 'normal' ? 0 : 1, stdout + stderr);
      if (finish === 'deadline') assert(stdout.includes('timed out after 1s'), 'not a real sweep deadline');
      assert(stderr.includes('selftest-sweep: CLEAN '), 'runner never reached completed containment check');
      const post = snapshot(); record.post = post; record.survivors = survivors(post.rows, receipt!.root);
      let caught: any;
      try { noSurvivors(post.rows, receipt!.root); } catch (error) { caught = error; }
      if (broken) {
        assert(caught?.message.includes('ADAPTER_LIFETIME_SURVIVOR'), 'removing BOTH defences did not fail the real survivor assertion');
        assert(record.survivors.some((r: Row) => r.pid === receipt!.leader.pid), 'control did not report the actual leaked stub');
        record.detected = caught.message;
        console.log(`CONTROL adapter lifetime ${finish}: ${caught.message}`);
      } else assert(!caught, caught?.message);
    } catch (error: any) {
      failures++; record.failure = String(error);
      record.readyExistsAtFailure = fs.existsSync(ready);
      if (record.readyExistsAtFailure) record.readyAtFailure = JSON.parse(fs.readFileSync(ready, 'utf8'));
      console.error(`FAIL adapter lifetime ${name}: ${error}`);
    }
    finally {
      published.cancel(); record.stdout = stdout; record.stderr = stderr; record.readyCheckpoints = readyCheckpoints; keep(name, record);
      // A control is never permission to leave its actors behind. Every group
      // signal rechecks cached native PID/PGID/birth/argv; unknown is refused.
      if (receipt) {
        if (!result && signalGroup(receipt.suite, 'SIGKILL')) record.guardianSignals.push({ kind: 'suite', pid: receipt.suite.pid });
        if (signalGroup(receipt.leader, 'SIGTERM')) record.guardianSignals.push({ kind: 'stub', pid: receipt.leader.pid });
        const retired = waitForCondition({ site: 'adapter-lifetime.retirement', paths: [dir], predicate: () => survivors(snapshot().rows, receipt!.root).length === 0 });
        try { await retired.promise; } finally { retired.cancel(); }
        record.final = snapshot(); noSurvivors(record.final.rows, receipt.root);
      } else if (child.exitCode === null) child.kill('SIGTERM'); // directly spawned runner; never a discovered host pid
      await closed; keep(name, record); records.push(record);
    }
    if (!record.failure) console.log(`PASS adapter lifetime ${name}: native${result.code}, both EOFs, ${broken ? 'actual leaked stub reported then retired' : 'no argv/cwd survivor; detach preserved'}`);
  }
  keep('results', records); assert.equal(failures, 0, `${failures} adapter lifetime case(s) failed`);
} else throw Error('unknown adapter lifetime mode');
