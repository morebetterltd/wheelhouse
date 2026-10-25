// Recorded aggregate: docker system df --format "{{json .}}", supplied by the
// commander for GH#84. docker-system-df.jsonl is verbatim; size changes below,
// daemon/errors/malformed responses are synthetic. Never delegates to Docker.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [implementation, scratch, mode = "all"] = process.argv.slice(2);
assert(fs.statSync(implementation).isFile());
fs.mkdirSync(scratch, { recursive: true });
const root = fs.realpathSync(scratch), runtime = path.dirname(implementation);
const capture = fs.readFileSync(path.join(import.meta.dir, "docker-system-df.jsonl"), "utf8");
const rows = capture.trim().split("\n").map(l => JSON.parse(l));
assert.equal(rows.filter(r => r.Type === "Build Cache").length, 1);
assert.equal(rows.find(r => r.Type === "Build Cache").Size, "40.31MB");
const records: any[] = [];
const tag = "DOCKER_PRESSURE_ASSERTION";
const evidence = process.env.WHEELHOUSE_DOCKER_PRESSURE_EVIDENCE;
const bun = Bun.which("bun")!, bash = Bun.which("bash")!;
assert(bun && bash);
function save() {
  const data = JSON.stringify({ implementation, capture, mode, records }, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "results.json"), data);
  if (evidence) { assert(fs.statSync(evidence).isDirectory()); fs.writeFileSync(path.join(evidence, `docker-pressure-${process.pid}.json`), data); }
}
async function command(file: string, args: string[], env: any) {
  const p = spawn(file, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = []; let stdoutEOF = false, stderrEOF = false;
  p.stdout!.on("data", x => out.push(x)); p.stderr!.on("data", x => err.push(x));
  p.stdout!.on("end", () => stdoutEOF = true); p.stderr!.on("end", () => stderrEOF = true);
  const result = await new Promise<any>((yes, no) => { p.once("error", no); p.once("close", (code, signal) => yes({ code, signal })); });
  return { file, args, pid: p.pid, ...result, stdoutEOF, stderrEOF, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}
async function scenario(name: string, opts: any, source = implementation) {
  const dir = path.join(root, name), seats = path.join(dir, "seats"), bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(seats, "run"), { recursive: true }); fs.mkdirSync(path.join(dir, "wheelhouse")); fs.mkdirSync(bin); fs.mkdirSync(path.join(dir, "home"));
  for (const f of fs.readdirSync(runtime)) if (/\.(ts|sh)$/.test(f) && !f.endsWith(".selftest.sh")) fs.copyFileSync(path.join(runtime, f), path.join(seats, f));
  fs.copyFileSync(source, path.join(seats, "alerts.ts"));
  fs.writeFileSync(path.join(seats, "seats.json"), '{"seats":{}}\n'); fs.writeFileSync(path.join(seats, "state.json"), '{"seats":{}}\n');
  fs.writeFileSync(path.join(dir, "wheelhouse/.template-source"), `alert-low-disk-gb=10\ngithub-issue-watch=off\n${opts.config ?? ""}`);
  fs.writeFileSync(path.join(seats, "template-drift.sh"), '#!/usr/bin/env bash\nprintf \'{"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n');
  fs.symlinkSync(bun, path.join(bin, "bun")); fs.symlinkSync(bash, path.join(bin, "bash"));
  const readyPayload=JSON.stringify(opts.ready ? '[{"id":"ready-fixture","title":"fixture"}]' : '[]');
  fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bun\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(path.join(dir, "bd-calls.jsonl"))},JSON.stringify(process.argv.slice(2))+'\\n');console.log(${readyPayload});\n`, { mode: 0o755 });
  const response = path.join(dir, "response.jsonl"), calls = path.join(dir, "docker-calls.jsonl");
  let text = capture;
  if (opts.size) text = rows.map(r => JSON.stringify(r.Type === "Build Cache" ? { ...r, Size: opts.size } : r)).join("\n") + "\n";
  if (opts.malformed) text = "not-json\n";
  fs.writeFileSync(response, text);
  if (!opts.absent) fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bun\nconst fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid,ppid:process.ppid,args,cwd:process.cwd()})+'\\n');if(JSON.stringify(args)!==JSON.stringify(['system','df','--format','{{json .}}'])){console.error('forbidden fixture docker call');process.exit(91);}if(${!!opts.daemon}){console.error('Cannot connect to the Docker daemon');process.exit(1);}process.stdout.write(fs.readFileSync(${JSON.stringify(response)}));process.exit(${opts.exit ?? 0});\n`, { mode: 0o755 });
  // Host space is ample by explicit input; never depend on this Mac's free disk.
  const preload = path.join(dir, "host-space.cjs");
  fs.writeFileSync(preload, "const fs=require('node:fs');fs.statfsSync=()=>({bavail:33*1024**3,bsize:1});\n");
  const dockerFile=path.join(bin,"docker"), dockerScript=opts.absent?"":fs.readFileSync(dockerFile,"utf8");
  const env = { ...process.env, HOME: path.join(dir, "home"), PATH: bin, WHEELHOUSE_ALERTS_ROOT: dir, WHEELHOUSE_ALERTS_FIXTURE_DOCKER: dockerFile };
  const observations: any[] = [];
  const rec: any = { name, opts, source, sourceText: fs.readFileSync(source,"utf8"), response: text, observations, attempts: [] }; records.push(rec);
  for (let i = 0; i < (opts.repeats ?? 1); i++) {
    if(opts.lifecycle){fs.writeFileSync(dockerFile,i===2?dockerScript.replace('if(false)','if(true)'):dockerScript);fs.writeFileSync(response,i===4?capture:text);}
    const native = await command("bun", ["--preload", preload, path.join(seats, "alerts.ts"), "check", "--json"], env);
    rec.attempts.push(native); save();
    assert.equal(native.code, 0, `${tag} ${name}: alerts CLI must complete: ${native.stderr}`); assert.equal(native.signal, null); assert(native.stdoutEOF && native.stderrEOF);
    const snapshot = JSON.parse(fs.readFileSync(path.join(seats, "run/fleet-snapshot.json"), "utf8"));
    const inboxFile = path.join(seats, "inbox.jsonl"), inbox = fs.existsSync(inboxFile) ? fs.readFileSync(inboxFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    const dockerCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
    observations.push({ native, snapshot, inbox, dockerCalls }); save();
    assert.equal(snapshot.disk.freeBytes, 33 * 1024 ** 3, "CONTROL_SETUP host statfs input");
    assert(!snapshot.alerts["low-disk"].active, "CONTROL_SETUP host should be ample");
    const alerts = inbox.filter(r => r.source?.name === "docker-cache-pressure");
    assert.equal(alerts.length, opts.lifecycle&&i===5?2:opts.alert?1:0, `${tag} ${name}: Docker alert count`);
    if(opts.lifecycle){assert.equal(snapshot.alerts["docker-cache-pressure"].active,i!==4,`${tag} ${name}: active/clear state`);if(i===2||i===3)assert.deepEqual(snapshot.alerts["docker-cache-pressure"],observations[1].snapshot.alerts["docker-cache-pressure"],`${tag} ${name}: unknown preserves last known state`);}
    if (opts.alert) { assert(alerts[0].detail.includes(opts.size), `${tag} ${name}: cache size`); assert(alerts[0].detail.includes("docker builder prune -f"), `${tag} ${name}: prune command`); assert(alerts[0].detail.includes("cache pressure"), `${tag} ${name}: pressure label`); assert(!/percent.full|VM.*full/i.test(alerts[0].detail), `${tag} ${name}: no VM fullness claim`); }
    assert.equal(dockerCalls.length, opts.absent || opts.disabled ? 0 : i + 1, `${tag} ${name}: expected fixture Docker calls`);
    if (opts.ready) { assert.equal(snapshot.snapshot.readyCount, 1, `${tag} ${name}: other checks`); assert(inbox.some(r => r.source?.name === "idle-fleet-ready-work"), `${tag} ${name}: other alert`); }
    if (!opts.alert) assert(inbox.every(r => ["idle-fleet-ready-work", "cold-seats-ready-work"].includes(r.source?.name)), `${tag} ${name}: no error row`);
  }
  console.log(`PASS Docker cache ${name}: alerts CLI0/EOF, Docker calls=${observations.at(-1).dockerCalls.length}, cache rows=${observations.at(-1).inbox.filter(r=>r.source?.name==="docker-cache-pressure").length}`);
}
try {
  await scenario("high-cache", { size: "19.5GB", alert: true, repeats: mode === "baseline" ? 1 : 3 });
  if (mode !== "baseline") {
    await scenario("recorded-ample", {});
    await scenario("decimal-below-gib", { size: "10GB" });
    await scenario("custom-threshold", { size: "19.5GB", config: "alert-docker-build-cache-gib=20\n" });
    await scenario("absent", { absent: true, ready: true });
    await scenario("daemon-stopped", { daemon: true, ready: true });
    await scenario("malformed", { malformed: true, ready: true });
    await scenario("native-failure", { size: "19.5GB", exit: 7, ready: true });
    await scenario("disabled", { disabled: true, config: "alert-docker-build-cache-gib=0\n" });
    await scenario("lifecycle", {size:"19.5GB",alert:true,repeats:6,lifecycle:true});
    const original=fs.readFileSync(implementation,"utf8");
    const controls:any[]=[
      ["forget-unavailable", '||(name==="docker-cache-pressure"&&docker.status==="unavailable")', '', {size:"19.5GB",alert:true,repeats:6,lifecycle:true}],
      ["ignore-clear", 'on:docker.status==="ok"&&docker.cacheBytes!==null&&docker.cacheBytes>=docker.thresholdBytes', 'on:priorAlerts["docker-cache-pressure"]?.active||(docker.status==="ok"&&docker.cacheBytes!==null&&docker.cacheBytes>=docker.thresholdBytes)', {size:"19.5GB",alert:true,repeats:6,lifecycle:true}],
      ["remove-observation", "const docker=await dockerCacheInfo();", 'const docker={status:"unavailable",cacheBytes:null,cacheSize:null,thresholdBytes:0};', {size:"19.5GB",alert:true}],
      ["always-pressure", "docker.cacheBytes>=docker.thresholdBytes", "true", {}],
      ["binary-docker-units", "GB:1000**3", "GB:1024**3", {size:"10GB"}],
      ["ignore-threshold", 'const raw=templateValue("alert-docker-build-cache-gib");', 'const raw="";', {size:"19.5GB",config:"alert-docker-build-cache-gib=20\n"}],
      ["fatal-absence", 'if(!dockerBin) return unavailable("docker not on PATH or fixture executable unavailable");', 'if(!dockerBin) throw Error("planted fatal absence");', {absent:true,ready:true}],
      ["fatal-daemon", 'if(r.error||r.signal||r.status!==0) return unavailable("docker observation did not complete successfully",r);', 'if(r.error||r.signal||r.status!==0) throw Error("planted fatal daemon failure");', {daemon:true,ready:true}],
      ["parse-failed-command", 'if(r.error||r.signal||r.status!==0) return unavailable("docker observation did not complete successfully",r);', 'if(r.error||r.signal) return unavailable("docker observation did not complete successfully",r);', {size:"19.5GB",exit:7,ready:true}],
      ["fatal-malformed", 'catch { return unavailable("invalid Docker JSONL",r); }', 'catch { throw Error("planted fatal malformed JSONL"); }', {malformed:true,ready:true}],
      ["drop-size-detail", 'build cache=${docker.cacheSize}', 'build cache=unknown', {size:"19.5GB",alert:true}],
      ["drop-prune-detail", 'docker builder prune -f', 'inspect Docker cache', {size:"19.5GB",alert:true}],
      ["ignore-disable", 'if(thresholdBytes===0) return {status:"disabled",cacheBytes:null,cacheSize:null,thresholdBytes};', '// planted removal: ignore explicit disable', {disabled:true,config:"alert-docker-build-cache-gib=0\n"}]
    ];
    for(const [name,old,replacement,opts] of controls){
      assert.equal(original.split(old).length,2,`CONTROL_SETUP ${name} source match`);
      const file=path.join(root,`${name}.ts`),changed=original.replace(old,replacement);assert.notEqual(changed,original);fs.writeFileSync(file,changed);
      let rejected=false;try{await scenario("removed-"+name,opts,file);}catch(e:any){assert(e.message.includes(tag),`CONTROL_SETUP ${name}: ${e.stack}`);rejected=true;records.at(-1).rejection=e.message;save();}
      assert(rejected,`${tag} ${name}: intended oracle failed to reject removal`);
      console.log(`PASS Docker removal ${name}: rejected by intended consumer oracle; native outcome retained`);
    }
  }
} finally { save(); }
