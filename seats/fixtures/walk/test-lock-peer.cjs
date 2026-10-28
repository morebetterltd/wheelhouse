#!/usr/bin/env node
// Protocol double only; the lock and queued heavy-test child are real.
const fs = require('fs'), path = require('path'), cp = require('child_process');
if (process.argv[2] === '--holder') {
  const dir = process.argv[3];
  fs.writeFileSync(path.join(dir, 'holder-ready'), String(process.pid));
  const poll = setInterval(() => {
    if (!fs.existsSync(path.join(dir, 'holder-release'))) return;
    clearInterval(poll); process.exit(0);
  }, 10);
} else {
const dir = process.env.WALK_LOCK_CASE, mode = process.env.WALK_LOCK_MODE;
const lock = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK;
let holder = null;
try { holder = JSON.parse(fs.readFileSync(path.join(lock, 'wheelhouse-selftest-sweep'), 'utf8')); } catch {}
let holderLive = false;
if (holder) try { process.kill(holder.pid, 0); holderLive = true; } catch (e) { if (e.code === 'EPERM') holderLive = true; }
fs.writeFileSync(path.join(dir,'launched.json'), JSON.stringify({pid:process.pid,at:Date.now(),holderPid:holder?.pid,holderLive}));
let child, interrupted;
const reply = () => process.stdout.write(process.env.STUB_REPLY);
const signals = {SIGINT:130,SIGTERM:143};
for (const signal of Object.keys(signals)) process.on(signal, () => {
  interrupted = signal;
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  else process.exit(signals[signal]);
});
const pause = () => new Promise(resolve => setTimeout(resolve,10));
(async()=>{
  if (mode === 'initial') {
    while (!fs.existsSync(path.join(dir,'holder-joined'))) await pause();
    // Test-only adversity: the suite's cmp-guarded old-clock control uses 3s.
    const delay = Number(process.env.WALK_LOCK_VERIFIER_DELAY_MS || 0);
    if (delay) { fs.writeFileSync(path.join(dir,'verifier-delay-started'),String(delay)); await new Promise(resolve => setTimeout(resolve, delay)); }
    reply(); return;
  }
  while (!fs.existsSync(path.join(dir,'start-suite'))) await pause();
  if (mode === 'queue') {
    child = cp.spawn('bash',[process.env.WALK_LOCK_HEAVY,'true'],{env:process.env,stdio:['ignore','inherit','inherit']});
    const result = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    fs.writeFileSync(path.join(dir,'suite-close.json'),JSON.stringify(result));
    if (interrupted) process.exit(signals[interrupted]);
    if (result.code !== 0 || result.signal) throw new Error('queued suite failed');
    reply(); return;
  }
  // No verifier suite is queued in this case, even though an unrelated one is.
  setInterval(()=>{},1000);
  await new Promise(()=>{});
})().catch(e=>{console.error(e);process.exitCode=1;});
}
