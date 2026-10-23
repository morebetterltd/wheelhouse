import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const [runtime, parent] = process.argv.slice(2);
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
const source = fs.readFileSync(path.join(runtime, "seats/prune.ts"), "utf8");
for (const mode of ["delayed", "expiry"]) {
  async function observe(removed: boolean) {
    const root = path.join(parent, `prune-state-${mode}-${removed ? "removed" : "positive"}`);
    fs.cpSync(runtime, root, { recursive: true });
    let changed = source;
    if (removed) {
      const old = mode === "delayed"
        ? 'Number(process.env.WHEELHOUSE_PRUNE_STATE_OBSERVE_MS || 120000)'
        : 'catch (e: any) { return `seat "${name}" state UNVERIFIED: ${e.message}; prune not authorized`; }';
      const replacement = mode === "delayed" ? "2000" : "catch { return null; }";
      assert.equal(source.split(old).length - 1, 1, "actual observation-policy/unknown guard must match once");
      changed = source.replace(old, () => replacement);
    }
    // Instrument a COPY to expose the real private decision function. Its CLI
    // entry remains gated by import.meta.main; no production test hook exists.
    fs.writeFileSync(path.join(root, "seats/prune.ts"), changed + "\nexport { midTurnSeatReason };\n");
    for (const dir of ["seats/run", "seats/logs"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const fifo = path.join(root, "seats/run/worker.stdin"), log = path.join(root, "seats/logs/worker.jsonl"), token = randomUUID();
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" }); assert.equal(made.status, 0); fs.writeFileSync(log, "");
    const actorFile = path.join(root, "actor.cjs"), driverFile = path.join(root, "driver.ts");
    fs.writeFileSync(actorFile, String.raw`const fs=require('node:fs'),path=require('node:path');const[root,token]=process.argv.slice(2),at=n=>path.join(root,n),pub=(n,v)=>{fs.writeFileSync(at(n+'.new'),JSON.stringify(v)+'\n');fs.renameSync(at(n+'.new'),at(n));};const fd=fs.openSync(at('seats/run/worker.stdin'),fs.constants.O_RDWR|fs.constants.O_NONBLOCK);let pending='',request;
pub('ready',{pid:process.pid,token});setInterval(()=>{
 if(fs.existsSync(at('stop'))&&fs.readFileSync(at('stop'),'utf8')===token){fs.closeSync(fd);pub('retired',{pid:process.pid,token});process.exit(0)}
 const b=Buffer.alloc(8192);let n=0;try{n=fs.readSync(fd,b,0,b.length,null)}catch(e){if(!['EAGAIN','EWOULDBLOCK'].includes(e.code))throw e;}if(n)pending+=b.subarray(0,n).toString('utf8');const lf=pending.indexOf('\n');if(lf>=0){request=JSON.parse(pending.slice(0,lf));pending=pending.slice(lf+1);pub('requested',{pid:process.pid,token,id:request.id,type:request.type});}
 if(request&&fs.existsSync(at('release'))){fs.appendFileSync(at('seats/logs/worker.jsonl'),JSON.stringify({id:request.id,type:'response',success:true,data:{isStreaming:true}})+'\n');pub('replied',{id:request.id,token});request=null;}
},25);
`);
    fs.writeFileSync(driverFile, 'import {midTurnSeatReason} from "./seats/prune.ts";console.log(JSON.stringify({reason:midTurnSeatReason()}));\n');
    const actor = Bun.spawn(["node", actorFile, root, token], { cwd: root, stdin: "ignore", stdout: Bun.file(path.join(root, "actor.out")), stderr: Bun.file(path.join(root, "actor.err")) });
    const until = performance.now() + 180000;
    async function wait(label: string, predicate: () => boolean) {
      while (!predicate()) { if (performance.now() >= until) throw Error(`INCOMPLETE ${mode} ${label}; actor=${actor.pid}`); await Bun.sleep(25); }
    }
    let driver: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await wait("native actor readiness", () => fs.existsSync(path.join(root, "ready")));
      const ready = JSON.parse(fs.readFileSync(path.join(root, "ready"), "utf8")); assert.equal(ready.pid, actor.pid); assert.equal(ready.token, token);
      const birth = spawnSync("ps", ["-p", String(actor.pid), "-o", "lstart="], { encoding: "utf8" });
      assert.equal(birth.status, 0); assert.equal(birth.signal, null); assert(Number.isFinite(Date.parse(birth.stdout.trim())));
      console.log("CAPTURE prune-state native birth " + JSON.stringify({ mode, pid: actor.pid, status: birth.status, signal: birth.signal, stdout: birth.stdout, stderr: birth.stderr }));
      fs.writeFileSync(path.join(root, "seats/state.json"), JSON.stringify({ seats: { worker: { pid: actor.pid, startedAt: new Date(Date.parse(birth.stdout.trim())).toISOString(), role: "worker", cwd: root, fifo, log } } }));
      driver = Bun.spawn(["bun", driverFile], { cwd: root, env: { ...process.env, WHEELHOUSE_SKIP_BD: "1", ...(mode === "expiry" ? { WHEELHOUSE_PRUNE_STATE_OBSERVE_MS: "100" } : {}) }, stdin: "ignore", stdout: Bun.file(path.join(root, "driver.out")), stderr: Bun.file(path.join(root, "driver.err")) });
      await wait("actual get_state receipt", () => fs.existsSync(path.join(root, "requested")));
      const request = JSON.parse(fs.readFileSync(path.join(root, "requested"), "utf8")); assert.equal(request.pid, actor.pid); assert.equal(request.type, "get_state"); assert.equal(request.token, token);
      if (mode === "delayed") {
        // Deliberate scheduling input exceeds the old 2s cutoff; no load cause
        // is inferred. A live native provider has accepted the actual request.
        const releaseAt = performance.now() + 3200;
        await wait("controlled response hold", () => performance.now() >= releaseAt);
        fs.writeFileSync(path.join(root, "release"), "release\n");
        await wait("actual response publication", () => fs.existsSync(path.join(root, "replied")));
      }
      const rc = await driver.exited;
      assert.equal(rc, 0, "setup/driver failure does not count: " + fs.readFileSync(path.join(root, "driver.err"), "utf8"));
      const result = JSON.parse(fs.readFileSync(path.join(root, "driver.out"), "utf8"));
      const alive = spawnSync("ps", ["-p", String(actor.pid), "-o", "lstart="], { encoding: "utf8" });
      assert.equal(alive.status, 0); assert.equal(alive.stdout.trim(), birth.stdout.trim(), "same original actor still live");
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, "seats/state.json"), "utf8")).seats.worker.pid, actor.pid);
      if (mode === "expiry") fs.writeFileSync(path.join(root, "release"), "release\n");
      return result;
    } finally {
      fs.writeFileSync(path.join(root, "stop"), token);
      assert.equal(await actor.exited, 0, "join the original actor, not a later numeric occupant");
    }
  }
  function check(result: any) {
    if (mode === "delayed") assert.match(result.reason ?? "", /mid-turn per get_state/, "actual delayed streaming response decides");
    else { assert.match(result.reason ?? "", /UNVERIFIED.*policy expired/); assert.match(result.reason, /observedOffset=.*prune not authorized/); }
  }
  check(await observe(false)); console.log("PASS native-prune " + mode);
  const removed = await observe(true);
  assert.throws(() => check(removed), assert.AssertionError, "restored cutoff/empty-idle fallback must reject with complete native setup");
  console.log("REJECT native-prune " + mode + " driverNative=0 actorNative=0");
}
console.log("PASS native-prune: 2 observations, 2 meaningful removals; no timer or missing response authorizes prune");
