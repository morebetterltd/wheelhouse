// Native actor gates prove that observations do not complete before their
// subjects publish events. Removal controls keep every actor/setup intact.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

type Capture = { code: number | null; signal: string | null; stdout: string; stderr: string; stdoutEOF: boolean; stderrEOF: boolean };
function start(argv: string[]) {
  const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false;
  const events: any[] = []; let pending = "", onEvent: (() => void) | undefined;
  child.stdout!.on("data", b => { stdout += b; });
  child.stderr!.on("data", b => {
    stderr += b; pending += b;
    for (;;) { const end = pending.indexOf("\n"); if (end < 0) break; const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.startsWith("FIXTURE_OBSERVER ")) { events.push(JSON.parse(line.slice("FIXTURE_OBSERVER ".length))); onEvent?.(); } }
  });
  child.stdout!.on("end", () => { stdoutEOF = true; }); child.stderr!.on("end", () => { stderrEOF = true; });
  const result = new Promise<Capture>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, stdoutEOF, stderrEOF })); });
  return { child, result, get observation() { return new Promise<any>((resolve, reject) => { onEvent = () => { if (events.length) resolve(events[0]); }; onEvent(); result.then(r => { if (!events.length) reject(new Error(`observer exited without an event: ${JSON.stringify(r)}`)); }, reject); }); } };
}
async function entered(file: string, actor: ReturnType<typeof start>) {
  let ended = false; actor.result.then(() => { ended = true; });
  while (!fs.existsSync(file)) { assert(!ended, "actor exited before publishing its entered barrier"); await Bun.sleep(20); }
}
async function one(root: string, mode: string, source: string, label: string) {
  const dir = path.join(root, label); fs.mkdirSync(dir);
  const project = path.join(dir, "project"), ledger = path.join(project, "seats/needs.jsonl"), log = path.join(project, "seats/logs/courier.out.log"), requests = path.join(dir, "requests.jsonl"), ready = path.join(dir, "ready.json"), gate = path.join(dir, "release"), stop = path.join(dir, "stop"), began = path.join(dir, "entered");
  fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(ledger, '{"type":"opened","id":"need-retry"}\n'); fs.writeFileSync(log, ""); fs.writeFileSync(requests, "");
  const script = path.join(dir, "actor.ts");
  fs.writeFileSync(script, `import fs from 'node:fs';
const mode=${JSON.stringify(mode)}, ledger=${JSON.stringify(ledger)}, log=${JSON.stringify(log)}, requests=${JSON.stringify(requests)};
const polls=()=>fs.writeFileSync(requests,Array.from({length:3},()=>JSON.stringify({method:'getUpdates'})+'\\n').join(''));
if(mode==='retry-complete'){polls();fs.appendFileSync(log,'courier scanned 1 event(s)\\ncourier scanned 0 event(s)\\n');fs.appendFileSync(ledger,JSON.stringify({type:'sent',id:'need-retry'}));}
fs.writeFileSync(${JSON.stringify(began)},String(process.pid));
while(!fs.existsSync(${JSON.stringify(gate)}))await Bun.sleep(20);
let server;
if(mode==='ready'){server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response('owned endpoint');}});const f=${JSON.stringify(ready)};fs.writeFileSync(f+'.new',JSON.stringify({pid:process.pid,root:${JSON.stringify(root)},port:server.port}));fs.renameSync(f+'.new',f);}
else if(mode==='retry-complete')fs.appendFileSync(ledger,'\\n');
else {polls();fs.appendFileSync(log,mode==='send-failed'?'send failed need=need-retry: Bad Request: chat not found\\n':mode==='poll-recovered'?'STOP: poll failed: Bad Request: poll failed\\ncourier scanned 0 event(s)\\n':'STOP: poll failed: telegram getUpdates timed out after 200ms\\n');}
while(!fs.existsSync(${JSON.stringify(stop)}))await Bun.sleep(20);
server?.stop(true);
`);
  const actor = start(["bun", script]); let observer: ReturnType<typeof start> | undefined, observed: any, native: Capture | undefined, actorNative: Capture | undefined;
  try {
    await entered(began, actor);
    observer = start(["bun", source, mode, root, String(actor.child.pid), mode === "ready" ? ready : project, requests]);
    observed = await observer.observation;
    const beforeRelease = observed.event === "complete";
    fs.writeFileSync(gate, "release\n");
    native = await observer.result;
    assert.equal(native.code, 0, native.stderr); assert.equal(native.signal, null); assert(native.stdoutEOF && native.stderrEOF);
    if (mode === "ready" && !beforeRelease) { const response = await fetch(`http://127.0.0.1:${Number(native.stdout.trim())}/`); assert.equal(await response.text(), "owned endpoint"); }
    // Retain native data BEFORE the criterion that a removal must fail.
    fs.writeFileSync(path.join(dir, "observer-native.json"), JSON.stringify(native, null, 2) + "\n");
    fs.writeFileSync(stop, "stop\n"); actorNative = await actor.result;
    assert.equal(actorNative.code, 0, actorNative.stderr); assert.equal(actorNative.signal, null); assert(actorNative.stdoutEOF && actorNative.stderrEOF);
    console.log("OBSERVATION_CONTROL " + JSON.stringify({ label, mode, actorEntered: true, event: observed, beforeRelease, observerNative: native, actorNative }));
    assert.equal(beforeRelease, false, "observation completed before the entered actor committed its event");
  } finally {
    fs.writeFileSync(gate, "cleanup\n"); fs.writeFileSync(stop, "cleanup\n");
    if (!actorNative) actorNative = await actor.result;
    if (observer && !native) await observer.result;
  }
}
function copyRuntime(source: string, project: string) {
  const dest = path.join(project, "seats"); fs.mkdirSync(path.join(dest, "run"), { recursive: true });
  for (const name of fs.readdirSync(source)) if (/\.(ts|sh)$/.test(name) && !name.endsWith(".selftest.sh") && fs.statSync(path.join(source, name)).isFile()) fs.copyFileSync(path.join(source, name), path.join(dest, name));
  for (const name of ["transports", "drivers"]) if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(dest, name), { recursive: true });
  fs.writeFileSync(path.join(dest, "run/telegram.token"), "TESTTOKEN\n", { mode: 0o600 }); fs.writeFileSync(path.join(dest, "run/telegram.allow"), "111\n");
}
async function main() {
  if (process.argv[2] === "--case") { const [root, mode, source, label] = process.argv.slice(3); await one(root, mode, source, label); return; }
  const [sourceSeats, root] = process.argv.slice(2); assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
  const helper = path.join(sourceSeats, "fixtures/transport-fixture-observation.ts"), text = fs.readFileSync(helper, "utf8"), removed = path.join(root, "observer-no-wait.ts"), uncommitted = path.join(root, "observer-uncommitted.ts");
  const guard = 'if (state.ready) { event("complete", state); return state; }'; assert.equal(text.split(guard).length, 2);
  fs.writeFileSync(removed, text.replace(guard, 'if (true) { event("complete", state); return state; }'));
  const committed = 'return end < 0 ? [] : text.slice(0, end).split("\\n").filter(line => line.trim()).map(line => JSON.parse(line));'; assert.equal(text.split(committed).length, 2);
  fs.writeFileSync(uncommitted, text.replace(committed, 'return text.split("\\n").filter(line => line.trim()).map(line => JSON.parse(line));'));
  for (const mode of ["ready", "send-failed", "retry-complete", "poll-recovered", "hung-retried"]) {
    for (const broken of [false, true]) {
      const label = `observer-${mode}-${broken ? "removed" : "fixed"}`, run = start(["bun", import.meta.path, "--case", root, mode, broken ? removed : helper, label]), native = await run.result;
      fs.writeFileSync(path.join(root, label + ".json"), JSON.stringify(native, null, 2) + "\n");
      assert.equal(native.code, broken ? 1 : 0, JSON.stringify(native)); assert.equal(native.signal, null); assert(native.stdoutEOF && native.stderrEOF);
      assert(native.stdout.includes('"actorEntered":true'), "control must actually execute its entered actor");
      if (broken) assert(native.stderr.includes("observation completed before the entered actor committed its event"));
      console.log(`PASS ${label}: native${native.code}, entered actor joined, both EOF; ${broken ? "meaningful early-completion rejected" : "published event required"}`);
    }
  }
  const partial = await start(["bun", import.meta.path, "--case", root, "retry-complete", uncommitted, "observer-uncommitted"]).result;
  assert.equal(partial.code, 1, JSON.stringify(partial)); assert(partial.stdout.includes('"actorEntered":true')); assert(partial.stderr.includes("observation completed before the entered actor committed its event"));
  console.log("PASS uncommitted-record removal: native1 after valid actor/setup; partial ledger publication cannot satisfy recovery");

  const actual = path.join(sourceSeats, "fixtures/courier-poll-observation.ts"), original = fs.readFileSync(actual, "utf8"), clocked = path.join(root, "poll-clocked.ts"), oldClock = path.join(root, "poll-clock-removed.ts"), noClass = path.join(root, "poll-no-policy-class.ts");
  const anchor = 'let active = 0, maximum = 0, polls = 0;'; assert.equal(original.split(anchor).length, 2);
  const clockSource = original.replace(anchor, anchor + '\nconst nativeNow=performance.now.bind(performance); Object.defineProperty(performance,"now",{value:()=>nativeNow()+(polls>0?31000:0)});');
  fs.writeFileSync(clocked, clockSource);
  const loop = '    while (polls < 3) {'; assert.equal(clockSource.split(loop).length, 2);
  fs.writeFileSync(oldClock, clockSource.replace(loop, '    const until = performance.now() + 30000;\n' + loop + '\n      if (performance.now() >= until) throw new Error("bounded observation ended before three real polls");'));
  const policy = '    if (produced.includes("STOP: poll failed: telegram getUpdates timed out after 1000ms")) failure = "network policy expired: telegram getUpdates timed out after 1000ms";'; assert.equal(original.split(policy).length, 2); fs.writeFileSync(noClass, original.replace(policy, '    // policy classification removed by control'));
  for (const [label, script, mode, expected] of [["clock-completion", clocked, "serial", 0], ["clock-budget-removed", oldClock, "serial", 2], ["policy-category", actual, "policy-timeout", 2], ["policy-category-removed", noClass, "policy-timeout", 1]] as const) {
    const project = path.join(root, label); copyRuntime(sourceSeats, project);
    const native = await start(["bun", script, project, path.join(root, label + "-observation"), mode, "350"]).result;
    fs.writeFileSync(path.join(root, label + ".json"), JSON.stringify(native, null, 2) + "\n");
    assert.equal(native.code, expected, JSON.stringify(native)); assert.equal(native.signal, null); assert(native.stdoutEOF && native.stderrEOF);
    const observation = JSON.parse(fs.readFileSync(path.join(root, label + "-observation/observation.json"), "utf8"));
    assert(observation.finalEvents.some((e: any) => e.phase === "begin"), "real courier must reach the owned endpoint before any rejection"); assert.equal(observation.joined, true);
    if (label === "clock-budget-removed") assert(native.stderr.includes("bounded observation ended before three real polls"));
    if (label === "policy-category") assert(native.stderr.includes("network policy expired"));
    if (label === "policy-category-removed") assert(native.stderr.includes("OVERLAP_REJECTED"));
    console.log(`PASS ${label}: native${native.code}, real endpoint reached, original courier joined, both EOF`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
