// Run the real fixture with native exec failures, not replacement cleanup logic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type Row = { pid: number; ppid: number; pgid: number; stat: string; birth: string; command: string };
const [input, mode, source] = process.argv.slice(2), root = fs.realpathSync(input);
assert(["startup", "both", "teardown"].includes(mode));
assert(fs.existsSync(path.join(root, ".wheelhouse-selftest-fixture")));
assert.equal(fs.realpathSync(process.env.WHEELHOUSE_SELFTEST_BD_ROOT!), path.join(root, "graph"));
assert(fs.statSync(source).isFile());
const result = path.join(root, "result"), project = path.join(root, "project");
fs.mkdirSync(result);
const read = (name: string) => fs.readFileSync(path.join(result, name), "utf8");
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(result, name), JSON.stringify(value, null, 2) + "\n");
const stateFile = path.join(project, "seats/state.json");
function state() { return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null; }
function parsePs(text: string): Row[] {
  return text.trim().split("\n").filter(Boolean).map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/);
    assert(m, `unparsed native ps record: ${line}`);
    return { pid: +m[1], ppid: +m[2], pgid: +m[3], stat: m[4], birth: m[5].replace(/\s+/g, " "), command: m[6] };
  });
}
function snapshot(label: string): Row[] {
  const r = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], { env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" });
  write(`${label}.ps.json`, { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() });
  assert.equal(r.exitCode, 0); assert.equal(r.stderr.toString(), "");
  return parsePs(r.stdout.toString());
}
async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000; // containment only; expiry is always a failure
  while (!predicate()) { assert(Date.now() < deadline, `containment waiting for ${label}`); await Bun.sleep(20); }
}
function replaceOnce(s: string, from: string, to: string): string { assert.equal(s.split(from).length, 2, `fixture anchor changed: ${from}`); return s.replace(from, to); }
const fixtures = path.join(project, "seats/fixtures"); fs.mkdirSync(fixtures);
const subject = path.join(fixtures, "cleanup-dispatch-errors-subject.ts");
let text = fs.readFileSync(source, "utf8");
// Preserve the entire try/catch/finally body under test. Only command-boundary
// faults and observations are inserted into this private copy.
const body = text.slice(text.indexOf("try {\n  await ok([\"git\""));
text = replaceOnce(text, 'process.on(\'SIGTERM\',()=>process.exit(0));',
  'fs.writeFileSync(${JSON.stringify(path.join(root, "result/peer-pid"))},String(process.pid));process.on(\'SIGTERM\',()=>process.exit(0));');
const spawn = '  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });';
text = replaceOnce(text, spawn, `  const requested = [...argv];
  if (argv[2] === "stop") {
    const file = path.join(project,"seats/state.json");
    const ps = Bun.spawnSync(["ps","-axo","pid=,ppid=,pgid=,stat=,lstart=,command="], {env:{...process.env,LC_ALL:"C"},stdout:"pipe",stderr:"pipe"});
    fs.writeFileSync(path.join(root,"result/before-stop.json"),JSON.stringify({state:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):null,ps:{code:ps.exitCode,stdout:ps.stdout.toString(),stderr:ps.stderr.toString()}},null,2)+"\\n");
  }
  if (${JSON.stringify(mode)} === "startup" && argv[0] === "bd" && argv[1] === "create") {
    argv[0] = path.join(root,"graph/bin/bd"); fs.chmodSync(argv[0],0o644);
  }
  if (${JSON.stringify(mode)} === "both" && argv[2] === "dispatch") argv[4] = "unsafe/task";
  if (${JSON.stringify(mode)} !== "startup" && argv[2] === "stop") argv[0] = path.join(root,"denied-exec");
  fs.appendFileSync(path.join(root,"result/commands.jsonl"),JSON.stringify({requested,argv})+"\\n");
  let child;
  try { child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
  catch (error: any) {
    fs.appendFileSync(path.join(root,"result/spawn-errors.jsonl"),JSON.stringify({argv,code:error.code,message:error.message})+"\\n");
    throw error;
  }`);
assert.equal(text.slice(text.indexOf("try {\n  await ok([\"git\"")), body, "error-preservation body changed by fault injector");
fs.writeFileSync(subject, text);
fs.writeFileSync(path.join(root, "denied-exec"), "#!/bin/sh\nexit 0\n", { mode: 0o644, flag: "wx" });
const launcher = path.join(root, "launch.ts");
fs.writeFileSync(launcher, `import fs from "node:fs";
function diagnostic(e:any):any{return {name:e?.name,code:e?.code,message:e?.message,stack:e?.stack,errors:e instanceof AggregateError?e.errors.map(diagnostic):undefined};}
try { await import(${JSON.stringify(subject)}); }
catch(error) {fs.writeFileSync(${JSON.stringify(path.join(result, "error.json"))},JSON.stringify(diagnostic(error),null,2)+"\\n");console.error(error);process.exitCode=1;}
`);
// An unrecorded process shares the project cwd, but is never a seat. A file
// handshake joins it without sending a signal, so any signal is a real failure.
const canaryFile = path.join(root, "canary.mjs"), release = path.join(root, "release-canary");
fs.writeFileSync(canaryFile, `import fs from 'node:fs';
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>fs.appendFileSync(${JSON.stringify(path.join(result, "canary-signals"))},signal+'\\n'));
fs.writeFileSync(${JSON.stringify(path.join(result, "canary-ready"))},String(process.pid));
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exitCode=0;}},20);
`);
const canary = Bun.spawn(["node", canaryFile], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const canaryOut = new Response(canary.stdout).text(), canaryErr = new Response(canary.stderr).text();
let ownedGroup: Row[] = [], beforeCanary: Row | undefined;
async function stopOwned() {
  const rec = state()?.seats?.["reviewer-1"];
  if (!rec?.pid) return;
  const current = snapshot("before-owned-rescue").find(row => row.pid === rec.pid);
  if (!current || current.stat.startsWith("Z")) return;
  const known = ownedGroup.find(row => row.pid === rec.pid);
  assert(known && current.birth === known.birth && current.pgid === known.pgid, "owned seat identity changed; refusing rescue");
  assert.equal(rec.pid, +read("peer-pid"));
  assert(current.command.includes(path.join(root, "peer.mjs")), "recorded process is not our fake peer");
  const env = { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CLEANUP_SYNC: "1" };
  delete (env as any).WHEELHOUSE_CLEANUP;
  const child = Bun.spawn(["bun", path.join(project, "seats/adapter.ts"), "stop", "reviewer-1"], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  write("owned-rescue.json", { code, signal: child.signalCode, stdout, stderr, stdoutEOF: true, stderrEOF: true });
  assert.equal(code, 0, stderr); assert.equal(child.signalCode, null);
}
let testFailed = false, testError: unknown;
try {
  await waitFor(() => fs.existsSync(path.join(result, "canary-ready")), "unrelated canary readiness");
  beforeCanary = snapshot("before").find(row => row.pid === canary.pid);
  assert(beforeCanary && !beforeCanary.stat.startsWith("Z"));
  const child = Bun.spawn(["bun", launcher, root], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  const code = await child.exited;
  const beforeStop = JSON.parse(read("before-stop.json"));
  assert.equal(beforeStop.ps.code, 0); assert.equal(beforeStop.ps.stderr, "");
  const seat = beforeStop.state?.seats?.["reviewer-1"];
  if (mode === "startup") {
    assert.equal(seat, undefined, "early failure unexpectedly created a seat");
    assert(!fs.existsSync(path.join(root, "account/session.jsonl")));
    assert(!fs.existsSync(path.join(result, "peer-pid")));
  } else {
    assert(seat?.pid > 0, "must prove real seat creation before measuring teardown");
    assert.equal(seat.pid, +read("peer-pid"));
    const rows = parsePs(beforeStop.ps.stdout), peer = rows.find(row => row.pid === seat.pid);
    assert(peer && !peer.stat.startsWith("Z") && peer.command.includes(path.join(root, "peer.mjs")));
    ownedGroup = rows.filter(row => row.pgid === peer.pgid);
    assert(ownedGroup.length && ownedGroup.every(row => row.pid !== canary.pid));
    const stillLive = snapshot("after-native-failure").find(row => row.pid === seat.pid);
    assert(stillLive && stillLive.birth === peer.birth, "fault must really leave the owned seat for measured cleanup");
    await stopOwned(); // only after retaining the subject's native nonzero result
    await waitFor(() => snapshot("drain").every(row => !ownedGroup.some(owned => row.pgid === owned.pgid && !row.stat.startsWith("Z"))), "owned seat group exit");
  }
  const [stdout, stderr] = await Promise.all([out, err]);
  if (fs.existsSync(path.join(root, "invocations.json"))) fs.copyFileSync(path.join(root, "invocations.json"), path.join(result, "invocations.json"));
  fs.writeFileSync(path.join(result, "stdout"), stdout); fs.writeFileSync(path.join(result, "stderr"), stderr);
  write("native.json", { code, signal: child.signalCode, stdoutEOF: true, stderrEOF: true });
  const after = snapshot("after");
  const unchangedCanary = after.find(row => row.pid === canary.pid);
  assert(unchangedCanary && unchangedCanary.birth === beforeCanary.birth && unchangedCanary.pgid === beforeCanary.pgid);
  assert(!fs.existsSync(path.join(result, "canary-signals")), "fixture signalled an unrelated process");
  assert.equal(code, 1); assert.equal(child.signalCode, null);
  const diagnostic = JSON.parse(read("error.json"));
  if (mode === "startup") {
    assert.equal(diagnostic.errors?.[0]?.code, "EACCES", "startup EACCES replaced by teardown diagnostic");
    assert.equal(diagnostic.name, "AggregateError"); assert.equal(diagnostic.errors.length, 2);
    assert.equal(diagnostic.errors[0].code, "EACCES"); assert.match(diagnostic.errors[0].message, /graph\/bin\/bd/);
    assert.match(diagnostic.errors[1].message, /no record of seat/);
    assert.match(stderr, /EACCES/); assert.match(stderr, /no record of seat/);
  } else {
    if (mode === "both") assert.equal(diagnostic.errors?.[0]?.code, "ERR_ASSERTION", "primary dispatch error replaced by teardown diagnostic");
    const errors = mode === "both" ? diagnostic.errors : [diagnostic];
    assert.equal(errors.length, mode === "both" ? 2 : 1);
    if (mode === "both") { assert.equal(diagnostic.name, "AggregateError"); assert.equal(errors[0].code, "ERR_ASSERTION"); assert.match(errors[0].message, /unsafe\/task/); assert.match(stderr, /unsafe\/task/); }
    assert.equal(errors.at(-1).code, "EACCES"); assert.match(errors.at(-1).message, /denied-exec/); assert.match(stderr, /EACCES/);
    if (mode === "teardown") { assert.equal(diagnostic.name, "Error"); assert(stdout.includes("PASS cleanup dispatch: unsafe-root refusals leave recorded task unchanged"), "ordinary ownership checks did not finish before teardown-only fault"); assert(!stdout.includes("FAIL cleanup dispatch:")); }
  }
  const measuredLines = stdout.split("\n").filter(line => line.startsWith("MEASUREMENTS "));
  assert.equal(measuredLines.length, 1, "teardown suppressed MEASUREMENTS");
  const measurements = JSON.parse(measuredLines[0].slice("MEASUREMENTS ".length));
  assert(measurements.length && measurements.every((row: any) => row.signal === null && row.stdoutEOF && row.stderrEOF));
  if (mode === "startup") assert(!measurements.some((row: any) => row.argv[2] === "spawn"));
  write("result.json", { mode, nativeCode: code, errorCodes: mode === "teardown" ? [diagnostic.code] : diagnostic.errors.map((e: any) => e.code), measurements: measurements.length, realSeat: mode !== "startup", ownedGroup, ownedSurvivors: after.filter(row => ownedGroup.some(owned => owned.pgid === row.pgid) && !row.stat.startsWith("Z")), canaryBefore: beforeCanary, canaryAfter: unchangedCanary, canarySignals: [], stdoutEOF: true, stderrEOF: true });
  console.log(`PASS cleanup dispatch errors ${mode}: native1, original ${mode === "teardown" ? "teardown error" : "primary + teardown errors"}, MEASUREMENTS, both EOF, owned seat ${mode === "startup" ? "never created" : "identity-checked stop and group drained"}, unrelated canary unchanged`);
} catch (error) {
  testFailed = true;
  testError = error;
} finally {
  const teardownErrors: unknown[] = [];
  try { await stopOwned(); } catch (error) { teardownErrors.push(error); }
  try {
    fs.writeFileSync(release, "release\n");
    const [code, stdout, stderr] = await Promise.all([canary.exited, canaryOut, canaryErr]);
    write("canary-exit.json", { code, signal: canary.signalCode, stdout, stderr, stdoutEOF: true, stderrEOF: true });
    assert.equal(code, 0); assert.equal(canary.signalCode, null); assert.equal(stdout, ""); assert.equal(stderr, "");
  } catch (error) { teardownErrors.push(error); }
  if (teardownErrors.length) throw new AggregateError([...(testFailed ? [testError] : []), ...teardownErrors], "cleanup error regression and owned teardown diagnostics");
}
if (testFailed) throw testError;
