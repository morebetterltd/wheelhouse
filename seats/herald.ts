#!/usr/bin/env bun
/**
 * herald.ts — Dispatch Office wake-event daemon.
 *
 * Non-LLM file carrier: tails seats/logs/*.jsonl and appends deduplicated
 * wake events to seats/inbox.jsonl. On first sight of an existing log with no
 * persisted cursor, the herald starts at EOF: adopting the herald must not
 * replay historical seat output. The event `state` values deliberately use
 * A2A task-update vocabulary (terminal, input-required, failed) so a later
 * transport can swap the file out without renaming the commander's concepts.
 *
 * Optional poke delivery is intentionally tiny: after appending wake events,
 * the herald sends exactly one constant phrase to the commander tmux pane —
 * "check the fleet inbox" — and only if that pane is verifiably an idle
 * Claude session. A withheld poke stays pending and is retried on later scans
 * until the pane is idle, honoring the configured cooldown. Correctness never
 * depends on this poke; commanders drain the inbox at start, after dispatch,
 * and whenever poked.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const ROOT = path.resolve(process.env.WHEELHOUSE_HERALD_ROOT || path.join(import.meta.dir, ".."));
const SEATS_DIR = path.join(ROOT, "seats");
const LOG_DIR = path.join(SEATS_DIR, "logs");
const INBOX = path.join(SEATS_DIR, "inbox.jsonl");
const HERALD_OUT_LOG = path.join(LOG_DIR, "herald.out.log");
const DRAIN_CURSOR = path.join(SEATS_DIR, "inbox.cursor");
const DRAIN_SEEN = path.join(SEATS_DIR, "inbox.seen.json");
const STATE_FILE = path.join(SEATS_DIR, "herald.state.json");
const PID_FILE = path.join(SEATS_DIR, "run", "herald.pid");
const INTERVAL_MS = Number(process.env.WHEELHOUSE_HERALD_INTERVAL_MS || 1000);
const MAX_SEEN = Number(process.env.WHEELHOUSE_HERALD_MAX_SEEN || 5000);
const READ_CHUNK_BYTES = Math.max(1024, Number(process.env.WHEELHOUSE_HERALD_READ_CHUNK_BYTES || 64 * 1024));
const POKE_PHRASE = "check the fleet inbox";
const POKE_STABILITY_MS = Math.max(3000, Number(process.env.WHEELHOUSE_HERALD_POKE_STABILITY_MS || 3000));
const POKE_COOLDOWN_MS = Math.max(0, Number(process.env.WHEELHOUSE_HERALD_POKE_COOLDOWN_MS || 120_000));
const TMUX_SESSION = process.env.WHEELHOUSE_HERALD_TMUX_SESSION || "";
const TMUX_PANE = process.env.WHEELHOUSE_HERALD_TMUX_PANE || (TMUX_SESSION ? `${TMUX_SESSION}:bridge.0` : "");
const TMUX_SOCKET = process.env.WHEELHOUSE_TMUX_SOCKET || "";

const DISTRESS_RE = /(?:\bauth(?:entication|orization)?\b|\bunauthoriz(?:ed|ation)?\b|\b401\b|\bforbidden\b|\binvalid_grant\b|\btoken\b.*\b(?:expired|invalid|revoked)\b|\blog ?in required\b|\bcredential(?:s)?\b|\bquota\b|\brate.?limit\b|\b429\b|\busage limit\b|\bexhaust(?:ed|ion)?\b|\bout of credits\b|\binsufficient\s+credits?\b)/i;
const STOP_DISTRESS_RE = /\bSTOP\b/;
const SENTINEL_RE = /^\s*@commander\s*:/im;

type WakeClass = "settle" | "distress" | "sentinel";
type A2AState = "terminal" | "input-required" | "failed";

interface HeraldState {
  logs: Record<string, { offset: number }>;
  seen: string[];
  lastPokedInboxSize?: number;
  lastPokedByPane?: Record<string, number>;
}

interface Candidate {
  eventClass: WakeClass;
  state: A2AState;
  title: string;
  detail: string;
  sourceType?: string;
}

function die(msg: string): never {
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(1);
}

function readState(): HeraldState {
  if (!fs.existsSync(STATE_FILE)) return { logs: {}, seen: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { logs: parsed.logs ?? {}, seen: Array.isArray(parsed.seen) ? parsed.seen : [], lastPokedInboxSize: parsed.lastPokedInboxSize, lastPokedByPane: parsed.lastPokedByPane ?? {} };
  } catch (e: any) {
    die(`cannot parse ${STATE_FILE}: ${e.message}`);
  }
}

function writeState(state: HeraldState): void {
  fs.mkdirSync(SEATS_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

function appendInbox(obj: unknown): void {
  fs.mkdirSync(SEATS_DIR, { recursive: true });
  fs.appendFileSync(INBOX, JSON.stringify(obj) + "\n");
}

function logFiles(): string[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter((name) => name.endsWith(".jsonl") && name !== "inbox.jsonl")
    .sort()
    .map((name) => path.join(LOG_DIR, name));
}

function readCompleteLines(file: string, offset: number, onLine: (rec: { line: string; offset: number; endOffset: number }) => void): { offset: number; linesRead: number } {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size < offset) offset = 0; // log rotation/truncation: reread from start
  if (size === offset) return { offset, linesRead: 0 };
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, size - offset)));
  const decoder = new StringDecoder("utf8");
  let pos = offset;
  let pending = "";
  let pendingOffset = offset;
  let linesRead = 0;
  try {
    while (pos < size) {
      const bytesToRead = Math.min(buf.length, size - pos);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, pos);
      if (bytesRead <= 0) break;
      const chunk = decoder.write(buf.subarray(0, bytesRead));
      const text = pending + chunk;
      let lineStart = 0;
      let running = pendingOffset;
      for (;;) {
        const lf = text.indexOf("\n", lineStart);
        if (lf === -1) break;
        const endOffset = pendingOffset + Buffer.byteLength(text.slice(0, lf + 1));
        const line = text.slice(lineStart, lf);
        if (line) {
          onLine({ line, offset: running, endOffset });
          linesRead++;
        }
        lineStart = lf + 1;
        running = endOffset;
      }
      pending = text.slice(lineStart);
      pendingOffset = running;
      pos += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { offset: pendingOffset, linesRead };
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const obj: any = value;
    const parts = [obj.text, obj.content, obj.message, obj.delta, obj.error, obj.output, obj.result, obj.messages]
      .map(textOf).filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function firstSentinelLine(text: string): string {
  return text.split(/\r?\n/).find((line) => SENTINEL_RE.test(line))?.trim() ?? text.trim();
}

function assistantTextContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part: any) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function sentinelText(obj: any): string {
  // Sentinel wakes are an explicit question from the seat's assistant turn,
  // not text quoted out of a tool, a file, a prompt, or a thinking block.
  if (obj?.type !== "turn_end" || obj?.message?.role !== "assistant") return "";
  return assistantTextContent(obj.message.content);
}

function own(obj: any, key: string): boolean {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function hasErrorField(obj: any): boolean {
  return own(obj, "error") || own(obj, "errorMessage") || own(obj, "stderr");
}

function stderrText(obj: any): string {
  if (obj === null || obj === undefined) return "";
  if (Array.isArray(obj)) return obj.map(stderrText).filter(Boolean).join("\n");
  if (typeof obj !== "object") return "";
  const direct = own(obj, "stderr") ? textOf(obj.stderr) : "";
  const nested = Object.values(obj).map(stderrText).filter(Boolean).join("\n");
  return [direct, nested].filter(Boolean).join("\n");
}

function lastMessage(obj: any): any {
  return Array.isArray(obj?.messages) && obj.messages.length > 0 ? obj.messages[obj.messages.length - 1] : undefined;
}

function agentEndStopReason(obj: any): string {
  const last = lastMessage(obj);
  return typeof last?.stopReason === "string" ? last.stopReason : "";
}

function agentEndErrorMessage(obj: any): string {
  const last = lastMessage(obj);
  return textOf([last?.errorMessage, last?.error]);
}

function errorText(obj: any): string {
  const type = typeof obj?.type === "string" ? obj.type : undefined;
  const stderr = stderrText(obj);
  if (stderr) return stderr;
  if (type === "response" && obj?.success === false) return textOf([obj.error, obj.errorMessage, obj.message, obj.data]);
  if (type === "tool_execution_end" && (obj?.isError === true || hasErrorField(obj) || hasErrorField(obj?.result))) {
    return textOf([obj.error, obj.errorMessage, obj.message, obj.result?.error, obj.result?.errorMessage]);
  }
  if (type === "agent_end" && agentEndStopReason(obj) === "error") return agentEndErrorMessage(obj) || textOf([obj.error, obj.errorMessage]);
  if ((type === "agent_end" || type === "turn_end" || type === "message_end") && (hasErrorField(obj) || hasErrorField(obj?.message))) {
    return textOf([obj.error, obj.errorMessage, obj.message?.error, obj.message?.errorMessage, obj.diagnostics, obj.message?.diagnostics]);
  }
  return "";
}

function distressTextMatches(text: string): boolean {
  return STOP_DISTRESS_RE.test(text) || DISTRESS_RE.test(text);
}

function truncate(s: string, n = 700): string {
  const oneLine = s.replace(/\s+$/g, "");
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function classify(obj: any): Candidate | null {
  const type = typeof obj?.type === "string" ? obj.type : undefined;
  const sentinel = sentinelText(obj);
  if (sentinel && SENTINEL_RE.test(sentinel)) {
    return {
      eventClass: "sentinel",
      state: "input-required",
      title: "sentinel question for commander",
      detail: truncate(firstSentinelLine(sentinel)),
      sourceType: type,
    };
  }
  if (type === "agent_end") {
    const stopReason = agentEndStopReason(obj);
    if (stopReason === "error") {
      if (obj?.willRetry === true) return null;
      return {
        eventClass: "distress",
        state: "failed",
        title: "seat turn failed",
        detail: truncate(agentEndErrorMessage(obj) || "agent_end stopReason=error"),
        sourceType: type,
      };
    }
    return {
      eventClass: "settle",
      state: "terminal",
      title: "seat turn settled",
      detail: truncate(textOf(obj) || "agent_end"),
      sourceType: type,
    };
  }
  const distressText = errorText(obj);
  const text = distressText ? "" : textOf(obj);
  if (distressText && distressTextMatches(distressText)) {
    return {
      eventClass: "distress",
      state: "failed",
      title: "seat distress",
      detail: truncate(distressText || text || JSON.stringify(obj)),
      sourceType: type,
    };
  }
  return null;
}

function distressDetailForInbox(candidate: Candidate, seat: string): string {
  if (candidate.eventClass !== "distress") return candidate.detail;
  if (!DISTRESS_RE.test(candidate.detail)) return candidate.detail;
  return truncate(`${candidate.detail}\nProbe command: bun seats/adapter.ts probe ${seat}`);
}

function eventId(relLog: string, offset: number, line: string, candidate: Candidate): string {
  return crypto.createHash("sha256")
    .update(`${relLog}\0${offset}\0${candidate.eventClass}\0${candidate.state}\0${line}`)
    .digest("hex");
}

function tmuxArgs(args: string[]): string[] {
  return TMUX_SOCKET ? ["-L", TMUX_SOCKET, ...args] : args;
}

function tmuxOutput(args: string[]): string {
  return execFileSync("tmux", tmuxArgs(args), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function logPoke(outcome: string, detail = ""): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const suffix = detail ? ` ${detail.replace(/\s+/g, " ").trim()}` : "";
  fs.appendFileSync(HERALD_OUT_LOG, `${new Date().toISOString()} poke ${outcome}${suffix}\n`);
}

function paneTextLooksIdleClaude(paneText: string): boolean {
  // Claude Code's current prompt UI is a bordered input box: a standalone
  // `❯` prompt line followed by a status/footer line. During a turn that
  // same box can still be visible below an active status line, so exclude the
  // measured active markers first.
  if (/[✶✽✻✢✳✷✸✹].*\b(thinking|working|fiddle-faddling|esc to interrupt)\b/i.test(paneText)) return false;
  if (/\b(thinking|working|fiddle-faddling|running|esc to interrupt)\b[^\n]*\([^\n]*(thinking|tool|running|esc)/i.test(paneText)) return false;
  return /(?:^|\n)\s*(?:[>❯]|Human:|You:)\s*(?:\n|$)/.test(paneText) || /(?:^|\n).*claude.*(?:idle|ready|waiting)/i.test(paneText);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.floor(ms)));
}

function captureCommanderPane(): { command: string; text: string } | null {
  const command = tmuxOutput(["display-message", "-p", "-t", TMUX_PANE, "#{pane_current_command}"]);
  const text = tmuxOutput(["capture-pane", "-p", "-J", "-t", TMUX_PANE, "-S", "-30"]);
  return { command, text };
}

function commanderPaneIdleClaude(): boolean {
  if (!TMUX_PANE) return false;
  try {
    const first = captureCommanderPane();
    if (!first || !["claude", "node", "bun"].includes(first.command)) return false;
    if (!paneTextLooksIdleClaude(first.text)) return false;
    sleepSync(POKE_STABILITY_MS);
    const second = captureCommanderPane();
    if (!second || second.command !== first.command) return false;
    return second.text === first.text && paneTextLooksIdleClaude(second.text);
  } catch {
    return false;
  }
}

function pokeCommanderIfSafe(state: HeraldState): void {
  const inboxSize = fs.existsSync(INBOX) ? fs.statSync(INBOX).size : 0;
  if (inboxSize <= 0 || state.lastPokedInboxSize === inboxSize) return;
  if (!TMUX_PANE) {
    logPoke("dropped", `reason=no-pane inbox=${inboxSize}`);
    state.lastPokedInboxSize = inboxSize;
    writeState(state);
    return;
  }
  const lastPoked = state.lastPokedByPane?.[TMUX_PANE] ?? 0;
  if (POKE_COOLDOWN_MS > 0 && lastPoked > 0 && Date.now() - lastPoked < POKE_COOLDOWN_MS) { logPoke("deferred", `reason=cooldown pane=${TMUX_PANE} inbox=${inboxSize}`); return; }
  if (!commanderPaneIdleClaude()) { logPoke("deferred", `reason=not-idle pane=${TMUX_PANE} inbox=${inboxSize}`); return; }
  try {
    execFileSync("tmux", tmuxArgs(["send-keys", "-t", TMUX_PANE, POKE_PHRASE, "Enter"]), { stdio: "ignore" });
  } catch (e: any) {
    logPoke("dropped", `reason=send-failed pane=${TMUX_PANE} inbox=${inboxSize} error=${e?.message || e}`);
    throw e;
  }
  logPoke("sent", `pane=${TMUX_PANE} inbox=${inboxSize}`);
  state.lastPokedInboxSize = inboxSize;
  state.lastPokedByPane = { ...(state.lastPokedByPane ?? {}), [TMUX_PANE]: Date.now() };
  writeState(state);
}

function scanOnce(): number {
  const state = readState();
  const seen = new Set(state.seen);
  let appended = 0;
  for (const file of logFiles()) {
    const rel = path.relative(ROOT, file);
    const priorRecord = state.logs[rel];
    if (!priorRecord) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      state.logs[rel] = { offset: size };
      writeState(state);
      continue;
    }
    const prior = priorRecord.offset;
    const batch = readCompleteLines(file, prior, (rec) => {
      let obj: any;
      try { obj = JSON.parse(rec.line); } catch {
        state.logs[rel] = { offset: rec.endOffset };
        writeState(state);
        return;
      }
      const candidate = classify(obj);
      if (candidate) {
        const id = eventId(rel, rec.offset, rec.line, candidate);
        if (!seen.has(id)) {
          seen.add(id);
          appendInbox({
            id,
            at: new Date().toISOString(),
            seat: path.basename(file, ".jsonl"),
            class: candidate.eventClass,
            state: candidate.state,
            title: candidate.title,
            detail: distressDetailForInbox(candidate, path.basename(file, ".jsonl")),
            source: { log: rel, offset: rec.offset, type: candidate.sourceType ?? null },
          });
          appended++;
        }
      }
      state.logs[rel] = { offset: rec.endOffset };
      state.seen = Array.from(seen).slice(-MAX_SEEN);
      writeState(state); // per-line persistence closes append-before-state crash window
    });
    if (batch.linesRead === 0 && batch.offset !== prior) {
      state.logs[rel] = { offset: batch.offset };
      writeState(state);
    }
  }
  pokeCommanderIfSafe(state);
  return appended;
}

function readDrainCursor(): number {
  if (!fs.existsSync(DRAIN_CURSOR)) return 0;
  const n = Number(fs.readFileSync(DRAIN_CURSOR, "utf8").trim() || "0");
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function readDrainSeen(): Set<string> {
  if (!fs.existsSync(DRAIN_SEEN)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(DRAIN_SEEN, "utf8"));
    return new Set(Array.isArray(parsed.ids) ? parsed.ids : []);
  } catch {
    return new Set();
  }
}

function writeDrainSeen(seen: Set<string>): void {
  const tmp = `${DRAIN_SEEN}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids: Array.from(seen) }, null, 2) + "\n");
  fs.renameSync(tmp, DRAIN_SEEN);
}

function drain(): void {
  const offset = readDrainCursor();
  const size = fs.existsSync(INBOX) ? fs.statSync(INBOX).size : 0;
  if (size < offset) {
    fs.writeFileSync(DRAIN_CURSOR, "0\n");
    return drain();
  }
  if (size === offset) return;
  const fd = fs.openSync(INBOX, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const seen = readDrainSeen();
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const id = String(obj.id ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      process.stdout.write(line + "\n");
    } catch {
      process.stdout.write(line + "\n");
    }
  }
  fs.writeFileSync(DRAIN_CURSOR, `${size}\n`);
  writeDrainSeen(seen);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

function status(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log("herald STOPPED — no pid file");
    process.exit(1);
  }
  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  if (Number.isFinite(pid) && pidAlive(pid)) {
    console.log(`herald RUNNING pid ${pid}`);
    return;
  }
  console.log(`herald DEAD pid ${Number.isFinite(pid) ? pid : "?"}`);
  process.exit(1);
}

async function daemon(): Promise<void> {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  const cleanup = () => {
    try {
      if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  for (;;) {
    scanOnce();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

const args = process.argv.slice(2);
if (args.includes("--drain")) drain();
else if (args.includes("--once")) console.log(`herald: appended ${scanOnce()} wake event(s)`);
else if (args.includes("--status")) status();
else daemon().catch((e) => die(e.message));
