import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";

const [root, seats, selected] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const modes = ['group', 'scratch', 'term-resistant', 'failed', 'clean', 'bad-cwd', 'bad-before-ps'];
assert(!selected || modes.includes(selected));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const psArgs = ['-ww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,command='];
function ps(pid: number) {
  const r = spawnSync('ps', ['-p', String(pid), ...psArgs], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.ifError(r.error); assert([0, 1].includes(r.status!)); assert.equal(r.stderr, '');
  if (r.status === 1) assert.equal(r.stdout, '');
  return r;
}
function identity(text: string) {
  // Native field layout first captured with ps -ww ... on the host. Parent,
  // state and argv can change; PID/PGID/birth must not change before signaling.
  const m = /^\s*(\d+)\s+\d+\s+(\d+)\s+\S+\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+/.exec(text);
  assert(m, `invalid native ps identity: ${text}`);
  return m.slice(1).join('|');
}
function stopOwned(pid: number, before: string, group = false) {
  const current = ps(pid);
  if (current.status === 1 || /\sZ\S*\s/.test(current.stdout)) return;
  assert.equal(identity(current.stdout), identity(before), 'owned identity changed; not signaled');
  if (group) assert.equal(identity(current.stdout).split('|')[1], String(pid), 'runner was not its own group leader');
  process.kill(group ? -pid : pid, 'SIGKILL');
}
for (const mode of modes.filter(x => !selected || x === selected)) {
  const dir = path.join(root, `case-${process.env.WHEELHOUSE_SURVIVOR_TAG ?? 'positive'}-${mode}`); fs.mkdirSync(dir);
  const suite = path.join(dir, '00-finished.selftest.sh');
  const after = path.join(dir, '01-after.selftest.sh');
  const before = path.join(dir, 'before.ps'), pidFile = path.join(dir, 'child.pid');
  const clean = mode === 'clean', plant = !mode.startsWith('bad-');
  const launch = mode === 'scratch'
    ? `(cd "$TMPDIR" && exec perl -MPOSIX=setsid -e 'setsid or die "setsid: $!"; exec @ARGV or die "exec: $!"' sleep 1000) &`
    : `(cd ${clean ? '"$CHILD_FIX"' : quote(dir)} && ${mode === 'term-resistant' ? "trap '' TERM; " : ''}exec sleep 1000) &`;
  const setup = clean ? `. ${quote(path.join(seats, 'selftest-lib.sh'))}
CHILD_FIX="$(selftest_make_fixture_dir "$TMPDIR/child.XXXXXX")" || exit 2
selftest_isolate_git "$CHILD_FIX" || exit 2
wait(){ printf '%s\\n' "$*" >> ${quote(path.join(dir, 'waits'))}; builtin wait "$@"; }
cleanup(){ selftest_cleanup_fixture_processes "$CHILD_FIX"; selftest_remove_fixture_dir "$CHILD_FIX"; }
selftest_install_cleanup_traps cleanup
` : '';
  fs.writeFileSync(suite, `#!/usr/bin/env bash\nset -eu\n${setup}${plant ? `${launch}
p=$!
printf '%s\\n' "$p" > ${quote(pidFile)}
# Actual exec acknowledgement establishes the subject, not a timed guess.
for i in $(seq 1 200); do
  comm="$(ps -p "$p" -o comm=)"
  case "$comm" in *sleep) break;; esac
  sleep 0.01
done
case "$comm" in *sleep) ;; *) echo 'sleep did not exec' >&2; exit 3;; esac
LC_ALL=C ps -p "$p" ${psArgs.map(quote).join(' ')} > ${quote(before)}
` : ''}printf 'fixture ${mode} body finished\\n'\nexit ${mode === 'failed' ? 23 : 0}\n`);
  fs.writeFileSync(after, `printf 'after\\n' > ${quote(path.join(dir, 'after'))}\n`);
  const env = { ...process.env, WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(dir, 'private.lock'),
    WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(dir, '*.selftest.sh'), WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: '1' };
  if (mode.startsWith('bad-')) {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    // Successful but empty inventories must be incomplete, never CLEAN.
    if (mode === 'bad-cwd') fs.writeFileSync(path.join(bin, 'lsof'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    else {
      const native = spawnSync('bash', ['-c', 'command -v ps'], { encoding: 'utf8' });
      assert.equal(native.status, 0); assert(native.stdout.trim());
      fs.writeFileSync(path.join(bin, 'ps'), `#!/usr/bin/env bash\ncase "$*" in *-axo*) if [ ! -e ${quote(path.join(dir, 'ps-seen'))} ]; then : > ${quote(path.join(dir, 'ps-seen'))}; exit 0; fi ;; esac\nexec ${quote(native.stdout.trim())} "$@"\n`, { mode: 0o755 });
    }
    env.PATH = `${bin}:${env.PATH}`;
  }
  // A sibling outside BOTH ownership boundaries must remain untouched.
  const decoy = spawn('sleep', ['1000'], { cwd: dir, detached: true, stdio: 'ignore' });
  const decoyBefore = ps(decoy.pid!); assert.equal(decoyBefore.status, 0);
  const began = Date.now();
  const runner = spawn('bash', [path.join(seats, 'selftest-sweep.sh')], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const runnerBefore = ps(runner.pid!); assert.equal(runnerBefore.status, 0);
  let stdout = '', stderr = '', pid = 0;
  runner.stdout.on('data', b => stdout += b); runner.stderr.on('data', b => stderr += b);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    runner.once('error', reject); runner.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>(resolve => runner.once('close', () => resolve()));
  // The admitted outer sweep retains its real suite watchdog. Observe this
  // runner's terminal result, identities and both EOFs; a busy host taking
  // >30s to reach containment is not evidence that containment was broken.
  try {
    const result = await exited;
    assert.equal(result.signal, null);
    assert.equal(result.code, clean ? 0 : 1, `wrong runner result for ${mode}: ${stdout}${stderr}`);
    assert.equal(ps(decoy.pid!).status, 0, 'unrelated sibling was signaled');
    if (plant) {
      assert(fs.statSync(before).size > 0); pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert(pid > 1); assert.match(fs.readFileSync(before, 'utf8'), /sleep 1000/);
      const post = ps(pid);
      console.log(JSON.stringify({ mode, pid, elapsedMs: Date.now() - began, runnerExitObserved: true, nativeExit: post.status, stdout: post.stdout, stderr: post.stderr }));
      assert(post.status === 1 || /\sZ\S*\s/.test(post.stdout), `child survived ${mode}: ${post.stdout}`);
      if (clean) {
        assert(fs.existsSync(path.join(dir, 'waits')) && fs.readFileSync(path.join(dir, 'waits'), 'utf8').trim().split('\n').includes(String(pid)), 'teardown did not wait for its child');
        assert(!stderr.includes('selftest-sweep: LEAK '), 'clean teardown was reported as a leak');
      } else {
        assert(stderr.includes(`selftest-sweep: LEAK ${suite} pid=${pid}`), 'missing named survivor');
        assert(stderr.includes(`via=${mode === 'scratch' ? 'scratch' : 'group'}`), 'wrong ownership boundary');
        assert(!stdout.includes(`selftest-sweep: PASS ${suite}`), 'leaking suite passed');
        assert(stdout.includes(`selftest-sweep: FAIL ${suite} rc=${mode === 'failed' ? 23 : 1}`));
        if (mode === 'term-resistant') assert(stderr.includes('KILL owned suite tree pgid='), 'no KILL escalation');
      }
    } else {
      assert(stderr.includes(mode === 'bad-cwd' ? 'suite cwd inventory omitted runner' : 'suite pre-cwd process inventory omitted runner'), 'empty inventory was not rejected');
      assert(stdout.includes(`selftest-sweep: FAIL ${suite} rc=2`));
      assert(!stderr.includes(`selftest-sweep: CLEAN ${suite} `), 'incomplete inspection claimed CLEAN');
    }
    await closed; // real stdout AND stderr EOF, not a throughput deadline
    assert(fs.existsSync(path.join(dir, 'after')), 'following suite did not run');
    assert(!fs.existsSync(env.WHEELHOUSE_SELFTEST_SWEEP_LOCK));
    assert(!fs.existsSync(env.WHEELHOUSE_SELFTEST_SWEEP_LOCK + '.queue'));
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`PASS ${mode}: runner=${result.code}, output EOF, unrelated sibling alive, following suite ran, lock released`);
  } finally {
    fs.writeFileSync(path.join(dir, 'runner.stdout'), stdout); fs.writeFileSync(path.join(dir, 'runner.stderr'), stderr);
    fs.writeFileSync(path.join(dir, 'runner.exit'), `${runner.exitCode}\n`);
    if (runner.exitCode === null) { stopOwned(runner.pid!, runnerBefore.stdout, true); console.error('control cleanup: stopped owned runner group'); }
    if (!pid && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (pid && fs.existsSync(before)) {
      const current = ps(pid);
      if (current.status === 0 && !/\sZ\S*\s/.test(current.stdout)) {
        stopOwned(pid, fs.readFileSync(before, 'utf8'));
        console.error(`control cleanup: stopped owned planted child ${pid}`);
      }
    }
    stopOwned(decoy.pid!, decoyBefore.stdout);
    await Promise.all([closed, new Promise<void>(resolve => decoy.exitCode !== null ? resolve() : decoy.once('exit', () => resolve()))]);
  }
}
