// Test-only Bun preload + fixture-owned writer. Never imported by the canary.
// The preload delegates the REAL rmSync, then waits for an acknowledged writer
// recreation before returning. The canary's adjacent delete/existsSync and
// assertion are untouched; ordinary runs never load this scheduling seam.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

if (process.argv[2] === '--writer') {
  const control = path.resolve(process.argv[3]), work = path.resolve(process.argv[4]);
  assert(fs.statSync(control).isDirectory());
  const timer = setTimeout(() => process.exit(98), 60000);
  fs.writeFileSync(path.join(control, 'waiting'), String(process.pid));
  const poll = setInterval(() => {
    if (!fs.existsSync(path.join(control, 'recreate'))) return;
    clearInterval(poll);
    fs.mkdirSync(path.join(work, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(work, 'nested/leftover.txt'), 'fixture residual\n');
    fs.symlinkSync(control, path.join(work, 'outside-link'), 'dir');
    process.chdir(work);
    const fd = fs.openSync(path.join(work, 'writer-open.log'), 'w');
    fs.writeSync(fd, 'fixture-owned writer\n');
    const s = fs.statSync(work, { bigint: true });
    fs.writeFileSync(path.join(control, 'ready'), JSON.stringify({ pid: process.pid, device: String(s.dev), inode: String(s.ino) }));
    setInterval(() => fs.writeSync(fd, 'writing\n'), 20);
  }, 5);
} else {
  const control = process.env.WHEELHOUSE_TEST_RETENTION_WRITER_CONTROL;
  assert(control, 'writer preload requires its explicit fixture control directory');
  const work = path.join(path.resolve(process.argv[2]), 'deleted-scratch');
  assert(fs.statSync(control).isDirectory());
  const remove = fs.rmSync;
  const oldDirectories: number[] = [];
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) !== work) return remove(target, options);
    // Retain the unlinked old inode until process exit, preventing inode reuse
    // from obscuring this deliberate DIFFERENT-directory control.
    oldDirectories.push(fs.openSync(work, 'r'));
    remove(target, options);
    // The canary owns the once-only existence check and its failure record.
    // An extra assertion here could abort before it records unexpected state.
    fs.writeFileSync(path.join(control, 'recreate'), 'after real rmSync\n');
    const deadline = Date.now() + 10000, wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(control, 'ready'))) {
      assert(Date.now() < deadline, 'fixture writer did not acknowledge recreation');
      Atomics.wait(wait, 0, 0, 5);
    }
    assert(fs.statSync(work).isDirectory());
  }) as typeof fs.rmSync;
  process.on('exit', () => { for (const fd of oldDirectories) fs.closeSync(fd); });
}
