#!/usr/bin/env node
// Order probes after each accepted prompt; wait for records, not a time window.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [project, barrier] = process.argv.slice(2).map(p => fs.realpathSync(p));
let fixture = project;
while (!fs.existsSync(path.join(fixture, '.wheelhouse-selftest-fixture'))) {
  const parent = path.dirname(fixture);
  if (parent === fixture) throw new Error('barrier requires an owned fixture');
  fixture = parent;
}
if (!barrier.startsWith(fixture + path.sep)) throw new Error('barrier outside fixture');
const state = JSON.parse(fs.readFileSync(path.join(project, 'seats/state.json')));
const seats = ['worker-a', 'worker-b'].map(name => ({ name, ...state.seats[name], probe: crypto.randomUUID() }));
for (const seat of seats) {
  if (!seat.fifo?.startsWith(fixture + path.sep) || !seat.log?.startsWith(fixture + path.sep)) throw new Error('foreign endpoint');
  if (!fs.statSync(seat.fifo).isFIFO()) throw new Error('missing fixture FIFO');
}
const watchers = [];
let finished = false;
const records = seat => fs.readFileSync(seat.log, 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
function check() {
  if (finished) return;
  try {
    for (const seat of seats) {
      process.kill(seat.pid, 0);
      const launch = path.join(seat.accountDir, `stub-launch.${seat.pid}.json`);
      if (fs.existsSync(launch) && JSON.parse(fs.readFileSync(launch)).exited) throw new Error(`${seat.name} fixture child exited before barrier observation`);
    }
    const logs = seats.map(records);
    const probes = seats.map((seat, i) => logs[i].find(row => row.id === seat.probe && row.command === 'barrier_probe'));
    if (probes.some(p => !p)) return;
    const ok = probes.every(p => p.success && p.data.held) && logs.every(rows =>
      rows.some(row => row.type === 'agent_start') && !rows.some(row => row.type === 'agent_end'));
    finished = true;
    for (const watcher of watchers) watcher.close();
    console.log(JSON.stringify({ barrierObserved: ok, probes, releaseExists: fs.existsSync(path.join(barrier, 'release')) }));
    if (!ok) { console.error('FAIL barrier: both turns must be held before either ends'); process.exitCode = 1; }
  } catch (error) {
    finished = true; for (const watcher of watchers) watcher.close();
    console.error(String(error)); process.exitCode = 1;
  }
}
// Watch append targets themselves: a directory watch need not report writes
// to existing files (notably on native macOS).
for (const log of new Set(seats.map(seat => seat.log))) watchers.push(fs.watch(log, check));
for (const seat of seats) {
  if (!seat.accountDir?.startsWith(fixture + path.sep)) throw new Error('foreign fixture account');
  watchers.push(fs.watch(seat.accountDir, check));
}
for (const seat of seats) {
  const fd = fs.openSync(seat.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  try { fs.writeSync(fd, JSON.stringify({ type: 'barrier_probe', id: seat.probe }) + '\n'); }
  finally { fs.closeSync(fd); }
}
check();
