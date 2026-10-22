import * as fs from "node:fs";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as path from "node:path";

export function barePidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e.code === "EPERM"; }
}

export function inspectOpenPaths(pid: number): { paths: string[]; verified: boolean; reason: string } {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      const out = execFileSync(lsof, ["-Fn", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: Number(process.env.WHEELHOUSE_LSOF_TIMEOUT_MS ?? 2000), stdio: ["ignore", "pipe", "pipe"] });
      const paths = out.split("\n").filter((l) => l.startsWith("n") && l.length > 1).map((l) => l.slice(1));
      return paths.length ? { paths, verified: true, reason: "" } : { paths: [], verified: false, reason: `lsof returned no descriptor observation for pid ${pid}` };
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      return { paths: [], verified: false, reason: `lsof could not verify pid ${pid}: ${e.message}` };
    }
  }
  return { paths: [], verified: false, reason: "lsof unavailable" };
}

export function openPaths(pid: number): string[] { return inspectOpenPaths(pid).paths; }

/** Compare metadata, not canonical names: Bun's realpathSync opens the final
 * component for reading on macOS. On an unattended FIFO that blocks forever,
 * even if a reader probe succeeded just before the seat died. stat follows
 * directory and final-component aliases without opening the pipe. */
export function openPathsMatch(paths: string[], p: string): boolean {
  if (paths.includes(p)) return true;
  let wanted: fs.BigIntStats;
  try { wanted = fs.statSync(p, { bigint: true }); } catch { return false; }
  return paths.some((n) => {
    try {
      const observed = fs.statSync(n, { bigint: true });
      return wanted.dev === observed.dev && wanted.ino === observed.ino;
    } catch { return false; }
  });
}

export function pidHoldsPath(pid: number, p: string): boolean {
  return openPathsMatch(openPaths(pid), p);
}

function fifoHasReader(fifo: string): boolean {
  try {
    if (!fs.statSync(fifo).isFIFO()) return true;
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code === "ENXIO") return false;
    return true;
  }
}

function inspectProcessStart(pid: number): { ms: number | null; reason: string } {
  let r: SpawnSyncReturns<string>;
  try { r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { return { ms: null, reason: `ps could not verify pid ${pid}: ${e.message}` }; }
  if (r.error || r.signal || r.status !== 0) return { ms: null, reason: `ps could not verify pid ${pid}: ${r.error?.message ?? r.signal ?? `exit ${r.status}`} ${(r.stderr ?? "").trim()}`.trim() };
  const ms = Date.parse((r.stdout ?? "").trim());
  return Number.isFinite(ms) ? { ms, reason: "" } : { ms: null, reason: `ps returned no parseable start time for pid ${pid}` };
}

export function processStartMs(pid: number): number | null { return inspectProcessStart(pid).ms; }

export type SeatIdentity = { kind: "owned" | "foreign" | "gone" | "unverified"; reason: string };
export class SeatIdentityUnverified extends Error {
  constructor(pid: number | null | undefined, reason: string) {
    super(`UNVERIFIED: pid ${pid}: ${reason}; left untouched; do not restart or reclaim until identity is verified`);
  }
}

function unverifiedIdentity(pid: number, reason: string): SeatIdentity {
  // A process can exit between kill(0) and ps/lsof (notably after SIGTERM).
  // Only fresh ESRCH may settle that race; an unreadable live pid stays unknown.
  try { process.kill(pid, 0); }
  catch (e: any) { if (e.code === "ESRCH") return { kind: "gone", reason: "pid exited during inspection" }; }
  return { kind: "unverified", reason };
}

/** Absence of an observation is not evidence of a different process. One
 * positive FIFO/start proof suffices; an unavailable alternative never does. */
export function seatIdentity(pid: number | null | undefined, fifo?: string, startedAt?: string): SeatIdentity {
  if (!pid) return { kind: "gone", reason: "no pid" };
  try { process.kill(pid, 0); }
  catch (e: any) {
    if (e.code === "ESRCH") return { kind: "gone", reason: "pid gone" };
    if (e.code !== "EPERM") return { kind: "unverified", reason: `cannot inspect pid: ${e.message}` };
  }
  if (fifo && fs.existsSync(fifo) && !fifoHasReader(fifo)) return { kind: "foreign", reason: "seat FIFO has no reader" };
  const files = fifo ? inspectOpenPaths(pid) : null;
  if (files?.verified && openPathsMatch(files.paths, fifo!)) return { kind: "owned", reason: "seat FIFO held" };
  if (startedAt) {
    const recorded = Date.parse(startedAt);
    if (!Number.isFinite(recorded)) return { kind: "unverified", reason: "invalid recorded start time" };
    const live = inspectProcessStart(pid);
    if (live.ms === null) return unverifiedIdentity(pid, live.reason);
    return Math.abs(live.ms - recorded) <= 2000
      ? { kind: "owned", reason: "start time matches" }
      : { kind: "foreign", reason: "start time differs" };
  }
  if (files?.verified) return { kind: "foreign", reason: "pid does not hold seat FIFO" };
  return unverifiedIdentity(pid, files?.reason ?? "no recorded FIFO or start-time proof");
}

export function pidMatchesStartedAt(pid: number, startedAt?: string): boolean {
  return pidAlive(pid, undefined, startedAt);
}

/** Single-argument callers check generic daemon/lock pids. Seat callers pass
 * their record, and MUST stop on uncertainty rather than treating it as dead. */
export function pidAlive(pid: number | null | undefined, fifo?: string, startedAt?: string): boolean {
  if (arguments.length === 1) return barePidAlive(pid);
  const identity = seatIdentity(pid, fifo, startedAt);
  if (identity.kind === "unverified") throw new SeatIdentityUnverified(pid, identity.reason);
  return identity.kind === "owned";
}

/** Automation must not turn an unobservable worker/reviewer into spare
 * capacity, or reclaim its cwd/scratch. Check before computing any actions. */
export function assertSeatIdentities(root: string): void {
  let state: any;
  try { state = JSON.parse(fs.readFileSync(path.join(root, "seats", "state.json"), "utf8")); }
  catch (e: any) {
    if (e.code === "ENOENT") return;
    throw new SeatIdentityUnverified(null, `cannot read seat state: ${e.message}`);
  }
  for (const [name, rec] of Object.entries<any>(state.seats ?? {})) {
    if (!rec?.pid) continue;
    const identity = seatIdentity(rec.pid, rec.fifo, rec.startedAt);
    if (identity.kind === "unverified") throw new SeatIdentityUnverified(rec.pid, `${name}: ${identity.reason}`);
  }
}

export function eventTimeIso(ev: any): string | null {
  for (const key of ["timestamp", "time", "created_at", "createdAt", "at"]) {
    const v = ev?.[key] ?? ev?.message?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 10_000_000_000 ? v * 1000 : v).toISOString();
    if (typeof v === "string") { const t = Date.parse(v); if (Number.isFinite(t)) return new Date(t).toISOString(); }
  }
  return null;
}

function logTailLines(log: string): { lines: string[]; ok: boolean; truncated: boolean } {
  try {
    const st = fs.statSync(log);
    const max = 1024 * 1024;
    const start = Math.max(0, st.size - max);
    const fd = fs.openSync(log, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { lines: buf.toString("utf8").split(/\r?\n/).filter(Boolean), ok: true, truncated: start > 0 };
    } finally { fs.closeSync(fd); }
  } catch { return { lines: [], ok: false, truncated: false }; }
}

function logEvents(log: string): any[] {
  const r = logTailLines(log);
  return r.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export function lastEvent(log: string): string {
  const r = logTailLines(log);
  for (let i = r.lines.length - 1; i >= 0; i--) {
    try { const obj = JSON.parse(r.lines[i]); if (obj?.type) return String(obj.type); } catch {}
  }
  return r.ok && !r.truncated ? "-" : "log too large to parse";
}

export function lastActivityAt(log: string): Date | null {
  const events = logEvents(log);
  for (let i = events.length - 1; i >= 0; i--) {
    const iso = eventTimeIso(events[i]);
    if (iso) return new Date(iso);
  }
  try { return fs.statSync(log).mtime; } catch { return null; }
}

export function agentSettledEvent(ev: string): boolean { return ev === "agent_end" || ev === "turn_end" || ev === "agent_settled"; }
