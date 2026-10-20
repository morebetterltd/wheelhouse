// A live process/RPC responder is not proof that its model turn is progressing.
// Only its own stream advances this clock. Open tool calls are a distinct wait
// phase: their duration is not a model-stream deadline.
import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "./seat-activity";
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
function ownedLog(root: string, seat: string, log: string): fs.Stats | null {
  if (!/^[A-Za-z0-9_-]+$/.test(seat) || log !== path.join(root, "seats/logs", seat + ".jsonl")) return null;
  try {
    let current = path.parse(log).root;
    for (const part of path.dirname(log).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const st = fs.lstatSync(log); return st.isFile() && st.nlink === 1 ? st : null;
  } catch { return null; }
}
export function seatStreamHealth(root: string, seat: string, rec: StreamSeat, prior?: StreamHealth, now = Date.now()): StreamHealth | null {
  if (!rec.log || rec.stoppedAt || rec.lastCapacityEvent || !pidAlive(rec.pid, rec.fifo, rec.startedAt)) return null;
  const st = ownedLog(root, seat, rec.log); if (!st) return null;
  const processKey = `${rec.pid}:${rec.startedAt ?? ""}`;
  const same = prior?.processKey === processKey;
  // Ignore a partial first record in a bounded tail. Tool updates reconstruct an
  // open tool even when its original start is older than the retained tail.
  const start = Math.max(0, st.size - 1024 * 1024), buf = Buffer.alloc(st.size - start);
  let fd: number | undefined, bytesRead = 0;
  try {
    fd = fs.openSync(rec.log, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) return null;
    bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  const data = buf.subarray(0, bytesRead);
  let active = !!(same && start > 0 && prior!.phase !== "idle"), sawLifecycle = false, last = "dispatch", key = "", received: number | null = null;
  const tools = new Map<string, string>(same && start > 0 ? Object.entries(prior!.pendingToolIds ?? {}) : []);
  // Cursor keys are byte offsets, not re-encoded lengths of a tail that may
  // begin halfway through a UTF-8 character.
  let begin = start > 0 ? data.indexOf(10) + 1 : 0;
  if (start > 0 && begin === 0) begin = data.length;
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
    } else {
      if (!/compaction_/.test(type)) active = true;
      sawLifecycle = true;
    }
    const id = String(ev.toolCallId ?? ev.toolName ?? "unknown");
    if (type === "tool_execution_start" || type === "tool_execution_update") tools.set(id, String(ev.toolName ?? "tool"));
    if (type === "tool_execution_end") tools.delete(id);
    if (type === "message_end" && ev.message?.role === "toolResult") tools.delete(String(ev.message.toolCallId));
  }
  if (!sawLifecycle) active = same ? prior!.phase !== "idle" : !!(rec.lastBead && rec.lastDispatchAt);
  if (!key && same) { key = prior!.progressKey; last = prior!.lastEvent; }
  // Legacy un-stamped logs start at their file mtime on first observation.
  // A persisted matching progress key then survives RPC-only appends/restarts.
  const at = received ?? (same && prior!.progressKey === key ? Date.parse(prior!.lastEventAt) : key ? st.mtimeMs : millis(rec.lastDispatchAt) ?? millis(rec.startedAt) ?? now);
  const lastAt = Math.min(now, at), quietMs = seatQuietMs(root), quietForMs = Math.max(0, now - lastAt);
  const phase = !active ? "idle" : tools.size ? "tool" : "model";
  return { seat, bead: rec.lastBead ?? null, processKey, progressKey: key, phase, pendingTools: [...tools.values()], pendingToolIds: Object.fromEntries(tools), lastEvent: last, lastEventAt: new Date(lastAt).toISOString(), quietMs, quietForMs, stalled: phase === "model" && quietForMs >= quietMs };
}
export function readStreamObservations(root: string): Record<string, StreamHealth> {
  try { return JSON.parse(fs.readFileSync(path.join(root, "seats/run/fleet-snapshot.json"), "utf8")).seatStreams ?? {}; } catch { return {}; }
}
export function observeSeatStreams(root: string, prior: Record<string, StreamHealth> = {}, now = Date.now()): Record<string, StreamHealth> {
  const out: Record<string, StreamHealth> = {};
  let seats: Record<string, StreamSeat>; try { seats = JSON.parse(fs.readFileSync(path.join(root, "seats/state.json"), "utf8")).seats ?? {}; } catch { return out; }
  for (const [seat, rec] of Object.entries(seats)) { const health = seatStreamHealth(root, seat, rec, prior[seat], now); if (health) out[seat] = health; }
  return out;
}
