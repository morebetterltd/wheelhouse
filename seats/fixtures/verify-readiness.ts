// Test-only clock and readiness driver. Never imported by production verify.ts.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { randomUUID } from "node:crypto";

type Timer = { dir: string; kind: string; callback: () => void; active: boolean; deadline: number };
const clocks = new Map<string, number>();
const timers = new Set<Timer>();
const record = (dir: string, name: string, value = "yes") => fs.writeFileSync(path.join(dir, name), value);
const exists = (dir: string, name: string) => fs.existsSync(path.join(dir, name));
// Poll cadence only schedules work. It never decides success, failure or expiry.
setInterval(() => {
  for (const dir of new Set([...timers].map(timer => timer.dir))) {
    const request = path.join(dir, "advance");
    if (!fs.existsSync(request)) continue;
    const next = Number(fs.readFileSync(request, "utf8"));
    if (!Number.isFinite(next) || next < (clocks.get(dir) ?? 0)) throw new Error("fixture clock must advance monotonically");
    clocks.set(dir, next); fs.unlinkSync(request);
    for (const timer of [...timers]) {
      if (!timer.active || timer.dir !== dir || timer.deadline > next) continue;
      timer.active = false; timer.callback(); record(dir, `expired-${timer.kind}`);
    }
    record(dir, "advanced", String(next));
  }
  for (const timer of timers) {
    if (!timer.active || !exists(timer.dir, `expire-${timer.kind}`)) continue;
    fs.unlinkSync(path.join(timer.dir, `expire-${timer.kind}`));
    timer.active = false;
    timer.callback();
    record(timer.dir, `expired-${timer.kind}`);
  }
}, 10).unref();
export function arm(kind: string, callback: () => void, budget: number): any {
  const dir = process.env.WHEELHOUSE_TEST_WATCHDOG_DIR!;
  if (!dir || !fs.statSync(dir).isDirectory()) throw new Error("fixture clock requires its own state directory");
  const timer = { dir, kind, callback, active: true, deadline: (clocks.get(dir) ?? 0) + budget };
  if (kind === "event") {
    const count = Number(exists(dir, "event-generation") ? fs.readFileSync(path.join(dir, "event-generation"), "utf8") : 0) + 1;
    record(dir, "event-generation", String(count));
  }
  timers.add(timer);
  record(dir, `armed-${kind}`, String(budget));
  return timer;
}
export function cancel(timer: Timer): void {
  timer.active = false;
  timers.delete(timer);
  record(timer.dir, `cancelled-${timer.kind}`);
}
export function stop(code: string): void { record(process.env.WHEELHOUSE_TEST_WATCHDOG_DIR!, "stop", code); }
export function output(): void { record(process.env.WHEELHOUSE_TEST_WATCHDOG_DIR!, "output"); }

export function instrument(source: string): string {
  const replace = (old: string, next: string, count: number) => {
    if (source.split(old).length - 1 !== count) throw new Error(`fixture clock anchor changed: ${old}`);
    source = source.replaceAll(old, next);
  };
  replace("const firstOutputTimer = setTimeout(() => {", 'const firstOutputTimer = fixtureArm("first", () => {', 1);
  replace("noEventTimer = setTimeout(() => killFor(code, message), stallMs);", 'noEventTimer = fixtureArm("event", () => killFor(code, message), stallMs);', 1);
  replace("clearTimeout(firstOutputTimer);", "fixtureCancel(firstOutputTimer);", 2);
  replace("if (noEventTimer) clearTimeout(noEventTimer);", "if (noEventTimer) fixtureCancel(noEventTimer);", 2);
  replace("const killFor = (code: string, message: string) => {", "const killFor = (code: string, message: string) => {\n      fixtureStop(code);", 1);
  replace("      sawOutput = true;", "      sawOutput = true; fixtureOutput();", 1);
  const header = source.startsWith("#!") ? source.slice(0, source.indexOf("\n") + 1) : "";
  return `${header}import {arm as fixtureArm,cancel as fixtureCancel,stop as fixtureStop,output as fixtureOutput} from ${JSON.stringify(import.meta.path)};\n${source.slice(header.length)}`;
}

export function ledger(event: Record<string, unknown>): void {
  const file = process.env.WHEELHOUSE_TEST_CHILD_LEDGER;
  if (file) fs.appendFileSync(file, JSON.stringify(event) + "\n");
}

export async function until(test: () => boolean, exited: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  const guardMs = Number(process.env.WHEELHOUSE_VERIFY_FIXTURE_WAIT_MS ?? 300_000);
  if (!Number.isFinite(guardMs) || guardMs <= 0) throw new Error("fixture wait guard must be positive");
  while (!test()) {
    if (exited()) throw new Error(`fixture exited before ${label}`);
    if (Date.now() - started >= guardMs) throw new Error(`fixture containment deadline ${guardMs}ms waiting for ${label}`);
    await Bun.sleep(10);
  }
}
export function release(dir: string): void { record(dir, "release"); }
export async function ready(dir: string, exited: () => boolean): Promise<void> {
  await until(() => exists(dir, "ready") && exists(dir, "armed-first"), exited, "readiness and armed watchdog");
  record(dir, "readiness-observed");
  release(dir);
}
export async function expireSilent(dir: string, exited: () => boolean): Promise<void> {
  await until(() => exists(dir, "silent"), exited, "silent reviewer entered");
  record(dir, "expire-first");
  await until(() => exists(dir, "expired-first"), exited, "explicit watchdog expiry");
  if (!exists(dir, "stop") || fs.readFileSync(path.join(dir, "stop"), "utf8") !== "WHEELHOUSE_FIRST_OUTPUT_TIMEOUT") {
    throw new Error("fixture silent expiry did not STOP the reviewer");
  }
}

export async function settle<T>(dir: string, result: Promise<T>, exited: () => boolean): Promise<T> {
  await until(() => exited() || exists(dir, "silent"), () => false, "output EOF or fixture-declared silence");
  if (!exited()) await expireSilent(dir, exited);
  return result;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: string };
export function own(name: string, label: string, bin: string, args: string[], env: NodeJS.ProcessEnv) {
  // The child publishes its native identity before executing main, not a
  // racy parent-side ps after a fast or deliberately killed child has exited.
  const tracing = Boolean(process.env.WHEELHOUSE_TEST_CHILD_LEDGER), launchId = randomUUID();
  if (tracing && bin !== "bun") throw new Error("fixture identity preload requires a Bun entrypoint");
  const identityFile = process.env.WHEELHOUSE_TEST_CHILD_IDENTITY ?? path.join(import.meta.dir, "verify-child-identity.cjs");
  const child = spawn(bin, tracing ? ["--preload", identityFile, ...args] : args, {
    env: tracing ? { ...env, WHEELHOUSE_TEST_CHILD_CAPTURE: JSON.stringify({ name, fixture: label, launchId }) } : env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(process.stdout, { end: false }); child.stderr!.pipe(process.stderr, { end: false });
  let exit: Exit | undefined;
  ledger({ event: "launch", name, fixture: label, pid: child.pid, launchId });
  const closed = new Promise<Exit>(resolve => {
    // Exit, not stdio EOF, is the readiness terminal event. EOF is joined below.
    child.once("exit", (code, signal) => { exit = { code, signal }; ledger({ event: "exit", name, fixture: label, pid: child.pid, ...exit }); });
    child.once("error", error => { exit = { code: 1, signal: null, error: error.message }; });
    child.once("close", (code, signal) => { exit ??= { code, signal }; resolve(exit); });
  });
  return { child, closed, exited: () => exit !== undefined, status: () => exit };
}
function status(exit: Exit): number { return exit.code ?? (exit.signal ? 128 + constants.signals[exit.signal] : 1); }

// Use the runner's real lock protocol: shell mv can instead put a PID file
// INSIDE a leftover directory lock, corrupting it before the dispatcher waits.
// The actual holder (not a separate shell surrogate) retains main's bounded
// admission/release wait and parent-liveness containment. Neither is a reviewer
// readiness verdict: only real admission publishes the ready file.
async function holdH4(lock: string, releaseFile: string, readyFile: string, helper: string): Promise<void> {
  const seconds = Number(process.env.WHEELHOUSE_VERIFY_FIXTURE_HOLDER_SECONDS ?? 300);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("fixture holder guard must be positive seconds");
  const deadline = Date.now() + seconds * 1000, parent = process.ppid;
  const token = randomUUID().replaceAll("-", "");
  let identity: string | undefined, stopped = 0;
  const waiting = () => {
    if (stopped || fs.existsSync(releaseFile)) return false;
    if (Date.now() >= deadline) {
      console.error("fixture holder containment deadline waiting for admission/release");
      stopped = 124; return false;
    }
    try { if (parent <= 1) { stopped = 125; return false; } process.kill(parent, 0); }
    catch (e: any) { if (e.code !== "ESRCH") throw e; stopped = 125; return false; }
    return true;
  };
  const term = () => { stopped = 143; }, interrupt = () => { stopped = 130; };
  process.once("SIGTERM", term); process.once("SIGINT", interrupt);
  const transition = async (op: "acquire" | "release") => {
    const args = [helper, op, lock, String(process.pid), token];
    if (op === "release" && identity) args.push(identity);
    const child = spawn("bun", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout!.on("data", b => { out += b; }); child.stderr!.on("data", b => { err += b; });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
    if (!child.stdout!.readableEnded || !child.stderr!.readableEnded) throw new Error("H4 transition lost output EOF");
    if (err) process.stderr.write(err);
    return { code, out: out.trim() };
  };
  try {
    while (waiting()) {
      const result = await transition("acquire");
      if (result.code === 0) {
        if (!/^\d+:\d+$/.test(result.out)) throw new Error("H4 admission lacks directory identity");
        identity = result.out;
        fs.writeFileSync(readyFile, "admitted\n");
        break;
      }
      if (result.code !== 75) throw new Error(`H4 holder admission failed: exit ${result.code}`);
      fs.writeFileSync(`${readyFile}.waiting`, `${result.out}\n`);
      await Bun.sleep(10); // Queue scheduling only, never a readiness deadline.
    }
    while (identity && waiting()) await Bun.sleep(10);
  } finally {
    try {
      const released = await transition("release");
      if (released.code !== 0) throw new Error(`H4 holder release failed: exit ${released.code}`);
    } finally {
      process.removeListener("SIGTERM", term); process.removeListener("SIGINT", interrupt);
    }
  }
  if (stopped) process.exitCode = stopped;
}

async function holderBounds(dir: string, helper: string): Promise<void> {
  for (const occupied of [true, false]) {
    const sub = path.join(dir, occupied ? "occupied" : "absent-release"); fs.mkdirSync(sub);
    const lock = path.join(sub, "lock"), release = path.join(sub, "release"), published = path.join(sub, "published");
    if (occupied) { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "KEEP"), "unchanged\n"); }
    const holder = own("holder-probe", "holder-bounds", "bun", [import.meta.path, "--hold-h4", lock, release, published, helper], { ...process.env, WHEELHOUSE_VERIFY_FIXTURE_HOLDER_SECONDS: "1" });
    let rescued = false;
    const guard = setTimeout(() => { rescued = true; holder.child.kill("SIGKILL"); }, 300_000);
    let exit: Exit;
    try { exit = await holder.closed; } finally { clearTimeout(guard); }
    // The real helper refuses this foreign directory (exit2); holdH4 reports
    // the admission failure (exit1). A missing release must expire natively.
    const expected = occupied ? 1 : 124;
    if (rescued || exit.code !== expected || exit.signal) throw new Error(`holder bounds proof failed: occupied=${occupied} actual=${JSON.stringify(exit)} expected=${expected} rescued=${rescued}`);
    if (occupied && (fs.readdirSync(lock).join() !== "KEEP" || fs.readFileSync(path.join(lock, "KEEP"), "utf8") !== "unchanged\n")) throw new Error("holder publication changed an occupied lock");
    if (!occupied && (!fs.existsSync(published) || fs.existsSync(lock))) throw new Error("bounded holder must acquire and release its own lock");
    console.log(`PASS holder ${occupied ? "exclusive publication refuses occupied directory unchanged" : "missing release fails bounded waiter"}: exit=${expected}, signal=none, rescue=false`);
  }
}

async function drive(): Promise<void> {
  const [sourceFile, dir, mode, ...args] = process.argv.slice(2);
  if (!sourceFile || !dir || !["ready", "silent", "progress", "holder-bounds"].includes(mode)) throw new Error("usage: verify-readiness.ts <verify.ts> <owned-state-dir> <ready|silent|progress|holder-bounds> <verify args...>");
  if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length) throw new Error("fixture clock needs a fresh state directory");
  if (mode === "holder-bounds") { await holderBounds(dir, path.join(path.dirname(sourceFile), "selftest-sweep-lock.ts")); return; }
  const copy = path.join(path.dirname(sourceFile), `.verify-readiness-${randomUUID()}.ts`);
  const label = args[0] || path.basename(dir);
  let source = fs.readFileSync(sourceFile, "utf8");
  if (process.env.WHEELHOUSE_TEST_KILL_FIXTURE === label) {
    const at = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
    source = source.slice(0, at) + 'process.kill(process.pid, "SIGKILL");\n' + source.slice(at);
  }
  let instrumented = instrument(source);
  if (mode === "progress" && process.env.WHEELHOUSE_VERIFY_TEST_UNCANCELLED_EVENT === "1") {
    const needle = "const resetNoEventTimer = () => {\n      if (noEventTimer) fixtureCancel(noEventTimer);";
    if (instrumented.split(needle).length !== 2) throw new Error("progress cancellation control anchor changed");
    instrumented = instrumented.replace(needle, "const resetNoEventTimer = () => {\n      // control: retain the previous event deadline");
  }
  fs.writeFileSync(copy, instrumented, { flag: "wx" });
  let fixture: ReturnType<typeof own> | undefined, holder: ReturnType<typeof own> | undefined;
  const holderRelease = path.join(dir, "holder.release");
  let cancelled = false;
  const terminate = () => { cancelled = true; fixture?.child.kill("SIGTERM"); };
  process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  try {
    // A held sweep is released only after the dispatcher has actually waited,
    // while the reviewer still cannot have signalled ready. No sleep duration.
    if (process.env.STUB_TEST_HOLD_H4 === "1") {
      const lock = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK;
      if (!lock) throw new Error("fixture H4 holder needs its private lock path");
      const admitted = path.join(dir, "holder.admitted"), helper = path.join(path.dirname(sourceFile), "selftest-sweep-lock.ts");
      if (!fs.statSync(helper).isFile()) throw new Error("fixture H4 holder requires the runner lock helper");
      holder = own("holder", label, "bun", [import.meta.path, "--hold-h4", lock, holderRelease, admitted, helper], process.env);
      await until(() => fs.existsSync(admitted), () => holder!.exited() || cancelled, "H4 holder admission");
    }
    fixture = own("fixture", label, "bun", [copy, ...args], { ...process.env, WHEELHOUSE_TEST_WATCHDOG_DIR: dir });
    const child = fixture.child, ended = () => fixture!.exited() || cancelled;
    const result = fixture.closed.then(status);
    if (holder) {
      const logs = path.join(path.dirname(sourceFile), "verdicts", "sweeps");
      await until(() => exists(dir, "ready") || (fs.existsSync(logs) && fs.readdirSync(logs).filter(name => name.includes(`.${child.pid}.`)).some(name => fs.readFileSync(path.join(logs, name), "utf8").includes("waiting for host-wide lock"))), () => ended() || holder!.exited(), "dispatcher H4 wait");
      if (exists(dir, "ready")) throw new Error("reviewer started before held sweep was released");
      record(dir, "holder-wait-observed");
      fs.writeFileSync(holderRelease, "release\n");
    }
    await ready(dir, ended);
    if (mode === "silent") await expireSilent(dir, ended);
    if (mode === "progress") {
      // Each actual collect() has rearmed its watchdog before the model gets
      // permission to emit the next record. Scheduling gaps are not time.
      for (let generation = 1; generation <= 9; generation++) {
        await until(() => exists(dir, "armed-event") && Number(exists(dir, "event-generation") ? fs.readFileSync(path.join(dir, "event-generation"), "utf8") : 0) >= generation, ended, `progress generation ${generation}`);
        if (fs.readFileSync(path.join(dir, "armed-event"), "utf8") !== "150") throw new Error("progress did not arm the real 150ms quiet watchdog");
        const at = generation * 100;
        record(dir, "advance", String(at));
        await until(() => exists(dir, "advanced") && fs.readFileSync(path.join(dir, "advanced"), "utf8") === String(at), ended, `virtual time ${at}`);
        if (exists(dir, "stop") || exists(dir, "expired-event")) throw new Error(`progress watchdog expired at virtual ${at}ms`);
        record(dir, `progress-ack-${generation}`);
      }
      const proof = { event: "progress-clock-proof", virtualElapsedMs: 900, totalBudgetMs: 300, quietGapMs: 100, quietBudgetMs: 150, generations: Number(fs.readFileSync(path.join(dir, "event-generation"), "utf8")), expired: exists(dir, "expired-event"), stopped: exists(dir, "stop") };
      if (proof.generations !== 9 || proof.expired || proof.stopped) throw new Error("progress clock proof incomplete");
      record(dir, "progress-proof", JSON.stringify(proof));
      console.log(JSON.stringify(proof));
    }
    const rc = mode === "ready" ? await settle(dir, result, ended) : await result;
    record(dir, "result.json", JSON.stringify({ rc, ready: exists(dir, "readiness-observed"), output: exists(dir, "output"), stop: exists(dir, "stop") ? fs.readFileSync(path.join(dir, "stop"), "utf8") : null }));
    process.exitCode = rc;
  } catch (error: any) {
    const fixtureExit = fixture?.status(), holderExit = holder?.status();
    const exit = fixtureExit ?? holderExit;
    const detail = exit ? `exit=${status(exit)} signal=${exit.signal ?? "none"}${exit.error ? ` error=${exit.error}` : ""}` : "controller error";
    ledger({ event: "fixture-failure", fixture: label, ready: exists(dir, "ready"), armed: exists(dir, "armed-first"), ...exit });
    throw new Error(`${!fixtureExit && holderExit ? "H4 holder" : "fixture"} ${label}: ${error.message}; ${detail}`);
  } finally {
    // Every file waiter is owned here, not by a caller blocked in wait(1).
    release(dir);
    if (holder) {
      fs.writeFileSync(holderRelease, "release\n");
      ledger({ event: "holder-cleanup", fixture: label, pid: holder.child.pid, release: holderRelease, released: fs.existsSync(holderRelease) });
      await holder.closed;
    }
    if (fixture) {
      if (!fixture.exited()) fixture.child.kill("SIGTERM");
      await fixture.closed; // Both stdout/stderr EOF, including inherited pipes.
    }
    process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate);
    fs.unlinkSync(copy); // Only the unique file this invocation created.
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const result = args[0] === "--hold-h4"
    ? holdH4(args[1], args[2], args[3], args[4])
    : drive();
  result.catch(error => { console.error(`FAIL ${error.message}`); process.exitCode = 1; });
}
