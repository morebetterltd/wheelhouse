import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

export function barePidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e.code === "EPERM"; }
}

export function openPaths(pid: number): string[] {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      return execFileSync(lsof, ["-Fn", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
        .split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
    } catch (e: any) { if (e.code === "ENOENT") continue; return []; }
  }
  return [];
}

export function pidHoldsPath(pid: number, p: string): boolean {
  const wanted = new Set([p]);
  try { wanted.add(fs.realpathSync(p)); } catch {}
  return openPaths(pid).some((n) => wanted.has(n));
}

export function processStartMs(pid: number): number | null {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim();
  if (!out) return null;
  const ms = Date.parse(out);
  return Number.isFinite(ms) ? ms : null;
}

export function pidMatchesStartedAt(pid: number, startedAt?: string): boolean {
  if (!startedAt) return false;
  const recorded = Date.parse(startedAt);
  if (!Number.isFinite(recorded)) return false;
  const live = processStartMs(pid);
  return live !== null && Math.abs(live - recorded) <= 2000;
}

export function pidAlive(pid: number | null | undefined, fifo?: string, startedAt?: string): boolean {
  if (!barePidAlive(pid)) return false;
  if (!fifo && !startedAt) return true;
  return (fifo ? pidHoldsPath(pid!, fifo) : false) || pidMatchesStartedAt(pid!, startedAt);
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
