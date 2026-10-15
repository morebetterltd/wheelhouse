#!/usr/bin/env node
// Fixture-only launcher: retain the OS exit result and stderr before teardown.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir) throw new Error('fixture supervisor: missing PI_CODING_AGENT_DIR');
fs.mkdirSync(dir, { recursive: true });
const record = path.join(dir, 'stub-launch.json');
const stderr = path.join(dir, 'stub-stderr.log');
const history = path.join(dir, `stub-launch.${process.pid}.json`);
const historyStderr = path.join(dir, `stub-stderr.${process.pid}.log`);
fs.writeFileSync(stderr, ''); fs.writeFileSync(historyStderr, '');
const result = { supervisorPid: process.pid, childPid: null, code: null, signal: null, requestedSignal: null, exited: false };
const save = () => {
  const text = JSON.stringify(result) + '\n';
  for (const target of [record, history]) {
    const candidate = target + '.new';
    fs.writeFileSync(candidate, text, { mode: 0o600 });
    fs.renameSync(candidate, target);
  }
};
const child = spawn(process.execPath, [path.join(__dirname, 'pi-stub.cjs'), ...process.argv.slice(2)], {
  stdio: ['inherit', 'inherit', 'pipe'],
});
result.childPid = child.pid ?? null;
save();
child.stderr.on('data', data => { fs.appendFileSync(stderr, data); fs.appendFileSync(historyStderr, data); process.stderr.write(data); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  result.requestedSignal = signal; save(); child.kill(signal);
});
child.on('error', error => { result.error = String(error); save(); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  Object.assign(result, { code, signal, exited: true }); save();
  process.exitCode = code ?? (signal === 'SIGKILL' ? 137 : 143);
});
