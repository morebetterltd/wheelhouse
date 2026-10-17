// Test-only clock and readiness driver. Never imported by production verify.ts.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { randomUUID } from "node:crypto";

type Timer = { dir: string; kind: string; callback: () => void; active: boolean };
const timers = new Set<Timer>();
const record = (dir: string, name: string, value = "yes") => fs.writeFileSync(path.join(dir, name), value);
const exists = (dir: string, name: string) => fs.existsSync(path.join(dir, name));
// Poll cadence only schedules work. It never decides success, failure or expiry.
setInterval(() => {
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
  const timer = { dir, kind, callback, active: true };
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
  while (!test()) {
    if (exited()) throw new Error(`fixture exited before ${label}`);
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
  await until(() => exists(dir, "silent"), exited, "silent verifier entered");
  record(dir, "expire-first");
  await until(() => exists(dir, "expired-first"), exited, "explicit watchdog expiry");
  if (!exists(dir, "stop") || fs.readFileSync(path.join(dir, "stop"), "utf8") !== "WHEELHOUSE_FIRST_OUTPUT_TIMEOUT") {
    throw new Error("fixture silent expiry did not STOP the verifier");
  }
}

export async function settle<T>(dir: string, result: Promise<T>, exited: () => boolean): Promise<T> {
  await until(() => exited() || exists(dir, "silent"), () => false, "output EOF or fixture-declared silence");
  if (!exited()) await expireSilent(dir, exited);
  return result;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: string };
function own(name: string, label: string, bin: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(process.stdout, { end: false }); child.stderr!.pipe(process.stderr, { end: false });
  let exit: Exit | undefined;
  ledger({ event: "spawn", name, fixture: label, pid: child.pid });
  const closed = new Promise<Exit>(resolve => {
    // Exit, not stdio EOF, is the readiness terminal event. EOF is joined below.
    child.once("exit", (code, signal) => { exit = { code, signal }; ledger({ event: "exit", name, fixture: label, pid: child.pid, ...exit }); });
    child.once("error", error => { exit = { code: 1, signal: null, error: error.message }; });
    child.once("close", (code, signal) => { exit ??= { code, signal }; resolve(exit); });
  });
  return { child, closed, exited: () => exit !== undefined, status: () => exit };
}
function status(exit: Exit): number { return exit.code ?? (exit.signal ? 128 + constants.signals[exit.signal] : 1); }

async function drive(): Promise<void> {
  const [sourceFile, dir, mode, ...args] = process.argv.slice(2);
  if (!sourceFile || !dir || !["ready", "silent"].includes(mode)) throw new Error("usage: verify-readiness.ts <verify.ts> <owned-state-dir> <ready|silent> <verify args...>");
  if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length) throw new Error("fixture clock needs a fresh state directory");
  const copy = path.join(path.dirname(sourceFile), `.verify-readiness-${randomUUID()}.ts`);
  const label = args[0] || path.basename(dir);
  let source = fs.readFileSync(sourceFile, "utf8");
  if (process.env.WHEELHOUSE_TEST_KILL_FIXTURE === label) {
    const at = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
    source = source.slice(0, at) + 'process.kill(process.pid, "SIGKILL");\n' + source.slice(at);
  }
  fs.writeFileSync(copy, instrument(source), { flag: "wx" });
  let fixture: ReturnType<typeof own> | undefined, holder: ReturnType<typeof own> | undefined;
  const holderRelease = path.join(dir, "holder.release");
  let cancelled = false;
  const terminate = () => { cancelled = true; fixture?.child.kill("SIGTERM"); };
  process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  try {
    // A held sweep is released only after the dispatcher has actually waited,
    // while the verifier still cannot have signalled ready. No sleep duration.
    if (process.env.STUB_TEST_HOLD_H4 === "1") {
      const lock = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK;
      if (!lock) throw new Error("fixture H4 holder needs its private lock path");
      holder = own("holder", label, "bash", ["-c", 'printf "pid=%s\\n" "$$" > "$1.new"; mv -f "$1.new" "$1"; while [ ! -f "$2" ]; do sleep 0.01; done; rm -f "$1"', "_", lock, holderRelease], process.env);
      await until(() => fs.existsSync(lock), () => holder!.exited() || cancelled, "H4 holder publication");
    }
    fixture = own("fixture", label, "bun", [copy, ...args], { ...process.env, WHEELHOUSE_TEST_WATCHDOG_DIR: dir });
    const child = fixture.child, ended = () => fixture!.exited() || cancelled;
    const result = fixture.closed.then(status);
    if (holder) {
      const logs = path.join(path.dirname(sourceFile), "verdicts", "sweeps");
      await until(() => fs.existsSync(logs) && fs.readdirSync(logs).filter(name => name.includes(`.${child.pid}.`)).some(name => fs.readFileSync(path.join(logs, name), "utf8").includes("waiting for host-wide lock")), () => ended() || holder!.exited(), "dispatcher H4 wait");
      if (exists(dir, "ready")) throw new Error("verifier started before held sweep was released");
      record(dir, "holder-wait-observed");
      fs.writeFileSync(holderRelease, "release\n");
    }
    await ready(dir, ended);
    if (mode === "silent") await expireSilent(dir, ended);
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
if (import.meta.main) drive().catch(error => { console.error(`FAIL ${error.message}`); process.exitCode = 1; });
