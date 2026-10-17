import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'peer') {
  const [name, mode, barrier] = process.argv.slice(3);
  let held = !(mode === 'serialized' && name === 'worker-b'), probe;
  const out = row => process.stdout.write(JSON.stringify(row) + '\n');
  if (held) out({ type: 'agent_start' });
  out({ type: 'fixture_ready' });
  // This is actual serialization: B cannot enter a turn until A finishes.
  if (!held) fs.watch(barrier, () => {
    if (!held && fs.existsSync(path.join(barrier, 'bead-a.finished'))) { held = true; out({ type: 'agent_start' }); }
  });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const command = JSON.parse(line);
    if (command.type === 'fixture_stop') process.exit(0);
    if (command.type === 'barrier_probe') { probe = command.id; return; }
    if (command.type !== 'fixture_go') return;
    if (name === 'worker-a' && mode === 'turn-end') {
      held = false; out({ type: 'agent_end' });
    } else if (!(name === 'worker-a' && (mode === 'output-eof' || mode === 'child-exit'))) {
      out({ id: probe, type: 'response', command: 'barrier_probe', success: true, data: { held } });
    }
    out({ type: 'fixture_go_done' });
    if (name === 'worker-a' && mode === 'output-eof') process.stdout.end();
    if (name === 'worker-a' && mode === 'child-exit') process.exit(23);
  });
} else {
  const [rootArg, barrierSource, supervisorSource, observerSource] = process.argv.slice(2);
  const root = path.resolve(rootArg);
  let fixture = path.dirname(root);
  while (!fs.existsSync(path.join(fixture, '.wheelhouse-selftest-fixture'))) {
    const parent = path.dirname(fixture);
    assert.notEqual(parent, fixture, 'regression requires an owned fixture'); fixture = parent;
  }
  assert(root.startsWith(fixture + path.sep));
  fs.mkdirSync(root);
  const peerScript = path.join(root, 'peer.mjs'), supervisor = path.join(root, 'supervisor.cjs');
  fs.copyFileSync(fileURLToPath(import.meta.url), peerScript); fs.copyFileSync(supervisorSource, supervisor);
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  function command(fifo, value) {
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(fd, JSON.stringify(value) + '\n'); } finally { fs.closeSync(fd); }
  }
  function track(child, dir, onLine = () => {}) {
    const exit = deferred(), close = deferred(); let stdoutEOF = false, stderrEOF = false, stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    readline.createInterface({ input: child.stdout }).on('line', line => onLine(JSON.parse(line)));
    child.stdout.on('end', () => { stdoutEOF = true; }); child.stderr.on('end', () => { stderrEOF = true; });
    child.on('exit', (code, signal) => exit.resolve({ code, signal }));
    const result = { child, exit: exit.promise, close: close.promise, exited: false };
    child.on('close', (code, signal) => {
      result.exited = true;
      const row = { pid: child.pid, code, signal, stdoutEOF, stderrEOF, stdout, stderr };
      fs.writeFileSync(path.join(dir, 'native.json'), JSON.stringify(row, null, 2) + '\n'); close.resolve(row);
    });
    return result;
  }
  async function runCase(label, mode, observe = '') {
    const project = path.join(root, label), barrier = path.join(project, 'turn-barrier');
    fs.mkdirSync(path.join(project, 'seats/logs'), { recursive: true }); fs.mkdirSync(barrier);
    const state = { seats: {} }, peers = [], rows = new Map(); let controller, failure, summary, observationCheckpointUsed = false;
    try {
      for (const name of ['worker-a', 'worker-b']) {
        const accountDir = path.join(project, name), fifo = path.join(accountDir, 'stdin'), log = path.join(project, 'seats/logs', `${name}.jsonl`);
        fs.mkdirSync(accountDir); fs.writeFileSync(log, '');
        const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr); assert(fs.lstatSync(fifo).isFIFO());
        const ready = deferred(), go = deferred(); const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        const child = spawn(process.execPath, [supervisor, 'peer', name, mode, barrier], {
          env: { ...process.env, PI_CODING_AGENT_DIR: accountDir, WHEELHOUSE_CONCURRENCY_STUB_SCRIPT: peerScript }, stdio: [fd, 'pipe', 'pipe'],
        }); fs.closeSync(fd);
        rows.set(name, []);
        const peer = track(child, accountDir, row => {
          fs.appendFileSync(log, JSON.stringify(row) + '\n'); rows.get(name).push(row);
          if (row.type === 'fixture_ready') ready.resolve(true);
          if (row.type === 'fixture_go_done') go.resolve(true);
        });
        Object.assign(peer, { name, fifo, accountDir, ready, go }); peers.push(peer);
        const readiness = await Promise.race([ready.promise, peer.close.then(r => ({ failed: r }))]); assert.equal(readiness, true, `peer exited before ready: ${JSON.stringify(readiness)}`);
        state.seats[name] = { pid: child.pid, accountDir, fifo, log };
      }
      fs.writeFileSync(path.join(project, 'seats/state.json'), JSON.stringify(state));
      const armed = deferred(), checkpoint = deferred();
      const child = spawn(process.execPath, ['--import', observerSource, barrierSource, project, barrier], {
        env: { ...process.env, WHEELHOUSE_BARRIER_OBSERVE: observe }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      controller = track(child, project);
      child.on('message', row => { if (row.type === 'armed') armed.resolve(row); if (row.type === 'checkpoint') checkpoint.resolve(row); });
      const first = await Promise.race([armed.promise, controller.close]);
      if (observe !== 'arm-race') {
        assert.equal(first.type, 'armed', `barrier exited before accepting probes: ${JSON.stringify(first)}`);
        for (const p of peers) command(p.fifo, { type: 'fixture_go' });
        for (const p of peers) {
          const done = await Promise.race([p.go.promise, p.close.then(r => ({ failed: r }))]); assert.equal(done, true, `peer did not process go: ${JSON.stringify(done)}`);
        }
      }
      if (mode === 'child-exit') await peers[0].close;
      if (mode === 'output-eof') {
        const history = path.join(peers[0].accountDir, `stub-launch.${peers[0].child.pid}.json`);
        await new Promise(resolve => {
          const observe = () => {
            if (JSON.parse(fs.readFileSync(history)).stdoutClosed) { fs.unwatchFile(history, observe); resolve(); }
          };
          fs.watchFile(history, { interval: 20 }, observe); observe();
        });
      }
      // Peer go acknowledgements mean the terminal/probe records are already
      // persisted. Ask the observer to run only reconciliation callbacks the
      // barrier actually registered, then report its state over native IPC.
      // This runs in the ORDINARY suite too: missing reconciliation must fail
      // this assertion, not leave the parent awaiting close forever. No clock
      // or attempt budget decides whether the barrier made progress.
      const expected = mode === 'healthy' ? 0 : 1;
      if (!controller.exited) {
        observationCheckpointUsed = true;
        child.send({ type: 'checkpoint' }, () => {});
        const observation = await Promise.race([checkpoint.promise, controller.close]);
        if (observation.type === 'checkpoint') {
          console.log(JSON.stringify({ test: label, observationCheckpoint: observation }));
          assert.equal(observation.exitCode, expected,
            `${label}: barrier still awaiting an impossible condition after observation wake`);
        }
      }
      const result = await controller.close;
      assert.equal(result.code, expected, result.stderr); assert.equal(result.signal, null); assert(result.stdoutEOF && result.stderrEOF);
      const verdict = JSON.parse(result.stdout.trim()); assert.equal(verdict.barrierObserved, expected === 0); assert.equal(verdict.releaseExists, false);
      if (mode === 'turn-end') assert.match(verdict.reason, /turn ended/);
      if (mode === 'output-eof') {
        const launch = JSON.parse(fs.readFileSync(path.join(peers[0].accountDir, `stub-launch.${peers[0].child.pid}.json`)));
        assert.equal(launch.stdoutClosed, true); assert.equal(launch.exited, false); process.kill(launch.childPid, 0);
        assert.match(verdict.reason, /pipe closed/);
      }
      if (mode === 'child-exit') { const native = await peers[0].close; assert.equal(native.code, 23); assert.equal(native.signal, null); assert(native.stdoutEOF && native.stderrEOF); }
      summary = { test: label, mode, barrierExit: result.code, stdoutEOF: true, stderrEOF: true, reason: verdict.reason, releaseExists: false, observationCheckpointUsed, peers: [] };
    } catch (error) { failure = error; }
    finally {
      if (controller && !controller.exited) {
        // Rescue only this recorded direct child AFTER the assertion failed.
        // The native signal outcome is retained and is never called a pass.
        assert(failure); controller.child.kill('SIGTERM');
        const rescued = await controller.close;
        console.error(JSON.stringify({ test: label, rescueAfterAssertion: true, ...rescued }));
      }
      for (const p of peers) {
        if (!p.exited) { try { command(p.fifo, { type: 'fixture_stop' }); } catch (e) { if (e.code !== 'ENXIO') throw e; } }
      }
      for (const p of peers) {
        const r = await p.close; assert(r.stdoutEOF && r.stderrEOF); assert.equal(r.signal, null);
        assert.equal(r.code, mode === 'child-exit' && p.name === 'worker-a' ? 23 : 0);
        summary?.peers.push({ name: p.name, code: r.code, signal: r.signal, stdoutEOF: r.stdoutEOF, stderrEOF: r.stderrEOF });
      }
    }
    if (failure) throw failure;
    console.log(JSON.stringify(summary));
  }
  // Each negative uses a real native terminal/data condition with a withheld
  // probe. These checks used to wait forever rather than report non-overlap.
  const cases = [['lost-notification', 'serialized', 'lost-wake'], ['arming-race', 'turn-end', 'arm-race'],
    ['turn-end', 'turn-end', 'lost-wake'], ['output-eof', 'output-eof', 'lost-wake'],
    ['child-exit', 'child-exit', 'lost-wake'], ['held-overlap', 'healthy']];
  const selected = process.env.WHEELHOUSE_CONCURRENCY_BARRIER_CASE;
  if (selected) assert(cases.some(([label]) => selected === label), 'unknown barrier regression case');
  for (const c of cases) if (!selected || c[0] === selected) await runCase(...c);
  if (!selected) console.log('PASS barrier regression: 6 deterministic probe/lifecycle fixtures; not repeated full-adapter canaries');
}
