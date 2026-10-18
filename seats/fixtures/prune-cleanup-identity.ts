import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { recordCleanupScratch, SCRATCH_MARKER } from "../cleanup-identity";

const [base, source, prune, mode = "fixed"] = process.argv.slice(2);
if (!fs.existsSync(path.join(path.dirname(base), ".wheelhouse-selftest-fixture"))) throw new Error("identity fixtures need the enclosing owned fixture");
fs.mkdirSync(base);
const bead = "identity-closed", baseline = mode === "baseline";
let failures = 0;
function check(ok: boolean, name: string) { console.log(`${ok ? "PASS" : "FAIL"} cleanup identity: ${name}`); if (!ok) failures++; }
function command(bin: string, args: string[], cwd: string, env = process.env) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
  if (r.error || r.signal) throw new Error(`${bin} did not complete: ${r.error ?? r.signal}`);
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(base, name + "-")), root = path.join(dir, "install"), outside = path.join(dir, "outside"), bin = path.join(dir, "bin");
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(bin);
  fs.cpSync(path.join(source, "seats"), path.join(root, "seats"), { recursive: true });
  fs.copyFileSync(prune, path.join(root, "seats", "prune.ts"));
  fs.writeFileSync(path.join(root, "seats", "state.json"), '{"seats":{}}');
  if (command("git", ["init", "-q", "-b", "main"], root).code !== 0) throw new Error("fixture git init failed");
  fs.mkdirSync(path.join(root, ".beads"));
  // Shape captured with bd list --status=closed --json --limit 1; retain only
  // the id/status fields the consumer reads, substituting this fixture's id.
  fs.writeFileSync(path.join(bin, "bd"), `#!/bin/sh\ncase " $* " in *" --status=closed "*) printf '%s\\n' '[{"id":"${bead}","status":"closed"}]';; *) printf '[]\\n';; esac\n`, { mode: 0o755 });
  const config = path.join(dir, "probe.json"), count = path.join(dir, "count"), lsof = path.join(bin, "lsof");
  fs.writeFileSync(config, JSON.stringify({ root, outside, count, mode: "quiet", target: path.join(root, ".wheelhouse-runs", bead + "-run") }));
  fs.writeFileSync(lsof, `#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const c=JSON.parse(fs.readFileSync(${JSON.stringify(config)},"utf8"));
let n=0;try{n=Number(fs.readFileSync(c.count,"utf8"));}catch{}fs.writeFileSync(c.count,String(++n));
const keep=p=>{fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,"KEEP"),"foreign fixture sentinel\\n");};
if(n===1){
 const lock=path.join(c.root,"seats","run","cleanup.lock");
 const st=fs.lstatSync(lock,{bigint:true});let marker=null;
 try{marker=JSON.parse(fs.readFileSync(path.join(lock,"wheelhouse-cleanup-lock"),"utf8"));}catch{}
 fs.writeFileSync(path.join(path.dirname(c.count),"observed-lock.json"),JSON.stringify({identity:String(st.dev)+":"+String(st.ino),pid:Number(fs.readFileSync(path.join(lock,"pid"),"utf8").trim()),marker}));
}
if(n===2){
 if(c.mode==="ancestor-swap"){const p=path.dirname(c.target);fs.renameSync(p,p+".original");fs.symlinkSync(c.outside,p);}
 if(c.mode==="ancestor-replace"){const p=path.dirname(c.target);fs.renameSync(p,p+".original");keep(c.target);}
 if(c.mode==="target-replace"){fs.renameSync(c.target,c.target+".original");keep(c.target);}
 if(c.mode==="marker-replace"){const p=path.join(c.target,${JSON.stringify(SCRATCH_MARKER)});const m=JSON.parse(fs.readFileSync(p,"utf8"));m.token="f".repeat(32);fs.writeFileSync(p,JSON.stringify(m)+"\\n");}
}
if(n===1 && c.mode.startsWith("release-")){
 const run=path.join(c.root,"seats","run"),lock=path.join(run,"cleanup.lock");
 if(c.mode==="release-parent"){fs.renameSync(run,run+".original");keep(lock);fs.writeFileSync(path.join(lock,"pid"),"999999\\n");}
 if(c.mode==="release-directory"){fs.renameSync(lock,lock+".original");keep(lock);fs.writeFileSync(path.join(lock,"pid"),"999999\\n");}
 if(c.mode==="release-token"){const p=path.join(lock,"wheelhouse-cleanup-lock");let m={};try{m=JSON.parse(fs.readFileSync(p,"utf8"));}catch{}m.token="0".repeat(32);fs.writeFileSync(p,JSON.stringify(m)+"\\n");}
}
// Real lsof -a -p <owned pid> -d cwd -Fpn capture: p<pid>, fcwd, n<cwd>.
// This quiet fixture record has no cwd inside any candidate.
process.stdout.write("p1\\nfcwd\\nn/\\n");
`, { mode: 0o755 });
  return { dir, root, outside, bin, config, count, lsof, entry: path.join(root, "seats", "prune.ts"), target: path.join(root, ".wheelhouse-runs", bead + "-run"), log: path.join(dir, "cleanup.log") };
}
type Fixture = ReturnType<typeof fixture>;
function keep(p: string) { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, "KEEP"), "foreign fixture sentinel\n"); }
function setMode(f: Fixture, mode: string) { const c = JSON.parse(fs.readFileSync(f.config, "utf8")); c.mode = mode; fs.writeFileSync(f.config, JSON.stringify(c)); }
function invoke(f: Fixture) {
  const env = { ...process.env, PATH: f.bin + ":" + process.env.PATH, WHEELHOUSE_LSOF: f.lsof };
  const r = command("bun", [f.entry, "cleanup", "--root", f.root, "--log", f.log], f.root, env);
  const record = { fixture: path.basename(f.dir), ...r, outsideLockKeep: fs.existsSync(path.join(f.outside, "cleanup.lock", "KEEP")), outsideScratchKeep: fs.existsSync(path.join(f.outside, path.basename(f.target), "KEEP")), targetKeep: fs.existsSync(path.join(f.target, "KEEP")) };
  console.log("MEASUREMENT " + JSON.stringify(record));
  fs.writeFileSync(path.join(f.dir, "result.json"), JSON.stringify(record, null, 2) + "\n");
  return r;
}
function deadPid() { try { process.kill(999999, 0); throw new Error("expected fixture dead pid is live"); } catch (e: any) { if (e.code !== "ESRCH") throw e; } }
deadPid();
{
  const f = fixture("symlink-run"), victim = path.join(f.outside, "cleanup.lock"); keep(victim); fs.writeFileSync(path.join(victim, "pid"), "999999\n");
  fs.symlinkSync(f.outside, path.join(f.root, "seats", "run"));
  if (!fs.existsSync(path.join(victim, "KEEP"))) throw new Error("D6 subject absent");
  const r = invoke(f), present = fs.existsSync(path.join(victim, "KEEP"));
  check(baseline ? r.code === 0 && !present : r.code === 2 && present && /seats\/run/.test(r.stderr), baseline ? "D6 pre-fix deletes outside KEEP" : "D6 symlinked seats/run refused, outside KEEP intact");
}
{
  const f = fixture("ancestor-swap"); keep(f.target); recordCleanupScratch(f.root, f.target, bead);
  const victim = path.join(f.outside, path.basename(f.target)); keep(victim); setMode(f, "ancestor-swap");
  if (!fs.existsSync(path.join(victim, "KEEP"))) throw new Error("D7 subject absent");
  const r = invoke(f), present = fs.existsSync(path.join(victim, "KEEP"));
  check(baseline ? r.code === 0 && !present : r.code === 0 && present && r.stdout.includes(`kept run-scratch ${f.target} reason=path changed during check`), baseline ? "D7 pre-fix deletes outside KEEP after lsof swap" : "D7 ancestor swap during lsof refused, outside KEEP intact");
  check(fs.existsSync(path.join(path.dirname(f.target) + ".original", path.basename(f.target), "KEEP")), "original scratch survives the ancestor swap");
}
if (!baseline) {
  {
    const f = fixture("symlink-seats"), retained = path.join(f.root, "original-seats");
    fs.renameSync(path.join(f.root, "seats"), retained); f.entry = path.join(retained, "prune.ts");
    keep(path.join(f.outside, "run", "cleanup.lock")); fs.writeFileSync(path.join(f.outside, "run", "cleanup.lock", "pid"), "999999\n");
    fs.symlinkSync(f.outside, path.join(f.root, "seats")); const r = invoke(f);
    check(r.code === 2 && fs.existsSync(path.join(f.outside, "run", "cleanup.lock", "KEEP")) && /seats/.test(r.stderr), "symlinked seats component refused");
  }
  for (const kind of ["extra", "pid-link", "invalid", "pidless"]) {
    const f = fixture("foreign-lock-" + kind), lock = path.join(f.root, "seats", "run", "cleanup.lock"); fs.mkdirSync(lock, { recursive: true });
    if (kind === "pid-link") { fs.writeFileSync(path.join(f.outside, "pid"), "999999\n"); fs.symlinkSync(path.join(f.outside, "pid"), path.join(lock, "pid")); }
    else if (kind !== "pidless") fs.writeFileSync(path.join(lock, "pid"), kind === "invalid" ? "unparseable\n" : "999999\n");
    if (kind === "extra") fs.writeFileSync(path.join(lock, "KEEP"), "foreign lock sentinel\n");
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
    const snapshot = () => fs.existsSync(lock) ? fs.readdirSync(lock).sort().map(name => { const file = path.join(lock,name), st = fs.lstatSync(file); return [name,st.dev,st.ino,st.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file,"utf8")]; }) : null;
    const before = JSON.stringify(snapshot()), r = invoke(f);
    check(r.code === 2 && JSON.stringify(snapshot()) === before && r.stderr.includes("cleanup.lock"), `${kind} lock refuses without removing foreign content`);
  }
  for (const live of [false, true]) {
    const f = fixture(live ? "legacy-live" : "legacy-dead"), lock = path.join(f.root, "seats", "run", "cleanup.lock"); fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, "pid"), `${live ? process.pid : 999999}\n`);
    const r = invoke(f); check(r.code === 0 && (live ? fs.existsSync(lock) && r.stdout.trim() === "already running" : !fs.existsSync(lock) && r.stdout.includes("cleanup done")), live ? "live legacy numeric owner is kept" : "provably dead legacy pid-only lock reclaimed");
  }
  for (const mode of ["ancestor-replace", "target-replace", "marker-replace"]) {
    const f = fixture(mode); keep(f.target); recordCleanupScratch(f.root, f.target, bead); setMode(f, mode);
    const r = invoke(f); check(r.code === 0 && fs.existsSync(path.join(f.target, "KEEP")) && r.stdout.includes("reason=path changed during check"), `${mode} identity/content change kept after lsof`);
  }
  for (const mode of ["release-parent", "release-directory", "release-token"]) {
    const f = fixture(mode); setMode(f, mode); const r = invoke(f), lock = path.join(f.root, "seats", "run", "cleanup.lock");
    const retained = mode === "release-token" ? fs.existsSync(path.join(lock,"wheelhouse-cleanup-lock")) && JSON.parse(fs.readFileSync(path.join(lock,"wheelhouse-cleanup-lock"),"utf8")).token === "0".repeat(32) : fs.existsSync(path.join(lock,"KEEP")) && fs.readFileSync(path.join(lock,"KEEP"),"utf8") === "foreign fixture sentinel\n";
    check(r.code === 2 && fs.existsSync(lock) && /cleanup.lock/.test(r.stderr) && retained, `${mode} refuses to release another identity/token`);
  }
  for (const marked of [false, true]) {
    const f = fixture(marked ? "foreign-marker" : "unmarked"); keep(f.target);
    if (marked) { const other = fixture("other-install"); keep(other.target); recordCleanupScratch(other.root, other.target, bead); fs.copyFileSync(path.join(other.target, SCRATCH_MARKER), path.join(f.target, SCRATCH_MARKER)); }
    const r = invoke(f); check(r.code === 0 && fs.existsSync(path.join(f.target, "KEEP")) && r.stdout.includes(`kept run-scratch ${f.target} reason=unproven scratch ownership`), marked ? "foreign scratch marker refused" : "unmarked scratch kept and named");
  }
  {
    const f = fixture("owned-positive"), sibling = f.target + "-foreign"; keep(f.target); keep(sibling); recordCleanupScratch(f.root, f.target, bead);
    const outsideFile = path.join(f.outside, "KEEP"); fs.writeFileSync(outsideFile, "outside read-only sentinel\n", { mode: 0o444 }); fs.symlinkSync(outsideFile, path.join(f.target, "external-link"));
    const scratchRecord = JSON.parse(fs.readFileSync(path.join(f.target,SCRATCH_MARKER),"utf8"));
    const before = fs.statSync(outsideFile).mode, r = invoke(f);
    check(r.code === 0 && !fs.existsSync(f.target) && fs.existsSync(path.join(sibling, "KEEP")) && r.stdout.includes(`removed run-scratch ${f.target} `), "only explicitly recorded closed-bead scratch removed");
    check(fs.readFileSync(outsideFile, "utf8") === "outside read-only sentinel\n" && fs.statSync(outsideFile).mode === before, "scratch child symlink cannot chmod or remove external file");
    const observed = JSON.parse(fs.readFileSync(path.join(f.dir,"observed-lock.json"),"utf8"));
    check(observed.marker?.kind === "wheelhouse-cleanup-lock" && /^[0-9a-f]{32}$/.test(observed.marker.token) && observed.marker.pid === observed.pid && observed.marker.identity === observed.identity && !fs.existsSync(path.join(f.root, "seats", "run", "cleanup.lock")), "observed new token/pid/inode-owned lock released after positive cleanup");
    for (const mismatch of [false,true]) {
      const other = fixture(mismatch ? "token-pid-mismatch" : "stale-token"), lock = path.join(other.root,"seats","run","cleanup.lock"); fs.mkdirSync(lock,{recursive:true});
      const {target,bead:recordedBead,...sharedFields} = scratchRecord;
      const st = fs.lstatSync(lock,{bigint:true}), m = {...sharedFields,kind:"wheelhouse-cleanup-lock",root:other.root,identity:`${st.dev}:${st.ino}`,pid:mismatch ? process.pid : 999999};
      fs.writeFileSync(path.join(lock,"pid"),"999999\n"); fs.writeFileSync(path.join(lock,"wheelhouse-cleanup-lock"),JSON.stringify(m)+"\n");
      const r = invoke(other);
      check(mismatch ? r.code === 2 && fs.existsSync(lock) && r.stderr.includes("ownership marker") : r.code === 0 && !fs.existsSync(lock), mismatch ? "stale token lock with mismatched pid refused" : "valid stale token-owned lock reclaimed");
    }
  }
}
console.log(`cleanup identity fixtures: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} mode=${mode}`);
process.exit(failures ? 1 : 0);
