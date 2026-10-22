// Real ps records are captured BEFORE constructing the replay. The wrapper
// changes capacity/status/data, never invents a valid process-table schema.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const project = process.argv[2], source = path.dirname(import.meta.dir);
assert(project && !fs.existsSync(project), "census fixture needs a fresh owned target");
fs.mkdirSync(path.join(project, "seats"), { recursive: true });
const root = fs.realpathSync(project);
fs.writeFileSync(path.join(root, ".wheelhouse-selftest-fixture"), "adapter census fixture\n");
for (const file of fs.readdirSync(source)) if (file.endsWith(".ts") && fs.statSync(path.join(source, file)).isFile()) fs.copyFileSync(path.join(source, file), path.join(root, "seats", file));
for (const dir of ["drivers", "transports"]) fs.cpSync(path.join(source, dir), path.join(root, "seats", dir), { recursive: true });
if (process.argv[3]) fs.copyFileSync(process.argv[3], path.join(root, "seats/adapter.ts"));
const evidence = process.env.WHEELHOUSE_CENSUS_EVIDENCE || path.join(root, "census-evidence");
fs.mkdirSync(evidence, { recursive: true });
const realPs = Bun.which("ps"); assert(realPs);
const bin = path.join(root, "census-bin"); fs.mkdirSync(bin);
const wrapper = path.join(bin, "ps");
const wrapperScript = path.join(bin, "ps.cjs");
fs.writeFileSync(wrapperScript, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const args=process.argv.slice(2),exact=args.length===2&&args[0]==='axo'&&args[1]==='pid=,ppid=,lstart=,command=';
if(!exact){const r=cp.spawnSync(process.env.CENSUS_REAL_PS,args,{stdio:'inherit'});if(r.signal)process.kill(process.pid,r.signal);process.exit(r.status??2);}
const dir=process.env.CENSUS_CASE_DIR,mode=process.env.CENSUS_MODE;
const a=fs.openSync(path.join(dir,'ps.stdout'),'wx',0o600),b=fs.openSync(path.join(dir,'ps.stderr'),'wx',0o600);let r;
try{r=cp.spawnSync(process.env.CENSUS_REAL_PS,args,{stdio:['ignore',a,b]});}finally{fs.closeSync(a);fs.closeSync(b);}
const bytes=fs.readFileSync(path.join(dir,'ps.stdout')),err=fs.readFileSync(path.join(dir,'ps.stderr'));
const capture={command:[process.env.CENSUS_REAL_PS,...args],status:r.status,signal:r.signal,error:r.error?{message:r.error.message,code:r.error.code}:null,bytes:bytes.length,stderrBytes:err.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify(capture,null,2));
if(r.error||r.signal||r.status!==0||!bytes.length||err.length){process.stderr.write('fixture real ps capture failed\\n');process.exit(2);}
let payload=bytes,exit=0,diagnostic='';
if(mode==='large')payload=Buffer.concat(Array(Math.ceil(2*1024*1024/bytes.length)+1).fill(bytes));
if(mode==='exit23'){exit=23;diagnostic='fixture census native23\\n';}
if(mode==='empty')payload=Buffer.alloc(0);
if(mode==='malformed')payload=Buffer.from('fixture malformed census\\n');
if(mode==='stderr')diagnostic='fixture census diagnostic despite exit0\\n';
fs.writeFileSync(path.join(dir,'replay.json'),JSON.stringify({mode,bytes:payload.length,exit,diagnostic,sha256:crypto.createHash('sha256').update(payload).digest('hex')},null,2));
process.stdout.write(payload);if(diagnostic)process.stderr.write(diagnostic);process.exitCode=exit;
`);
fs.writeFileSync(wrapper, '#!/bin/sh\nexec node "$CENSUS_WRAPPER_SCRIPT" "$@"\n', { mode: 0o700 });
const stateFile = path.join(root, "seats/state.json"), original = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
const home = path.join(root, "home"), account = path.join(root, "census-account"), log = path.join(root, "seats/logs/worker-1.jsonl");
fs.mkdirSync(home); fs.mkdirSync(account); fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, "");
fs.writeFileSync(path.join(root, "seats/seats.json"), JSON.stringify({ seats: { "worker-1": { role: "worker", harness: "pi", worktree: false, model: "fixture", account: { dir: account } } } }));
// The recorded process and duplicate are siblings, not ancestor/descendant:
// status must continue to exclude genuine children of a recorded seat.
const recordedReady = path.join(root, "census-recorded.ready");
const recorded = Bun.spawn(["node", path.join(source, "fixtures/adapter-selftest-holder.mjs"), "census-recorded-holder"], {
  cwd: root, env: { ...process.env, HOME: home, ADAPTER_HOLDER_READY: recordedReady, ADAPTER_HOLDER_TITLE: "census-recorded-holder" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const recordedOut = new Response(recorded.stdout).text(), recordedErr = new Response(recorded.stderr).text();
const ready = path.join(root, "census-holder.ready"), title = `pi --mode rpc census-duplicate ${account} ${root}`;
const peer = Bun.spawn(["node", path.join(source, "fixtures/adapter-selftest-holder.mjs"), title], {
  cwd: root, env: { ...process.env, HOME: home, ADAPTER_HOLDER_READY: ready, ADAPTER_HOLDER_TITLE: title }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const peerOut = new Response(peer.stdout).text(), peerErr = new Response(peer.stderr).text();
function fileReady(file: string) {
  let resolve: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const watcher = fs.watch(path.dirname(file), () => { if (fs.existsSync(file)) resolve(); });
  if (fs.existsSync(file)) resolve!();
  return { promise, close: () => watcher.close() };
}
const readySignal = fileReady(ready), recordedSignal = fileReady(recordedReady);
let failures = 0; const results: any[] = [];
try {
  const setup = await Promise.race([Promise.all([readySignal.promise, recordedSignal.promise]).then(() => "ready"), peer.exited.then(() => "exit"), recorded.exited.then(() => "exit")]);
  assert.equal(setup, "ready", "both owned siblings must establish real live-process preconditions");
  assert.equal(Number(fs.readFileSync(ready, "utf8")), peer.pid); process.kill(peer.pid, 0);
  assert.equal(Number(fs.readFileSync(recordedReady, "utf8")), recorded.pid); process.kill(recorded.pid, 0);
  const birth = spawnSync(realPs, ["-p", String(recorded.pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(birth.status, 0); assert(!birth.error && !birth.signal && !birth.stderr);
  const start = Date.parse(birth.stdout.trim()); assert(Number.isFinite(start));
  const seat = { pid: recorded.pid, startedAt: new Date(start).toISOString(), role: "worker", roleBrief: "fixture", accountDir: account, cwd: root, log, sessionId: "census-session", sessionFile: null, lastBead: "census-bead" };
  fs.writeFileSync(stateFile, JSON.stringify({ seats: { "worker-1": seat } }, null, 2));
  fs.writeFileSync(path.join(evidence, "birth.json"), JSON.stringify({ command: [realPs, "-p", String(recorded.pid), "-o", "lstart="], status: birth.status, signal: birth.signal, stdout: birth.stdout, stderr: birth.stderr }));
  for (const mode of ["large", "exit23", "empty", "malformed", "stderr"]) {
    const dir = path.join(evidence, mode); fs.mkdirSync(dir);
    const child = Bun.spawn(["bun", path.join(root, "seats/adapter.ts"), "status"], {
      cwd: root, env: { ...process.env, HOME: home, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CLEANUP: "0", PATH: bin + path.delimiter + process.env.PATH, CENSUS_REAL_PS: realPs, CENSUS_WRAPPER_SCRIPT: wrapperScript, CENSUS_MODE: mode, CENSUS_CASE_DIR: dir, WHEELHOUSE_ORPHAN_CONFIRM_MS: "0" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const result: any = { mode, code, stdout, stderr, seatPid: recorded.pid, candidatePid: peer.pid, failure: null };
    try {
      const captured = JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8"));
      const replay = JSON.parse(fs.readFileSync(path.join(dir, "replay.json"), "utf8"));
      assert.equal(captured.status, 0); assert.equal(captured.signal, null); assert.equal(captured.error, null);
      const actual = fs.readFileSync(path.join(dir, "ps.stdout"), "utf8");
      assert(actual.split("\n").some(line => new RegExp(`^\\s*${peer.pid}\\s+`).test(line) && line.includes(account)), "actual captured candidate row exists before replay");
      assert.equal(code, 0, "status must keep its total reporting contract");
      const healthy = stdout.split("\n").find(line => line.startsWith("worker-1"));
      assert(healthy?.includes("RUNNING") && healthy.includes(`pid ${recorded.pid}`), "healthy recorded seat remains visible");
      if (mode === "large") {
        assert(replay.bytes > 2 * 1024 * 1024); assert.equal(replay.exit, 0);
        assert(stdout.includes(`pid ${peer.pid}`) && /ORPHAN|fixture leak/.test(stdout) && stdout.includes("remedy:"), "large census must report the real captured duplicate");
        assert(!stderr.includes("UNVERIFIED orphan census"), "complete captured census is verified");
      } else {
        assert(stderr.includes("UNVERIFIED orphan census"), `${mode} must not become a silent empty census`);
        assert(stderr.includes("no absence of extra processes inferred"));
        assert(!stdout.includes(`pid ${peer.pid}`), "unverified census must not publish candidates from untrusted output");
        if (mode === "exit23") assert(stderr.includes("exit=23") && stderr.includes("fixture census native23"));
        if (mode === "empty") assert(stderr.includes("empty census"));
        if (mode === "malformed") assert(stderr.includes("malformed census record"));
        if (mode === "stderr") assert(stderr.includes("fixture census diagnostic despite exit0"));
      }
      process.kill(recorded.pid, 0); assert(recorded.exitCode === null, "healthy process remains live");
      process.kill(peer.pid, 0); assert(peer.exitCode === null, "candidate remains live, not stopped/restarted by reporting");
      const current = JSON.parse(fs.readFileSync(stateFile, "utf8")).seats["worker-1"];
      for (const key of ["pid", "sessionId", "lastBead"]) assert.equal(current[key], (seat as any)[key], "reporting preserves context");
      result.capture = captured; result.replay = replay;
    } catch (error) { result.failure = String(error); failures++; }
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2)); results.push(result);
    console.log(`${result.failure ? "FAIL" : "PASS"} adapter-census ${mode}: ${result.failure || "captured native records/status honoured; healthy row visible; context and live candidate preserved"}`);
  }
} finally {
  readySignal.close(); recordedSignal.close();
  // Restore before caller cleanup can mistake a fixture helper for a real seat.
  if (original) fs.writeFileSync(stateFile, original); else if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  if (peer.exitCode === null) peer.kill("SIGTERM");
  if (recorded.exitCode === null) recorded.kill("SIGTERM");
  await Promise.all([peer.exited, peerOut, peerErr, recorded.exited, recordedOut, recordedErr]);
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
}
console.log(`adapter-census: ${results.length - failures}/${results.length} passed; actual-capture replay, no elapsed success/failure budget`);
process.exitCode = failures ? 1 : 0;
