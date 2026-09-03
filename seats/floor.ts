#!/usr/bin/env bun
/**
 * floor.ts — the bridge floor: manual-spotlight viewer for the seats.
 *
 * Runs in ONE tmux pane (cockpit.sh puts it there) and renders two regions:
 *
 *   SPOTLIGHT  the top of the pane, pinned to ONE seat; that seat's event
 *              log (seats/logs/<seat>.jsonl) humanized, newest at the bottom.
 *   RAIL       the bottom strip: one line per seat with an attention cue —
 *              amber = idle-with-ready-work or quota, red = auth dead or
 *              process gone, green = verdict landed. [0] is the STATUS cell.
 *
 * The spotlight moves ONLY on user action: keys 1-9 pin a seat, 0 pins the
 * full STATUS view, `f` toggles follow-mode (OFF by default; when on, the
 * spotlight tracks the most recently active log), `o` toggles an overview
 * grid of every seat, `q` also returns to overview instead of exiting the
 * tmux pane. Use Ctrl-C to quit.
 *
 * READ-ONLY by contract: this program reads state.json, seats.json, the
 * logs, and seats/verdicts/*.md. It never writes to a FIFO, never touches
 * state.json, never signals a seat. It is a window, not a hand.
 *
 * Failure states are DISTINCT LINES, never silence: a seat whose process is
 * gone, whose auth is dead, whose quota is exhausted, whose review bounced,
 * whose verdict's evidence floor failed (or whose verdict file is
 * unreadable), or whose log is missing each gets its own named line in the
 * rail — and the STATUS cell leads with an ALERTS roll-up of every red or
 * amber seat.
 *
 * Usage: bun seats/floor.ts [--once] [--pin <1-9|0|seat-name>] [--overview]
 *   --once      render a single frame to stdout and exit (for tests/scripts)
 *   --pin       initial spotlight target (default: seat 1)
 *   --overview  start in overview grid mode
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const LOG_DIR = path.join(SEATS_DIR, "logs");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");

const TAIL_BYTES = 64 * 1024; // how much of each log we look at per frame
const READY_TTL_MS = 15000; // how often we re-ask bd for ready work

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  amber: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  inverse: useColor ? "\x1b[7m" : "",
};

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

/** Last complete lines from the tail of a file, or null if it does not exist. */
function tailLines(file: string, maxBytes = TAIL_BYTES): string[] | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (start > 0 && lines.length > 0) lines.shift(); // first line may be partial
  return lines;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, Math.max(0, n - 1)) + "…" : flat;
}

function nowMs(): number {
  const forced = Number(process.env.FLOOR_NOW_MS || "");
  return Number.isFinite(forced) && forced > 0 ? forced : Date.now();
}

function quietAfterMs(): number {
  const forced = Number(process.env.FLOOR_QUIET_AFTER_MS || "");
  return Number.isFinite(forced) && forced > 0 ? forced : 10 * 60 * 1000;
}

function humanAge(ms: number | null): string {
  if (ms === null) return "-";
  const delta = Math.max(0, nowMs() - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function eventTimeMs(ev: any): number | null {
  for (const key of ["timestamp", "time", "created_at", "createdAt", "at"]) {
    const v = ev?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v < 10_000_000_000 ? v * 1000 : v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

function lastActivityMs(seat: Seat, events: string[] | null = tailLines(seat.log)): number | null {
  let best: number | null = null;
  if (events) {
    for (const line of events) {
      try {
        const t = eventTimeMs(JSON.parse(line));
        if (t !== null && (best === null || t > best)) best = t;
      } catch {
        /* raw lines fall through to mtime */
      }
    }
  }
  if (best !== null) return best;
  try {
    return fs.statSync(seat.log).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model: seats, events, assessment
// ---------------------------------------------------------------------------

interface Seat {
  name: string;
  role: string;
  provider: string;
  model: string;
  accountLabel: string;
  record: any | null; // state.json entry, if any
  log: string;
  errLog: string;
}

/** Roster order first (it is the crew list), then state-only seats. */
function listSeats(): Seat[] {
  const roster = readJson(ROSTER_FILE)?.seats ?? {};
  const state = readJson(STATE_FILE)?.seats ?? {};
  const names: string[] = [];
  for (const n of Object.keys(roster)) if (!roster[n]?.external) names.push(n);
  for (const n of Object.keys(state)) if (!names.includes(n)) names.push(n);
  return names.map((name) => ({
    name,
    role: roster[name]?.role ?? state[name]?.role ?? "?",
    provider: roster[name]?.provider ?? "-",
    model: roster[name]?.model ?? "-",
    accountLabel: roster[name]?.account?.label ?? "-",
    record: state[name] ?? null,
    log: state[name]?.log ?? path.join(LOG_DIR, `${name}.jsonl`),
    errLog: path.join(LOG_DIR, `${name}.stderr.log`),
  }));
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === "string" ? c.text : typeof c?.thinking === "string" ? c.thinking : ""))
      .join(" ");
  }
  return "";
}

/** One event object -> one humanized line. Unknown types stay visible. */
function humanize(line: string, width: number): string {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return truncate(`[raw] ${line}`, width);
  }
  const t = String(ev.type ?? "?");
  if (t === "agent_start") return "[turn] agent started";
  if (t === "agent_end") {
    const n = Array.isArray(ev.messages) ? ev.messages.length : null;
    const usage = ev.usage ? ` ${ev.usage.input_tokens ?? "?"}in/${ev.usage.output_tokens ?? "?"}out tok` : "";
    return `[turn_end] turn finished${n === null ? "" : ` — ${n} message(s)`}${usage}`;
  }
  if (t === "message_start" || t === "message_end" || t === "message_update") {
    const role = ev.message?.role ?? "?";
    const text = textOf(ev.message?.content);
    const hasThink = Array.isArray(ev.message?.content) && ev.message.content.some((c: any) => c?.type === "thinking" || typeof c?.thinking === "string");
    if (hasThink && !text.trim()) return truncate(`[think] (thinking)`, width);
    const tag = role === "user" ? "[user]" : role === "toolResult" ? "[tool] result:" : "[say]";
    return truncate(`${tag} ${text}`, width);
  }
  if (t.includes("thinking") || t === "think") return truncate(`[think] ${textOf(ev.content) || ev.text || ""}`, width);
  if (t.includes("tool")) {
    const name = ev.toolName ?? ev.tool?.name ?? ev.name ?? "?";
    const args = ev.args ?? ev.tool?.args ?? ev.input ?? "";
    const phase = t.includes("end") || t.includes("result") ? "done" : "";
    return truncate(`[tool] ${name} ${phase || JSON.stringify(args) || ""}`, width);
  }
  if (t === "response") {
    const ok = ev.success ? "ok" : `FAIL: ${ev.error ?? "?"}`;
    return truncate(`[rpc] ${ev.command ?? "?"} ${ok}`, width);
  }
  return truncate(`[${t}]`, width);
}

type Cue = "red" | "amber" | "green" | "ok" | "off";

interface Assessment {
  cue: Cue;
  line: string; // the rail line body (no seat name)
}

const AUTH_RE = /auth|unauthoriz|401|forbidden|token.*(expired|invalid|revoked)|log ?in required|credential/i;
const QUOTA_RE = /quota|rate.?limit|429|usage limit|exhaust|out of credits|insufficient.credit/i;
const CAPACITY_EVENT_TYPES = new Set(["message_end", "turn_end", "agent_end"]);

function lastMessage(obj: any): any {
  return Array.isArray(obj?.messages) && obj.messages.length > 0 ? obj.messages[obj.messages.length - 1] : undefined;
}

function stopReasonOf(obj: any): string {
  return String(obj?.message?.stopReason ?? obj?.stopReason ?? lastMessage(obj)?.stopReason ?? "");
}

function providerErrorText(obj: any): string {
  return textOf([
    obj?.message?.errorMessage,
    obj?.message?.error,
    obj?.errorMessage,
    obj?.error,
    lastMessage(obj)?.errorMessage,
    lastMessage(obj)?.error,
    obj?.diagnostics,
    obj?.message?.diagnostics,
    lastMessage(obj)?.diagnostics,
  ]).trim();
}

function capacityDetailFromEvent(obj: any): string | null {
  if (!CAPACITY_EVENT_TYPES.has(String(obj?.type ?? ""))) return null;
  if (stopReasonOf(obj) !== "error") return null;
  const detail = providerErrorText(obj);
  if (!QUOTA_RE.test(detail)) return null;
  return detail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "quota-shaped provider error";
}

const VERDICTS_DIR = path.join(SEATS_DIR, "verdicts");

interface VerdictFile {
  verdict: "APPROVE" | "BOUNCE" | "DISCOVER" | null; // null = unreadable
  unsatisfied: number; // evidence floor checks that read UNSATISFIED
  file: string;
}

/**
 * The verdict file verify.ts leaves for a bead, if one exists. Two failure
 * states live ONLY here, so the floor must read it: evidence floor checks
 * that read UNSATISFIED (verify.ts records them under "## Evidence checks"),
 * and a file whose verdict line is missing or malformed — which is an error
 * routed to a human, never a judgment, exactly as verify.ts's exit-1 rule
 * says. Only the failure states are surfaced from here; a clean APPROVE
 * still renders through the event-log path like before.
 */
function readVerdictFile(bead: string | null | undefined): VerdictFile | null {
  if (!bead) return null;
  const file = path.join(VERDICTS_DIR, `${bead}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/^- verdict:\s*(APPROVE|BOUNCE|DISCOVER)\b/m);
  const unsatisfied = (text.match(/—\s*UNSATISFIED\s*$/gm) ?? []).length;
  return { verdict: (m?.[1] as VerdictFile["verdict"]) ?? null, unsatisfied, file };
}

let readyCache: { at: number; count: number | null } = { at: 0, count: null };
/** How many beads are ready to claim. Read-only shell-out, cached, optional. */
function readyCount(): number | null {
  if (Date.now() - readyCache.at < READY_TTL_MS) return readyCache.count;
  let count: number | null = null;
  try {
    const out = execFileSync("bd", ["ready"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    count = out.split("\n").filter((l) => /\S/.test(l) && !/no issues|nothing/i.test(l)).length;
  } catch {
    count = null; // bd missing or unhappy — the rail just skips this signal
  }
  readyCache = { at: Date.now(), count };
  return count;
}

/**
 * Decide the seat's rail line. Order matters: identity problems (auth) beat
 * process problems, which beat quota, which beat review states, which beat
 * plain idle/working. Every failure is a DISTINCT named line, never silence.
 */
function assess(seat: Seat): Assessment {
  const rec = seat.record;
  const events = tailLines(seat.log);
  const errTail = (tailLines(seat.errLog, 8 * 1024) ?? []).slice(-20).join("\n");

  // Recent error strings from the event stream (response failures etc).
  const errorTexts: string[] = [];
  let lastType = "-";
  let verdict: string | null = null;
  if (events) {
    for (const line of events.slice(-200)) {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type) lastType = ev.type;
      if (ev.success === false && typeof ev.error === "string") errorTexts.push(ev.error);
      if (typeof ev.error === "string" && ev.success !== true) errorTexts.push(ev.error);
      const text = textOf(ev.message?.content);
      const m = text.match(/VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)/);
      if (m) verdict = m[1];
    }
  }
  const errBlob = errorTexts.slice(-10).join("\n") + "\n" + errTail;
  const eventCapacityDetail = (() => {
    if (!events) return null;
    let detail: string | null = null;
    for (const line of events.slice(-200)) {
      try {
        const ev = JSON.parse(line);
        const capacity = capacityDetailFromEvent(ev);
        if (capacity) detail = capacity;
        else if (detail && CAPACITY_EVENT_TYPES.has(String(ev?.type ?? "")) && stopReasonOf(ev) !== "error") detail = null;
      } catch {
        /* ignore */
      }
    }
    return detail;
  })();
  const alive = pidAlive(rec?.pid);

  if (AUTH_RE.test(errBlob)) {
    return { cue: "red", line: `AUTH DEAD — OAuth: PI_CODING_AGENT_DIR=${rec?.accountDir ?? "<dir>"} pi, then /login in the REPL; api_key: auth.json or provider env var` };
  }
  if (rec && rec.pid && !alive && !rec.stoppedAt) {
    return { cue: "red", line: `PROCESS GONE — pid ${rec.pid} died; check ${path.relative(ROOT, seat.errLog)}` };
  }
  if (rec?.lastCapacityEvent) {
    const at = eventTimeMs({ at: rec.lastCapacityEvent.at });
    return { cue: "amber", line: `PARKED/QUOTA — probe with: bun seats/adapter.ts probe ${seat.name} — ${humanAge(at)}: ${rec.lastCapacityEvent.detail}` };
  }
  if (eventCapacityDetail) {
    return { cue: "amber", line: `PARKED/QUOTA — probe with: bun seats/adapter.ts probe ${seat.name} — ${eventCapacityDetail}` };
  }
  if (QUOTA_RE.test(errBlob)) {
    return { cue: "amber", line: `PARKED/QUOTA — probe with: bun seats/adapter.ts probe ${seat.name}` };
  }
  // Verdict-file states (verify.ts's record for this seat's last bead).
  // Failure states only: unreadable beats everything the file could say,
  // and unsatisfied evidence beats the verdict word — even an APPROVE in
  // the file must never render green while a floor check reads UNSATISFIED.
  const vf = readVerdictFile(rec?.lastBead);
  if (vf) {
    const rel = path.relative(ROOT, vf.file);
    if (vf.verdict === null) {
      return { cue: "amber", line: `VERDICT UNREADABLE — routed to human: no parseable verdict line in ${rel}` };
    }
    if (vf.unsatisfied > 0) {
      return { cue: "amber", line: `EVIDENCE UNSATISFIED — ${vf.unsatisfied} floor check(s) failed on ${rec!.lastBead}; see ${rel}` };
    }
    if (vf.verdict === "BOUNCE") {
      return { cue: "amber", line: `REVIEW BLOCKED — VERDICT: BOUNCE on ${rec!.lastBead}; redispatch to author` };
    }
  }
  if (verdict === "BOUNCE") {
    return { cue: "amber", line: `REVIEW BLOCKED — VERDICT: BOUNCE on ${rec?.lastBead ?? "last bead"}; redispatch to author` };
  }
  if (verdict === "APPROVE" || verdict === "DISCOVER") {
    return { cue: "green", line: `VERDICT LANDED — ${verdict}${rec?.lastBead ? ` on ${rec.lastBead}` : ""}` };
  }
  if (!rec) return { cue: "off", line: "-" };
  if (!rec.pid && rec.stoppedAt) return { cue: "off", line: `stopped ${humanAge(eventTimeMs({ at: rec.stoppedAt }))} (session kept)` };
  if (!alive) return { cue: "red", line: `PROCESS GONE — no live pid; check ${path.relative(ROOT, seat.errLog)}` };
  if (events === null) {
    return { cue: "amber", line: `no event log yet — ${path.relative(ROOT, seat.log)} missing` };
  }
  if (lastType === "agent_end") {
    const ready = readyCount();
    if (ready !== null && ready > 0) {
      return { cue: "amber", line: `IDLE with ready work — ${ready} bead(s) in bd ready` };
    }
    return { cue: "ok", line: `idle${rec.lastBead ? ` after ${rec.lastBead}` : ""}` };
  }
  return { cue: "ok", line: `working${rec.lastBead ? ` ${rec.lastBead}` : ""} — last event ${lastType}` };
}

function cueMark(cue: Cue): string {
  switch (cue) {
    case "red":
      return `${C.red}●${C.reset} RED  `;
    case "amber":
      return `${C.amber}●${C.reset} AMBER`;
    case "green":
      return `${C.green}●${C.reset} GREEN`;
    case "ok":
      return `${C.dim}●${C.reset} ok   `;
    case "off":
      return `${C.dim}○${C.reset} off  `;
  }
}

function isQuiet(seat: Seat, activityMs: number | null = lastActivityMs(seat)): boolean {
  const rec = seat.record;
  return Boolean(rec?.pid && pidAlive(rec.pid) && activityMs !== null && nowMs() - activityMs > quietAfterMs());
}

function stateText(a: Assessment, quiet: boolean): string {
  return `${quiet ? "QUIET " : ""}${cueMark(a.cue)} ${a.line}`;
}

function seatRow(seat: Seat, a: Assessment, width: number): string {
  const rec = seat.record;
  const active = rec?.lastBead ?? "-";
  const activity = lastActivityMs(seat);
  const vendor = `${seat.provider}/${seat.model}`;
  return truncate(
    `${seat.name} | ${seat.role} | ${vendor} | ${seat.accountLabel} | ${stateText(a, isQuiet(seat, activity))} | ${active} | ${humanAge(activity)}`,
    width + 80,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface View {
  pin: number; // 1..9 seat index, 0 = STATUS
  follow: boolean;
  overview: boolean;
}

function railLines(seats: Seat[], view: View, width: number): string[] {
  const out: string[] = [];
  out.push(`${C.inverse}${C.bold} RAIL ${C.reset}${C.dim} name | role | provider/model | account | state | active bead | last activity   1-9 pin  0 status  f follow(${view.follow ? "ON" : "off"})  o/q overview  Ctrl-C quit${C.reset}`);
  seats.forEach((s, i) => {
    const n = i + 1;
    const a = assess(s);
    const sel = !view.overview && view.pin === n ? `${C.cyan}▶${C.reset}` : " ";
    out.push(truncate(`${sel}[${n}] ${seatRow(s, a, width)}`, width + 90));
  });
  const sel0 = !view.overview && view.pin === 0 ? `${C.cyan}▶${C.reset}` : " ";
  out.push(`${sel0}[0] STATUS | - | -/- | - | ${C.dim}●${C.reset} cell full fleet status | - | -`);
  return out;
}

function spotlightLines(seat: Seat, height: number, width: number): string[] {
  const a = assess(seat);
  const rec = seat.record;
  const head = `${C.inverse}${C.bold} SPOTLIGHT ${C.reset} ${C.bold}${seat.name}${C.reset} (${seat.role}; ${seat.provider}/${seat.model}; account ${seat.accountLabel}; last ${humanAge(lastActivityMs(seat))}${rec?.pid && pidAlive(rec.pid) ? `; pid ${rec.pid}` : ""})  ${stateText(a, isQuiet(seat))}`;
  const out = [truncate(head, width + 40)];
  const events = tailLines(seat.log);
  if (events === null) {
    out.push(`${C.amber}no event log yet for ${seat.name} — ${path.relative(ROOT, seat.log)} missing${C.reset}`);
    out.push(`${C.dim}the seat has not been spawned on this machine, or its log was cleaned${C.reset}`);
    return out;
  }
  const room = Math.max(1, height - 1);
  for (const line of events.slice(-room)) out.push(humanize(line, width));
  return out;
}

function statusLines(seats: Seat[], width: number): string[] {
  const out = [`${C.inverse}${C.bold} STATUS ${C.reset} ${path.basename(ROOT)} — ${seats.length} seat(s)`];
  const ready = readyCount();
  out.push(ready === null ? `${C.dim}bd ready: unavailable${C.reset}` : `bd ready: ${ready} bead(s) waiting`);
  out.push("");
  // Alerts first: every red/amber seat on one screen, before the per-seat
  // detail — a failure the commander has to scroll for is a failure hidden.
  const alerts = seats.map((s) => ({ s, a: assess(s) })).filter(({ a }) => a.cue === "red" || a.cue === "amber");
  if (alerts.length > 0) {
    out.push(`${C.bold}ALERTS (${alerts.length})${C.reset}`);
    for (const { s, a } of alerts) {
      out.push(truncate(`  ${stateText(a, isQuiet(s))}  ${s.name} — ${a.line}`, width + 20));
    }
    out.push("");
  }
  for (const s of seats) {
    const a = assess(s);
    const rec = s.record;
    out.push(`${C.bold}${seatRow(s, a, width)}${C.reset}`);
    if (rec) {
      out.push(truncate(`  pid ${rec.pid ?? "-"}${pidAlive(rec.pid) ? " (alive)" : ""}  session ${rec.sessionId ?? "-"}`, width));
      out.push(truncate(`  last bead ${rec.lastBead ?? "-"}  last activity ${humanAge(lastActivityMs(s))}`, width));
      out.push(truncate(`  capacity ${rec.lastCapacityEvent ? `QUOTA ${humanAge(eventTimeMs({ at: rec.lastCapacityEvent.at }))} — ${rec.lastCapacityEvent.detail}` : "ok (no recorded capacity event)"}`, width));
    } else {
      out.push(`  ${C.dim}no state.json record${C.reset}`);
    }
    out.push(truncate(`  log ${path.relative(ROOT, s.log)}`, width));
    out.push("");
  }
  return out;
}

function overviewLines(seats: Seat[], width: number): string[] {
  const out = [`${C.inverse}${C.bold} OVERVIEW ${C.reset} every seat, last two events  ${C.dim}(1-9/0 to pin, o to leave)${C.reset}`];
  seats.forEach((s, i) => {
    const a = assess(s);
    out.push(truncate(`[${i + 1}] ${seatRow(s, a, width)}`, width + 90));
    const events = tailLines(s.log);
    if (events === null) {
      out.push(`     ${C.dim}no event log yet — ${path.relative(ROOT, s.log)} missing${C.reset}`);
    } else {
      for (const line of events.slice(-2)) out.push(`     ${humanize(line, width - 5)}`);
    }
  });
  return out;
}

function frame(view: View, rows: number, cols: number): string {
  const seats = listSeats();
  if (seats.length === 0) {
    return "no seats: neither seats/seats.json nor seats/state.json names any —\ncopy seats/seats.json.example to seats/seats.json to define the roster.\n";
  }
  let pin = view.pin;
  if (view.follow) {
    // Follow-mode: spotlight the most recently active log. OFF by default;
    // this is the only automatic movement, and the user opted into it.
    let best = -1;
    let bestAt = -1;
    seats.forEach((s, i) => {
      const at = lastActivityMs(s);
      if (at !== null && at > bestAt) {
        bestAt = at;
        best = i;
      }
    });
    if (best >= 0) pin = best + 1;
  }

  const rail = railLines(seats, { ...view, pin }, cols);
  const topH = Math.max(3, rows - rail.length - 1);
  let top: string[];
  if (view.overview) top = overviewLines(seats, cols);
  else if (pin === 0) top = statusLines(seats, cols);
  else {
    const seat = seats[Math.min(pin, seats.length) - 1];
    top = seat ? spotlightLines(seat, topH, cols) : [`no seat pinned at [${pin}]`];
  }
  top = top.slice(0, topH);
  while (top.length < topH) top.push("");
  return [...top, `${C.dim}${"─".repeat(Math.max(10, Math.min(cols, 200)))}${C.reset}`, ...rail].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main: --once or interactive
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { once: boolean; view: View } {
  const view: View = { pin: 1, follow: false, overview: false };
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") once = true;
    else if (a === "--overview") view.overview = true;
    else if (a === "--pin") {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write("STOP: --pin needs a value (1-9, 0, or a seat name)\n");
        process.exit(1);
      }
      if (/^[0-9]$/.test(v)) view.pin = Number(v);
      else {
        const idx = listSeats().findIndex((s) => s.name === v);
        if (idx === -1) {
          process.stderr.write(`STOP: no seat named "${v}"\n`);
          process.exit(1);
        }
        view.pin = idx + 1;
      }
    } else {
      process.stderr.write(`usage: floor.ts [--once] [--pin <1-9|0|seat>] [--overview]\n`);
      process.exit(1);
    }
  }
  return { once, view };
}

const { once, view } = parseArgs(process.argv.slice(2));

if (once) {
  const cols = Number(process.env.COLUMNS || 100);
  const rows = Number(process.env.LINES || 40);
  process.stdout.write(frame(view, rows, cols));
  process.exit(0);
}

// Interactive: alt screen, poll-render, raw keys.
const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";

function restore(): void {
  if (process.stdout.isTTY) process.stdout.write(ALT_OFF);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function render(): void {
  const rows = process.stdout.rows || Number(process.env.LINES || 40);
  const cols = process.stdout.columns || Number(process.env.COLUMNS || 100);
  process.stdout.write("\x1b[H\x1b[J" + frame(view, rows - 1, cols));
}

if (process.stdout.isTTY) process.stdout.write(ALT_ON);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b: Buffer) => {
    const k = b.toString("utf8");
    if (k === "\x03") {
      restore();
      process.exit(0);
    } else if (k === "q") {
      view.overview = true;
      view.follow = false;
    } else if (/^[1-9]$/.test(k)) {
      view.pin = Number(k);
      view.follow = false; // a manual pin always wins over follow
      view.overview = false;
    } else if (k === "0") {
      view.pin = 0;
      view.follow = false;
      view.overview = false;
    } else if (k === "f") {
      view.follow = !view.follow;
    } else if (k === "o") {
      view.overview = !view.overview;
    }
    render();
  });
}
process.on("SIGINT", () => {
  restore();
  process.exit(0);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(0);
});

render();
setInterval(render, 500);
