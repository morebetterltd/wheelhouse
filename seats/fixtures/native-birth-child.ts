import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

const [root, harness, mode = "observed"] = process.argv.slice(2);
assert(fs.statSync(path.join(root, "seats/adapter.ts")).isFile());
for (const dir of ["native", "account", "contracts"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
const token = randomUUID(), q = JSON.stringify;
let sample = 0;
function native(label: string, file: string, args: string[]) {
  const prefix = path.join(root, "native", String(sample++).padStart(3, "0") + "-" + label);
  const a = fs.openSync(prefix + ".out", "wx", 0o600), b = fs.openSync(prefix + ".err", "wx", 0o600);
  let r;
  try { r = spawnSync(file, args, { cwd: root, env: process.env, stdio: ["ignore", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  const stdout = fs.readFileSync(prefix + ".out", "utf8"), stderr = fs.readFileSync(prefix + ".err", "utf8");
  fs.writeFileSync(prefix + ".json", JSON.stringify({ command: [file, ...args], status: r.status, signal: r.signal, error: r.error?.message ?? null, stdout, stderr }) + "\n");
  return { ...r, stdout, stderr };
}
// Capture a REAL failed native observation before using its protocol as a
// controlled observer fault. It is not evidence that our live actor is gone.
const failed = native("unavailable-reference", "ps", ["-p", "999999999", "-o", "lstart="]);
assert.equal(failed.status, 1); assert.equal(failed.signal, null); assert(!failed.error);
fs.writeFileSync(path.join(root, "contracts/WORKER.md"), "# Fleet: Worker\n\nNative birth fixture brief.\n");
for (const file of ["auth.json", ".claude.json"]) fs.writeFileSync(path.join(root, "account", file), '{"fixture":"no-provider-access"}\n');
fs.writeFileSync(path.join(root, "seats/seats.json"), JSON.stringify({ seats: { worker: { role: "worker", harness, provider: "anthropic", model: "fixture", allowedTools: "Bash(printf *)", worktree: false, account: { dir: path.join(root, "account"), authRoute: "oauth" } } } }));
const actorFile = path.join(root, "native-actor.cjs"), preload = path.join(root, "native-spawn.ts"), reader = path.join(root, "native-reader.ts");
fs.writeFileSync(actorFile, String.raw`const fs=require('node:fs'),path=require('node:path'),{StringDecoder}=require('node:string_decoder');
const[root,token]=process.argv.slice(2),at=n=>path.join(root,n),pub=(n,v)=>{fs.writeFileSync(at(n+'.new'),JSON.stringify(v)+'\n');fs.renameSync(at(n+'.new'),at(n));};
const fd=fs.openSync(at('seats/run/worker.stdin'),fs.constants.O_RDWR|fs.constants.O_NONBLOCK),decoder=new StringDecoder('utf8');
pub('actor.info',{pid:process.pid,token});
process.on('SIGTERM',()=>{pub('actor.signal',{signal:'SIGTERM'});fs.closeSync(fd);process.exit(99)});
let pending='';
setInterval(()=>{
 if(fs.existsSync(at('stop'))&&fs.readFileSync(at('stop'),'utf8')===token){fs.closeSync(fd);pub('actor.retired',{pid:process.pid,token});process.exit(0)}
 const b=Buffer.alloc(8192);let n=0;
 try{n=fs.readSync(fd,b,0,b.length,null)}catch(e){if(!['EAGAIN','EWOULDBLOCK'].includes(e.code))throw e;}
 if(n)pending+=decoder.write(b.subarray(0,n));
 for(;;){const i=pending.indexOf('\n');if(i<0)break;const c=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);
  if(c.type!=='get_state')throw Error('unexpected native fixture command');
  pub('request.info',{pid:process.pid,id:c.id,type:c.type,token});
  const timer=setInterval(()=>{if(!fs.existsSync(at('release')))return;clearInterval(timer);
   fs.appendFileSync(at('seats/logs/worker.jsonl'),JSON.stringify({type:'response',command:c.type,id:c.id,success:true,data:{sessionId:'native-birth',sessionFile:at('session.jsonl'),model:'fixture',isStreaming:false}})+'\n');
  },25);
 }
},25);
`);
fs.writeFileSync(path.join(root, "session.jsonl"), '{"type":"session","id":"native-birth"}\n');
// Substitute only the launch actor, retaining the actual original ChildProcess
// handle, native FIFO, readiness response, kernel birth and production launcher
// branches. This does not claim provider/driver interoperability.
fs.writeFileSync(preload, `import fs from "node:fs";import {mock} from "bun:test";
const cp=await import("node:child_process"),nativeSpawn=cp.spawn,nativeSync=cp.spawnSync;let ownedPid;
const spawn=(file,args,options)=>{
 if(file!=="bash"||!options?.detached)return nativeSpawn(file,args,options);
 fs.writeFileSync(${q(path.join(root, "launch.json"))},JSON.stringify({file,args,cwd:options.cwd,detached:options.detached,stdio:options.stdio}));
 const child=nativeSpawn("node",[${q(actorFile)},${q(root)},${q(token)}],options);ownedPid=child.pid;
 child.once("exit",(code,signal)=>fs.writeFileSync(${q(path.join(root, "child-exit.json"))},JSON.stringify({pid:child.pid,code,signal})));
 child.once("close",(code,signal)=>fs.writeFileSync(${q(path.join(root, "child-close.json"))},JSON.stringify({pid:child.pid,code,signal})));
 child.unref=()=>child;return child;
};
const spawnSync=(file,args,options)=>{
 if(${q(mode)}==="unavailable"&&file==="ps"&&args[0]==="-p"&&Number(args[1])===ownedPid&&args[3]==="lstart="){
  const r=nativeSync("ps",["-p","999999999","-o","lstart="],options);
  fs.writeFileSync(${q(path.join(root, "birth-failure.json"))},JSON.stringify({target:ownedPid,status:r.status,signal:r.signal,error:r.error?.message??null}));return r;
 }
 return nativeSync(file,args,options);
};
mock.module("node:child_process",()=>({...cp,spawn,spawnSync,default:{...cp.default,spawn,spawnSync}}));
`);
fs.writeFileSync(reader, 'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[2]).href);console.log(JSON.stringify(m.seatIdentity(Number(process.argv[3]),undefined,process.argv[4])));\n');
const cli = Bun.spawn(["bun", "--preload", preload, path.join(root, "seats/adapter.ts"), "spawn", "worker"], { cwd: root, env: { ...process.env, WHEELHOUSE_SKIP_BD: "1" }, stdin: "ignore", stdout: Bun.file(path.join(root, "cli.out")), stderr: Bun.file(path.join(root, "cli.err")) });
const deadline = performance.now() + 180000;
let last: any = { phase: "waiting original native actor" }, result: any;
async function wait(label: string, predicate: () => boolean) {
  while (!predicate()) {
    if (performance.now() > deadline) throw Error(`INCOMPLETE fixture ${label}; last=${JSON.stringify(last)}`);
    await Bun.sleep(25);
  }
}
try {
  await wait("actor publication", () => fs.existsSync(path.join(root, "actor.info")));
  const info = JSON.parse(fs.readFileSync(path.join(root, "actor.info"), "utf8")); assert.equal(info.token, token);
  const birth = native("actor-birth", "ps", ["-p", String(info.pid), "-o", "lstart="]);
  assert.equal(birth.status, 0); assert.equal(birth.signal, null);
  const ms = Date.parse(birth.stdout.trim()); assert(Number.isFinite(ms));
  last = { phase: "holding actual readiness", pid: info.pid, nativeBirthMs: ms };
  await wait("get_state received", () => fs.existsSync(path.join(root, "request.info")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "request.info"), "utf8")).pid, info.pid);
  // Controlled input crosses the EXISTING 2s tolerance, not a natural load claim.
  await wait("birth older than existing tolerance", () => Date.now() - ms > 3500);
  fs.writeFileSync(path.join(root, "release"), "release\n"); last.phase = "readiness released";
  await wait("state publication", () => fs.existsSync(path.join(root, "seats/state.json")) && JSON.parse(fs.readFileSync(path.join(root, "seats/state.json"), "utf8")).seats?.worker?.pid === info.pid);
  const rec = JSON.parse(fs.readFileSync(path.join(root, "seats/state.json"), "utf8")).seats.worker;
  const proof = native("actor-live-proof", "ps", ["-p", String(info.pid), "-o", "pid=,ppid=,uid=,lstart=,command="]);
  assert.equal(proof.status, 0); assert(proof.stdout.includes(actorFile));
  const inspected = native("timestamp-consumer", "bun", [reader, path.join(root, "seats/seat-activity.ts"), String(info.pid), rec.startedAt]);
  assert.equal(inspected.status, 0); const identity = JSON.parse(inspected.stdout);
  if (mode === "unavailable") {
    const failure = JSON.parse(fs.readFileSync(path.join(root, "birth-failure.json"), "utf8"));
    assert.equal(failure.target, info.pid); assert.equal(failure.status, failed.status); assert.equal(failure.signal, failed.signal);
  }
  let error: string | null = null;
  try {
    if (mode === "unavailable") { assert.equal(rec.startedAt, "", "unobserved birth must not become a synthetic timestamp"); assert(rec.birthUnverified); assert.equal(identity.kind, "unverified"); }
    else { assert.equal(Date.parse(rec.startedAt), ms, "record native birth, not post-readiness time"); assert.equal(identity.kind, "owned"); }
  } catch (e) { if (!(e instanceof assert.AssertionError)) throw e; error = e.message; }
  result = { harness, mode, inputComplete: true, nativeBirthMs: ms, recordedMs: Date.parse(rec.startedAt), deltaMs: Date.parse(rec.startedAt) - ms, identity, checkerAccepted: !error, error, adapterSha256: createHash("sha256").update(fs.readFileSync(path.join(root, "seats/adapter.ts"))).digest("hex") };
  fs.writeFileSync(path.join(root, "comparison-before-retirement.json"), JSON.stringify(result) + "\n");
} finally {
  fs.writeFileSync(path.join(root, "stop"), token);
  if (fs.existsSync(path.join(root, "actor.info"))) {
    const info = JSON.parse(fs.readFileSync(path.join(root, "actor.info"), "utf8"));
    await wait("actor retirement", () => fs.existsSync(path.join(root, "actor.retired")));
    await wait("ORIGINAL child close", () => fs.existsSync(path.join(root, "child-close.json")));
    const closed = JSON.parse(fs.readFileSync(path.join(root, "child-close.json"), "utf8"));
    assert.equal(closed.pid, info.pid); assert.equal(closed.code, 0); assert.equal(closed.signal, null);
  }
  assert.equal(await cli.exited, 0, fs.readFileSync(path.join(root, "cli.err"), "utf8"));
}
assert(result); assert(!fs.existsSync(path.join(root, "actor.signal")), "observation never grants new signal authority");
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result) + "\n");
console.log("NATIVE_BIRTH_RESULT " + JSON.stringify({ ...result, cliNative: 0 }));
// Driver success establishes valid native setup/retirement; the parent checks
// the intended invariant separately for positive and feature-removal copies.
