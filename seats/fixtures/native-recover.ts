import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [runtime, parent] = process.argv.slice(2);
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
const data = path.join(parent, "recovery-holder"); fs.mkdirSync(data);
const session = path.join(data, "session.jsonl"), ready = path.join(data, "ready"), stop = path.join(data, "stop"), actorFile = path.join(data, "holder.cjs");
fs.writeFileSync(session, '{"type":"session","id":"fixture"}\n');
fs.writeFileSync(actorFile, String.raw`const fs=require('node:fs');const[file,ready,stop]=process.argv.slice(2),fd=fs.openSync(file,'r');fs.writeFileSync(ready+'.new',JSON.stringify({pid:process.pid})+'\n');fs.renameSync(ready+'.new',ready);setInterval(()=>{if(fs.existsSync(stop)){fs.closeSync(fd);process.exit(0)}},25);`);
const actor = Bun.spawn(["node", actorFile, session, ready, stop], { cwd: data, stdin: "ignore", stdout: Bun.file(path.join(data, "actor.out")), stderr: Bun.file(path.join(data, "actor.err")) });
let serial = 0;
function capture(command: string, args: string[], cwd = data, env = process.env) {
  const prefix = path.join(data, "native-" + serial++), a = fs.openSync(prefix + ".out", "wx", 0o600), b = fs.openSync(prefix + ".err", "wx", 0o600); let r;
  try { r = spawnSync(command, args, { cwd, env, stdio: ["ignore", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  assert(!r.error && !r.signal, "native input/setup must complete");
  const stdout = fs.readFileSync(prefix + ".out", "utf8"), stderr = fs.readFileSync(prefix + ".err", "utf8");
  console.log("CAPTURE native-recover " + JSON.stringify({ command: [command, ...args], status: r.status, signal: r.signal, stdout, stderr }));
  return { ...r, stdout, stderr, outFile: prefix + ".out" };
}
try {
  const until = performance.now() + 120000;
  while (!fs.existsSync(ready)) { if (performance.now() > until) throw Error("INCOMPLETE regular-file holder readiness"); await Bun.sleep(25); }
  assert.equal(JSON.parse(fs.readFileSync(ready, "utf8")).pid, actor.pid);
  const lookup = capture("sh", ["-c", "command -v lsof"]); assert.equal(lookup.status, 0); const realLsof = lookup.stdout.trim(); assert(fs.statSync(realLsof).isFile());
  // REAL native file-holder protocol first. Replaying its positive bytes with
  // a controlled failed exit is explicitly incomplete observation, not absence.
  const holder = capture(realLsof, ["-Fp", "--", session]); assert.equal(holder.status, 0); assert(holder.stdout.split("\n").includes("p" + actor.pid));
  let missing: any; try { process.kill(999999999, 0); } catch (e) { missing = e; } assert.equal(missing?.code, "ESRCH");
  console.log('CAPTURE native-recover recorded-seat absence {"signal":0,"error":"ESRCH"}');
  const source = fs.readFileSync(path.join(runtime, "seats/recover.ts"), "utf8");
  assert(holder.stdout.split("\n").some(line => /^f[0-9]+$/.test(line)), "native numeric FD record must exist before testing its parser");
  function run(removed: boolean, failed = true) {
    const root = path.join(parent, "recovery-" + (failed ? "failed-" : "holder-") + (removed ? "removed" : "positive")); fs.cpSync(runtime, root, { recursive: true });
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "seats/state.json"), JSON.stringify({ seats: { worker: { pid: 999999999, role: "worker", sessionId: "fixture", sessionFile: session, cwd: root } } }));
    fs.writeFileSync(path.join(root, "bin/lsof"), `#!/usr/bin/env node\nconst fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);if(args[0]==='-Fp'&&args[1]==='--'&&args[2]===${JSON.stringify(session)}){process.stdout.write(fs.readFileSync(${JSON.stringify(holder.outFile)}));process.stderr.write(${JSON.stringify(failed ? "controlled native observer failure\n" : "")});process.exitCode=${failed ? 7 : 0};}else{const r=cp.spawnSync(${JSON.stringify(realLsof)},args,{stdio:'inherit'});process.exitCode=r.status??2;}\n`, { mode: 0o755 });
    if (removed) {
      const old = failed ? 'if (r.error || r.signal || r.status !== 0) return unknown("lsof session-file observation failed");' : 'if (/^f[0-9]+$/.test(line) && currentPid !== null) continue;';
      assert.equal(source.split(old).length - 1, 1);
      const replacement = failed ? 'if (r.error || r.signal || r.status !== 0) return { holders: [], reason: "" };' : 'if (/^f[0-9]+$/.test(line)) return unknown("restored PID-only protocol assumption");';
      fs.writeFileSync(path.join(root, "seats/recover.ts"), source.replace(old, () => replacement));
    }
    const env = { ...process.env, PATH: path.join(root, "bin") + ":" + process.env.PATH };
    const failure = capture("lsof", ["-Fp", "--", session], root, env); assert.equal(failure.status, failed ? 7 : 0); assert.equal(failure.stdout, holder.stdout); assert.equal(failure.stderr, failed ? "controlled native observer failure\n" : "");
    const consumer = capture("bun", [path.join(root, "seats/recover.ts")], root, env); assert.equal(consumer.status, 0);
    const final = capture(realLsof, ["-Fp", "--", session]); assert.equal(final.status, 0); assert(final.stdout.split("\n").includes("p" + actor.pid), "same original session holder remains live");
    assert(fs.existsSync(session));
    return consumer.stdout;
  }
  function check(out: string) { assert.match(out, /REFUSED resume: UNVERIFIED session attachment/); assert.doesNotMatch(out, /\n\s+(?:resume:|resumable)/, "unknown holder observation cannot authorize a second writer"); }
  check(run(false)); console.log("PASS native-recover failed-observer");
  const failedObserverRemoval = run(true);
  assert.throws(() => check(failedObserverRemoval), assert.AssertionError); console.log("REJECT native-recover failed-observer consumerNative=0 holderStillLive=true");
  function checkHolder(out: string) { assert.match(out, /REFUSED double-resume/); assert(out.includes("pid " + actor.pid)); assert.doesNotMatch(out, /UNVERIFIED session attachment/); }
  checkHolder(run(false, false)); console.log("PASS native-recover native-pid-fd-protocol");
  const pidFdRemoval = run(true, false);
  assert.throws(() => checkHolder(pidFdRemoval), assert.AssertionError); console.log("REJECT native-recover native-pid-fd-protocol consumerNative=0 holderStillLive=true");
} finally { fs.writeFileSync(stop, "release\n"); assert.equal(await actor.exited, 0); }
console.log("PASS native-recover: 2 observations, 2 meaningful removals; native pPID/fFD protocol and failed-observer refusal; original actor retired");
