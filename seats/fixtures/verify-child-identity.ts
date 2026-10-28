import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
import { createRequire } from 'node:module';
import { own } from './verify-readiness';
const [here, root, ...args] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const option = (key: string) => args.find(x => x.startsWith(key + '='))?.slice(key.length + 1);
const selected = option('--case'), helperFile = option('--helper') ?? path.join(here, 'fixtures/verify-child-identity.cjs');
const stubFile = option('--stub') ?? path.join(here, 'verify.selftest.sh');
const helper = createRequire(import.meta.url)(helperFile);
const cases = ['publication', 'gone', 'zombie', 'reused', 'live', 'regrouped', 'model', 'preload', 'incomplete'];
assert(!selected || cases.includes(selected));
function expectSuccessfulClose(child: ReturnType<typeof spawn>, stderr: () => string) {
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      // Throwing out of this callback would leave the promise pending.
      try { assert.equal(code, 0, stderr()); assert.equal(signal, null); resolve(); }
      catch (error) { reject(error); }
    });
  });
  void closed.catch(() => {}); // observe rejection before readiness/finally joins
  return closed;
}
async function until(test: () => boolean, label: string, ended: () => boolean = () => false) {
  console.error(`FIXTURE_WAIT child identity: ${label}`);
  while (!test()) { assert(!ended(), `child exited before ${label}`); await Bun.sleep(10); }
}
async function held(dir: string, zombie = false, blockPublication = false) {
  fs.mkdirSync(dir);
  const child = spawn('perl', ['-MPOSIX', '-MFcntl=:DEFAULT', '-e', String.raw`
my ($dir,$zombie,$block_publication)=@ARGV; $SIG{CHLD}="DEFAULT";
if($zombie){ my $kid=fork(); defined($kid) or die "fork: $!"; if($kid){while(!-e "$dir/reap"){select undef,undef,undef,0.01;} waitpid($kid,0); exit 0;} }
# File existence is the reader's readiness signal. Publish only closed bytes.
my $pid_path = "$dir/pid.pending";
sysopen(my $out,$pid_path,O_WRONLY|O_CREAT|O_EXCL) or die "open PID stage: $!";
if($block_publication){
  open(my $ack,">","$dir/pid-opened") or die $!; close $ack or die $!;
  while(!-e "$dir/publish"){select undef,undef,undef,0.01;}
}
print $out "$$\n" or die "write PID stage: $!"; close $out or die "close PID stage: $!";
rename($pid_path,"$dir/pid") or die "publish PID: $!";
while(!-e "$dir/release"){
  if(-e "$dir/regroup" && !-e "$dir/regrouped"){POSIX::setpgid(0,0)==0 or die "setpgid: $!";open(my $ack,">","$dir/regrouped") or die $!;close $ack;}
  select undef,undef,undef,0.01;
}
`, dir, zombie ? '1' : '0', blockPublication ? '1' : '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => stderr += b); child.stdout.resume();
  const closed = expectSuccessfulClose(child, () => stderr);
  const stop = async () => { fs.writeFileSync(path.join(dir, 'publish'), 'publish\n'); fs.writeFileSync(path.join(dir, 'release'), 'release\n'); fs.writeFileSync(path.join(dir, 'reap'), 'reap\n'); await closed; };
  try {
    if (blockPublication) {
      await until(() => fs.existsSync(path.join(dir, 'pid-opened')), 'child PID stage opened', () => child.exitCode !== null || child.signalCode !== null);
      assert(!fs.existsSync(path.join(dir, 'pid')), 'partial child PID file exposed before publication');
      assert.equal(fs.readFileSync(path.join(dir, 'pid.pending'), 'utf8'), '', 'writer must still be held before PID bytes');
      console.log(JSON.stringify({ event: 'pid-publication-held', childPid: child.pid, published: false, stageBytes: 0 }));
      fs.writeFileSync(path.join(dir, 'publish'), 'publish\n');
    }
    await until(() => fs.existsSync(path.join(dir, 'pid')), 'real child readiness', () => child.exitCode !== null || child.signalCode !== null);
    const text = fs.readFileSync(path.join(dir, 'pid'), 'utf8');
    assert.match(text, /^[1-9][0-9]*\n$/, 'published child PID must be complete');
    const pid = Number(text);
    const initial = helper.readProcess(pid); assert.equal(initial.kind, 'present', 'native live subject');
    assert(!initial.identity.state.startsWith('Z'));
    return { pid, initial, stop, exited: () => child.exitCode !== null || child.signalCode !== null, release: () => fs.writeFileSync(path.join(dir, 'release'), 'release\n') };
  } catch (e) { await stop(); throw e; }
}
for (const name of cases.filter(x => !selected || x === selected)) {
  const dir = path.join(root, `${process.env.IDENTITY_CASE_TAG ?? 'positive'}-${name}`); fs.mkdirSync(dir);
  try {
    if (['publication', 'gone', 'zombie', 'reused', 'live', 'regrouped'].includes(name)) {
      const old = await held(path.join(dir, 'old'), name === 'zombie', name === 'publication');
      try {
        if (name === 'gone') {
          await old.stop();
          assert.doesNotThrow(() => helper.assertNoSurvivors([helper.inspect(old.initial.identity)]), 'gone must not fail');
        } else if (name === 'zombie') {
          old.release(); let observed: any;
          await until(() => { observed = helper.readProcess(old.pid); return observed.kind === 'present' && observed.identity.state.startsWith('Z'); }, 'native unreaped zombie', old.exited);
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
            await until(() => fs.existsSync(path.join(dir, 'old/regrouped')), 'real group change', old.exited);
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
      const child = spawn('bun', [file, '--mode', 'json'], { env: { ...process.env, TZ: 'Pacific/Honolulu', PI_CODING_AGENT_DIR: agent, STUB_REPLY_FILE: reply, WHEELHOUSE_TEST_WATCHDOG_DIR: dir, WHEELHOUSE_TEST_CHILD_LEDGER: ledger, WHEELHOUSE_TEST_CHILD_IDENTITY: helperFile }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '', stdinError: Error | undefined; child.stderr.on('data', b => stderr += b); child.stdout.resume();
      child.stdin.on('error', error => { stdinError = error; });
      child.stdin.end('Child identity fixture prompt delivered on stdin.\n');
      const closed = expectSuccessfulClose(child, () => stderr);
      try {
        await until(() => fs.existsSync(path.join(dir, 'ready')), 'Bun model payload readiness', () => child.exitCode !== null || child.signalCode !== null);
        const row = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
        assert.equal(row.identity?.pid, child.pid, 'model missing native identity');
        assert.equal(helper.inspect(row.identity).verdict, 'surviving', 'model timezone must preserve birth');
        console.log(JSON.stringify({ name, row, beforePayloadRelease: true }));
      } finally {
        fs.writeFileSync(path.join(dir, 'release'), 'release\n');
        try { await closed; assert.ifError(stdinError); }
        finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
      }
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
  const source = fs.readFileSync(helperFile, 'utf8'), stub = fs.readFileSync(stubFile, 'utf8'), fixtureSource = fs.readFileSync(import.meta.path, 'utf8');
  const replace = (text: string, old: string, value: string) => { assert.equal(text.split(old).length, 2, 'mutation anchor: ' + old); return text.replace(old, value); };
  const variants = [
    { name: 'no-atomic-pid', mode: 'publication', fixture: replace(fixtureSource, 'my $pid_path = ' + '"$dir/pid.pending";', 'my $pid_path = ' + '"$dir/pid";'), message: 'partial child PID file exposed before publication' },
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
    const file = path.join(root, v.name + '.cjs'), stubCopy = path.join(root, v.name + '.sh'), fixtureCopy = path.join(root, v.name + '.ts');
    const commandModule = path.join(here, 'fixtures/fixture-command.cjs');
    const helperSource = (v.code ?? source).replace(/require\(['"]\.\/fixture-command\.cjs['"]\)/, 'require(' + JSON.stringify(commandModule) + ')');
    fs.writeFileSync(file, helperSource); fs.writeFileSync(stubCopy, v.stub ?? stub);
    if (v.fixture) {
      const relocated = v.fixture.replace(/^import \{ own \} from .*;$/m, 'import { own } from ' + JSON.stringify(path.join(here, 'fixtures/verify-readiness.ts')) + ';')
        .replace(/^import \{ spawnSync \} from ["']\.\/fixture-command\.cjs["'];$/m, 'import { spawnSync } from ' + JSON.stringify(commandModule) + ';');
      assert.notEqual(relocated, v.fixture, 'fixture control import relocated');
      fs.writeFileSync(fixtureCopy, relocated);
    }
    const r = spawnSync('bun', [v.fixture ? fixtureCopy : import.meta.path, here, root, '--case=' + v.mode, '--helper=' + file, '--stub=' + stubCopy], { env: { ...process.env, IDENTITY_CASE_TAG: v.name }, encoding: 'utf8' });
    fs.writeFileSync(path.join(root, v.name + '.stdout'), r.stdout ?? ''); fs.writeFileSync(path.join(root, v.name + '.stderr'), r.stderr ?? '');
    assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 1, v.name);
    assert(r.stderr.includes('CASE_ASSERTION ' + v.mode)); assert(r.stderr.includes('AssertionError')); assert(r.stderr.includes(v.message), r.stderr);
    console.log(`PASS removal ${v.name}: native exit=1, intended own assertion`); process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  }
}
