// Real CLI writes, isolated fixture runtimes; gates/events, never test deadlines.
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";

const [source, root] = process.argv.slice(2);
assert.ok(source && fs.statSync(source).isFile(), "adapter source must exist");
assert.ok(root && fs.statSync(root).isDirectory(), "owned case root must exist");
const seats = path.join(root, "project", "seats");
fs.mkdirSync(seats, { recursive: true });
for (const entry of fs.readdirSync(path.dirname(source), { withFileTypes: true })) {
  const src = path.join(path.dirname(source), entry.name), dest = path.join(seats, entry.name);
  if (entry.isFile() && entry.name.endsWith(".ts")) fs.copyFileSync(src, dest);
  if (entry.isDirectory() && ["drivers", "transports"].includes(entry.name)) fs.cpSync(src, dest, { recursive: true });
}
const adapter = path.join(seats, "adapter.ts");
fs.copyFileSync(source, adapter);
const state = path.join(seats, "state.json"), lock = path.join(seats, "state.lock");
const home = path.join(root, "home"), tmp = path.join(root, "tmp");
fs.mkdirSync(home); fs.mkdirSync(tmp);
const env = { ...process.env, HOME: home, TMPDIR: tmp, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CLEANUP: "0", GIT_CEILING_DIRECTORIES: root };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "WHEELHOUSE_STATE_LOCK_TIMEOUT_MS", "WHEELHOUSE_STATE_WRITE_DELAY_MS"]) delete (env as any)[key];
for (const args of [["init", "-q", "-b", "main"], ["rev-parse", "--show-toplevel"]]) {
  const p = spawnSync("git", ["-C", path.dirname(seats), ...args], { env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  if (args[0] === "rev-parse") assert.equal(p.stdout.trim(), fs.realpathSync(path.dirname(seats)));
}
const fixedNow = 1_700_000_000_000;
const preload = path.join(root, "clock.ts");
fs.writeFileSync(preload, `Date.now = () => ${fixedNow};\n`);
const aged = () => { const at = new Date(fixedNow - 60_000); fs.utimesSync(lock, at, at); };
function reset() {
  fs.rmSync(lock, { force: true });
  fs.writeFileSync(state, JSON.stringify({ seats: Object.fromEntries(["worker-a", "worker-b", "worker-c"].map(name => [name, { pid: null, cwd: root, sessionId: "fixture-only" }])) }));
}
type Child = ReturnType<typeof child>;
const active = new Set<ReturnType<typeof spawn>>();
const closes: Promise<unknown>[] = [];
const measurements: object[] = [];
const releases = new Set<() => void>();
function child(file = adapter, seat = "worker-a", clock = false, extra = {}) {
  const proc = spawn(process.execPath, [...(clock ? ["--preload", preload] : []), file, "stop", seat], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  active.add(proc);
  let stdout = "", stderr = "", ended = false, stdoutEOF = false, stderrEOF = false;
  proc.stdout.on("data", b => stdout += b); proc.stderr.on("data", b => stderr += b);
  proc.stdout.on("end", () => { stdoutEOF = true; }); proc.stderr.on("end", () => { stderrEOF = true; });
  const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; stdoutEOF: boolean; stderrEOF: boolean }>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => {
      ended = true; active.delete(proc);
      const result = { code, signal, stdout, stderr, stdoutEOF, stderrEOF };
      measurements.push({ file: path.basename(file), seat, pid: proc.pid, ...result });
      resolve(result);
    });
  });
  closes.push(done);
  return { proc, done, get stdout() { return stdout; }, get stderr() { return stderr; }, get ended() { return ended; } };
}
async function until(check: () => boolean, c: Child, phase: string) {
  while (!check()) {
    if (c.ended) throw Error(`CLI exited before ${phase}: ${c.stdout}\n${c.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function wrote(c: Child) {
  const r = await c.done;
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.signal, null); assert(r.stdoutEOF && r.stderrEOF);
  assert.equal("cwd" in JSON.parse(fs.readFileSync(state, "utf8")).seats["worker-a"], false, "real state mutation must commit");
  assert.equal(fs.existsSync(lock), false, "owner must release state.lock");
}
async function protectedUntilCancel(signal: "SIGINT" | "SIGTERM", who: string) {
  const before = fs.readFileSync(state, "utf8"), text = fs.readFileSync(lock, "utf8"), ino = fs.statSync(lock).ino;
  const c = child(adapter, "worker-a", true);
  await until(() => c.stderr.includes("WAIT:"), c, "visible protected wait");
  c.proc.kill(signal);
  const r = await c.done;
  assert.equal(r.code, signal === "SIGINT" ? 130 : 143, r.stderr);
  assert.equal(r.signal, null, "adapter must explain cancellation, not just die to the OS signal");
  assert(r.stdoutEOF && r.stderrEOF);
  const cancelled = r.stderr.split("\n").find(line => line.startsWith("STOP:")) ?? "";
  assert(cancelled.includes(`cancelled by ${signal}`), r.stderr);
  assert(cancelled.includes(who), r.stderr);
  assert.match(cancelled, /waiting since \d{4}-\d\d-\d\dT/);
  assert.equal(fs.readFileSync(state, "utf8"), before);
  assert.equal(fs.readFileSync(lock, "utf8"), text);
  assert.equal(fs.statSync(lock).ino, ino);
}
function replaceOnce(text: string, old: string, next: string) {
  assert.equal(text.split(old).length, 2, `unique fixture anchor ${old}`);
  return text.replace(old, next);
}
const holderFile = path.join(seats, "adapter-holder.ts");
fs.writeFileSync(holderFile, replaceOnce(fs.readFileSync(adapter, "utf8"), "  const fd = await acquireStateLock();", `  const fd = await acquireStateLock();
  const fixtureGate = fs.openSync(process.env.WHEELHOUSE_LOCK_FIXTURE_GATE!, "r+");
  fs.writeSync(1, JSON.stringify({held:process.pid})+"\\n");
  fs.readSync(fixtureGate, Buffer.alloc(1), 0, 1, null); fs.closeSync(fixtureGate);`));
let gateIndex = 0;
async function heldWriter() {
  const gate = path.join(root, `release-${++gateIndex}.fifo`);
  const p = spawnSync("mkfifo", [gate], { encoding: "utf8" }); assert.equal(p.status, 0, p.stderr);
  const c = child(holderFile, "worker-a", false, { WHEELHOUSE_LOCK_FIXTURE_GATE: gate });
  await until(() => c.stdout.includes('{"held":'), c, "held lock FIFO");
  assert.equal(fs.readFileSync(lock, "utf8"), `${c.proc.pid}\n`);
  let released = false;
  const release = () => { if (released) return; const fd = fs.openSync(gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); try { fs.writeSync(fd, "r"); released = true; } finally { fs.closeSync(fd); } };
  releases.add(release);
  return { c, release };
}
let failures = 0;
async function test(name: string, check: () => void | Promise<void>) {
  if (process.env.WHEELHOUSE_STATE_LOCK_CASE && process.env.WHEELHOUSE_STATE_LOCK_CASE !== name) return;
  try { await check(); console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
try {
  const { waitForStateLock } = await import(path.join(seats, "state-lock.ts"));
  const { releasePidLock } = await import(path.join(seats, "lock.ts"));
  await test("reporting", async () => {
    reset(); fs.writeFileSync(lock, `${process.pid}\n`);
    const messages: string[] = []; let tick = 0, steps = 0;
    const fd = await waitForStateLock(lock, { now: () => tick, report: s => messages.push(s), pause: async () => {
      steps++;
      assert.equal(messages.length, steps, steps === 1 ? "initial wait notice missing" : "periodic wait notice missing");
      assert(messages.at(-1)!.includes(`recorded holder pid=${process.pid}`), "notice must name holder");
      assert.match(messages.at(-1)!, /waiting since \d{4}-\d\d-\d\dT/);
      if (steps === 1) tick += 1000; else fs.unlinkSync(lock);
    } });
    releasePidLock(lock, fd); assert.equal(steps, 2, "live owner must not be stolen");
  });
  await test("owner-change", async () => {
    reset(); process.kill(process.ppid, 0); fs.writeFileSync(lock, `${process.pid}\n`);
    const messages: string[] = []; let steps = 0;
    const fd = await waitForStateLock(lock, { now: () => 0, report: s => messages.push(s), pause: async () => {
      steps++;
      assert.equal(messages.length, steps, "holder change must be visible immediately without a reporting tick");
      assert(messages.at(-1)!.includes(`recorded holder pid=${steps === 1 ? process.pid : process.ppid}`));
      if (steps === 1) fs.writeFileSync(lock, `${process.ppid}\n`); else fs.unlinkSync(lock);
    } });
    releasePidLock(lock, fd); assert.equal(steps, 2);
  });
  for (const [name, text] of [["closed-empty", ""], ["closed-malformed", "not a pid\n"]]) await test(name, async () => {
    reset(); fs.writeFileSync(lock, text); aged(); await wrote(child(adapter, "worker-a", true));
  });
  await test("fresh", async () => {
    reset(); fs.writeFileSync(lock, ""); const at = new Date(fixedNow); fs.utimesSync(lock, at, at);
    await protectedUntilCancel("SIGINT", "holder unknown (empty/incomplete lock)");
    aged(); await wrote(child(adapter, "worker-a", true));
  });
  await test("open", async () => {
    reset(); const fd = fs.openSync(lock, "wx");
    try { aged(); await protectedUntilCancel("SIGTERM", "holder unknown (empty/incomplete lock)"); }
    finally { fs.closeSync(fd); }
    await wrote(child(adapter, "worker-a", true));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) await test(`live-${signal}`, async () => {
    reset(); fs.writeFileSync(lock, `${process.pid}\n`); aged();
    await protectedUntilCancel(signal, `recorded holder pid=${process.pid}`);
  });
  await test("dead", async () => {
    reset(); const p = spawn(process.execPath, ["-e", "process.exit(0)"], { env, stdio: "ignore" });
    await new Promise(resolve => p.once("close", resolve));
    assert.throws(() => process.kill(p.pid!, 0), { code: "ESRCH" }); fs.writeFileSync(lock, `${p.pid}\n`);
    const writer = child();
    await until(() => writer.ended || writer.stderr.includes("WAIT:"), writer, "dead-owner acquisition or explicit refusal");
    if (!writer.ended && writer.stderr.includes("WAIT:")) writer.proc.kill("SIGTERM");
    await wrote(writer);
  });
  await test("replacement", async () => {
    reset(); const holder = await heldWriter();
    try {
      fs.unlinkSync(lock); fs.writeFileSync(lock, `${process.pid}\n`); aged(); const ino = fs.statSync(lock).ino;
      holder.release(); const r = await holder.c.done; assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`, "old release deleted live replacement");
      assert.equal(fs.statSync(lock).ino, ino);
      assert.equal("cwd" in JSON.parse(fs.readFileSync(state, "utf8")).seats["worker-a"], false);
    } finally { holder.release(); await holder.c.done; }
  });
  await test("publication", async () => {
    reset();
    // Reuse the existing explicit CJS-file fault injector: its documented Bun
    // interposition reaches this native fs write; ESM setup does not.
    const rows = JSON.parse(fs.readFileSync(state, "utf8")); rows.seats["worker-1"] = { ...rows.seats["worker-a"] };
    fs.writeFileSync(state, JSON.stringify(rows));
    const before = fs.readFileSync(state, "utf8");
    const inject = path.join(import.meta.dir, "pid-write-fault.cjs");
    const p = spawnSync(process.execPath, [inject, "adapter", adapter], { env, encoding: "utf8" });
    measurements.push({ file: "pid-write-fault.cjs", code: p.status, signal: p.signal, stdout: p.stdout, stderr: p.stderr });
    assert.equal(p.status, 1); assert.match(p.stderr, /fixture PID write refusal/);
    assert.equal(fs.existsSync(lock), false); assert.equal(fs.readdirSync(seats).some(n => n.startsWith("state.lock.tmp.")), false);
    assert.equal(fs.readFileSync(state, "utf8"), before);
  });
  await test("past-deadline", async () => {
    reset(); const holder = await heldWriter(); let waiter: Child | undefined;
    try {
      waiter = child(adapter, "worker-b");
      await until(() => waiter!.stderr.includes("WAIT:"), waiter, "new waiter entered contention");
      const module = fs.readFileSync(path.join(seats, "state-lock.ts"), "utf8");
      const control = replaceOnce(module, "    while (true) {", `    const deadline = Date.now() + 5000;\n    while (true) {\n      if (Date.now() >= deadline) throw new Error("fixture legacy 5000ms state.lock deadline");`);
      fs.writeFileSync(path.join(seats, "state-lock-deadline.ts"), control);
      const controlAdapter = path.join(seats, "adapter-deadline.ts");
      fs.writeFileSync(controlAdapter, replaceOnce(fs.readFileSync(adapter, "utf8"), 'from "./state-lock";', 'from "./state-lock-deadline";'));
      const witness = await child(controlAdapter, "worker-c").done;
      assert.equal(witness.signal, null); assert(witness.stdoutEOF && witness.stderrEOF);
      assert.equal(witness.code, 1, witness.stderr); assert.match(witness.stderr, /5000ms.*deadline|timed out waiting for/);
      assert.equal(waiter.ended, false, "live-holder waiter gave up at the old deadline");
      process.kill(holder.c.proc.pid!, 0); assert.equal(fs.readFileSync(lock, "utf8"), `${holder.c.proc.pid}\n`);
      console.log("legacy deadline witness exited 1 after its real 5000ms rule; live-holder waiter still waiting");
      holder.release(); assert.equal((await holder.c.done).code, 0);
      const result = await waiter.done; assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null); assert(result.stdoutEOF && result.stderrEOF);
      const rows = JSON.parse(fs.readFileSync(state, "utf8")).seats;
      assert.equal(rows["worker-a"].sessionId, "fixture-only"); assert.equal("cwd" in rows["worker-b"], false); assert.equal("cwd" in rows["worker-c"], true);
      assert.equal(fs.existsSync(lock), false);
    } finally { holder.release(); await holder.c.done; if (waiter) await waiter.done; }
  });
} finally {
  for (const release of releases) release();
  for (const proc of active) proc.kill("SIGTERM");
  await Promise.allSettled(closes);
  fs.writeFileSync(path.join(root, "state-lock-results.json"), JSON.stringify(measurements, null, 2) + "\n");
  console.log("STATE_LOCK_MEASUREMENTS " + JSON.stringify(measurements));
}
console.log(`adapter state lock: ${failures ? "FAIL" : "PASS"} (${failures} failure(s))`);
process.exitCode = failures ? 1 : 0;
