// Real private FIFO/holder, real alerts CLI; only the alert's clock is advanced.
// No live host endpoint, daemon, credentials, or graph mutation is used.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { dlopen, FFIType, read } from "bun:ffi";

const [here, base, source] = process.argv.slice(2);
assert(here && base && source);
let marked = false;
for (let d = path.dirname(base); ; d = path.dirname(d)) {
  if (fs.existsSync(path.join(d, ".wheelhouse-selftest-fixture"))) { marked = true; break; }
  if (path.dirname(d) === d) break;
}
assert(marked, "lane test needs an owned fixture ancestor");
fs.mkdirSync(base);
const root = path.join(base, "project"), seats = path.join(root, "seats"), bin = path.join(root, "bin");
for (const d of [seats, bin, path.join(seats, "run"), path.join(seats, "logs"), path.join(root, "wheelhouse"), path.join(root, "home")]) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(here)) if (/\.(ts|sh)$/.test(f) && !f.endsWith(".selftest.sh")) fs.copyFileSync(path.join(here, f), path.join(seats, f));
const original = fs.readFileSync(source, "utf8"), file = path.join(seats, "alerts.ts");
// Trace the actual private CLI observation, not a second racy probe. No hook or
// changed behavior is installed in production alerts; all mutation anchors stay
// in the real implementation and every consumer assertion is unchanged.
const observationFile = path.join(base, "observation.json"), observationAnchor = "const testLane=testLaneInfo();";
assert.equal(original.split(observationAnchor).length, 2);
const implementation = original.replace(observationAnchor, observationAnchor + ` fs.writeFileSync(${JSON.stringify(observationFile)},JSON.stringify(testLane));`);
fs.writeFileSync(file, implementation);
fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
fs.writeFileSync(path.join(seats, "template-drift.sh"), '#!/bin/sh\nprintf \'{"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n', { mode: 0o700 });
fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "github-issue-watch=off\nalert-low-disk-gb=0\nalert-test-lane-held-minutes=1\n");
fs.writeFileSync(path.join(seats, "seats.json"), '{"seats":{"worker-lane":{"role":"worker","account":{"dir":"~/lane-account"}},"commander":{"role":"commander","external":true}}}\n');
fs.writeFileSync(path.join(seats, "state.json"), '{"seats":{}}\n');
const clock = path.join(base, "clock.ts");
fs.writeFileSync(clock, "if(process.env.LANE_NOW) Date.now=()=>Number(process.env.LANE_NOW);\n");
const idle = path.join(base, "lane-idle-holder.cjs"), signals = path.join(base, "signals"), release = path.join(base, "release");
fs.writeFileSync(idle, `const fs=require('fs');
for(const s of ['SIGTERM','SIGINT','SIGHUP','SIGUSR1','SIGUSR2'])process.on(s,()=>fs.appendFileSync(process.argv[2],s+'\\n'));
const timer=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(timer);process.exit(0);}},25);
setTimeout(()=>process.exit(94),120000).unref();
`);
const lock = path.join(seats, "run/lane.lock"), markerFile = path.join(lock, "wheelhouse-selftest-sweep");
const snapshot = path.join(seats, "run/fleet-snapshot.json"), inbox = path.join(seats, "inbox.jsonl"), log = path.join(seats, "logs/alerts.log");
const env: Record<string, string | undefined> = { ...process.env, HOME: path.join(root, "home"), TMPDIR: base, PATH: bin + path.delimiter + process.env.PATH,
  WHEELHOUSE_ALERTS_ROOT: root, WHEELHOUSE_ALERTS_FIXTURE_TEST_LOCK: lock,
  GIT_CEILING_DIRECTORIES: base + path.delimiter + path.dirname(base) };
assert(env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE, "generic tests must disable host lane observation");
// This executable wraps /bin/ps; only the extra rows are synthetic. The real
// host/holder/alert rows and native status remain authoritative on every call.
const psExtra = path.join(base, "ps-extra.txt"), psRaw = path.join(base, "ps-latest.txt"), psWrapper = path.join(bin, "lane-ps");
fs.writeFileSync(psExtra, "");
fs.writeFileSync(psWrapper, `#!/bin/sh
/bin/ps "$@" > ${JSON.stringify(psRaw)}
rc=$?
/bin/cat ${JSON.stringify(psRaw)}
[ "$rc" = 0 ] || exit "$rc"
/bin/cat ${JSON.stringify(psExtra)}
`, { mode: 0o700 });
env.WHEELHOUSE_ALERTS_FIXTURE_PS = psWrapper;
const children: ChildProcess[] = [];
const ownedHolders = new Set<number>();
function command(command: string, args: string[], cwd = root, extra: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) reject(new Error(`lane command incomplete: ${command} ${args.join(" ")}: ${e.message}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr, code: 0 });
    });
    children.push(child); child.stdin?.end();
  });
}
async function until(subject: string, predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert(Date.now() < deadline, "bounded wait expired: " + subject); await Bun.sleep(25); }
}
const supervised: { child: ChildProcess; done: Promise<number | null>; output: number; timer: ReturnType<typeof setTimeout> }[] = [];
function supervise(label: string, args: string[], cwd: string) {
  const output = fs.openSync(path.join(base, label + ".log"), "w");
  const child = spawn("bun", [path.join(here, "selftest-sweep-lock.ts"), "supervise", lock, "bash", "-c", 'exec "$@"', "lane-payload", ...args], {
    cwd, env: { ...env, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock }, stdio: ["ignore", output, output], detached: true,
  });
  children.push(child);
  const done = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  // Hard containment only for this private fixture family, never host admission.
  const timer = setTimeout(() => {
    if(child.exitCode===null&&child.signalCode===null) try { process.kill(-child.pid!, "SIGKILL"); } catch {}
  }, 110000);
  const run = { child, done, output, timer }; supervised.push(run); return run;
}
// The real waiter polls acquire() under an EXCLUSIVE parent-directory flock.
// observeTestLane intentionally uses SH|NB and returns unknown while that writer
// owns it. Resetting the snapshot and checking once in that window yields zero
// rows, not a missing FIRE_DETAIL. Hold a SH reader lease across each CLI check:
// writers wait, the CLI takes its own SH lease, and no observation is retried or
// synthesized. This touches ONLY this fixture's private parent, never host locks.
const darwin = process.platform === "darwin";
assert(darwin || process.platform === "linux");
const flock = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
});
const SH = 1, EX = 2, NB = 4;
let writerBlocked: (() => void) | undefined;
async function parentLease(mode: number) {
  const parent = path.dirname(lock);
  assert(parent === path.join(seats, "run") && parent.startsWith(base + path.sep));
  const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    await until("private parent reader/writer lease", () => {
      if (flock.symbols.flock(fd, mode | NB) === 0) return true;
      const errno = read.i32(flock.symbols[darwin ? "__error" : "__errno_location"]() as number);
      assert(errno === constants.errno.EWOULDBLOCK || errno === constants.errno.EAGAIN, "native private flock errno=" + errno);
      if (mode === SH) writerBlocked?.();
      return false;
    });
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}
const json = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const alertRows = () => fs.existsSync(inbox) ? fs.readFileSync(inbox, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.class === "alert") : [];
const rows = () => alertRows().filter(r => r.source?.name === "test-lane-held");
const active = () => json(snapshot).alerts["test-lane-held"]?.active === true;
function reset() { for (const f of [snapshot, inbox, log]) fs.rmSync(f, { force: true }); }
let sourceControl = "";
async function check(at: number) {
  const reader = await parentLease(SH);
  try {
    const r = await command("bun", ["--preload", clock, file, "check", "--json"], root, { LANE_NOW: String(at) });
    const value = JSON.parse(r.stdout); assert.deepEqual(value, json(snapshot), "published snapshot equals actual CLI output");
    const observed = json(observationFile);
    // Capture immediately, including the exact table the wrapper delivered and
    // a fresh native observation. A later retry cannot recover a vanished row.
    if (observed.status === "unavailable") {
      const n = fs.existsSync(path.join(base, "checks.jsonl")) ? fs.readFileSync(path.join(base, "checks.jsonl"), "utf8").trim().split("\n").length + 1 : 1;
      if (fs.existsSync(psRaw)) fs.copyFileSync(psRaw, path.join(base, `ps-input.${n}.txt`));
      fs.copyFileSync(psExtra, path.join(base, `ps-extra.${n}.txt`));
      const table = await new Promise<{ stdout: string; stderr: string; error: string | null }>(resolve => {
        const child = execFile("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], { env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ stdout, stderr, error: error?.message ?? null }));
        children.push(child); child.stdin?.end();
      });
      fs.writeFileSync(path.join(base, `ps-table.${n}.txt`), table.stdout);
      fs.writeFileSync(path.join(base, `ps-table.${n}.stderr`), table.stderr);
      fs.writeFileSync(path.join(base, `ps-table.${n}.result.txt`), JSON.stringify({ error: table.error }));
    }
    const evidence = { at, nativeCode: r.code, sourceControl, observed, active: value.alerts["test-lane-held"]?.active, alertNames: alertRows().map(r => r.source?.name), laneRows: rows().length };
    fs.appendFileSync(path.join(base, "checks.jsonl"), JSON.stringify(evidence) + "\n");
    console.log((sourceControl === "TABLE_SKIP" ? "CAPTURE lane source-control check " : "CAPTURE lane check ") + JSON.stringify(evidence));
    return value;
  } finally { fs.closeSync(reader); }
}
function mutate(needle: string, replacement: string) {
  assert.equal(implementation.split(needle).length, 2, "unique actual lane source: " + needle);
  fs.writeFileSync(file, implementation.replace(needle, replacement));
}
async function sensitive(name: string, needle: string, replacement: string, at: number, oracle: () => void | Promise<void>, preserve = false) {
  if (!preserve) reset();
  mutate(needle, replacement);
  sourceControl = name;
  let writer = -1, blocked = false;
  // Reproduce the formerly accidental input race on EVERY fixture execution.
  // An independent native EX lease is released only after the reader actually
  // observes contention, not after a guessed delay. Removing the SH barrier
  // leaves this writer present during the CLI and reproduces the original FIRE
  // failure (CLI0, observation busy, zero rows), never FIRE_DETAIL credit.
  if (needle === 'heldMs=${heldMs}; ') {
    writer = await parentLease(EX);
    writerBlocked = () => { if (writer >= 0) { blocked = true; fs.closeSync(writer); writer = -1; } };
  }
  try {
    await check(at); // A parse, import, or command failure is NOT sensitivity.
    let red = "";
    try { await oracle(); } catch (e: any) { red = e.message; }
    assert(red.includes(name), `source control must fail the actual ${name} oracle: ${red}`);
    if (needle === 'heldMs=${heldMs}; ') assert(blocked, "native writer must overlap the observation attempt");
    console.log(`REJECT lane ${name}: actual check exit=0; consumer assertion fails with source control ${JSON.stringify(needle)}`);
    if (blocked) console.log("CAPTURE lane contention: actual EX writer blocked SH reader; writer released before CLI; FIRE_DETAIL still rejects its missing field");
  } finally {
    sourceControl = "";
    writerBlocked = undefined;
    if (writer >= 0) fs.closeSync(writer);
    fs.writeFileSync(file, implementation);
  }
}
function fired() { assert(active() && rows().length === 1 && alertRows().length === 1, "FIRE: exactly one active inbox alert row required"); }
function running(marker: any, before: string) {
  assert(process.kill(marker.pid, 0), "NO_ACTION: holder remains alive");
  assert(!fs.existsSync(signals) || !fs.readFileSync(signals, "utf8"), "NO_ACTION: holder received a signal");
  assert.equal(fs.readFileSync(markerFile, "utf8"), before, "NO_ACTION: admission marker must remain byte-identical");
}
let holder: ReturnType<typeof supervise> | undefined, waiter: ReturnType<typeof supervise> | undefined;
async function start(cwd: string, label: string) {
  fs.rmSync(release, { force: true }); fs.rmSync(signals, { force: true });
  holder = supervise(label, ["node", idle, signals, release], cwd);
  await until("real holder admission", () => fs.existsSync(markerFile));
  const marker = json(markerFile);
  ownedHolders.add(marker.pid);
  assert.equal(marker.kind, "wheelhouse-selftest-sweep"); assert(Number.isInteger(marker.pid));
  console.log("CAPTURE lane admission " + JSON.stringify({ pid: marker.pid, started: marker.started, command: ["node", idle, signals, release], cwd, label }));
  return marker;
}
async function queue() {
  waiter = supervise("waiter-" + supervised.length, ["node", "-e", "process.exit(0)"], root);
  await until("real queued waiter", () => {
    try { return fs.readdirSync(lock + ".queue").filter(n => /^\d{20}\./.test(n)).length === 2; } catch { return false; }
  });
}
async function finish() {
  const retiring=json(markerFile).pid;
  fs.writeFileSync(release, "release by fixture owner\n");
  assert.equal(await holder!.done, 0, "holder exits only on owner release");
  ownedHolders.delete(retiring);
  if (waiter) assert.equal(await waiter.done, 0, "queued waiter admitted after release");
  waiter = undefined;
  await until("real helper release", () => !fs.existsSync(lock));
}
try {
  const product = path.join(root, "product"), worktree = path.join(root, ".wheelhouse-worktrees/worker-lane"), outside = path.join(root, "outside");
  fs.mkdirSync(product); fs.mkdirSync(outside);
  await command("git", ["init", "-q", "-b", "main"], product);
  await command("git", ["-c", "user.name=Lane Fixture", "-c", "user.email=fixture@invalid.example", "commit", "--allow-empty", "-q", "-m", "fixture"], product);
  await command("git", ["worktree", "add", "-q", "-b", "fleet/lane", worktree], product);
  const marker = await start(worktree, "seat-holder"), admitted = Date.parse(marker.started), young = admitted + 30000, old = admitted + 120001;
  const originalMarker = fs.readFileSync(markerFile, "utf8");
  reset(); await check(old); assert(!active() && rows().length === 0, "NO_WAITERS: past-threshold lane without waiter stays quiet");
  await sensitive("NO_WAITERS", 'heldMs>thresholdMs&&observed.waiting>0', 'heldMs>thresholdMs', old,
    () => assert(!active() && rows().length === 0, "NO_WAITERS: must stay quiet"));
  await queue();
  const config=path.join(root,"wheelhouse/.template-source"), configured=fs.readFileSync(config,"utf8");
  fs.writeFileSync(config,configured.replace(/^alert-test-lane-held-minutes=.*\n/m,""));
  reset(); await check(old); assert(!active(),"DEFAULT: two minutes is below the default 60");
  await sensitive("DEFAULT", 'minutesValue("alert-test-lane-held-minutes",60)', 'minutesValue("alert-test-lane-held-minutes",1)', old,
    () => assert(!active(),"DEFAULT: missing setting must use 60 minutes"));
  reset(); await check(admitted+61*60000); fired();
  fs.writeFileSync(config,configured);
  console.log("  ok    test-lane-held uses the 60-minute default and configured override");
  reset(); await check(young); assert(!active() && rows().length === 0, "THRESHOLD: young holder stays quiet");
  await sensitive("THRESHOLD", 'heldMs>thresholdMs&&observed.waiting>0', 'observed.waiting>0', young,
    () => assert(!active() && rows().length === 0, "THRESHOLD: must stay quiet"));
  console.log("  ok    test-lane-held quiet under threshold or with no waiters");
  reset(); await check(old); fired();
  const row = rows()[0];
  console.log("CAPTURE lane alert " + JSON.stringify(row));
  for (const field of [`pid=${marker.pid}`, "lane-idle-holder.cjs", marker.started, "waiting=1", "seat=worker-lane", "heldMs=120001"]) assert(row.detail.includes(field), "FIRE_DETAIL: " + field);
  await check(old + 1); fired();
  console.log("  ok    test-lane-held fires for a holder past threshold with waiters");
  running(marker, originalMarker);
  console.log("  ok    test-lane-held leaves the holder running");
  const nativeTable = await command("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="]);
  fs.writeFileSync(path.join(base, "ps-case-source.txt"), nativeTable.stdout);
  const nativeLines = nativeTable.stdout.trimEnd().split("\n");
  const nativeRow = (pid: number) => {
    const matches = nativeLines.filter(line => Number(/^\s*(\d+)\s/.exec(line)?.[1]) === pid);
    assert.equal(matches.length, 1, "actual native case subject exists exactly once: " + pid);
    return matches[0];
  };
  // Use this stable, unrelated real process for the exact duplicate, never a
  // fabricated whole table or an invented holder identity.
  assert.notEqual(process.pid, marker.pid);
  const unrelated = nativeRow(process.pid), holderRow = nativeRow(marker.pid);
  const extraRows = `fixture row without pid\n9999999 1 - fixture-unreadable-start\n${unrelated}\n`;
  fs.writeFileSync(psExtra, extraRows);
  const unrelatedOracle = () => {
    const observed = json(observationFile);
    assert.equal(observed.status, "held", "TABLE_SKIP: holder remains observable");
    assert.equal(observed.tableSkipped.count, 3, "TABLE_SKIP: all three unrelated rows counted");
    assert.equal(observed.tableSkipped.sample, "fixture row without pid", "TABLE_SKIP: first skipped row retained");
    assert(observed.tableRows > 0, "TABLE_SKIP: real parsed table retained");
    fired();
    for (const field of [`pid=${marker.pid}`, "lane-idle-holder.cjs", marker.started, "waiting=1", "seat=worker-lane", "heldMs=120001"]) assert(rows()[0].detail.includes(field), "TABLE_SKIP: " + field);
    running(marker, originalMarker);
  };
  reset(); await check(old); unrelatedOracle();
  await sensitive("TABLE_SKIP", 'if(!m||!Number.isFinite(Date.parse(m[3]))){ skip(line); continue; }',
    'if(!m||!Number.isFinite(Date.parse(m[3]))) return {status:"unavailable",on:false,sig,detail:`fixture fatal skipped row: rows=${rows.size}; skipped=${tableSkipped.count}; first skipped=${line.slice(0,160)}`,thresholdMs,tableRows:rows.size,tableSkipped};', old, unrelatedOracle);
  fs.writeFileSync(psExtra, extraRows + holderRow + " fixture-conflicting-command\n");
  const ambiguousOracle = () => {
    const observed = json(observationFile);
    assert(observed.status === "unavailable" && observed.detail.startsWith("holder process row ambiguous") && /rows=\d+; skipped=4; first skipped=/.test(observed.detail), "TABLE_AMBIGUOUS: conflicting holder row must explain unavailable");
    assert(observed.tableRows > 0 && observed.tableSkipped.count === 4, "TABLE_AMBIGUOUS: row counts retained");
    assert(!active() && rows().length === 0 && alertRows().length === 0, "TABLE_AMBIGUOUS: no inbox row for ambiguous holder");
    running(marker, originalMarker);
  };
  reset(); await check(old); ambiguousOracle();
  await sensitive("TABLE_AMBIGUOUS", 'if(holderAmbiguous) return unavailable("holder process row ambiguous");', '', old, ambiguousOracle);
  fs.writeFileSync(psExtra, "");
  reset(); await check(old); fired(); running(marker, originalMarker);
  console.log("  ok    test-lane-held ignores process-table rows that are not the holder's");
  await sensitive("FIRE", '"test-lane-held":testLane,', '"test-lane-held":{...testLane,on:false},', old, fired);
  for(const [needle,field] of [
    ['pid=${observed.pid}; ',`pid=${marker.pid}`], ['command=${holder.command}; ',"lane-idle-holder.cjs"],
    ['admitted=${observed.started}; ',marker.started], ['heldMs=${heldMs}; ',"heldMs=120001"],
    ['waiting=${observed.waiting}; ',"waiting=1"], ['; seat=${seat}',"seat=worker-lane"],
  ]) await sensitive("FIRE_DETAIL",needle,"",old,()=>{fired();assert(rows()[0].detail.includes(field),"FIRE_DETAIL: "+field);});
  reset(); await check(old); fired();
  await sensitive("DEDUPE", 'if(shouldFire)', 'if(next.active)', old + 1,
    () => assert.equal(rows().length, 1, "DEDUPE: repeated pass must add no row"), true);
  await sensitive("NO_ACTION", 'return {...observed,on,sig,thresholdMs,heldMs,seat,command:holder.command,', 'process.kill(observed.pid,"SIGTERM"); return {...observed,on,sig,thresholdMs,heldMs,seat,command:holder.command,', old,
    async () => { await Bun.sleep(100); running(marker, originalMarker); });
  // The forbidden-action control signals only our own handler-equipped idle
  // fixture, which records it without exiting; remove that deliberate record.
  fs.rmSync(signals, { force: true });
  reset(); await check(old); fired(); const prior = fs.readFileSync(snapshot, "utf8");
  await finish(); await check(old + 2);
  assert(!active(), "CLEAR: released lane must clear");
  assert(fs.readFileSync(log, "utf8").includes("alert cleared test-lane-held"), "CLEAR_LOG: clear must be logged");
  console.log("  ok    test-lane-held clears after release");
  fs.writeFileSync(snapshot, prior); fs.rmSync(log, { force: true });
  await sensitive("CLEAR_LOG", 'if(!next.active&&was?.active){', 'if(false&&!next.active&&was?.active){', old + 2,
    () => assert(fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("alert cleared test-lane-held"), "CLEAR_LOG: clear must be logged"), true);
  const unknown = await start(outside, "unknown-holder"), unknownMarker=fs.readFileSync(markerFile,"utf8"); await queue();
  const unknownOld = Date.parse(unknown.started) + 120001;
  reset(); await check(unknownOld); fired(); assert(rows()[0].detail.includes("seat=unknown"), "UNKNOWN: unowned holder must be reported");
  console.log("CAPTURE unknown lane alert " + JSON.stringify(rows()[0]));
  console.log("  ok    test-lane-held names seat=unknown for a holder no seat owns");
  await sensitive("UNKNOWN", 'return {...observed,on,sig,thresholdMs,heldMs,seat,command:holder.command,', 'return {...observed,on:on&&seat!=="unknown",sig,thresholdMs,heldMs,seat,command:holder.command,', unknownOld,
    () => assert(active() && rows().length === 1 && rows()[0].detail.includes("seat=unknown"), "UNKNOWN: unknown owner must still fire"));
  running(unknown, unknownMarker);
  const birth=await command("ps",["-p",String(process.pid),"-o","lstart="]);
  console.log("CAPTURE lane ancestor ps "+JSON.stringify(birth));
  const startedAt=new Date(Date.parse(birth.stdout.trim())).toISOString();
  fs.writeFileSync(path.join(seats,"state.json"),JSON.stringify({seats:{"worker-lane":{pid:process.pid,startedAt,log:path.join(seats,"logs/worker-lane.jsonl")}}}));
  reset(); await check(unknownOld); fired();
  assert(rows()[0].detail.includes("seat=worker-lane"),"ANCESTRY: verified seat ancestor must own holder outside worktree");
  console.log("  ok    test-lane-held attributes a verified seat ancestor outside its worktree");
  await sensitive("ANCESTRY",'if(record.pid===cursor&&Math.abs','if(false&&record.pid===cursor&&Math.abs',unknownOld,
    ()=>assert(active()&&rows()[0].detail.includes("seat=worker-lane"),"ANCESTRY: verified seat ancestor required"));
  await finish();
  console.log("alerts test lane: PASS (real private lock/FIFO; 17 source sensitivity controls; bounded helpers)");
} finally {
  for (const run of supervised) {
    clearTimeout(run.timer);
    if (run.child.exitCode === null && run.child.signalCode === null) try { process.kill(-run.child.pid!, "SIGTERM"); } catch {}
  }
  await Bun.sleep(100);
  // A handler-equipped payload deliberately survives TERM. Verify its native
  // command still names our exact private script before hard containment.
  for(const pid of ownedHolders) try {
    const r=await command("ps",["-p",String(pid),"-o","command="]);
    if(r.stdout.includes(idle)) process.kill(pid,"SIGKILL");
  } catch {}
  for (const run of supervised) {
    if (run.child.exitCode === null && run.child.signalCode === null) try { process.kill(-run.child.pid!, "SIGKILL"); } catch {}
    await run.done; fs.closeSync(run.output);
  }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (process.env.WHEELHOUSE_TEST_LANE_EVIDENCE) {
    const target = process.env.WHEELHOUSE_TEST_LANE_EVIDENCE; fs.mkdirSync(target, { recursive: true });
    for (const f of fs.readdirSync(base)) if (f.endsWith(".log") || /^ps-.*\.(txt|stderr)$/.test(f) || f === "checks.jsonl" || f === "observation.json") fs.copyFileSync(path.join(base, f), path.join(target, f));
  }
}
