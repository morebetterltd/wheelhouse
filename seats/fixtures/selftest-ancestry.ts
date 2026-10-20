// Real inherited-lock proofs, with disposable ps observation faults. All locks
// are private fixtures beneath an already-admitted suite; no host lock bypass.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
const [root, helper] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(helper).isFile());
const target = process.env.WHEELHOUSE_ANCESTRY_HELPER || helper;
const ps = Bun.which("ps"); assert(ps);
const bun = process.execPath;
const selected = process.env.WHEELHOUSE_ANCESTRY_CASE || "all";
const names = ["direct-parent-no-ps", "single-snapshot", "transient-observation", "unavailable-observation", "malformed-observation", "real-outsider"];
assert(selected === "all" || names.includes(selected));
function run(bin: string, args: string[], env = process.env) {
  const result = spawnSync(bin, args, { env, encoding: "utf8" });
  assert(!result.error, String(result.error)); assert.equal(result.signal, null);
  return { command: [bin, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const marker = "wheelhouse-selftest-sweep", token = randomUUID().replaceAll("-", "");
function transition(lock: string, op: string, pid: number, owned = "") {
  return run(bun, [helper, op, lock, String(pid), token, owned]);
}
function bytes(lock: string) {
  return [lock, lock + ".queue"].map(dir => {
    const d = fs.statSync(dir, { bigint: true });
    return [String(d.dev), String(d.ino), fs.readdirSync(dir).sort().map(file => {
      const f = path.join(dir, file), s = fs.statSync(f, { bigint: true });
      return [file, String(s.ino), fs.readFileSync(f).toString("base64")];
    })];
  });
}
const shim = `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),p=require('path');
const args=process.argv.slice(2),dir=process.env.ANCESTRY_CASE;
const calls=p.join(dir,'ps-calls.jsonl');
const n=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\\n').filter(Boolean).length:0;
const snapshot=JSON.stringify(args)===JSON.stringify(['-axo','pid=,ppid=']);
const mode=process.env.ANCESTRY_MODE;
let r, fault=false;
if((mode==='single-snapshot'&&!snapshot)||(mode==='transient-observation'&&n===0)||mode==='unavailable-observation'||mode==='direct-parent-no-ps'){
 r=JSON.parse(fs.readFileSync(p.join(dir,'native-gone.json'),'utf8'));fault=true;
}else{
 const actual=cp.spawnSync(process.env.ANCESTRY_NATIVE_PS,args,{encoding:'utf8'});
 r={status:actual.status,stdout:actual.stdout||'',stderr:actual.stderr||'',error:actual.error?.message,signal:actual.signal};
 if(mode==='malformed-observation'){r.stdout='not a PID/PPID row\\n';fault=true;}
}
fs.appendFileSync(calls,JSON.stringify({args,snapshot,fault,...r})+'\\n');
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status===null?2:r.status);
`;
let failed = 0;
for (const name of names) {
  if (selected !== "all" && selected !== name) continue;
  const dir = path.join(root, "ancestry-" + name); fs.mkdirSync(dir);
  const lock = path.join(dir, "host.lock"), bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  // Capture the real native command BEFORE using its no-row result as a fault.
  const table = run(ps, ["-axo", "pid=,ppid="]);
  fs.writeFileSync(path.join(dir, "native-table.json"), JSON.stringify(table));
  assert.equal(table.status, 0, table.stderr);
  const rows = table.stdout.trim().split("\n").map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); assert(m, line); return [+m[1], +m[2]];
  });
  assert(rows.some(([pid]) => pid === process.pid), "fixture subject exists before ancestry measurement");
  assert(!rows.some(([pid]) => pid === 2147483647), "absent native probe PID is actually absent");
  const gone = run(ps, ["-o", "ppid=", "-p", "2147483647"]);
  assert.equal(gone.status, 1); assert.equal(gone.stdout, ""); assert.equal(gone.stderr, "");
  fs.writeFileSync(path.join(dir, "native-gone.json"), JSON.stringify(gone));
  fs.writeFileSync(path.join(bin, "ps"), shim, { mode: 0o700 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    ANCESTRY_CASE: dir, ANCESTRY_MODE: name, ANCESTRY_NATIVE_PS: ps };
  let owned = "", owner: ReturnType<typeof spawn> | undefined, ownerDone: Promise<number | null> | undefined;
  try {
    if (name === "real-outsider") {
      // A genuine sibling, NOT an environment-spoofed child of the lock owner.
      const ownerFile = path.join(dir, "owner.ts");
      fs.writeFileSync(ownerFile, `import {spawnSync} from 'node:child_process';
const [helper,lock,token]=process.argv.slice(2);
const op=(name:string,owned='')=>spawnSync(process.execPath,[helper,name,lock,String(process.pid),token,owned],{encoding:'utf8'});
const a=op('acquire'); if(a.status!==0){process.stderr.write(a.stderr);process.exit(2);}
console.log('OWNER_READY '+process.pid);process.stdin.resume();let done=false;
function finish(){if(done)return;done=true;const r=op('release',a.stdout.trim());process.stderr.write(r.stderr);process.exit(r.status??2);}
process.stdin.once('data',finish);process.stdin.once('end',finish);
`);
      owner = spawn(bun, [ownerFile, helper, lock, token], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      ownerDone = new Promise((resolve, reject) => { owner!.once("error", reject); owner!.once("close", resolve); });
      await new Promise<void>((resolve, reject) => {
        owner!.stdout!.on("data", b => { out += b; if (/^OWNER_READY \d+$/m.test(out)) resolve(); });
        owner!.stderr!.on("data", b => err += b);
        ownerDone!.then(code => reject(new Error(`owner closed before proof: ${code} ${out} ${err}`)), reject);
      });
      assert.equal(Number(fs.readFileSync(path.join(lock, "pid"), "utf8")), owner.pid);
      assert.notEqual(owner.pid, process.pid);
    } else {
      const a = transition(lock, "acquire", process.pid); assert.equal(a.status, 0, a.stderr); owned = a.stdout.trim();
      assert.equal(Number(fs.readFileSync(path.join(lock, "pid"), "utf8")), process.pid);
    }
    const before = bytes(lock);
    // Keep an intermediate shell alive; the positive proof must traverse it.
    const result = name === "direct-parent-no-ps" ? run(bun, [target, "inherited", lock], env)
      : run("bash", ["-c", '"$1" "$2" inherited "$3"; rc=$?; exit "$rc"', "ancestry-proof", bun, target, lock], env);
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    assert.deepEqual(bytes(lock), before, "inherited inspection never mutates lock/FIFO ownership");
    const expected = name === "real-outsider" ? 75 : ["unavailable-observation", "malformed-observation"].includes(name) ? 2 : 0;
    assert.equal(result.status, expected, `${name}: native exit=${result.status}, expected=${expected}\n${result.stderr}`);
    const callsFile = path.join(dir, "ps-calls.jsonl");
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
    assert(calls.length <= 3, "native process observations remain bounded");
    if (name !== "direct-parent-no-ps") assert(calls.length >= 1, "indirect proof actually observed the process table");
    if (name === "direct-parent-no-ps") {
      assert.equal(calls.length, 0, "direct kernel proof needs no ps subprocess");
    } else if (expected === 0) {
      assert(calls.every(c => c.snapshot), "no per-PID subprocess walk");
      assert.equal(calls.length, name === "transient-observation" ? 2 : 1);
      assert.equal(calls.at(-1).status, 0);
    } else if (expected === 2) {
      const line = result.stderr.split("\n").find(x => x.startsWith("SELFTEST_LOCK_REFUSAL ")); assert(line, result.stderr);
      const refusal = JSON.parse(line.slice("SELFTEST_LOCK_REFUSAL ".length));
      assert.equal(refusal.operation, "inherited"); assert.equal(refusal.ancestryObservations.length, 3);
      assert(refusal.ancestryObservations.every((x: any) => x.status !== undefined && typeof x.stdout === "string" && typeof x.stderr === "string"));
    }
    console.log(`PASS inherited ancestry ${name}: exit=${result.status}, observations=${calls.length}, lock/FIFO unchanged`);
  } catch (error) {
    failed++; console.error(`FAIL inherited ancestry ${name}: ${error}`);
  } finally {
    if (owner) { owner.stdin!.end("release\n"); assert.equal(await ownerDone, 0); }
    else if (owned) { const r = transition(lock, "release", process.pid, owned); assert.equal(r.status, 0, r.stderr); }
    if (owned || owner) { assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue")); }
  }
}
console.log(`inherited ancestry regression: ${selected === "all" ? names.length : 1} cases, ${failed} failures`);
process.exitCode = failed ? 1 : 0;
