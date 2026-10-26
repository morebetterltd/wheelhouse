// Advisory, read-only walk timing observations. This never grants admission,
// takes/releases a test lock, edits a ticket, or authenticates its recorded actor.
// The heavy-test helper still owns all resource admission and stale recovery.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { completedSpawnSync } from "./native-command";

export interface TestLockHolder { lock: string; pid: number; started: string; epoch: string }
const pidValid = (n: unknown): n is number => Number.isInteger(n) && Number(n) > 0 && Number(n) <= 0x7fffffff;
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { if (e.code === "ESRCH") return false; if (e.code === "EPERM") return true; throw e; }
}
function bounded(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 16384) throw new Error(`unreadable test-lock record: ${file}`);
    const bytes = Buffer.alloc(16385), n = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (n > 16384) throw new Error(`oversize test-lock record: ${file}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n));
  } finally { fs.closeSync(fd); }
}
export function testLockPath(env: NodeJS.ProcessEnv = process.env) {
  const file = path.resolve(env.WHEELHOUSE_SELFTEST_SWEEP_LOCK || "/tmp/wheelhouse-selftest-sweep.lock");
  return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
}
export function testLockHolder(lock: string): TestLockHolder | null {
  try {
    const st = fs.lstatSync(lock, { bigint: true });
    let pid: number, started: string, token = "legacy";
    if (st.isDirectory()) {
      const m = JSON.parse(bounded(path.join(lock, "wheelhouse-selftest-sweep")));
      if (m.kind !== "wheelhouse-selftest-sweep" || m.version !== 1 || !pidValid(m.pid) || typeof m.started !== "string" || !Number.isFinite(Date.parse(m.started)) || !/^[0-9a-f]{32}$/.test(m.token)) throw new Error(`invalid test-lock holder: ${lock}`);
      if (bounded(path.join(lock, "pid")) !== `${m.pid}\n` || bounded(path.join(lock, "started")) !== `${m.started}\n`) throw new Error(`inconsistent test-lock holder: ${lock}`);
      pid = m.pid; started = m.started; token = m.token;
    } else if (st.isFile()) {
      const fields = Object.fromEntries(bounded(lock).trimEnd().split("\n").map(line => { const i = line.indexOf("="); if (i < 0) throw new Error(`invalid legacy test lock: ${lock}`); return [line.slice(0, i), line.slice(i + 1)]; }));
      pid = Number(fields.pid); started = fields.started || "unknown";
      if (!pidValid(pid)) throw new Error(`invalid legacy test-lock pid: ${lock}`);
    } else throw new Error(`test lock is not a regular record/directory: ${lock}`);
    const again = fs.lstatSync(lock, { bigint: true });
    if (again.dev !== st.dev || again.ino !== st.ino) throw new Error(`test lock changed during observation: ${lock}`);
    return alive(pid) ? { lock, pid, started, epoch: `${st.dev}:${st.ino}:${pid}:${started}:${token}` } : null;
  } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}
function parents(): Map<number, number> {
  const r = completedSpawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (r.error || r.signal || r.status !== 0 || r.stderr || !r.stdout.trim()) throw new Error("cannot observe test-lock process ancestry");
  const result = new Map<number, number>();
  for (const line of r.stdout.trim().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m || !pidValid(Number(m[1])) || !(Number(m[2]) === 0 || pidValid(Number(m[2]))) || result.has(Number(m[1]))) throw new Error("invalid test-lock process ancestry");
    result.set(Number(m[1]), Number(m[2]));
  }
  if (!result.has(process.pid)) throw new Error("test-lock ancestry omitted observer");
  return result;
}
function ancestor(owner: number, child: number, table: Map<number, number>): boolean {
  const seen = new Set<number>();
  while (child > 0 && !seen.has(child)) { if (child === owner) return true; seen.add(child); child = table.get(child) ?? 0; }
  return false;
}
export function initialTestLock(lock: string): TestLockHolder | null {
  const holder = testLockHolder(lock);
  // An already-admitted caller is not another run. This does not substitute
  // for the helper's separate token/FIFO/inherited-admission validation.
  return holder && !ancestor(holder.pid, process.pid, parents()) ? holder : null;
}
export async function waitForInitialTestLock(initial: TestLockHolder | null): Promise<void> {
  if (!initial) return;
  console.error(`work walk: waiting for test lock ${initial.lock} held by pid=${initial.pid} started=${initial.started}; verifier clock has not started`);
  while (testLockHolder(initial.lock)?.epoch === initial.epoch) await new Promise(resolve => setTimeout(resolve, 100));
  // Do not reserve admission or wait out later holders. A subsequent queue
  // belongs to verifier runtime and is diagnosed separately at policy expiry.
}
export function queuedTestLock(lock: string, verifierPid: number): string | undefined {
  const holder = testLockHolder(lock);
  if (!holder) return;
  const queue = lock + ".queue", table = parents();
  if (!table.has(verifierPid)) return;
  let entries: string[];
  try { entries = fs.readdirSync(queue); } catch (e: any) { if (e.code === "ENOENT") return; throw e; }
  for (const name of entries) {
    if (!/^[0-9]{20}\.[0-9a-f]{32}$/.test(name)) continue;
    const ticket = JSON.parse(bounded(path.join(queue, name)));
    if (ticket.kind !== "wheelhouse-selftest-sweep-waiter" || ticket.version !== 1 || !pidValid(ticket.pid) || !name.endsWith("." + ticket.token)) throw new Error(`invalid test-lock waiter: ${queue}/${name}`);
    if (ticket.pid !== holder.pid && alive(ticket.pid) && ancestor(verifierPid, ticket.pid, table)) {
      if (testLockHolder(lock)?.epoch !== holder.epoch) return;
      return `queued for the test lock ${lock}, waiting behind pid=${holder.pid} started=${holder.started} (suite pid=${ticket.pid})`;
    }
  }
}

/** Same named wall-clock policy, armed only after the verifier is spawned.
 * Observe its real queued descendants BEFORE signalling this owned child group;
 * join the original child/streams and preserve native exit/signal/spawn error. */
export async function spawnWorkWalker(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, budget: number, lock: string) {
  if (!Number.isFinite(budget) || budget < 0) throw new RangeError("invalid work-walk timeout");
  const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = [];
  child.stdout?.on("data", b => out.push(b)); child.stderr?.on("data", b => err.push(b));
  let timer: ReturnType<typeof setTimeout> | undefined, error: Error | undefined, queued: string | undefined;
  child.once("error", e => error = e);
  const terminate = () => { if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch (e: any) { if (e.code !== "ESRCH") throw e; } };
  child.once("spawn", () => { if (budget > 0 && !interrupted) timer = setTimeout(() => {
    try { queued = queuedTestLock(lock, child.pid!); }
    catch (e: any) { console.error(`work walk: test-lock observation unavailable at timeout: ${e.message}`); }
    error = Object.assign(new Error(`work walk policy timed out after ${budget}ms`), { code: "ETIMEDOUT" }); terminate();
  }, budget); });
  // makeScratchCwd's existing signal handlers remove the checkout and exit.
  // Delay those handlers until this original child has joined, not vice versa.
  const previous = new Map<NodeJS.Signals, Function[]>();
  let interrupted: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal; clearTimeout(timer);
    if (child.pid && child.exitCode === null && child.signalCode === null)
      try { process.kill(-child.pid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const old = process.rawListeners(signal); previous.set(signal, old);
    for (const handler of old) process.removeListener(signal, handler as any);
    const handler = () => interrupt(signal); handlers.set(signal, handler); process.on(signal, handler);
  }
  try {
    const native = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (status, signal) => resolve({ status, signal })));
    return { ...native, pid: child.pid, error, queued, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
  } finally {
    clearTimeout(timer);
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
      for (const old of previous.get(signal)!) process.on(signal, old as any);
    }
    if (interrupted) {
      if (process.listenerCount(interrupted)) process.emit(interrupted);
      else process.kill(process.pid, interrupted);
    }
  }
}
