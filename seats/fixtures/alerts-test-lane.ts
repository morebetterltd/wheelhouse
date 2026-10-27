// Real private FIFO/holder, real alerts CLI; only the alert's clock is advanced.
// No live host endpoint, daemon, credentials, or graph mutation is used.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";

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
const implementation = fs.readFileSync(source, "utf8"), file = path.join(seats, "alerts.ts");
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
const env = { ...process.env, HOME: path.join(root, "home"), TMPDIR: base, PATH: bin + path.delimiter + process.env.PATH,
  WHEELHOUSE_ALERTS_ROOT: root, WHEELHOUSE_ALERTS_FIXTURE_TEST_LOCK: lock,
  GIT_CEILING_DIRECTORIES: base + path.delimiter + path.dirname(base) };
assert(env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE, "generic tests must disable host lane observation");
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
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 110000);
  const run = { child, done, output, timer }; supervised.push(run); return run;
}
const json = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const rows = () => fs.existsSync(inbox) ? fs.readFileSync(inbox, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.source?.name === "test-lane-held") : [];
const active = () => json(snapshot).alerts["test-lane-held"]?.active === true;
function reset() { for (const f of [snapshot, inbox, log]) fs.rmSync(f, { force: true }); }
async function check(at: number) {
  const r = await command("bun", ["--preload", clock, file, "check", "--json"], root, { LANE_NOW: String(at) });
  const value = JSON.parse(r.stdout); assert.deepEqual(value, json(snapshot), "published snapshot equals actual CLI output"); return value;
}
function mutate(needle: string, replacement: string) {
  assert.equal(implementation.split(needle).length, 2, "unique actual lane source: " + needle);
  fs.writeFileSync(file, implementation.replace(needle, replacement));
}
async function sensitive(name: string, needle: string, replacement: string, at: number, oracle: () => void | Promise<void>, preserve = false) {
  if (!preserve) reset();
  mutate(needle, replacement);
  try {
    await check(at); // A parse, import, or command failure is NOT sensitivity.
    let red = "";
    try { await oracle(); } catch (e: any) { red = e.message; }
    assert(red.includes(name), `source control must fail the actual ${name} oracle: ${red}`);
    console.log(`REJECT lane ${name}: actual check exit=0; consumer assertion fails with source control ${JSON.stringify(needle)}`);
  } finally { fs.writeFileSync(file, implementation); }
}
function fired() { assert(active() && rows().length === 1, "FIRE: one active lane row required"); }
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
  console.log("alerts test lane: PASS (real private lock/FIFO; 15 source sensitivity controls; bounded helpers)");
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
    for (const f of fs.readdirSync(base)) if (f.endsWith(".log")) fs.copyFileSync(path.join(base, f), path.join(target, f));
  }
}
