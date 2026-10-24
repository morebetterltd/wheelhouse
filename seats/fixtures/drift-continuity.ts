// Real alerts CLI sequences: unknown observations are not condition clears.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { completedCommand } from "../completed-command";

const [here, base, implementation, scenario, mutation = "none"] = process.argv.slice(2);
assert(fs.statSync(path.join(here, "alerts.ts")).isFile());
assert(fs.statSync(implementation).isFile());
let marked = false;
for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, ".wheelhouse-selftest-fixture"))) { marked = true; break; }
  if (path.dirname(dir) === dir) break;
}
assert(marked, "drift continuity requires an owned fixture ancestor");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const marker = (name: string) => `DRIFT_CONTINUITY_ASSERTION ${name}`;
const save = (file: string, value: any) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
if (!scenario) {
  fs.mkdirSync(base);
  const results = [];
  for (const [kind, change, oracle] of [
    ["active", "none", ""], ["pending", "none", ""], ["transitions", "none", ""],
    ["active", "forget-unknown", "active-repeat"], ["pending", "forget-unknown", "pending-clock"],
    ["active", "repeat-active", "active-repeat"], ["transitions", "ignore-change", "change"],
    ["transitions", "ignore-clear", "clear"],
  ]) {
    const dir = path.join(base, kind + "-" + change);
    const child = completedCommand("bun", [import.meta.path, here, dir, implementation, kind, change]);
    fs.writeFileSync(dir + ".stdout", child.stdout); fs.writeFileSync(dir + ".stderr", child.stderr);
    save(dir + ".native.json", { status: child.status, signal: child.signal ?? null, error: child.error?.message ?? null });
    assert(!child.signal && !child.error, "case must complete naturally");
    // No setup failure is accepted as a successful removal control.
    const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    results.push(result);
    assert(result.steps.length > 0 && result.steps.every((s: any) => s.check.status === 0 && !s.check.signal && !s.check.error));
    if (change === "none") {
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(`PASS drift ${kind}: rows=${result.steps.map((s: any) => s.rows).join(",")}; unknowns preserve state, real changes/clears remain meaningful`);
    } else {
      assert.equal(child.status, 1, "removal must fail its consumer assertion");
      assert(child.stderr.includes("AssertionError: " + marker(oracle)), child.stderr);
      if (oracle === "active-repeat") assert(result.steps.at(-1).rows > 1, "actual repeat rows must exist");
      if (oracle === "pending-clock") assert(result.steps.some((s: any) => s.status === "check-failed" && s.alert.since === null));
      if (oracle === "change") assert.equal(result.steps.find((s: any) => s.label === "b-change").rows, 1);
      if (oracle === "clear") assert.equal(result.steps.find((s: any) => s.label === "clear").alert.active, true);
      console.log(`REJECT drift ${kind}/${change}: native case1 at ${marker(oracle)}; actual rows=${result.steps.map((s: any) => s.rows).join(",")}`);
    }
  }
  save(path.join(base, "result.json"), results);
  const evidence = process.env.WHEELHOUSE_DRIFT_CONTINUITY_EVIDENCE;
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    // Only regular measurements, never a live pipe or copied runtime.
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(base, entry.name), path.join(evidence, entry.name));
      else if (entry.isDirectory()) for (const file of fs.readdirSync(path.join(base, entry.name))) {
        if (!/^(?:result\.json|step-.*\.(?:json|stdout|stderr))$/.test(file)) continue;
        const source = path.join(base, entry.name, file);
        assert(fs.lstatSync(source).isFile());
        fs.copyFileSync(source, path.join(evidence, entry.name + "." + file));
      }
    }
  }
  console.log("drift-continuity: PASS (3 consumer sequences, 5 meaningful removals, real native timeout input)");
} else {
  assert(["active", "pending", "transitions"].includes(scenario));
  assert(["none", "forget-unknown", "repeat-active", "ignore-change", "ignore-clear"].includes(mutation));
  fs.mkdirSync(base);
  const project = path.join(base, "project"), bin = path.join(base, "bin"), home = path.join(base, "home");
  for (const dir of [project, bin, home]) fs.mkdirSync(dir);
  const copied = completedCommand("bash", ["-c", '. "$1/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1"', "copy", here, project]);
  assert.equal(copied.status, 0, copied.stderr); assert(!copied.error && !copied.signal);
  for (const dir of ["seats/run", "seats/logs", "wheelhouse"]) fs.mkdirSync(path.join(project, dir), { recursive: true });
  fs.writeFileSync(path.join(project, "seats/seats.json"), '{"seats":{"commander":{"role":"commander","external":true}}}\n');
  fs.writeFileSync(path.join(project, "seats/state.json"), '{"seats":{}}\n');
  fs.writeFileSync(path.join(project, "seats/inbox.jsonl"), "");
  fs.writeFileSync(path.join(project, "wheelhouse/.template-source"), "github-issue-watch=off\ngithub-issue-repos=fixture/repo\nalert-low-disk-gb=0\nalert-inbox-lag-minutes=1000000\nalert-human-after-minutes=1000000\n");
  fs.writeFileSync(path.join(bin, "bd"), '#!/usr/bin/env bash\nprintf \'[]\\n\'\n', { mode: 0o700 });
  const sourceFile = path.join(project, "seats/alerts.ts");
  fs.copyFileSync(implementation, sourceFile);
  const original = fs.readFileSync(sourceFile, "utf8");
  const guard = '(name==="template-drift"&&drift.status==="check-failed")';
  const replacements: Record<string, [string, string]> = {
    "forget-unknown": ["||" + guard, ""],
    "repeat-active": ["if(shouldFire)", "if(next.active)"],
    "ignore-change": ["const shouldFire = next.active&&(!was?.active||was.signature!==next.signature);", "const shouldFire = next.active&&!was?.active;"],
    "ignore-clear": [guard, '(name==="template-drift"&&drift.status!=="drift")'],
  };
  if (mutation !== "none") {
    const [needle, replacement] = replacements[mutation];
    assert.equal(original.split(needle).length, 2, "unique actual transition removal");
    fs.writeFileSync(sourceFile, original.replace(needle, replacement));
  }
  const input = path.join(base, "input.json"), emitter = path.join(base, "emitter.ts"), preload = path.join(base, "timeout.ts");
  const driftScript = path.join(project, "seats/template-drift.sh"), token = randomUUID();
  fs.writeFileSync(driftScript, '#!/usr/bin/env bash\nexec bun "$WHEELHOUSE_DRIFT_EMITTER" "$@"\n', { mode: 0o700 });
  fs.writeFileSync(emitter, `import fs from 'node:fs';const x=JSON.parse(fs.readFileSync(process.env.WHEELHOUSE_DRIFT_INPUT,'utf8'));
if(x.mode==='crash'){console.error('fixture drift exit7');process.exit(7);}
if(x.mode==='garbage'){console.log('not-json');process.exit(0);}
if(x.mode==='timeout'){
 fs.writeFileSync(process.env.WHEELHOUSE_DRIFT_NATIVE_PREFIX+'.ready.json',JSON.stringify({pid:process.pid,ppid:process.ppid,uid:process.getuid(),cwd:process.cwd(),token:process.env.WHEELHOUSE_DRIFT_TOKEN}));
 console.log('timeout partial stdout');console.error('timeout partial stderr');setInterval(()=>{},1000);await new Promise(()=>{});
}
console.log(JSON.stringify(x.data));process.exit(x.data.modified.length||x.data.localOnly.length||x.data.missing.length||x.data.aheadBy?1:0);
`);
  // This delegates to the REAL native spawn. Its ETIMEDOUT/SIGTERM/partial-byte
  // shape was captured first. No canned error, fake native status or host load.
  fs.writeFileSync(preload, `import fs from 'node:fs';import * as cp from 'node:child_process';import {mock} from 'bun:test';const original={...cp};
const spawnSync=(cmd,args,options)=>{
 if(cmd==='bash'&&args?.[0]===process.env.WHEELHOUSE_DRIFT_SCRIPT){
  if(options?.timeout!==undefined)throw Error('product drift deadline unexpectedly present');
  const r=original.spawnSync(cmd,args,{...options,timeout:2000,killSignal:'SIGTERM'}),prefix=process.env.WHEELHOUSE_DRIFT_NATIVE_PREFIX;
  fs.writeFileSync(prefix+'.native.json',JSON.stringify({command:[cmd,...args],policyInputMs:2000,pid:r.pid,status:r.status,signal:r.signal,error:r.error?{code:r.error.code,message:r.error.message}:null,ready:fs.existsSync(prefix+'.ready.json')?JSON.parse(fs.readFileSync(prefix+'.ready.json','utf8')):null}));return r;
 }return original.spawnSync(cmd,args,options);
};mock.module('node:child_process',()=>({...original,spawnSync,default:{...original.default,spawnSync}}));
`);
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH,
    WHEELHOUSE_ALERTS_ROOT: project, WHEELHOUSE_DRIFT_INPUT: input, WHEELHOUSE_DRIFT_EMITTER: emitter,
    WHEELHOUSE_DRIFT_SCRIPT: driftScript, WHEELHOUSE_DRIFT_TOKEN: token,
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS: scenario === "pending" ? "600000" : "0" };
  const a = { error: null, modified: ["a.ts", "b.ts"], localOnly: [], missing: [], aheadBy: 0 };
  const b = { ...a, modified: ["c.ts"] };
  const equivalent = { ...a, modified: [], localOnly: ["b.ts", "a.ts", "a.ts"], aheadBy: 7 };
  const clean = { ...a, modified: [] };
  const steps: any[] = [], snapshot = path.join(project, "seats/run/fleet-snapshot.json");
  function step(label: string, mode = "good", data = a) {
    save(input, { mode, data });
    const prefix = path.join(base, "step-" + steps.length);
    const check = completedCommand("bun", [...(mode === "timeout" ? ["--preload", preload] : []), "seats/alerts.ts", "check"],
      { cwd: project, env: { ...env, WHEELHOUSE_DRIFT_NATIVE_PREFIX: prefix } });
    const native = { status: check.status, signal: check.signal ?? null, error: check.error?.message ?? null, stdout: check.stdout, stderr: check.stderr };
    save(prefix + ".check.json", native); fs.writeFileSync(prefix + ".stdout", check.stdout); fs.writeFileSync(prefix + ".stderr", check.stderr);
    assert.equal(check.status, 0, check.stderr); assert(!check.signal && !check.error); assert.equal(check.stderr, "");
    assert(fs.statSync(snapshot).isFile());
    const s = JSON.parse(fs.readFileSync(snapshot, "utf8")), inbox = path.join(project, "seats/inbox.jsonl");
    assert(fs.statSync(inbox).isFile(), "the measured inbox must exist");
    const rows = fs.readFileSync(inbox, "utf8").split("\n").filter(Boolean).map(x => JSON.parse(x));
    const record = { label, mode, check: native, status: s.drift.status, drift: s.drift,
      alert: s.alerts["template-drift"], rows: rows.filter(x => x.source?.name === "template-drift").length,
      failureRows: rows.filter(x => x.source?.name === "template-drift-check-failed").length };
    if (mode === "timeout") {
      const captured = JSON.parse(fs.readFileSync(prefix + ".native.json", "utf8"));
      assert(captured.ready, "owned timeout producer must start before termination");
      assert.equal(captured.ready.pid, captured.pid); assert.equal(captured.ready.ppid, check.pid);
      assert.equal(captured.ready.uid, process.getuid!());
      assert.equal(captured.ready.cwd, fs.realpathSync(project)); assert.equal(captured.ready.token, token);
      assert.equal(captured.error?.code, "ETIMEDOUT"); assert.equal(captured.signal, "SIGTERM"); assert.equal(captured.status, null);
      assert.equal(s.drift.status, "check-failed"); assert.equal(s.drift.exitCode, null); assert.equal(s.drift.signal, "SIGTERM");
      assert(s.drift.reason.includes("ETIMEDOUT"));
      assert.equal(s.drift.stdout, "timeout partial stdout\n"); assert.equal(s.drift.stderr, "timeout partial stderr\n");
    } else if (mode !== "good") {
      assert.equal(s.drift.status, "check-failed");
      if (mode === "crash") { assert.equal(s.drift.exitCode, 7); assert.equal(s.drift.stderr, "fixture drift exit7\n"); }
      else { assert.equal(s.drift.exitCode, 0); assert.equal(s.drift.stdout, "not-json\n"); }
    } else assert.equal(s.drift.status, data === clean ? "clean" : "drift");
    steps.push(record); save(prefix + ".observation.json", record); return record;
  }
  let expectedPending: any;
  if (scenario === "active") {
    step("unknown-before-any-drift", "crash"); step("a-first"); step("a-repeat"); step("a-repeat-2");
    step("unknown-exit7", "crash"); step("a-after-exit7"); step("a-again");
    step("unknown-invalid-json", "garbage"); step("a-after-invalid-json");
    step("unknown-native-timeout", "timeout"); step("a-after-timeout"); step("a-still-unchanged");
  } else if (scenario === "pending") {
    step("a-pending");
    const s = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    s.alerts["template-drift"].since = new Date(Date.now() - 20 * 60_000).toISOString();
    expectedPending = s.alerts["template-drift"]; save(snapshot, s);
    step("pending-unknown-exit7", "crash"); step("pending-unknown-timeout", "timeout");
    step("a-known-after-eligible-hold"); step("a-still-active");
  } else {
    step("a-first"); step("a-repeat"); step("a-equivalent", "good", equivalent);
    step("b-change", "good", b); step("b-repeat", "good", b);
    step("clear", "good", clean); step("clear-again", "good", clean);
    step("b-return", "good", b); step("b-still-unchanged", "good", b);
  }
  const result = { scenario, mutation, holdMs: Number(env.WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS),
    moduleSha256: hash(fs.readFileSync(sourceFile, "utf8")), expectedPending, steps };
  save(path.join(base, "result.json"), result);
  console.log("MEASUREMENT drift-continuity " + JSON.stringify({ scenario, mutation, rows: steps.map(s => s.rows), active: steps.map(s => s.alert.active), statuses: steps.map(s => s.status) }));
  if (scenario === "active") {
    assert.equal(steps.at(-1).rows, 1, marker("active-repeat") + ": unchanged drift must alert once across unknown checks");
    let previous: any;
    for (const s of steps) {
      if (s.status === "check-failed" && previous) assert.deepEqual(s.alert, previous, marker("active-state"));
      if (s.status === "drift") previous = s.alert;
    }
    assert.equal(steps[0].alert.active, false, "initial unknown cannot invent active drift");
    assert(steps.some(s => s.failureRows > 0), "failure diagnostic must remain visible");
  } else if (scenario === "pending") {
    for (const s of steps.filter(s => s.status === "check-failed")) assert.deepEqual(s.alert, expectedPending, marker("pending-clock"));
    assert.deepEqual(steps.map(s => s.rows), [0, 0, 0, 1, 1], marker("pending-clock"));
  } else {
    assert.equal(steps.find(s => s.label === "b-change").rows, 2, marker("change"));
    assert.equal(steps.find(s => s.label === "clear").alert.active, false, marker("clear"));
    assert.deepEqual(steps.map(s => s.rows), [1, 1, 1, 2, 2, 2, 2, 3, 3], marker("clear"));
  }
}
