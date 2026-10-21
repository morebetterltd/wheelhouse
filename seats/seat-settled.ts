// A settled task reminder, not a model-stream watchdog. No dependency on the
// optional stream-health/logger feature: legacy logs start an observation clock.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pidAlive } from "./seat-activity";
import type { LiveWorker } from "./fleet-snapshot";

export interface SettledSeat {
  seat: string; bead: string; contextKey: string; contextSince: string;
  logIdentity: string; logSize: number; phase: "settled" | "active" | "unknown";
  eventKey: string; eventHash: string; lastEvent: string; lastEventAt: string;
  eventTimeSource: "received" | "driver" | "observed";
  mode: "progress" | "review" | null; quietSince: string; quietMs: number; quietForMs: number; due: boolean;
}
function millis(value: unknown): number | null {
  const n = typeof value === "number" ? (value < 1e10 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? n : null;
}
export function settledSeatMs(root: string): number {
  let raw = process.env.WHEELHOUSE_SEAT_SETTLED_MS, scale = 1;
  if (raw === undefined || raw.trim() === "") {
    try { raw = fs.readFileSync(path.join(root, "wheelhouse/.template-source"), "utf8").match(/^seat-settled-minutes=(.*)$/m)?.[1]?.trim(); } catch {}
    scale = 60_000;
  }
  if (raw === undefined || raw.trim() === "") return 30 * 60_000;
  const value = Number(raw) * scale;
  if (!Number.isFinite(value) || value < 1000) throw new Error("seat-settled-minutes/WHEELHOUSE_SEAT_SETTLED_MS must be at least 1000ms");
  return value;
}
function ownedLog(root: string, seat: string, log: string, archive = false): fs.Stats | null {
  if (!/^[A-Za-z0-9_-]+$/.test(seat) || log !== path.join(root, "seats/logs", seat + ".jsonl" + (archive ? ".1" : ""))) return null;
  try {
    let current = path.parse(log).root;
    for (const part of path.dirname(log).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const st = fs.lstatSync(log); return st.isFile() && st.nlink === 1 ? st : null;
  } catch { return null; }
}
type Event = Pick<SettledSeat, "phase" | "eventKey" | "eventHash" | "lastEvent"> & { at: number | null; source: SettledSeat["eventTimeSource"] };
function scan(log: string, st: fs.Stats, phase: SettledSeat["phase"] = "unknown"): Event | null | undefined {
  const start = Math.max(0, st.size - 1024 * 1024), buf = Buffer.alloc(st.size - start);
  let fd: number | undefined, count = 0, boundary = start === 0;
  try {
    fd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) return undefined;
    if (start) { const b = Buffer.alloc(1); if (fs.readSync(fd, b, 0, 1, start - 1) === 1) boundary = b[0] === 10; }
    count = fs.readSync(fd, buf, 0, buf.length, start);
  } catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
  const data = buf.subarray(0, count);
  let begin = boundary ? 0 : data.indexOf(10) + 1, last: Event | null = null;
  if (!boundary && !begin) begin = data.length;
  for (let end = data.indexOf(10, begin); end >= 0; end = data.indexOf(10, begin)) {
    const line = data.subarray(begin, end).toString("utf8"), offset = start + end + 1; begin = end + 1;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const type = String(ev?.type ?? "");
    // Transport replies (including get_state=false) do not start/finish a turn
    // or postpone a reminder. turn_end alone is NOT an agent settlement.
    if (!/^(?:agent_start|agent_end|agent_settled|turn_start|turn_end|message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end|stream_activity|auto_retry_start|auto_retry_end|compaction_start|compaction_end|auto_compaction_start|auto_compaction_end|summarization_retry_.*)$/.test(type)) continue;
    const received = millis(ev.wheelhouse_received_at);
    const at = received ?? millis(ev.timestamp) ?? millis(ev.at);
    const terminal = type === "agent_settled" || (type === "agent_end" && ev.willRetry !== true);
    if (terminal) phase = "settled";
    else if (!/compaction_/.test(type)) phase = "active";
    last = { phase, eventKey: `${st.dev}:${st.ino}:${offset}`, eventHash: createHash("sha256").update(line).digest("hex"), lastEvent: type, at, source: received !== null ? "received" : at !== null ? "driver" : "observed" };
  }
  return last;
}
export function observeSettledSeats(root: string, workers: LiveWorker[], prior: Record<string, SettledSeat> = {}, now = Date.now()): Record<string, SettledSeat> {
  const quietMs = settledSeatMs(root), out: Record<string, SettledSeat> = Object.create(null);
  let state: any; try { state = JSON.parse(fs.readFileSync(path.join(root, "seats/state.json"), "utf8")).seats ?? {}; } catch { return out; }
  for (const worker of workers) {
    const seat = worker.name, rec = state[seat];
    if (!rec?.lastBead || rec.lastBead !== worker.lastBead || rec.stoppedAt || !pidAlive(rec.pid, rec.fifo, rec.startedAt)) continue;
    const st = rec.log && ownedLog(root, seat, rec.log); if (!st) continue;
    const contextKey = JSON.stringify([rec.pid, rec.startedAt ?? null, rec.lastBead, rec.lastDispatchAt ?? null]);
    const stored = prior[seat], sameContext = stored?.contextKey === contextKey;
    const validPrior = sameContext && millis(stored.lastEventAt) !== null && millis(stored.contextSince) !== null ? stored : undefined;
    const identity = `${st.dev}:${st.ino}`;
    const continuous = validPrior && validPrior.logIdentity === identity && st.size >= validPrior.logSize;
    let event = scan(rec.log, st, continuous ? validPrior.phase : "unknown"), archived = false;
    if (event === undefined) continue;
    if (!event && (!validPrior || validPrior.logIdentity !== identity || st.size < validPrior.logSize)) {
      const archive = ownedLog(root, seat, rec.log + ".1", true);
      const candidate = archive && scan(rec.log + ".1", archive);
      // An old archive may not hide a newer active turn. Missing legacy
      // timestamps need the prior event hash to prove rotation continuity.
      if (candidate && (!validPrior || candidate.eventHash === validPrior.eventHash ||
          (candidate.at !== null && candidate.at >= Date.parse(validPrior.lastEventAt)))) {
        const started = millis(rec.startedAt);
        if (started === null || (candidate.at ?? archive!.mtimeMs) >= started) { event = candidate; archived = true; }
      }
    }
    if (!event && continuous) event = { phase: validPrior.phase, eventKey: validPrior.eventKey, eventHash: validPrior.eventHash, lastEvent: validPrior.lastEvent, at: Date.parse(validPrior.lastEventAt), source: validPrior.eventTimeSource };
    if (event && archived && validPrior?.eventHash === event.eventHash) event = { ...event, eventKey: validPrior.eventKey, at: Date.parse(validPrior.lastEventAt), source: validPrior.eventTimeSource };
    const at = Math.min(now, event?.at ?? (validPrior && event && validPrior.eventKey === event.eventKey ? Date.parse(validPrior.lastEventAt) : now));
    const dispatch = millis(rec.lastDispatchAt), contextSince = validPrior?.contextSince ?? new Date(Math.min(now, dispatch ?? now)).toISOString();
    const mode = worker.taskStatus === "closed" ? null : worker.taskNeedsReview ? "review" : worker.taskStatus === "in_progress" ? "progress" : null;
    // In-review means free for new work: the commander's grace is measured
    // from dispatch, not from a late completion/label update by a background job.
    const since = mode === "review" ? Date.parse(contextSince) : Math.max(at, Date.parse(contextSince));
    const quietForMs = Math.max(0, now - since), phase = event?.phase ?? "unknown";
    out[seat] = { seat, bead: rec.lastBead, contextKey, contextSince, logIdentity: identity, logSize: st.size,
      phase, eventKey: event?.eventKey ?? "", eventHash: event?.eventHash ?? "", lastEvent: event?.lastEvent ?? "unknown",
      lastEventAt: new Date(at).toISOString(), eventTimeSource: event?.source ?? "observed", mode,
      quietSince: new Date(since).toISOString(), quietMs, quietForMs, due: phase === "settled" && mode !== null && quietForMs >= quietMs };
  }
  return out;
}
