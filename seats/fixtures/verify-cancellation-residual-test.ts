// Real retention canary + real writer/lsof/ps, with explicit capture failures.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parseLsof, parsePs } from './verify-cancellation-residual.ts';

const [root, canary, fixture, runtime] = process.argv.slice(2);
for (const file of [canary, fixture, path.join(runtime, 'verify.ts')]) assert(fs.statSync(file).isFile());
assert(!fs.existsSync(root)); fs.mkdirSync(root);
const persistent = process.env.WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT!;
assert(fs.statSync(persistent).isDirectory());
const seam = path.join(import.meta.dir, 'verify-cancellation-retention-writer.ts');
const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'verify-cancellation-residual-capture.json'), 'utf8'));
assert.equal(captured.lsof.code, 1); assert.equal(captured.lsof.stderr, '');
assert.deepEqual(parseLsof(captured.lsof.stdout), [{ pid: 1234, command: 'bun', files: [{ fd: 'cwd', type: 'DIR', path: '/fixture/work' }, { fd: '5', type: 'REG', path: '/fixture/work/held-file' }] }]);
assert.deepEqual(parsePs(captured.ps.stdout), { rows: [{ pid: 1234, ppid: 2222, pgid: 1234, command: 'bun fixture-writer.ts writer' }], errors: [] });
console.log('PASS retention residual parsers: native NUL lsof matches retained despite native1; ps identity fields');

async function waitFor(test: () => boolean, child: ReturnType<typeof spawn>, label: string) {
  const end = Date.now() + 10000;
  while (!test()) { assert(child.exitCode === null && child.signalCode === null, label + ': writer exited'); assert(Date.now() < end, label + ': deadline'); await Bun.sleep(5); }
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn('bun', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '', expired = false;
  child.stdout!.on('data', b => stdout += b); child.stderr!.on('data', b => stderr += b);
  const timer = setTimeout(() => { expired = true; if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 45000);
  try {
    const result = await new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    assert(!expired, 'retention test containment expired'); assert.equal(result.signal, null);
    assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
    return { ...result, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const ledger = path.join(path.dirname(root), 'groups.retention-residual');
const cases = ['ordinary', 'writer', 'lsof-error', 'ps-error', 'lsof-timeout', 'ps-timeout'];
for (const name of cases) {
  const dir = path.join(root, name), target = path.join(dir, 'canary'), work = path.join(target, 'deleted-scratch'), control = path.join(dir, 'control'), bin = path.join(dir, 'bin');
  fs.mkdirSync(control, { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(control, 'do-not-traverse'), 'outside the residual subject');
  const proof = fs.mkdtempSync(path.join(persistent, `retention-proof-${name}-`));
  const env = { ...process.env, WHEELHOUSE_VERIFY_CANCEL_RETENTION_EVIDENCE: proof, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_TEST_RETENTION_WRITER_CONTROL: control };
  const command = name.startsWith('lsof-') ? 'lsof' : 'ps';
  if (name.endsWith('-error') || name.endsWith('-timeout')) fs.writeFileSync(path.join(bin, command), `#!/usr/bin/env bash\nprintf 'planted ${command} capture diagnostic\\n' >&2\n${name.endsWith('-error') ? 'exit ' + (command === 'lsof' ? 23 : 29) : 'exec sleep 60'}\n`, { mode: 0o755 });
  let writer: ReturnType<typeof spawn> | undefined, writerClosed: Promise<unknown> | undefined;
  try {
    if (name !== 'ordinary') {
      writer = spawn('bun', [seam, '--writer', control, work], { stdio: 'ignore', detached: true });
      writerClosed = new Promise((resolve, reject) => { writer!.once('error', reject); writer!.once('close', resolve); });
      assert(writer.pid && writer.pid > 1);
      // The suite's teardown also owns this group if this test is interrupted.
      fs.appendFileSync(ledger, writer.pid + '\n');
      await waitFor(() => fs.existsSync(path.join(control, 'waiting')), writer, 'writer readiness');
    }
    const result = await run([...(writer ? ['--preload', seam] : []), canary, target, fixture, runtime], env);
    fs.writeFileSync(path.join(proof, 'test-exit.json'), JSON.stringify({ name, writerPid: writer?.pid ?? null, ...result }, null, 2) + '\n', { mode: 0o600 });
    const record = JSON.parse(fs.readFileSync(path.join(proof, 'result.json'), 'utf8'));
    assert.equal(record.code, 1); assert.equal(record.subject.code, 37); assert.equal(record.subject.stdoutEOF, true); assert.equal(record.subject.stderrEOF, true);
    if (name === 'ordinary') {
      assert.equal(result.code, 0, result.stderr); assert.equal(record.scratchGone, true); assert.equal(record.failure, null);
      assert(!('residual' in record)); assert(!fs.readdirSync(proof).some(n => n.startsWith('residual-')), 'passing canary must not run capture');
      console.log('PASS retention residual ordinary: scratchGone true, no residual object or capture files');
      continue;
    }
    assert.equal(result.code, 1); assert(result.stderr.includes('FAIL verify-cancellation retention:'));
    assert.equal(record.scratchGone, false); assert(record.failure.includes('AssertionError'));
    const residual = record.residual; assert(residual && !residual.captureError);
    const ready = JSON.parse(fs.readFileSync(path.join(control, 'ready'), 'utf8'));
    assert.equal(ready.pid, writer!.pid); assert.equal(residual.before.error, null); assert.equal(residual.after.error, null);
    assert.equal(residual.after.inode, ready.inode); assert.equal(residual.after.device, ready.device);
    assert.notEqual(residual.before.inode, residual.after.inode); assert.equal(residual.sameInode, false);
    assert.deepEqual(residual.enumerationErrors, []);
    assert.deepEqual(residual.entries.map((entry: any) => entry.path).sort(), ['.', 'nested', 'nested/leftover.txt', 'outside-link', 'writer-open.log'].sort());
    for (const entry of residual.entries) { assert(['directory', 'file', 'symlink'].includes(entry.type)); assert.equal(typeof entry.size, 'number'); assert.equal(typeof entry.mtimeMs, 'number'); }
    assert.equal(residual.entries.find((e: any) => e.path === 'outside-link').type, 'symlink');
    for (const cmd of Object.values(residual.captures) as any[]) {
      assert.equal(typeof cmd.code === 'number' || cmd.code === null, true); assert.equal(typeof cmd.stderr, 'string'); assert.equal(typeof cmd.stdout, 'string'); assert.equal(cmd.timeoutMs, 5000);
    }
    if (name === 'writer') {
      const row = residual.processes.find((p: any) => p.pid === writer!.pid); assert(row, 'lsof/ps census must include the actual planted writer pid');
      assert.equal(row.ppid, process.pid); assert.equal(row.pgid, writer!.pid); assert(row.psMatched && row.command.includes('--writer'));
      assert(row.files.some((f: any) => f.fd === 'cwd' && f.path === work));
      assert(row.files.some((f: any) => f.path === path.join(work, 'writer-open.log')));
      assert.equal(residual.captures.ps.code, 0); assert.equal(residual.captures.ps.signal, null);
      assert([0, 1].includes(residual.captures.lsof.code)); // native1 can carry real matches
      console.log(`PASS retention residual writer: canary1, inode ${residual.before.inode}->${residual.after.inode}, all five paths, writer pid=${writer!.pid} ppid=${row.ppid} pgid=${row.pgid}, native lsof=${residual.captures.lsof.code} ps=0`);
    } else {
      const capture = residual.captures[command];
      assert.equal(capture.error, null); assert(capture.stderr.includes(`planted ${command} capture diagnostic`));
      assert.equal(residual.censusComplete, false);
      if (name.endsWith('-error')) { assert.equal(capture.code, command === 'lsof' ? 23 : 29); assert.equal(capture.signal, null); assert.equal(capture.timedOut, false); }
      else { assert.equal(capture.code, null); assert.equal(capture.signal, 'SIGKILL'); assert.equal(capture.timedOut, true); }
      console.log(`PASS retention residual ${name}: canary1, native=${capture.code} signal=${capture.signal} timedOut=${capture.timedOut}, stderr retained`);
    }
  } finally {
    if (writer?.pid) { try { process.kill(-writer.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; } await writerClosed; fs.unlinkSync(ledger); }
  }
}
console.log('  ok    retention canary records the residual scratch and its writer when deletion does not hold');
