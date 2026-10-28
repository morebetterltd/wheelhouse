// Real cleanup CLIs, a held first scan, and explicit logical lock time. No
// guessed sleep decides readiness, success, or whether the waiter contended.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
import { recordCleanupScratch } from "../cleanup-identity";
import { assertGraph } from "./prune-graph.ts";
const [base, source, prune, clock, mode = "fixed", graph] = process.argv.slice(2);
assert(["fixed", "removed"].includes(mode), "unknown prune wait fixture mode");
assert(fs.statSync(path.join(path.dirname(base), ".wheelhouse-selftest-fixture")).isFile());
fs.mkdirSync(base);
const root = path.join(base, "install"), home = path.join(base, "home"), bin = path.join(base, "bin");
fs.mkdirSync(root); fs.mkdirSync(home); fs.mkdirSync(bin);
// No simulator or installed app is part of this lock-only fixture.
fs.writeFileSync(path.join(bin, "xcrun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
fs.cpSync(path.join(source, "seats"), path.join(root, "seats"), { recursive: true });
fs.copyFileSync(prune, path.join(root, "seats", "prune.ts"));
fs.writeFileSync(path.join(root, "seats", "state.json"), '{"seats":{}}\n');
const env = { ...process.env, HOME: home, PWD: root, PATH: bin + path.delimiter + process.env.PATH };
function command(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { cwd: root, env, encoding: "utf8" });
  assert(!r.error && !r.signal, `${bin}: ${r.error ?? r.signal}`);
  assert.equal(r.status, 0, `${bin} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
command("git", ["init", "-q", "-b", "main"]);
command("git", ["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]);
assert(graph, "shell must supply the helper-built waiter graph");
fs.symlinkSync(path.join(graph, ".beads"), path.join(root, ".beads"), "dir");
function verifyGraph(tasks: [string, string][], announce = false) {
  try {
    const binding = assertGraph(root, graph, tasks, env);
    if (announce) {
      console.log("MEASUREMENT prune graph waitcase " + JSON.stringify(binding));
      console.log("  ok    waitcase tasks were written to the selftest scratch graph only");
    }
  } catch (error) { console.log("  FAIL  waitcase tasks were written to the selftest scratch graph only: " + error); throw error; }
}
verifyGraph([]);
for (const id of ["waitcase-a", "waitcase-b"]) {
  // The sanctioned builder uses scratch-, while these lock fixtures have fixed IDs.
  command("bd", ["create", "--force", "--id", id, "--title", "Owned cleanup waiter fixture"]);
  command("bd", ["close", id]);
  const target = path.join(root, ".wheelhouse-runs", id + "-run");
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, "KEEP"), id + "\n");
  recordCleanupScratch(root, target, id);
}
verifyGraph([["waitcase-a", "closed"], ["waitcase-b", "closed"]], true);
const realLsof = command("which", ["lsof"]), held = path.join(base, "held"), release = path.join(base, "release"), polled = path.join(base, "polled");
assert(path.isAbsolute(realLsof) && fs.existsSync(realLsof));
const lsof = path.join(base, "lsof");
fs.writeFileSync(lsof, `#!/usr/bin/env bun
import fs from "node:fs";import{spawnSync}from"node:child_process";
if(!fs.existsSync(${JSON.stringify(held)})){fs.writeFileSync(${JSON.stringify(held)},"first cleanup owns lock and reached scan\\n");while(!fs.existsSync(${JSON.stringify(release)}))await Bun.sleep(10);}
const r=spawnSync(${JSON.stringify(realLsof)},process.argv.slice(2),{stdio:"inherit"});process.exit(r.status??2);
`, { mode: 0o755 });
// Adversarial input clock: enough logical time passes to exhaust the old
// progress test's budget while A still owns the lock. The freeze preload is
// the fix; omitting exactly that preload is the negative control.
const elapsed = path.join(base, "elapsed.ts"), observer = path.join(base, "observer.ts");
fs.writeFileSync(elapsed, 'let calls=0;Date.now=()=>100000+(calls++===0?0:31000);\n');
fs.writeFileSync(observer, `import fs from "node:fs";const now=Date.now;let calls=0;Date.now=()=>{const value=now();if(++calls===2)fs.writeFileSync(${JSON.stringify(polled)},JSON.stringify({calls,value})+"\\n");return value;};\n`);
function launch(id: string, waiter: boolean) {
  const args: string[] = [];
  if (waiter) args.push("--preload", elapsed);
  if (mode !== "removed" || !waiter) args.push("--preload", clock);
  if (waiter) args.push("--preload", observer);
  args.push("seats/prune.ts", "cleanup", "--bead", id, "--wait", "30");
  const child = spawn("bun", args, { cwd: root, env: { ...env, WHEELHOUSE_LSOF: lsof }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", closed = false;
  child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
  const done = new Promise<{ code: number | null; signal: string | null; out: string; err: string }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal, out, err }); });
  });
  return { child, done, closed: () => closed };
}
const a = launch("waitcase-a", false);let b: ReturnType<typeof launch> | undefined;
try {
  while (!fs.existsSync(held) && !a.closed()) await Bun.sleep(10);
  assert(fs.existsSync(held), "first cleanup exited before the held-scan witness");
  const owner = Number(fs.readFileSync(path.join(root, "seats/run/cleanup.lock/pid"), "utf8"));
  assert.equal(owner, a.child.pid, "actual first cleanup must own the live lock");
  b = launch("waitcase-b", true);
  while (!fs.existsSync(polled) && !b.closed()) await Bun.sleep(10);
  assert(fs.existsSync(polled), "waiter never reached its lock-budget check");
  assert.equal(Number(fs.readFileSync(path.join(root, "seats/run/cleanup.lock/pid"), "utf8")), owner, "first owner still holds lock when waiter checks its budget");
  fs.writeFileSync(release, "release after witnessed contention\n");
  const ar = await a.done, br = await b.done;
  const targets = ["waitcase-a", "waitcase-b"].map(id => path.join(root, ".wheelhouse-runs", id + "-run"));
  const present = targets.map(target => fs.existsSync(target));
  const log = fs.readFileSync(path.join(root, "seats/logs/cleanup.log"), "utf8");
  const counts = targets.map(target => log.split("\n").filter(line => line.includes(`removed run-scratch ${target} `)).length);
  const record = { mode, firstOwner: owner, polled: JSON.parse(fs.readFileSync(polled, "utf8")), a: ar, b: br, present, removedLogCounts: counts };
  fs.writeFileSync(path.join(base, "result.json"), JSON.stringify(record, null, 2) + "\n");console.log("MEASUREMENT prune-wait " + JSON.stringify(record));
  assert.equal(ar.code, 0);assert.equal(br.code, 0);assert.equal(ar.signal, null);assert.equal(br.signal, null);
  assert(!ar.out.includes("already running") && !br.out.includes("already running"), "a --wait cleanup gave up instead of completing");
  assert(present.every(p => !p), "both owned scratch folders must be removed");assert(counts.every(n => n === 1), "one removal log per bead");
  console.log("PASS prune wait: held owner, actual waiter budget check, both CLIs complete and log one removal each");
} finally {
  fs.writeFileSync(release, "teardown release\n");
  for (const p of [a, b]) if (p && !p.closed()) p.child.kill("SIGTERM");
  await Promise.all([a.done, ...(b ? [b.done] : [])]);
}
