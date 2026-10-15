// Test-only clock and readiness driver. Never imported by production verify.ts.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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

async function drive(): Promise<void> {
  const [sourceFile, dir, mode, ...args] = process.argv.slice(2);
  if (!sourceFile || !dir || !["ready", "silent"].includes(mode)) throw new Error("usage: verify-readiness.ts <verify.ts> <owned-state-dir> <ready|silent> <verify args...>");
  if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length) throw new Error("fixture clock needs a fresh state directory");
  const copy = path.join(path.dirname(sourceFile), `.verify-readiness-${randomUUID()}.ts`);
  fs.writeFileSync(copy, instrument(fs.readFileSync(sourceFile, "utf8")), { flag: "wx" });
  let ended = false;
  const child = spawn("bun", [copy, ...args], { env: { ...process.env, WHEELHOUSE_TEST_WATCHDOG_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(process.stdout); child.stderr!.pipe(process.stderr);
  const result = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { ended = true; resolve(code ?? (signal ? 143 : 1)); });
  });
  const terminate = () => { child.kill("SIGTERM"); };
  process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  try {
    // A held sweep is released only after the dispatcher has actually waited,
    // while the verifier still cannot have signalled ready. No sleep duration.
    const holderRelease = process.env.STUB_TEST_HOLDER_RELEASE;
    if (holderRelease) {
      const logs = path.join(path.dirname(sourceFile), "verdicts", "sweeps");
      await until(() => fs.existsSync(logs) && fs.readdirSync(logs).filter(name => name.includes(`.${child.pid}.`)).some(name => fs.readFileSync(path.join(logs, name), "utf8").includes("waiting for host-wide lock")), () => ended, "dispatcher H4 wait");
      if (exists(dir, "ready")) throw new Error("verifier started before held sweep was released");
      record(dir, "holder-wait-observed");
      fs.writeFileSync(holderRelease, "release\n");
    }
    await ready(dir, () => ended);
    if (mode === "silent") await expireSilent(dir, () => ended);
    const rc = mode === "ready" ? await settle(dir, result, () => ended) : await result;
    record(dir, "result.json", JSON.stringify({ rc, ready: exists(dir, "readiness-observed"), output: exists(dir, "output"), stop: exists(dir, "stop") ? fs.readFileSync(path.join(dir, "stop"), "utf8") : null }));
    process.exitCode = rc;
  } finally {
    if (!ended) { terminate(); await result; }
    process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate);
    fs.unlinkSync(copy); // Only the unique file this invocation created.
  }
}
if (import.meta.main) drive().catch(error => { console.error(error.message); process.exitCode = 1; });
