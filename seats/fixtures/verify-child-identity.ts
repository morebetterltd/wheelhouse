import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { own } from './verify-readiness';
const [here, root, ...args] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const option = (key: string) => args.find(x => x.startsWith(key + '='))?.slice(key.length + 1);
const selected = option('--case'), helperFile = option('--helper') ?? path.join(here, 'fixtures/verify-child-identity.cjs');
const stubFile = option('--stub') ?? path.join(here, 'verify.selftest.sh');
const helper = createRequire(import.meta.url)(helperFile);
const cases = ['gone', 'zombie', 'reused', 'live', 'regrouped', 'model', 'preload', 'incomplete'];
assert(!selected || cases.includes(selected));
async function until(test: () => boolean, label: string) {
  const end = performance.now() + 30000;
  while (!test()) { assert(performance.now() < end, `containment guard: ${label}`); await Bun.sleep(10); }
}
async function held(dir: string, zombie = false) {
  fs.mkdirSync(dir);
  const child = spawn('perl', ['-MPOSIX', '-e', String.raw`
my ($dir,$zombie)=@ARGV; $SIG{CHLD}="DEFAULT";
if($zombie){ my $kid=fork(); defined($kid) or die "fork: $!"; if($kid){while(!-e "$dir/reap"){select undef,undef,undef,0.01;} waitpid($kid,0); exit 0;} }
open(my $out,">","$dir/pid") or die $!; print $out "$$\n"; close $out;
while(!-e "$dir/release"){
  if(-e "$dir/regroup" && !-e "$dir/regrouped"){POSIX::setpgid(0,0)==0 or die "setpgid: $!";open(my $ack,">","$dir/regrouped") or die $!;close $ack;}
  select undef,undef,undef,0.01;
}
`, dir, zombie ? '1' : '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => stderr += b); child.stdout.resume();
  const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { assert.equal(code, 0, stderr); assert.equal(signal, null); resolve(); }); });
  const stop = async () => { fs.writeFileSync(path.join(dir, 'release'), 'release\n'); fs.writeFileSync(path.join(dir, 'reap'), 'reap\n'); await closed; };
  try {
    await until(() => fs.existsSync(path.join(dir, 'pid')), 'real child readiness');
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    const initial = helper.readProcess(pid); assert.equal(initial.kind, 'present', 'native live subject');
    assert(!initial.identity.state.startsWith('Z'));
    return { pid, initial, stop, release: () => fs.writeFileSync(path.join(dir, 'release'), 'release\n') };
  } catch (e) { await stop(); throw e; }
}
for (const name of cases.filter(x => !selected || x === selected)) {
  const dir = path.join(root, `${process.env.IDENTITY_CASE_TAG ?? 'positive'}-${name}`); fs.mkdirSync(dir);
  try {
    if (['gone', 'zombie', 'reused', 'live', 'regrouped'].includes(name)) {
      const old = await held(path.join(dir, 'old'), name === 'zombie');
      try {
        if (name === 'gone') {
          await old.stop();
          assert.doesNotThrow(() => helper.assertNoSurvivors([helper.inspect(old.initial.identity)]), 'gone must not fail');
        } else if (name === 'zombie') {
          old.release(); let observed: any;
          await until(() => { observed = helper.readProcess(old.pid); return observed.kind === 'present' && observed.identity.state.startsWith('Z'); }, 'native unreaped zombie');
          assert.equal(observed.identity.started, old.initial.identity.started);
          console.log(JSON.stringify({ name, recorded: old.initial, observed }));
          assert.doesNotThrow(() => helper.assertNoSurvivors([helper.inspect(old.initial.identity)]), 'zombie must not fail');
          assert.equal(helper.judge(old.initial.identity, observed), 'zombie');
        } else if (name === 'reused') {
          await old.stop(); await Bun.sleep(1100); // setup spacing, never decides survival
          const foreign = await held(path.join(dir, 'foreign'));
          try {
            assert.notEqual(foreign.initial.identity.started, old.initial.identity.started, 'distinct native births must exist');
            // Controlled PID-slot collision, not forced host PID recycling.
            // Every other old field comes from its real, completed generation.
            const recorded = { ...old.initial.identity, pid: foreign.pid };
            console.log(JSON.stringify({ name, simulatedPidCollision: true, recorded, observed: foreign.initial }));
            assert.doesNotThrow(() => helper.assertNoSurvivors([helper.inspect(recorded)]), 'reused PID must not fail');
            assert.equal(helper.judge(recorded, foreign.initial), 'reused');
            assert.equal(helper.readProcess(foreign.pid).kind, 'present', 'unrelated process must remain alive');
          } finally { await foreign.stop(); }
        } else {
          if (name === 'regrouped') {
            fs.writeFileSync(path.join(dir, 'old/regroup'), 'regroup\n');
            await until(() => fs.existsSync(path.join(dir, 'old/regrouped')), 'real group change');
            assert.notEqual(helper.readProcess(old.pid).identity.pgid, old.initial.identity.pgid);
          }
          const check = helper.inspect(old.initial.identity); console.log(JSON.stringify({ name, check }));
          assert.throws(() => helper.assertNoSurvivors([check]), /surviving fixture child identity/, `${name} must still fail survival check`);
        }
      } finally { await old.stop(); }
    } else if (name === 'model') {
      const source = fs.readFileSync(stubFile, 'utf8'), start = 'cat > "$BIN/pi" <<\'STUB\'\n';
      assert.equal(source.split(start).length, 2);
      const file = path.join(dir, 'pi.cjs'); fs.writeFileSync(file, source.split(start)[1].split('\nSTUB\n')[0]);
      const ledger = path.join(dir, 'ledger'), agent = path.join(dir, 'agent'), reply = path.join(dir, 'reply');
      fs.writeFileSync(ledger, ''); fs.writeFileSync(reply, 'ready\nVERDICT: APPROVE\n');
      const originalTZ = process.env.TZ; process.env.TZ = 'UTC';
      const child = spawn('node', [file, '--mode', 'json'], { env: { ...process.env, TZ: 'Pacific/Honolulu', PI_CODING_AGENT_DIR: agent, STUB_REPLY_FILE: reply, WHEELHOUSE_TEST_WATCHDOG_DIR: dir, WHEELHOUSE_TEST_CHILD_LEDGER: ledger, WHEELHOUSE_TEST_CHILD_IDENTITY: helperFile }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', b => stderr += b); child.stdout.resume();
      const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { assert.equal(code, 0, stderr); assert.equal(signal, null); resolve(); }); });
      try {
        await until(() => fs.existsSync(path.join(dir, 'ready')), 'Node model payload readiness');
        const row = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
        assert.equal(row.identity?.pid, child.pid, 'model missing native identity');
        assert.equal(helper.inspect(row.identity).verdict, 'surviving', 'model timezone must preserve birth');
        console.log(JSON.stringify({ name, row, beforePayloadRelease: true }));
      } finally { fs.writeFileSync(path.join(dir, 'release'), 'release\n'); await closed; if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
    } else if (name === 'preload') {
      const ledger = path.join(dir, 'ledger'); fs.writeFileSync(ledger, '');
      process.env.WHEELHOUSE_TEST_CHILD_LEDGER = ledger; process.env.WHEELHOUSE_TEST_CHILD_IDENTITY = helperFile;
      try {
        const child = own('fixture', 'startup-kill', 'bun', ['-e', 'process.kill(process.pid,"SIGKILL")'], { ...process.env });
        const exit = await child.closed; assert.equal(exit.signal, 'SIGKILL');
        const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(x => JSON.parse(x));
        const launch = rows.find(x => x.event === 'launch'), spawn = rows.find(x => x.event === 'spawn');
        assert.equal(spawn?.identity?.pid, child.child.pid, 'preloaded fixture missing native identity');
        assert.equal(spawn.launchId, launch.launchId);
        assert(!spawn.identity.state.startsWith('Z'));
        console.log(JSON.stringify({ name, rows, exit }));
      } finally { delete process.env.WHEELHOUSE_TEST_CHILD_LEDGER; delete process.env.WHEELHOUSE_TEST_CHILD_IDENTITY; }
    } else {
      assert.throws(() => helper.readProcess(process.pid, () => ({status:0,stdout:'',stderr:'',signal:null})), /incomplete child identity record/, 'incomplete observer must not claim absence');
    }
    console.log(`PASS identity ${name}`);
  } catch (e) { console.error(`CASE_ASSERTION ${name}`); throw e; }
}
if (!selected) {
  const source = fs.readFileSync(helperFile, 'utf8'), stub = fs.readFileSync(stubFile, 'utf8');
  const replace = (text: string, old: string, value: string) => { assert.equal(text.split(old).length, 2, 'mutation anchor: ' + old); return text.replace(old, value); };
  const variants = [
    { name: 'no-absence', mode: 'gone', code: replace(source, 'if (native.status === 1 && !native.stdout.trim()) return { kind: "absent", native };', 'if (native.status === 1 && !native.stdout.trim()) throw new Error("removed absence handling");'), message: 'gone must not fail' },
    { name: 'no-zombie', mode: 'zombie', code: replace(source, 'if (observed.identity.state.startsWith("Z")) return "zombie";', 'if (false) return "zombie";'), message: 'zombie must not fail' },
    { name: 'no-birth', mode: 'reused', code: replace(source, 'if (recorded.started !== observed.identity.started) return "reused";', 'if (false) return "reused";'), message: 'reused PID must not fail' },
    ...['live', 'regrouped'].map(mode => ({ name: 'no-assert-' + mode, mode, code: replace(source, '    assert.notEqual(check.verdict, "surviving", `surviving fixture child identity ${JSON.stringify(check)}`);', '    void check;'), message: mode + ' must still fail survival check' })),
    { name: 'no-timezone', mode: 'model', code: replace(source, 'LC_ALL: "C", TZ: "UTC"', 'LC_ALL: "C"'), message: 'model timezone must preserve birth' },
    { name: 'no-model-record', mode: 'model', stub: replace(stub, 'if (process.env.WHEELHOUSE_TEST_CHILD_LEDGER) require(process.env.WHEELHOUSE_TEST_CHILD_IDENTITY).recordChild({event:"model"});', 'if (process.env.WHEELHOUSE_TEST_CHILD_LEDGER) fs.appendFileSync(process.env.WHEELHOUSE_TEST_CHILD_LEDGER, JSON.stringify({event:"model",pid:process.pid})+"\\n");'), message: 'model missing native identity' },
    { name: 'no-preload-record', mode: 'preload', code: replace(source, '  recordChild({ event: "spawn", ...role });', '  fs.appendFileSync(process.env.WHEELHOUSE_TEST_CHILD_LEDGER, JSON.stringify({event:"spawn",...role,pid:process.pid})+"\\n");'), message: 'preloaded fixture missing native identity' },
    { name: 'empty-is-absent', mode: 'incomplete', code: replace(source, 'if (native.status !== 0 || !m || Number(m[1]) !== pid) throw new Error(`incomplete child identity record: ${JSON.stringify({ pid, ...native })}`);', 'if (native.status !== 0 || !m || Number(m[1]) !== pid) return {kind:"absent",native};'), message: 'incomplete observer must not claim absence' },
  ];
  for (const v of variants) {
    const file = path.join(root, v.name + '.cjs'), stubCopy = path.join(root, v.name + '.sh');
    fs.writeFileSync(file, v.code ?? source); fs.writeFileSync(stubCopy, v.stub ?? stub);
    const r = spawnSync('bun', [import.meta.path, here, root, '--case=' + v.mode, '--helper=' + file, '--stub=' + stubCopy], { env: { ...process.env, IDENTITY_CASE_TAG: v.name }, encoding: 'utf8', timeout: 60000 });
    fs.writeFileSync(path.join(root, v.name + '.stdout'), r.stdout ?? ''); fs.writeFileSync(path.join(root, v.name + '.stderr'), r.stderr ?? '');
    assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 1, v.name);
    assert(r.stderr.includes('CASE_ASSERTION ' + v.mode)); assert(r.stderr.includes('AssertionError')); assert(r.stderr.includes(v.message), r.stderr);
    console.log(`PASS removal ${v.name}: native exit=1, intended own assertion`); process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  }
}
