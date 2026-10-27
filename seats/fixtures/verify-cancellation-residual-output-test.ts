// Test-only preload recreates the ordinary scratch without a writer. The main
// test drives the real residual driver, removes its simulated review verdicts,
// then proves the complete record and original failure survive in its streams.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

if (!import.meta.main) {
  const work = path.join(path.resolve(process.argv[2]), 'deleted-scratch');
  const remove = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) !== work) return remove(target, options);
    // Leave the original tree/inode in place only for the explicit test
    // control. A real failed removal must not throw EEXIST before result.json.
    if (process.env.WHEELHOUSE_TEST_RETENTION_SKIP_REMOVAL !== '1') remove(target, options);
    if (!fs.existsSync(work)) fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'ordinary-leftover.txt'), 'test-only ordinary recreation\n');
  }) as typeof fs.rmSync;
} else {
  await main();
}

async function run(args: string[], env: NodeJS.ProcessEnv, ledger: string) {
  const child = spawn('bun', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '', expired = false;
  child.stdout!.on('data', b => stdout += b); child.stderr!.on('data', b => stderr += b);
  if (child.pid) fs.writeFileSync(ledger, child.pid + '\n', { flag: 'wx', mode: 0o600 });
  const timer = setTimeout(() => { expired = true; if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 90000);
  try {
    const result = await new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    assert(!expired, 'residual output test containment expired'); assert.equal(result.signal, null);
    assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.pid) fs.unlinkSync(ledger);
  }
}

async function main() {
  const [root, driver, canary, fixture, runtime, mode] = process.argv.slice(2);
  assert(mode === undefined || mode === '--skip-removal');
  const skipRemoval = mode === '--skip-removal';
  assert(!fs.existsSync(root));
  for (const file of [driver, canary, fixture, path.join(runtime, 'verify.ts')]) assert(fs.statSync(file).isFile());
  const persistent = process.env.WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT!;
  assert(fs.statSync(persistent).isDirectory());
  fs.mkdirSync(root);
  const proof = fs.mkdtempSync(path.join(persistent, 'retention-output-proof-'));
  const ledger = path.join(path.dirname(root), 'groups.retention-output');
  assert(!fs.existsSync(ledger));
  let allJudged = true;
  for (const name of ['ordinary', 'writer']) {
    const copy = path.join(root, `review-copy-${name}`), evidence = path.join(copy, 'verdicts');
    const temporary = path.join(root, `child-tmp-${name}`);
    fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(temporary);
    // A sibling root keeps the driver's existing writer ledger visible to the
    // suite's teardown. Only this simulated copy's verdicts are removed below.
    const subject = path.join(path.dirname(root), `${path.basename(root)}-${name}-driver`);
    assert(!fs.existsSync(subject));
    const args = [driver, subject, canary, fixture, runtime, name === 'ordinary' ? '--ordinary-retention-control' : '--writer-output-control'];
    const result = await run(args, { ...process.env, TMPDIR: temporary, WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT: evidence, WHEELHOUSE_TEST_RETENTION_SKIP_REMOVAL: skipRemoval ? '1' : '0' }, ledger);
    const { stdout, stderr } = result;
    const dirs = fs.readdirSync(evidence).filter(n => n.startsWith(`retention-proof-${name}-`));
    assert.equal(dirs.length, 1, 'must actually create one canary record');
    const record = JSON.parse(fs.readFileSync(path.join(evidence, dirs[0], 'result.json'), 'utf8'));
    const native = JSON.parse(fs.readFileSync(path.join(evidence, dirs[0], 'test-exit.json'), 'utf8'));
    fs.writeFileSync(path.join(proof, `${name}.json`), JSON.stringify({ args, ...result, native, record }, null, 2) + '\n', { mode: 0o600 });
    fs.rmSync(copy, { recursive: true, force: true });
    assert(!fs.existsSync(copy), 'the simulated review verdicts must really be removed');
    const lines = stdout.split('\n').filter(line => line.startsWith('RETENTION_RESIDUAL '));
    assert.equal(lines.length, 1, 'entire residual record must survive copy deletion as one output line');
    assert.deepEqual(JSON.parse(lines[0].slice('RETENTION_RESIDUAL '.length)), record);
    assert.equal(record.scratchGone, false); assert(record.residual);
    assert.equal(typeof record.retainedDiagnostics, 'string', 'isolate retention destination from the child TMPDIR');
    assert(!record.stderr.includes('UNAVAILABLE:'), 'test must not plant a diagnostics storage refusal');
    assert.equal(record.subject.code, 37); assert.equal(native.code, 1);
    if (record.residual.sameInode === true) {
      // This is the canary's real failure, not the planted recreation. The
      // driver already emitted its marker; do not repeat it or judge the seam.
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      allJudged = false;
      process.exitCode = 1;
      continue;
    }
    if (name === 'ordinary') {
      assert.equal(result.code, 1, 'ordinary real failure must fail the suite');
      assert.equal(native.writerPid, null, 'ordinary control must not start a planted writer');
      assert(record.residual.entries.some((e: any) => e.path === 'ordinary-leftover.txt'));
      const failures = stderr.split('\n').filter(line => line.startsWith('FAIL verify-cancellation retention:'));
      assert.equal(failures.length, 1, 'ordinary failure must be reported once');
      assert.equal(stderr, native.stderr, 'forward original stderr, not an assertion around it');
      assert(!stderr.includes('verify-cancellation-residual-test.ts'), 'no secondary driver AssertionError');
      assert.equal(failures[0], 'FAIL verify-cancellation retention: ' + record.failure);
    } else {
      assert.equal(result.code, 0, stderr);
      assert.equal(stderr, '', 'expected planted failure must not add a suite FAIL');
      assert(native.writerPid > 1);
      assert(record.residual.processes.some((p: any) => p.pid === native.writerPid), 'log census must retain the actual writer pid');
    }
    console.log(lines[0]);
    console.log(`PASS retention residual log ${name}: driver${result.code}, canary1, one complete record after copy deletion; ${name === 'ordinary' ? 'one original FAIL, no writer or secondary assertion' : 'writer pid=' + native.writerPid + ' in census'}`);
  }
  if (allJudged) console.log('  ok    retention log survives review-copy deletion and ordinary failure is reported once');
  if (!skipRemoval) {
    // Run both real-failure cases in a child so their intended FAILs do not
    // become suite failures. Its result and both streams remain in the proof.
    const args = [import.meta.path, root + '-real-failure-control', driver, canary, fixture, runtime, '--skip-removal'];
    const result = await run(args, process.env, path.join(path.dirname(root), 'groups.retention-output-control'));
    fs.writeFileSync(path.join(proof, 'real-failure-control.json'), JSON.stringify({ args, ...result }, null, 2) + '\n', { mode: 0o600 });
    assert.equal(result.code, 1, 'surviving original scratch must fail both drivers');
    const lines = result.stdout.split('\n');
    const records = lines.filter(line => line.startsWith('RETENTION_RESIDUAL ')).map(line => JSON.parse(line.slice('RETENTION_RESIDUAL '.length)));
    assert.equal(records.length, 2, 'one whole record per canary run');
    const failures = result.stderr.split('\n').filter(line => line.startsWith('FAIL verify-cancellation retention:'));
    assert.equal(failures.length, 2, 'one original FAIL per canary run');
    const otherStderr = result.stderr.split('\n').filter(line => !line.startsWith('FAIL verify-cancellation retention:')).join('\n');
    assert(!/AssertionError|verify-cancellation-residual-(?:output-)?test\.ts|^\s+at /m.test(otherStderr), 'no secondary assertion, fixture name or stack frame');
    assert(!lines.some(line => line.startsWith('  ok    ')), 'unjudged cases must not print success lines');
    for (const [i, name] of ['ordinary', 'writer'].entries()) {
      const record = records[i];
      assert.equal(record.scratchGone, false); assert.equal(record.residual.sameInode, true);
      assert.equal(failures[i], 'FAIL verify-cancellation retention: ' + record.failure);
      const marker = `RETENTION_REAL_FAILURE ${name}: original scratch survived deletion (sameInode true, ${record.residual.entries.length} paths retained); planted ${name} assertions not judged`;
      assert.equal(lines.filter(line => line === marker).length, 1, 'one explicit unjudged marker per case');
      console.log(`PASS retention real-failure control ${name}: driver1, original inode, ${record.residual.entries.length} paths, one canary FAIL and record, no secondary assertion`);
    }
    assert.equal(lines.filter(line => line.startsWith('RETENTION_REAL_FAILURE ')).length, 2);
    console.log('  ok    residual legs report the real retention failure once and judge nothing planted');
  }
}
