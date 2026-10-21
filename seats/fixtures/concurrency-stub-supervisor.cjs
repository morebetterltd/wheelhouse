#!/usr/bin/env node
// Fixture-only launcher: retain the OS exit result and stderr before teardown.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir) throw new Error('fixture supervisor: missing PI_CODING_AGENT_DIR');
fs.mkdirSync(dir, { recursive: true });
const record = path.join(dir, 'stub-launch.json');
const stderr = path.join(dir, 'stub-stderr.log');
const history = path.join(dir, `stub-launch.${process.pid}.json`);
const historyStderr = path.join(dir, `stub-stderr.${process.pid}.log`);
fs.writeFileSync(stderr, ''); fs.writeFileSync(historyStderr, '');
let fixture = fs.realpathSync(dir);
while (!fs.existsSync(path.join(fixture, '.wheelhouse-selftest-fixture'))) {
  const parent = path.dirname(fixture);
  if (parent === fixture) throw new Error('fixture supervisor requires an owned fixture');
  fixture = parent;
}
// An open writer makes peer death observable as native EOF, even if its
// pid is still a zombie or the final history-file notification was lost.
const lifecycle = path.join(dir, `stub-lifecycle.${process.pid}.fifo`);
execFileSync('mkfifo', ['-m', '600', lifecycle]);
let lifecycleFd = fs.openSync(lifecycle, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
const closeLifecycle = () => {
  if (lifecycleFd !== null) { fs.closeSync(lifecycleFd); lifecycleFd = null; }
};
const result = { supervisorPid: process.pid, childPid: null, code: null, signal: null, requestedSignal: null, exited: false, stdoutClosed: false, stderrClosed: false, lifecycle };
const save = () => {
  const text = JSON.stringify(result) + '\n';
  for (const target of [record, history]) {
    const candidate = target + '.new';
    fs.writeFileSync(candidate, text, { mode: 0o600 });
    fs.renameSync(candidate, target);
  }
};
const script = process.env.WHEELHOUSE_CONCURRENCY_STUB_SCRIPT || path.join(__dirname, 'pi-stub.cjs');
if (!fs.realpathSync(script).startsWith(fixture + path.sep)) throw new Error('foreign fixture child script');
const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'],
});
result.childPid = child.pid ?? null;
save();
child.stdout.pipe(process.stdout, { end: false });
child.stdout.on('end', () => { result.stdoutClosed = true; save(); closeLifecycle(); });
child.stderr.on('end', () => { result.stderrClosed = true; save(); });
child.stderr.on('data', data => { fs.appendFileSync(stderr, data); fs.appendFileSync(historyStderr, data); process.stderr.write(data); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  result.requestedSignal = signal; save(); child.kill(signal);
});
child.on('error', error => { result.error = String(error); save(); closeLifecycle(); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  Object.assign(result, { code, signal, exited: true }); save(); closeLifecycle();
  process.exitCode = code ?? (signal === 'SIGKILL' ? 137 : 143);
});
