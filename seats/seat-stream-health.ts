// A live process/RPC responder is not proof that its model turn is progressing.
// Only its own stream advances this clock. Open tool calls are a distinct wait
// phase: their duration is not a model-stream deadline.
import fs from "node:fs";
import path from "node:path";
import { pidAlive, SeatIdentityUnverified } from "./seat-activity";
export interface StreamSeat { pid?: number | null; fifo?: string; startedAt?: string; stoppedAt?: string; log?: string; lastBead?: string; lastDispatchAt?: string; lastCapacityEvent?: unknown }
export interface StreamHealth {
  seat: string; bead: string | null; processKey: string; progressKey: string;
  phase: "model" | "tool" | "idle"; pendingTools: string[]; pendingToolIds: Record<string, string>;
  lastEvent: string; lastEventAt: string; quietMs: number; quietForMs: number; stalled: boolean;
}
function setting(root: string, key: string, env: string, minutes: number, minimum: number): number {
  let raw = process.env[env], scale = 1;
  if (raw === undefined || raw.trim() === "") {
    try { raw = fs.readFileSync(path.join(root, "wheelhouse/.template-source"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim(); } catch {}
    scale = 60_000;
  }
  if (raw === undefined || raw.trim() === "") return minutes * 60_000;
  const value = Number(raw) * scale;
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${key}/${env} must be at least ${minimum}ms`);
  return value;
}
export function seatQuietMs(root: string): number { return setting(root, "seat-quiet-minutes", "WHEELHOUSE_SEAT_QUIET_MS", 20, 1000); }
export function seatStallNeedMs(root: string): number { return setting(root, "seat-stall-need-after-minutes", "WHEELHOUSE_SEAT_STALL_NEED_MS", 15, 0); }
function millis(v: unknown): number | null {
  const n = typeof v === "number" ? (v < 1e10 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
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
type Scan = { active: boolean; sawLifecycle: boolean; last: string; key: string; received: number | null; tools: Map<string, string> };
function scanStreamLog(log: string, st: fs.Stats, prior?: StreamHealth): Scan | null {
  // Ignore only a partial first record in a bounded tail. Tool updates
  // reconstruct an open tool whose start is older than the retained tail.
  const start = Math.max(0, st.size - 1024 * 1024), buf = Buffer.alloc(st.size - start);
  let fd: number | undefined, bytesRead = 0, boundary = start === 0;
  try {
    fd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) return null;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      if (fs.readSync(fd, previous, 0, 1, start - 1) === 1) boundary = previous[0] === 10;
    }
    bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  const data = buf.subarray(0, bytesRead);
  let active = !!prior && prior.phase !== "idle", sawLifecycle = false, last = "dispatch", key = "", received: number | null = null;
  const tools = new Map<string, string>(prior ? Object.entries(prior.pendingToolIds ?? {}) : []);
  // Cursor keys are byte offsets, not re-encoded lengths of a tail that may
  // begin halfway through a UTF-8 character.
  let begin = boundary ? 0 : data.indexOf(10) + 1;
  if (!boundary && begin === 0) begin = data.length;
  for (let end = data.indexOf(10, begin); end >= 0; end = data.indexOf(10, begin)) {
    const line = data.subarray(begin, end).toString("utf8"), offset = start + end + 1; begin = end + 1;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const type = String(ev?.type ?? "");
    // get_state/queue/dispatch acknowledgements must not keep a dead turn alive
    // or settle an unfinished turn merely because isStreaming reports false.
    if (!/^(?:agent_start|agent_end|agent_settled|turn_start|turn_end|message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end|stream_activity|auto_retry_start|auto_retry_end|compaction_start|compaction_end|auto_compaction_start|auto_compaction_end|summarization_retry_.*)$/.test(type)) continue;
    last = type; key = `${st.dev}:${st.ino}:${offset}`;
    // Top-level shim timestamps are receipt times. Never use an assistant's
    // message.timestamp: a long streaming message retains its creation time.
    received = millis(ev.wheelhouse_received_at) ?? millis(ev.timestamp) ?? millis(ev.at);
    // A new model turn starts after all tools from the previous turn returned,
    // even if a giant preceding tool result fell outside the bounded tail.
    if (type === "agent_start" || type === "turn_start") tools.clear();
    if (type === "agent_end" || type === "agent_settled") {
      active = type === "agent_end" && ev.willRetry === true; tools.clear(); sawLifecycle = true;
    } else if (!/compaction_/.test(type)) {
      active = true; sawLifecycle = true;
    }
    const id = String(ev.toolCallId ?? ev.toolName ?? "unknown");
    if (type === "tool_execution_start" || type === "tool_execution_update") tools.set(id, String(ev.toolName ?? "tool"));
    if (type === "tool_execution_end") tools.delete(id);
    if (type === "message_end" && ev.message?.role === "toolResult") tools.delete(String(ev.message.toolCallId));
  }
  return { active, sawLifecycle, last, key, received, tools };
}
export function seatStreamHealth(root: string, seat: string, rec: StreamSeat, prior?: StreamHealth, now = Date.now()): StreamHealth | null {
  if (!rec.log || rec.stoppedAt || rec.lastCapacityEvent || !pidAlive(rec.pid, rec.fifo, rec.startedAt)) return null;
  let st = ownedLog(root, seat, rec.log); if (!st) return null;
  const processKey = `${rec.pid}:${rec.startedAt ?? ""}`;
  if (prior?.processKey !== processKey) prior = undefined;
  let scan = scanStreamLog(rec.log, st, prior); if (!scan) return null;
  // Status copy-truncates completed logs. With no new turn lifecycle in the
  // current file, recover its actual terminal event from the owned archive instead of
  // mistaking a cached unfinished turn/assignment for a newly silent model.
  if (!scan.sawLifecycle) {
    const archive = ownedLog(root, seat, rec.log + ".1", true);
    if (archive) {
      const archived = scanStreamLog(rec.log + ".1", archive, prior);
      const archiveAt = archived?.received ?? archive.mtimeMs;
      if (archived?.sawLifecycle && archiveAt >= (prior ? Date.parse(prior.lastEventAt) : -Infinity)) { scan = archived; st = archive; }
    }
  }
  if (!scan.key && prior) { scan.key = prior.progressKey; scan.last = prior.lastEvent; }
  // An assignment alone is not proof of an unfinished turn. Legacy un-stamped
  // logs start at mtime, then a persisted matching key survives RPC appends.
  const at = scan.received ?? (prior && prior.progressKey === scan.key ? Date.parse(prior.lastEventAt) : scan.key ? st.mtimeMs : millis(rec.lastDispatchAt) ?? millis(rec.startedAt) ?? now);
  const lastAt = Math.min(now, at), quietMs = seatQuietMs(root), quietForMs = Math.max(0, now - lastAt);
  const phase = !scan.active ? "idle" : scan.tools.size ? "tool" : "model";
  return { seat, bead: rec.lastBead ?? null, processKey, progressKey: scan.key, phase, pendingTools: [...scan.tools.values()], pendingToolIds: Object.fromEntries(scan.tools), lastEvent: scan.last, lastEventAt: new Date(lastAt).toISOString(), quietMs, quietForMs, stalled: phase === "model" && quietForMs >= quietMs };
}
export function readStreamObservations(root: string): Record<string, StreamHealth> {
  try { return JSON.parse(fs.readFileSync(path.join(root, "seats/run/fleet-snapshot.json"), "utf8")).seatStreams ?? {}; } catch { return {}; }
}
export function observeSeatStreams(root: string, prior: Record<string, StreamHealth> = {}, now = Date.now(), onUnverified?: (seat: string, rec: StreamSeat, reason: string) => void): Record<string, StreamHealth> {
  const out: Record<string, StreamHealth> = {};
  let seats: Record<string, StreamSeat>; try { seats = JSON.parse(fs.readFileSync(path.join(root, "seats/state.json"), "utf8")).seats ?? {}; } catch { return out; }
  for (const [seat, rec] of Object.entries(seats)) {
    try { const health = seatStreamHealth(root, seat, rec, prior[seat], now); if (health) out[seat] = health; }
    catch (e) { if (!(e instanceof SeatIdentityUnverified)) throw e; onUnverified?.(seat, rec, e.message); }
  }
  return out;
}
