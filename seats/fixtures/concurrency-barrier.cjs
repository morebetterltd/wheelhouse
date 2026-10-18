#!/usr/bin/env node
// Order probes after accepted prompts. Only records, process exit and native
// pipe EOF decide the result; stat polling reconciles missed fs.watch wakes.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const [project, barrier] = process.argv.slice(2).map(p => fs.realpathSync(p));
let fixture = project;
while (!fs.existsSync(path.join(fixture, '.wheelhouse-selftest-fixture'))) {
  const parent = path.dirname(fixture);
  if (parent === fixture) throw new Error('barrier requires an owned fixture');
  fixture = parent;
}
if (!barrier.startsWith(fixture + path.sep)) throw new Error('barrier outside fixture');
const stateFile = path.join(project, 'seats/state.json');
const state = JSON.parse(fs.readFileSync(stateFile));
const seats = ['worker-a', 'worker-b'].map(name => ({ name, ...state.seats[name], probe: crypto.randomUUID() }));
for (const seat of seats) {
  if (!seat.fifo?.startsWith(fixture + path.sep) || !seat.log?.startsWith(fixture + path.sep) ||
      !seat.accountDir?.startsWith(fixture + path.sep)) throw new Error('foreign endpoint');
  if (!fs.lstatSync(seat.fifo).isFIFO()) throw new Error('missing fixture FIFO');
}
if (new Set(seats.map(seat => seat.log)).size !== seats.length || new Set(seats.map(seat => seat.fifo)).size !== seats.length) {
  throw new Error('barrier requires distinct seat logs and FIFOs');
}
const disposers = [];
let finished = false;
const records = seat => fs.readFileSync(seat.log, 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
function finish(ok, reason, logs) {
  if (finished) return;
  finished = true;
  process.exitCode = ok ? 0 : 1;
  for (const dispose of disposers) dispose();
  console.log(JSON.stringify({ barrierObserved: ok, reason,
    probes: seats.map((seat, i) => logs[i]?.find(row => row.id === seat.probe && row.command === 'barrier_probe') ?? null),
    releaseExists: fs.existsSync(path.join(barrier, 'release')) }));
  if (!ok) console.error('FAIL barrier: both turns must be held before either ends');
}
function check() {
  if (finished) return;
  let logs = [];
  try {
    // Every wake (and every newly armed watch) reconciles the actual files.
    logs = seats.map(records);
    const current = JSON.parse(fs.readFileSync(stateFile));
    for (const [i, seat] of seats.entries()) {
      for (const key of ['pid', 'fifo', 'log', 'accountDir']) {
        if (current.seats[seat.name]?.[key] !== seat[key]) throw new Error(`${seat.name} endpoint changed`);
      }
      if (logs[i].some(row => row.type === 'agent_end')) throw new Error(`${seat.name} turn ended before barrier observation`);
      if (seat.pipeClosed) throw new Error(`${seat.name} lifecycle pipe closed before barrier observation`);
      if (seat.pipeError) throw new Error(`${seat.name} lifecycle pipe failed: ${seat.pipeError}`);
      try { process.kill(seat.pid, 0); }
      catch (error) { throw new Error(`${seat.name} process unavailable: ${error.code}`); }
      const launch = JSON.parse(fs.readFileSync(path.join(seat.accountDir, `stub-launch.${seat.pid}.json`)));
      if (launch.exited) throw new Error(`${seat.name} fixture child exited before barrier observation`);
      if (launch.stdoutClosed) throw new Error(`${seat.name} output pipe closed before barrier observation`);
      if (!seat.pipe) {
        const endpoint = launch.lifecycle;
        if (!endpoint?.startsWith(seat.accountDir + path.sep) || !fs.lstatSync(endpoint).isFIFO()) throw new Error('missing owned lifecycle FIFO');
        // Nonblocking open cannot hang if the writer died before we attached.
        // libuv's pipe handle then supplies native readable/EOF notifications.
        const fd = fs.openSync(endpoint, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
        try { seat.pipe = new net.Socket({ fd, readable: true, writable: false }); }
        catch (error) { fs.closeSync(fd); throw error; }
        disposers.push(() => seat.pipe.destroy());
        seat.pipe.on('end', () => { seat.pipeClosed = true; check(); });
        seat.pipe.on('close', () => { seat.pipeClosed = true; check(); });
        seat.pipe.on('error', error => { seat.pipeError = String(error); check(); });
        seat.pipe.resume();
      }
    }
    const probes = seats.map((seat, i) => logs[i].find(row => row.id === seat.probe && row.command === 'barrier_probe'));
    if (probes.some(p => p && !(p.success === true && p.data?.held === true))) {
      finish(false, 'a probe did not observe a held turn', logs); return;
    }
    if (probes.some(p => !p)) return;
    const ok = logs.every(rows => rows.some(row => row.type === 'agent_start'));
    finish(ok, ok ? 'both held turns observed' : 'missing turn start', logs);
  } catch (error) { finish(false, String(error), logs); }
}
function armNative(target) {
  if (finished) return;
  const watcher = fs.watch(target, check);
  disposers.push(() => watcher.close());
  check();
}
function armReconciliation(target) {
  if (finished) return;
  // This is a scheduling interval, NOT a deadline or a failure threshold.
  // An idle/live peer may wait indefinitely; only check()'s file/native state
  // can finish it. Native file notifications are advisory and can be lost.
  fs.watchFile(target, { interval: 20 }, check);
  disposers.push(() => fs.unwatchFile(target, check));
  check();
}
try {
  for (const seat of seats) {
    armNative(seat.log);
    armReconciliation(seat.log);
    armNative(seat.accountDir);
    armReconciliation(path.join(seat.accountDir, `stub-launch.${seat.pid}.json`));
  }
  for (const seat of seats) {
    if (finished) break;
    const fd = fs.openSync(seat.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(fd, JSON.stringify({ type: 'barrier_probe', id: seat.probe }) + '\n'); }
    finally { fs.closeSync(fd); }
    check();
  }
  check();
} catch (error) { finish(false, String(error), []); }
