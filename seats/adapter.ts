#!/usr/bin/env bun
/**
 * adapter.ts — commander-facing control of Pi seats over RPC.
 *
 * One seat = one long-lived `pi --mode rpc` process on its own agent
 * directory. This adapter spawns that process, talks to it, and records what
 * it learned; it is NOT a supervisor — nothing here restarts a dead seat or
 * meters its quota. Every invocation is short-lived and stateless: the three
 * durable pieces are
 *
 *   seats/state.json        seat -> pid, session, paths (schema in README.md)
 *   seats/run/<seat>.stdin  a FIFO; commands go in here as JSON lines
 *   seats/logs/<seat>.jsonl every event pi emits, appended raw
 *
 * The process outlives the adapter because its stdin is the FIFO, opened
 * read-write (`0<>` in bash) so it never sees EOF, and its stdout is the log
 * file, appended by redirection with no pipe to hold open. A later `dispatch`
 * opens the FIFO for writing, drops one line, and tails the log for the
 * response.
 *
 * Framing is strict JSONL, LF-only. Pi's own docs call out Node readline as
 * non-compliant here (it splits on Unicode separators that are legal inside
 * JSON strings), so both directions in this file are hand-buffered: write
 * LF-terminated lines, split incoming bytes on `\n` and nothing else.
 *
 * No tokens, ever: state.json and the logs record names, paths, pids, and
 * session ids. Identity stays in each seat's auth.json, which only
 * OAuth `/login` inside the interactive Pi REPL or an operator-written api_key
 * entry writes.
 *
 * Usage: bun seats/adapter.ts <command> [args]
 *
 *   spawn    <seat> [bead-id]          start the seat from seats/seats.json
 *   probe    <seat>                    one-shot provider/model liveness check
 *   dispatch <seat> <bead-id> <text>   send a prompt (same-bead queues; mid-turn cross-bead refuses unless forced)
 *   steer    <seat> <text>             redirect the current turn
 *   status                             liveness + last event, every seat
 *   stop     <seat>                    graceful SIGTERM; session survives
 *   stop-all                           SIGTERM every idle rostered seat; report busy seats
 *   resume   <seat>                    respawn attached to the recorded session
 *   reset    <seat>                    stop, discard the session, respawn cold
 *
 * A seat's process cwd is the bead's worktree, not the project root and not
 * prompt discipline: spawn with a bead id, or dispatch a bead the running
 * seat is not already sitting in, resolves to
 * `.wheelhouse-worktrees/<bead-id>` and STOPs loudly if that directory does
 * not exist yet — the worktree is a precondition dispatch enforces, not one
 * it creates. A cross-bead dispatch never interrupts a mid-turn seat: it
 * STOPs and names the in-flight bead and the agent_end/isStreaming=false
 * settle it is waiting on, unless WHEELHOUSE_DISPATCH_FORCE=1 deliberately
 * abandons that turn and allows the stop-and-relaunch escape.
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRoleBrief } from "./briefs";
import { hostBudgetAutoPrune, hostBudgetMaxWorktrees, hostBudgetPath } from "./host-budget";
import { harnessNameForSeat, requirePiHarness } from "./harness";

interface SeatDriver {
  readonly name: string;
  launch(name: string, entry: SeatEntry, sessionFile: string | null, cwd: string, retriedFresh?: boolean): Promise<void>;
  probe(name: string, entry: SeatEntry): void;
  getState(rec: SeatRecord): Promise<any>;
  prompt(rec: SeatRecord, message: string, streamingBehavior: "followUp" | "steer", timeoutMs?: number): Promise<any>;
  steer(rec: SeatRecord, text: string): Promise<any>;
  stop(state: State, name: string, rec: SeatRecord): Promise<string>;
}

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const RUN_DIR = path.join(SEATS_DIR, "run");
const LOG_DIR = path.join(SEATS_DIR, "logs");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const WORKTREES_DIR = path.join(ROOT, ".wheelhouse-worktrees");

// One knob for every wait in this file; the selftest raises it for real pi.
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_RPC_TIMEOUT_MS || 20000);
const PROMPT_ACK_MS = Number(process.env.WHEELHOUSE_PROMPT_ACK_MS || 60000);
const SPAWN_TERM_GRACE_MS = Number(process.env.WHEELHOUSE_SPAWN_TERM_GRACE_MS || 2000);
const LOG_TAIL_BYTES = Number(process.env.WHEELHOUSE_LOG_TAIL_BYTES || 1024 * 1024);
const LOG_ROTATE_BYTES = Number(process.env.WHEELHOUSE_LOG_ROTATE_BYTES || 256 * 1024 * 1024);
const LOG_ROTATE_KEEP = Number(process.env.WHEELHOUSE_LOG_ROTATE_KEEP || 3);
const LOG_EVENT_STRING_BYTES = Number(process.env.WHEELHOUSE_LOG_EVENT_STRING_BYTES || 64 * 1024);
const ORPHAN_CONFIRM_MS = Number(process.env.WHEELHOUSE_ORPHAN_CONFIRM_MS || 3000);

/** A bead's worktree, by the convention every worker and reviewer already
 * follows (wheelhouse/fleet/WORKER.md): `.wheelhouse-worktrees/<bead-id>`
 * beside seats/. This does not create it — it names where dispatch expects
 * to find it already created (worker claim, or the commander's own setup). */
function beadWorktreeDir(beadId: string): string {
  return path.join(WORKTREES_DIR, beadId);
}

function die(msg: string): never {
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(1);
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * A seat name is used as a path segment (run/<seat>.stdin, logs/<seat>.jsonl)
 * and lands inside the quoted shell command that launches pi. A bead id is
 * used the same way at dispatch (recover.ts's printed resume-suggestion
 * quotes it back). Anything that is not one plain segment — separators,
 * dot-dirs, whitespace, quotes — would write outside seats/, break the
 * launch line, or split printed output across lines, so it is refused
 * loudly, naming the offending key. Same rules as verify.ts's validateSegment.
 */
function validateSegment(kind: string, value: string): string {
  const bad =
    value.length === 0 ? "empty" :
    value === "." || value === ".." ? "a dot segment" :
    /[/\\]/.test(value) ? "a path separator" :
    /\s/.test(value) ? "whitespace" :
    /['"`]/.test(value) ? "a quote character" :
    null;
  if (bad !== null) {
    die(`invalid ${kind} ${JSON.stringify(value)} (${bad}) — must be a single path segment: no /, no .., no whitespace, no quotes`);
  }
  return value;
}

function validateSeatName(name: string): string {
  return validateSegment("seat name", name);
}

// ---------------------------------------------------------------------------
// Comment authorship (BEADS_ACTOR)
// ---------------------------------------------------------------------------

/**
 * BEADS_ACTOR names which seat spoke, so a bead comment's author field says
 * which seat wrote it (contracts/GRAPH.md, "Comment authorship is
 * configured, not inferred"). This adapter sets it in every child pi
 * process's own environment — spawn, resume, reset, and the cwd-changing
 * relaunch inside dispatch, because all four call launch() below — rather
 * than asking the operator to export it before invoking the adapter. An
 * operator export cannot be the mechanism: one commander pane launches five
 * seats with five different actor names, and dispatch/resume/reset relaunch
 * a seat transparently from whatever env the adapter process happens to
 * have at that later moment, which is not necessarily the env the operator
 * exported into at spawn time. Construction beats convention here, the same
 * way requireCwdDir() below makes a seat's cwd a fact of how it was spawned
 * rather than an instruction inside a prompt.
 *
 * An operator override remains available, for the rare case a seat's bd
 * comments need a different actor name than its seat name:
 * WHEELHOUSE_BEADS_ACTOR_<SEAT>, with the seat name upper-cased and every
 * character outside [A-Z0-9] turned into "_" (so "reviewer-codex" reads its
 * override from WHEELHOUSE_BEADS_ACTOR_REVIEWER_CODEX). Optional, not
 * required — the seat name alone is always a correct default.
 */
function beadsActorEnvVar(name: string): string {
  return `WHEELHOUSE_BEADS_ACTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function beadsActorFor(name: string): string {
  const override = process.env[beadsActorEnvVar(name)];
  return override && override.length > 0 ? override : name;
}

// ---------------------------------------------------------------------------
// Roster and state
// ---------------------------------------------------------------------------

interface SeatEntry {
  role: string;
  harness?: string;
  provider?: string;
  model?: string;
  external?: boolean;
  shadow?: boolean;
  skills?: string[];
  allowedTools?: string;
  account?: { dir: string; label?: string; authRoute?: string };
}


// The three routes BOOTSTRAP.md's question 8 offers: `oauth` for a
// subscription seat's REPL /login, `api_key` for a written auth.json entry,
// `env` for a provider env var exported in the spawning shell. Durable but
// optional — `seats/seats.json` written before this field existed has no
// `account.authRoute` at all, and that stays a valid roster.
const AUTH_ROUTES = ["oauth", "api_key", "env", "default"] as const;

function validateAuthRoute(seatName: string, entry: SeatEntry): void {
  const route = entry.account?.authRoute;
  if (route === undefined) return; // absent is valid — pre-existing rosters
  if (!AUTH_ROUTES.includes(route as (typeof AUTH_ROUTES)[number])) {
    die(
      `seat "${seatName}" has an invalid account.authRoute ${JSON.stringify(route)} in seats/seats.json — ` +
        `must be one of ${AUTH_ROUTES.join(", ")} (or omitted)`
    );
  }
}

function validateHarness(seatName: string, entry: SeatEntry): void {
  try {
    harnessNameForSeat(seatName, entry);
  } catch (e: any) {
    die(e.message);
  }
}

function validateShadow(seatName: string, entry: SeatEntry): void {
  if (entry.shadow === undefined) return; // absent means false
  if (typeof entry.shadow !== "boolean") {
    die(
      `seat "${seatName}" has an invalid shadow ${JSON.stringify(entry.shadow)} in seats/seats.json — ` +
        `must be boolean true or false (or omitted)`
    );
  }
}

// Optional per-seat skill directories, passed to pi as `--skill <path>` at
// spawn (and at the relaunches inside resume/reset/dispatch, which all come
// through launch). Tilde-expanded like account.dir. A path that does not
// exist is a STOP while reading the roster, not a silent omission: a seat
// spawned without the skill its brief assumes would run the brief wrong and
// nobody would see why.
function validateSkills(seatName: string, entry: SeatEntry): void {
  if (entry.skills === undefined) return; // absent means none
  if (!Array.isArray(entry.skills) || entry.skills.some((s) => typeof s !== "string" || s.length === 0)) {
    die(
      `seat "${seatName}" has an invalid skills ${JSON.stringify(entry.skills)} in seats/seats.json — ` +
        `must be an array of non-empty path strings (or omitted)`
    );
  }
  for (const raw of entry.skills) {
    const p = expandTilde(raw);
    if (!fs.existsSync(p)) die(`seat "${seatName}" lists skill ${raw} in seats/seats.json, but ${p} does not exist`);
  }
}

function skillArgs(_seatName: string, entry: SeatEntry): string[] {
  const args: string[] = [];
  for (const raw of entry.skills ?? []) args.push("--skill", expandTilde(raw));
  return args;
}

interface SeatRecord {
  pid: number | null;
  startedAt: string;
  stoppedAt?: string;
  accountDir: string;
  accountLabel?: string;
  role: string;
  roleBrief: string;
  roleBriefHash?: string;
  cwd: string;
  fifo: string;
  log: string;
  sessionId: string | null;
  sessionFile: string | null;
  model?: string;
  lastBead?: string;
  lastDispatchAt?: string;
  lastPrompt?: string;
  lastCapacityEvent?: { at: string; detail: string; accountLabel?: string };
  lastStalledEvent?: { at: string; detail: string };
  lastLaunchFailure?: { at: string; detail: string };
}

interface State {
  seats: Record<string, SeatRecord>;
}

function parseRosterFile(): Record<string, SeatEntry> {
  const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
  return raw.seats ?? {};
}

function readRoster(): Record<string, SeatEntry> {
  if (!fs.existsSync(ROSTER_FILE)) {
    die(`no ${ROSTER_FILE} — copy seats/seats.json.example to seats/seats.json and edit it`);
  }
  const seats = parseRosterFile();
  for (const [name, entry] of Object.entries(seats)) {
    validateHarness(name, entry);
    validateAuthRoute(name, entry);
    validateShadow(name, entry);
    validateSkills(name, entry);
  }
  return seats;
}

function readNamedRosterEntry(name: string): SeatEntry | undefined {
  if (!fs.existsSync(ROSTER_FILE)) return undefined;
  const seats = parseRosterFile();
  return seats[name];
}

function driverForRunningSeat(name: string, operation: string): SeatDriver {
  let entry: SeatEntry | undefined;
  try {
    entry = readNamedRosterEntry(name);
  } catch {
    return PI_DRIVER;
  }
  if (!entry) return PI_DRIVER;
  return driverForSeat(name, entry, operation);
}

function readState(): State {
  if (!fs.existsSync(STATE_FILE)) return { seats: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function sleepMs(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(): number {
  const lock = path.join(SEATS_DIR, "state.lock");
  const deadline = Date.now() + Number(process.env.WHEELHOUSE_STATE_LOCK_TIMEOUT_MS || 5000);
  while (true) {
    fs.mkdirSync(SEATS_DIR, { recursive: true });
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      return fd;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let owner: number | null = null;
      try {
        const raw = fs.readFileSync(lock, "utf8").trim();
        owner = raw ? Number(raw) : null;
      } catch {}
      if (owner && !barePidAlive(owner)) {
        try { fs.rmSync(lock, { force: true }); continue; } catch {}
      }
      if (Date.now() >= deadline) die(`timed out waiting for ${lock}`);
      sleepMs(25);
    }
  }
}

function releaseStateLock(fd: number): void {
  try { fs.closeSync(fd); } catch {}
  try { fs.rmSync(path.join(SEATS_DIR, "state.lock"), { force: true }); } catch {}
}

function writeState(state: State): void {
  const testDelay = Number(process.env.WHEELHOUSE_STATE_WRITE_DELAY_MS || 0);
  const fd = acquireStateLock();
  try {
    if (testDelay > 0) sleepMs(testDelay);
    // Re-read-before-merge under the lock plus a per-writer tmp file: two
    // adapter invocations updating different seats must not let the later
    // rename erase the earlier writer's record.
    let merged = state;
    if (fs.existsSync(STATE_FILE)) {
      try {
        const current = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
        merged = { seats: { ...(current.seats ?? {}), ...(state.seats ?? {}) } };
      } catch {}
    }
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    releaseStateLock(fd);
  }
}

function barePidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists, not ours to signal — still alive
  }
}

function openPaths(pid: number): string[] {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      return execFileSync(lsof, ["-Fn", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .filter((l) => l.startsWith("n"))
        .map((l) => l.slice(1));
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      return [];
    }
  }
  return [];
}
function pidHoldsPath(pid: number, p: string): boolean {
  const wanted = new Set([p]);
  try { wanted.add(fs.realpathSync(p)); } catch {}
  return openPaths(pid).some((n) => wanted.has(n));
}
function pidAlive(pid: number | null, fifo?: string): boolean {
  if (!barePidAlive(pid)) return false;
  return fifo ? pidHoldsPath(pid!, fifo) : true;
}

// Same rule as seat-env.sh: pi auto-creates an empty {} auth.json on a first
// headless run, and a seat with only that has never been logged in.
function authIsIdentity(authFile: string): boolean {
  if (!fs.existsSync(authFile)) return false;
  const body = fs.readFileSync(authFile, "utf8").replace(/[{}\s]/g, "");
  return body.length > 0;
}

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function providerEnvVar(provider: string): string | undefined {
  return PROVIDER_ENV_VARS[provider];
}

function scrubbedSeatEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function providerAuthEntry(authFile: string, provider: string): unknown {
  if (!fs.existsSync(authFile)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, provider)) {
      return (parsed as Record<string, unknown>)[provider];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function requireLaunchCredential(name: string, entry: SeatEntry, accountDir: string, authFile: string, labelSuffix: string): void {
  if (entry.account?.authRoute === "env") {
    if (!entry.provider) die(`seat "${name}"${labelSuffix} uses account.authRoute=env but has no provider in seats/seats.json`);
    const envVar = providerEnvVar(entry.provider);
    if (!envVar) {
      die(`seat "${name}"${labelSuffix} uses account.authRoute=env for provider ${JSON.stringify(entry.provider)}, but this adapter does not know that provider's env var`);
    }
    if (!process.env[envVar]) {
      die(`seat "${name}"${labelSuffix} uses account.authRoute=env but ${envVar} is not set in the shell spawning this seat`);
    }
    if (providerAuthEntry(authFile, entry.provider) !== undefined) {
      die(
        `seat "${name}"${labelSuffix} uses account.authRoute=env, but ${authFile} contains a ${entry.provider} entry that pi checks before ${envVar}. ` +
          `Remove that provider entry (do not replace it with an env stub) or switch the roster to account.authRoute=api_key; leaving it in place shadows the exported key.`
      );
    }
    return;
  }
  if (!authIsIdentity(authFile)) {
    die(
      `seat "${name}"${labelSuffix} has no identity — ${authFile} is missing or empty.\n` +
        `      OAuth: PI_CODING_AGENT_DIR="${accountDir}" pi, then type /login in the REPL and /exit after the browser flow\n` +
        `      api_key: write ${authFile} or set account.authRoute=env and export the provider env var in the shell that spawns this seat`
    );
  }
}

// ---------------------------------------------------------------------------
// Talking to a running seat: FIFO in, log out
// ---------------------------------------------------------------------------

/**
 * Append one LF-terminated JSON line to the seat's FIFO. Non-blocking open:
 * if no process holds the read side, the open fails with ENXIO — which is the
 * honest answer, "this seat is not running" — instead of hanging forever.
 * Retried briefly because a just-spawned seat opens its end a moment after
 * the adapter returns from spawn.
 */
async function fifoWrite(fifo: string, obj: unknown, retryMs = 3000): Promise<void> {
  const line = JSON.stringify(obj) + "\n";
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try {
        fs.writeSync(fd, line);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (e: any) {
      if (e.code !== "ENXIO" || Date.now() > deadline) {
        throw new Error(`cannot write to ${fifo}: ${e.code ?? e.message} — is the seat running?`);
      }
      await sleep(100);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read complete log lines from a byte offset; for old offset=0 callers, tail only. */
function logLinesFrom(log: string, offset: number, maxBytes = LOG_TAIL_BYTES): { lines: string[]; offset: number; truncated: boolean } {
  if (!fs.existsSync(log)) return { lines: [], offset, truncated: false };
  const size = fs.statSync(log).size;
  if (size <= offset) return { lines: [], offset, truncated: false };
  const start = offset === 0 && size > maxBytes ? size - maxBytes : offset;
  const truncated = start > offset;
  const fd = fs.openSync(log, "r");
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(size - start);
    fs.readSync(fd, chunk, 0, chunk.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = chunk.toString("utf8");
  let base = start;
  if (truncated) {
    const firstLf = text.indexOf("\n");
    if (firstLf !== -1) { base += Buffer.byteLength(text.slice(0, firstLf + 1)); text = text.slice(firstLf + 1); }
  }
  const lastLf = text.lastIndexOf("\n");
  if (lastLf === -1) return { lines: [], offset: start, truncated }; // partial line; come back
  return {
    lines: text.slice(0, lastLf).split("\n").filter((l) => l.length > 0),
    offset: base + Buffer.byteLength(text.slice(0, lastLf + 1)),
    truncated,
  };
}

/**
 * Send a command and wait for its response line in the log. The log offset is
 * taken BEFORE the write so the response cannot land in a blind spot.
 */
function promptCommand(message: string, streamingBehavior: "followUp" | "steer"): Record<string, unknown> {
  return { type: "prompt", message, streamingBehavior };
}

async function rpc(
  rec: { fifo: string; log: string; pid: number | null },
  command: Record<string, unknown>,
  timeoutMs = TIMEOUT_MS
): Promise<any> {
  const id = crypto.randomUUID();
  let offset = fs.existsSync(rec.log) ? fs.statSync(rec.log).size : 0;
  const sentOffset = offset;
  await fifoWrite(rec.fifo, { ...command, id });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = logLinesFrom(rec.log, offset);
    offset = r.offset;
    for (const line of r.lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // not ours to police; the log is pi's raw stream
      }
      if (obj.type === "response" && obj.id === id) return obj;
    }
    if (!pidAlive(rec.pid, rec.fifo)) {
      throw new Error(`seat process died while waiting for ${command.type} response — check the .stderr.log beside its event log`);
    }
    await sleep(100);
  }
  const err: any = new Error(`timed out after ${timeoutMs}ms waiting for ${command.type} response`);
  err.code = "WHEELHOUSE_RPC_TIMEOUT";
  err.logOffset = sentOffset;
  err.commandType = command.type;
  err.commandId = id;
  throw err;
}

function promptDeliveredAfter(rec: { log: string }, offset: number, prompt: string): boolean {
  const r = logLinesFrom(rec.log, offset);
  for (const line of r.lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "agent_start" || obj.type === "turn_start") return true;
    if (obj.type === "message_start" || obj.type === "message_end") {
      const role = obj.message?.role;
      const text = textOf(obj.message?.content);
      if (role === "user" && text.includes(prompt)) return true;
    }
  }
  return false;
}

async function terminateSpawnedOnly(pid: number): Promise<string> {
  if (!pidAlive(pid)) return `spawned pid ${pid} already gone`;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const termDeadline = Date.now() + SPAWN_TERM_GRACE_MS;
  while (pidAlive(pid) && Date.now() < termDeadline) await sleep(100);
  if (!pidAlive(pid)) return `terminated spawned pid ${pid} with SIGTERM`;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  const killDeadline = Date.now() + TIMEOUT_MS;
  while (pidAlive(pid) && Date.now() < killDeadline) await sleep(100);
  return pidAlive(pid) ? `spawned pid ${pid} survived SIGKILL` : `terminated spawned pid ${pid} with SIGKILL after ${SPAWN_TERM_GRACE_MS}ms grace`;
}

// Capacity visibility (visibility ONLY — nothing here meters or brokers
// quota). Same pattern the floor uses, kept in both places on purpose: the
// adapter stamps state.json when a dispatch fails quota-shaped, the floor
// renders from the stamp AND keeps scanning raw streams for what the
// adapter never saw.
const QUOTA_RE = /quota|rate.?limit|429|usage limit|exhaust|out of credits|insufficient.credit/i;
const CAPACITY_EVENT_TYPES = new Set(["message_end", "turn_end", "agent_end"]);

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const obj: any = value;
    const parts = [obj.text, obj.content, obj.message, obj.delta, obj.error, obj.errorMessage, obj.stderr, obj.output, obj.result, obj.messages, obj.diagnostics]
      .map(textOf).filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function eventTimeIso(ev: any): string {
  for (const key of ["timestamp", "time", "created_at", "createdAt", "at"]) {
    const v = ev?.[key] ?? ev?.message?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 10_000_000_000 ? v * 1000 : v).toISOString();
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  }
  return new Date().toISOString();
}

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

function eventIsSuccessfulTurnEnd(obj: any): boolean {
  if (!CAPACITY_EVENT_TYPES.has(String(obj?.type ?? ""))) return false;
  return stopReasonOf(obj) !== "error";
}

function syncCapacityFromLog(name: string, rec: SeatRecord, state: State, roster: Record<string, SeatEntry>): void {
  const r = logLinesFrom(rec.log, 0);
  let changed = false;
  let sawCapacityInThisScan = false;
  for (const line of r.lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const detail = capacityDetailFromEvent(obj);
    if (detail) {
      sawCapacityInThisScan = true;
      const label = accountLabel(roster[name], rec);
      rec.lastCapacityEvent = {
        at: eventTimeIso(obj),
        detail: label ? `${detail} (account ${label})` : detail,
        ...(label ? { accountLabel: label } : {}),
      };
      changed = true;
    } else if (sawCapacityInThisScan && rec.lastCapacityEvent && eventIsSuccessfulTurnEnd(obj)) {
      delete rec.lastCapacityEvent;
      changed = true;
    }
  }
  if (changed) writeState(state);
}


/** Last few KB of the seat's stderr log — where pi complains about limits. */
function recordLaunchFailure(name: string, existing: SeatRecord | undefined, detail: string): void {
  const state = readState();
  state.seats[name] = {
    ...(existing ?? state.seats[name] ?? {}),
    pid: null,
    lastLaunchFailure: { at: new Date().toISOString(), detail } as any,
  } as SeatRecord;
  writeState(state);
}

function stderrTail(rec: { log: string }, maxBytes = 8 * 1024): string {
  const errLog = rec.log.replace(/\.jsonl$/, ".stderr.log");
  try {
    const size = fs.statSync(errLog).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(errLog, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function requireSeat(name: string): SeatEntry {
  const roster = readRoster();
  const entry = roster[name];
  if (!entry) {
    die(`no seat named "${name}" in seats/seats.json (have: ${Object.keys(roster).join(", ") || "none"})`);
  }
  if (entry.external) die(`"${name}" is external — it runs on its own harness, not on a Pi seat`);
  const harness = harnessNameForSeat(name, entry);
  if (!entry.account?.dir && !(harness === "claude-code" && entry.account?.authRoute === "default")) die(`seat "${name}" has no account.dir in seats/seats.json`);
  return entry;
}

function roleBriefPath(role: string): string {
  try {
    return resolveRoleBrief(ROOT, role);
  } catch (e: any) {
    die(e.message);
  }
}

function accountLabel(entry: SeatEntry | undefined, rec?: SeatRecord): string | undefined {
  const label = entry?.account?.label ?? rec?.accountLabel;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

function accountLabelSuffix(entry: SeatEntry | undefined, rec?: SeatRecord): string {
  const label = accountLabel(entry, rec);
  return label ? ` (account label: ${label})` : "";
}

// The seat's process cwd IS the bead's worktree — construction, not a
// prompt telling the seat to cd there. Callers compute cwd from the bead id
// (beadWorktreeDir); launch() only ever starts a process in a directory
// that already exists, never creates one. Checked BEFORE anything is
// stopped or spawned: a dispatch aimed at a bead with no worktree must
// refuse loudly and leave whatever was already running alone, not kill a
// live seat on the way to discovering the target doesn't exist.
function requireCwdDir(cwd: string): string {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    die(`seat cwd target does not exist or is not a directory: ${cwd} — create the worktree before spawning/dispatching there (see wheelhouse/fleet/WORKER.md)`);
  }
  return cwd;
}

function processCwd(pid: number): string | null {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      const out = execFileSync(lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const line = out.split("\n").find((l) => l.startsWith("n"));
      if (line) return path.resolve(line.slice(1));
    } catch {}
  }
  try {
    const procCwd = `/proc/${pid}/cwd`;
    if (fs.existsSync(procCwd)) return path.resolve(fs.realpathSync(procCwd));
  } catch {}
  return null;
}

function logFilterShell(): string {
  const script = `const readline=require('readline'); const limit=Number(process.env.WHEELHOUSE_LOG_EVENT_STRING_BYTES||65536); function trim(v){ if(typeof v==='string' && Buffer.byteLength(v)>limit){ const b=Buffer.from(v); return b.subarray(0,limit).toString('utf8')+'\\n[wheelhouse log truncated '+(b.length-limit)+' bytes; full output remains in the pi session file]'; } if(Array.isArray(v)) return v.map(trim); if(v&&typeof v==='object'){ for(const k of Object.keys(v)) v[k]=trim(v[k]); } return v;} const rl=readline.createInterface({input:process.stdin}); rl.on('line',l=>{try{const o=JSON.parse(l); if(o.type==='tool_execution_update'){const before=Buffer.byteLength(l); const t=trim(o); const after=Buffer.byteLength(JSON.stringify(t)); if(after<before) t.wheelhouse_truncated_bytes=before-after; process.stdout.write(JSON.stringify(t)+'\\n');} else process.stdout.write(l+'\\n');}catch{process.stdout.write(l+'\\n')}});`;
  return `'${process.execPath.replace(/'/g, `'\\''`)}' -e '${script.replace(/'/g, `'\\''`)}'`;
}

async function piLaunch(name: string, entry: SeatEntry, sessionFile: string | null, cwd: string, retriedFresh = false): Promise<void> {
  requireCwdDir(cwd);
  const labelSuffix = accountLabelSuffix(entry);
  const state = readState();
  const existing = state.seats[name];
  if (existing && pidAlive(existing.pid, existing.fifo)) {
    die(`seat "${name}" is already running (pid ${existing.pid}) — stop it first`);
  }

  const accountDir = expandTilde(entry.account!.dir);
  if (!fs.existsSync(accountDir)) {
    die(
      `seat directory does not exist for seat "${name}"${labelSuffix}: ${accountDir}\n` +
        `      provision it first: seats/seat-env.sh <namespace> ${name} "${ROOT}"`
    );
  }
  const authFile = path.join(accountDir, "auth.json");
  requireLaunchCredential(name, entry, accountDir, authFile, labelSuffix);

  const brief = roleBriefPath(entry.role);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fifo = path.join(RUN_DIR, `${name}.stdin`);
  const log = path.join(LOG_DIR, `${name}.jsonl`);
  const errLog = path.join(LOG_DIR, `${name}.stderr.log`);

  if (fs.existsSync(fifo)) {
    if (!fs.statSync(fifo).isFIFO()) die(`${fifo} exists and is not a FIFO — refusing to guess what it is`);
  } else {
    execFileSync("mkfifo", [fifo]);
  }

  const args = ["--mode", "rpc", "--append-system-prompt", brief];
  if (entry.provider) args.push("--provider", entry.provider);
  if (entry.model) args.push("--model", entry.model);
  args.push(...skillArgs(name, entry));
  if (sessionFile) {
    args.push("--session", sessionFile); // resume-attach
  }

  // bash's `0<>` opens the FIFO read-write, so pi's stdin never sees EOF when
  // a writer closes; stdout appends to the log by redirection, so no pipe
  // ties pi's lifetime to ours. `exec` makes the child's pid pi's pid.
  const shellCmd =
    `exec pi ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")} ` +
    `0<> '${fifo}' > >(${logFilterShell()} >> '${log}') 2>> '${errLog}'`;
  const child = spawn("bash", ["-c", shellCmd], {
    cwd,
    env: { ...process.env, PATH: hostBudgetPath(ROOT), PI_CODING_AGENT_DIR: accountDir, BEADS_ACTOR: beadsActorFor(name) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid!;

  // Ask the seat who it is. This doubles as the readiness gate: pi answers
  // get_state only once its session exists, and the answer carries the
  // session file resume will need.
  const probe = { fifo, log, pid };
  let st: any;
  try {
    st = await rpc(probe, { type: "get_state" });
  } catch (e: any) {
    const cleanup = await terminateSpawnedOnly(pid);
    recordLaunchFailure(name, existing, `${e.message}; launch-only cleanup: ${cleanup}`);
    die(`spawned pid ${pid} for seat "${name}"${labelSuffix} but ${e.message}. launch-only cleanup: ${cleanup}. stderr tail:\n${stderrTail(probe)}`);
  }
  if (!st.success) {
    const cleanup = await terminateSpawnedOnly(pid);
    recordLaunchFailure(name, existing, `get_state failed on fresh seat: ${st.error}; launch-only cleanup: ${cleanup}`);
    die(`get_state failed on fresh seat "${name}"${labelSuffix}: ${st.error}. launch-only cleanup: ${cleanup}. stderr tail:\n${stderrTail(probe)}`);
  }

  const requestedCwd = path.resolve(cwd);
  const liveCwd = processCwd(pid);
  if (liveCwd && liveCwd !== requestedCwd) {
    const cleanup = await terminateSpawnedOnly(pid);
    if (sessionFile && !retriedFresh) {
      console.log(
        `seat ${name}: recorded session could not move cwd from ${liveCwd} to ${requestedCwd}; ${cleanup}; ` +
          `starting a fresh session in the requested cwd`
      );
      await piLaunch(name, entry, null, cwd, true);
      return;
    }
    die(`spawned pid ${pid} for seat "${name}"${labelSuffix} has live cwd ${liveCwd}, not requested cwd ${requestedCwd}. launch-only cleanup: ${cleanup}`);
  }

  state.seats[name] = {
    pid,
    startedAt: new Date().toISOString(),
    accountDir,
    ...(accountLabel(entry) ? { accountLabel: accountLabel(entry) } : {}),
    role: entry.role,
    roleBrief: brief,
    cwd: liveCwd ?? requestedCwd,
    fifo,
    log,
    sessionId: st.data?.sessionId ?? null,
    sessionFile: st.data?.sessionFile ?? null,
    model: entry.model,
    ...(existing?.lastBead ? { lastBead: existing.lastBead } : {}),
  };
  writeState(state); // spawn-record
  console.log(`seat ${name}${labelSuffix}: pid ${pid}, session ${state.seats[name].sessionId}`);
  console.log(`  events -> ${log}`);
}

const PI_DRIVER: SeatDriver = {
  name: "pi",
  launch: piLaunch,
  probe: piProbe,
  getState: (rec) => rpc(rec, { type: "get_state" }),
  prompt: (rec, message, streamingBehavior, timeoutMs = PROMPT_ACK_MS) => rpc(rec, promptCommand(message, streamingBehavior), timeoutMs),
  steer: (rec, text) => rpc(rec, { type: "steer", message: text }),
  stop: stopRecord,
};


function scrubbedSeatEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function isClaudeDefaultAuth(entry: SeatEntry): boolean {
  return entry.account?.authRoute === "default";
}

function claudeAccountDir(entry: SeatEntry): string {
  if (isClaudeDefaultAuth(entry)) return process.env.HOME ?? ROOT;
  return expandTilde(entry.account!.dir);
}

function requireClaudeCredential(name: string, entry: SeatEntry, accountDir: string, labelSuffix: string): void {
  if (isClaudeDefaultAuth(entry)) return;
  const config = path.join(accountDir, ".claude.json");
  if (!fs.existsSync(config) || fs.statSync(config).size === 0) {
    die(
      `seat "${name}"${labelSuffix} has no Claude Code identity in ${accountDir}.\n` +
        `      OAuth: CLAUDE_CONFIG_DIR="${accountDir}" claude auth login --claudeai`
    );
  }
}

function claudeChildEnv(entry: SeatEntry, accountDir: string, name: string): NodeJS.ProcessEnv {
  return scrubbedSeatEnv({
    PATH: hostBudgetPath(ROOT),
    CLAUDE_CONFIG_DIR: isClaudeDefaultAuth(entry) ? undefined : accountDir,
    BEADS_ACTOR: beadsActorFor(name),
  });
}

async function claudeLaunch(name: string, entry: SeatEntry, sessionFile: string | null, cwd: string): Promise<void> {
  requireCwdDir(cwd);
  const labelSuffix = accountLabelSuffix(entry);
  const state = readState();
  const existing = state.seats[name];
  if (existing && pidAlive(existing.pid, existing.fifo)) die(`seat "${name}" is already running (pid ${existing.pid}) — stop it first`);

  const accountDir = claudeAccountDir(entry);
  if (!isClaudeDefaultAuth(entry) && !fs.existsSync(accountDir)) {
    die(`seat directory does not exist for seat "${name}"${labelSuffix}: ${accountDir}\n      provision it first: seats/seat-env.sh <namespace> ${name} "${ROOT}"`);
  }
  requireClaudeCredential(name, entry, accountDir, labelSuffix);
  if (!entry.model) die(`seat "${name}"${labelSuffix} has no model pin in seats/seats.json — claude-code launch must pin the exact model`);
  if (!entry.allowedTools) die(`seat "${name}"${labelSuffix} has no allowedTools list in seats/seats.json — claude-code acceptEdits mode must name the tools it may use`);

  const brief = roleBriefPath(entry.role);
  const roleBriefHash = crypto.createHash("sha256").update(fs.readFileSync(brief)).digest("hex");
  if (sessionFile && existing?.roleBriefHash && existing.roleBriefHash !== roleBriefHash) {
    die(`seat "${name}" brief changed; reset instead of resume (recorded ${existing.roleBriefHash.slice(0, 12)}, current ${roleBriefHash.slice(0, 12)})`);
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fifo = path.join(RUN_DIR, `${name}.stdin`);
  const log = path.join(LOG_DIR, `${name}.jsonl`);
  const rawLog = path.join(LOG_DIR, `${name}.raw.jsonl`);
  const errLog = path.join(LOG_DIR, `${name}.stderr.log`);
  if (fs.existsSync(fifo)) {
    if (!fs.statSync(fifo).isFIFO()) die(`${fifo} exists and is not a FIFO — refusing to guess what it is`);
  } else {
    execFileSync("mkfifo", [fifo]);
  }

  const args = [
    path.join(SEATS_DIR, "drivers", "claude-code", "shim.ts"),
    "--log", log,
    "--raw-log", rawLog,
    "--err-log", errLog,
    "--account-dir", accountDir,
    "--brief", brief,
    "--model", entry.model,
    "--cwd", cwd,
    "--actor", beadsActorFor(name),
    "--permission-mode", "acceptEdits",
    "--allowed-tools", entry.allowedTools,
  ];
  if (isClaudeDefaultAuth(entry)) args.push("--default-login");
  if (sessionFile) args.push("--resume", sessionFile);
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const shellCmd = `exec ${q(process.execPath)} ${args.map(q).join(" ")} 0<> ${q(fifo)} 2>> ${q(errLog)}`;
  const child = spawn("bash", ["-c", shellCmd], { cwd, env: claudeChildEnv(entry, accountDir, name), detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;

  const probe = { fifo, log, pid };
  let st: any;
  try {
    st = await rpc(probe, { type: "get_state" });
  } catch (e: any) {
    const cleanup = await terminateSpawnedOnly(pid);
    recordLaunchFailure(name, existing, `${e.message}; launch-only cleanup: ${cleanup}`);
    die(`spawned pid ${pid} for seat "${name}"${labelSuffix} but ${e.message}. launch-only cleanup: ${cleanup}. stderr tail:\n${stderrTail(probe)}`);
  }
  if (!st.success) {
    const cleanup = await terminateSpawnedOnly(pid);
    recordLaunchFailure(name, existing, `get_state failed on fresh seat: ${st.error}; launch-only cleanup: ${cleanup}`);
    die(`get_state failed on fresh seat "${name}"${labelSuffix}: ${st.error}. launch-only cleanup: ${cleanup}. stderr tail:\n${stderrTail(probe)}`);
  }

  const requestedCwd = path.resolve(cwd);
  const liveCwd = processCwd(pid);
  state.seats[name] = {
    pid,
    startedAt: new Date().toISOString(),
    accountDir,
    ...(accountLabel(entry) ? { accountLabel: accountLabel(entry) } : {}),
    role: entry.role,
    roleBrief: brief,
    roleBriefHash,
    cwd: liveCwd ?? requestedCwd,
    fifo,
    log,
    sessionId: st.data?.sessionId ?? null,
    sessionFile: st.data?.sessionFile ?? null,
    model: st.data?.model ?? entry.model,
    ...(existing?.lastBead ? { lastBead: existing.lastBead } : {}),
  };
  writeState(state);
  console.log(`seat ${name}${labelSuffix}: pid ${pid}, session ${state.seats[name].sessionId}`);
  console.log(`  events -> ${log}`);
}

function claudeProbe(name: string, entry: SeatEntry): void {
  const labelSuffix = accountLabelSuffix(entry);
  const accountDir = claudeAccountDir(entry);
  if (!isClaudeDefaultAuth(entry) && !fs.existsSync(accountDir)) die(`seat directory does not exist for seat "${name}"${labelSuffix}: ${accountDir}`);
  requireClaudeCredential(name, entry, accountDir, labelSuffix);
  if (!entry.model) die(`seat "${name}"${labelSuffix} has no model pin in seats/seats.json — probe must test the exact roster model`);
  const args = ["-p", "--output-format", "json", "--model", entry.model, "--setting-sources", "project", "Reply with exactly the word OK. Use no tools."];
  const result = spawnSync("claude", args, { cwd: ROOT, env: claudeChildEnv(entry, accountDir, name), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) die(`probe failed to start claude for seat "${name}"${labelSuffix}: ${result.error.message}`);
  let parsed: any = null;
  try { parsed = JSON.parse(result.stdout.trim()); } catch {}
  if (result.status === 0 && parsed?.subtype === "success" && String(parsed?.result ?? "").trim() === "OK") { console.log("OK"); return; }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const CLAUDE_DRIVER: SeatDriver = {
  name: "claude-code",
  launch: claudeLaunch,
  probe: claudeProbe,
  getState: (rec) => rpc(rec, { type: "get_state" }),
  prompt: (rec, message, streamingBehavior, timeoutMs = PROMPT_ACK_MS) => rpc(rec, promptCommand(message, streamingBehavior), timeoutMs),
  steer: (rec, text) => rpc(rec, { type: "steer", message: text }),
  stop: stopRecord,
};

function isCodexDefaultAuth(entry: SeatEntry): boolean { return entry.account?.authRoute === "default"; }
function codexAccountDir(entry: SeatEntry): string { return isCodexDefaultAuth(entry) ? (process.env.HOME ?? ROOT) : expandTilde(entry.account!.dir); }
function requireCodexCredential(name: string, entry: SeatEntry, accountDir: string, labelSuffix: string): void {
  if (isCodexDefaultAuth(entry) || entry.account?.authRoute === "api_key" || entry.account?.authRoute === "env") return;
  if (!fs.existsSync(path.join(accountDir, "auth.json"))) die(`seat "${name}"${labelSuffix} has no Codex identity in ${accountDir}.\n      OAuth: CODEX_HOME="${accountDir}" codex login`);
}
function codexChildEnv(entry: SeatEntry, accountDir: string, name: string): NodeJS.ProcessEnv {
  return scrubbedSeatEnv({ PATH: hostBudgetPath(ROOT), CODEX_HOME: isCodexDefaultAuth(entry) ? undefined : accountDir, BEADS_ACTOR: beadsActorFor(name) });
}
async function codexLaunch(name: string, entry: SeatEntry, sessionFile: string | null, cwd: string): Promise<void> {
  requireCwdDir(cwd);
  const labelSuffix = accountLabelSuffix(entry);
  const state = readState(); const existing = state.seats[name];
  if (existing && pidAlive(existing.pid, existing.fifo)) die(`seat "${name}" is already running (pid ${existing.pid}) — stop it first`);
  const accountDir = codexAccountDir(entry);
  if (!isCodexDefaultAuth(entry) && !fs.existsSync(accountDir)) die(`seat directory does not exist for seat "${name}"${labelSuffix}: ${accountDir}\n      provision it first: seats/seat-env.sh <namespace> ${name} "${ROOT}"`);
  requireCodexCredential(name, entry, accountDir, labelSuffix);
  if (!entry.model) die(`seat "${name}"${labelSuffix} has no model pin in seats/seats.json — codex launch must pin the exact model`);
  const brief = roleBriefPath(entry.role); const roleBriefHash = crypto.createHash("sha256").update(fs.readFileSync(brief)).digest("hex");
  if (sessionFile && existing?.roleBriefHash && existing.roleBriefHash !== roleBriefHash) die(`seat "${name}" brief changed; reset instead of resume (recorded ${existing.roleBriefHash.slice(0, 12)}, current ${roleBriefHash.slice(0, 12)})`);
  fs.mkdirSync(RUN_DIR, { recursive: true }); fs.mkdirSync(LOG_DIR, { recursive: true });
  const fifo = path.join(RUN_DIR, `${name}.stdin`), log = path.join(LOG_DIR, `${name}.jsonl`), rawLog = path.join(LOG_DIR, `${name}.raw.jsonl`), errLog = path.join(LOG_DIR, `${name}.stderr.log`);
  if (fs.existsSync(fifo)) { if (!fs.statSync(fifo).isFIFO()) die(`${fifo} exists and is not a FIFO — refusing to guess what it is`); } else execFileSync("mkfifo", [fifo]);
  const args = [path.join(SEATS_DIR, "drivers", "codex", "shim.ts"), "--log", log, "--raw-log", rawLog, "--err-log", errLog, "--account-dir", accountDir, "--brief", brief, "--model", entry.model, "--cwd", cwd, "--actor", beadsActorFor(name)];
  if (isCodexDefaultAuth(entry)) args.push("--default-login");
  if (sessionFile) { const base = path.basename(sessionFile, ".jsonl"); const m = base.match(/^rollout--(.+)$/); args.push("--resume", existing?.sessionId ?? m?.[1] ?? base); }
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const shellCmd = `exec ${q(process.execPath)} ${args.map(q).join(" ")} 0<> ${q(fifo)} 2>> ${q(errLog)}`;
  const child = spawn("bash", ["-c", shellCmd], { cwd, env: codexChildEnv(entry, accountDir, name), detached: true, stdio: "ignore" }); child.unref();
  const pid = child.pid!, probe = { fifo, log, pid }; let st: any;
  try { st = await rpc(probe, { type: "get_state" }); } catch (e: any) { const cleanup = await terminateSpawnedOnly(pid); recordLaunchFailure(name, existing, `${e.message}; launch-only cleanup: ${cleanup}`); die(`spawned pid ${pid} for seat "${name}"${labelSuffix} but ${e.message}. launch-only cleanup: ${cleanup}. stderr tail:\n${stderrTail(probe)}`); }
  if (!st.success) { const cleanup = await terminateSpawnedOnly(pid); recordLaunchFailure(name, existing, `get_state failed on fresh seat: ${st.error}; launch-only cleanup: ${cleanup}`); die(`get_state failed on fresh seat "${name}"${labelSuffix}: ${st.error}. launch-only cleanup: ${cleanup}. stderr tail:\n${stderrTail(probe)}`); }
  const requestedCwd = path.resolve(cwd), liveCwd = processCwd(pid);
  state.seats[name] = { pid, startedAt: new Date().toISOString(), accountDir, ...(accountLabel(entry) ? { accountLabel: accountLabel(entry) } : {}), role: entry.role, roleBrief: brief, roleBriefHash, cwd: liveCwd ?? requestedCwd, fifo, log, sessionId: st.data?.sessionId ?? null, sessionFile: st.data?.sessionFile ?? null, model: st.data?.model ?? entry.model, ...(existing?.lastBead ? { lastBead: existing.lastBead } : {}) };
  writeState(state); console.log(`seat ${name}${labelSuffix}: pid ${pid}, session ${state.seats[name].sessionId}`); console.log(`  events -> ${log}`);
}
function codexProbe(name: string, entry: SeatEntry): void {
  const labelSuffix = accountLabelSuffix(entry); const accountDir = codexAccountDir(entry);
  requireCodexCredential(name, entry, accountDir, labelSuffix);
  if (!isCodexDefaultAuth(entry)) {
    const login = spawnSync("codex", ["login", "status"], { cwd: ROOT, env: codexChildEnv(entry, accountDir, name), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (login.status !== 0) {
      if (login.stdout) process.stdout.write(login.stdout); if (login.stderr) process.stderr.write(login.stderr);
      process.exit(login.status ?? 1);
    }
  }
  if (!entry.model) die(`seat "${name}"${labelSuffix} has no model pin in seats/seats.json — probe must test the exact roster model`);
  const result = spawnSync("codex", ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-c", "approval_policy=never", "-m", entry.model, "Reply with exactly the word OK. Use no tools."], { cwd: ROOT, env: codexChildEnv(entry, accountDir, name), input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  let ok = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const item = ev?.item ?? ev?.params?.item;
      const text = typeof item?.text === "string" ? item.text : Array.isArray(item?.content) ? item.content.map((c: any) => c.text ?? "").join("") : item?.message;
      if ((ev.type === "item.completed" || ev.method === "item/completed") && item?.type === "agent_message" && String(text ?? "").trim() === "OK") ok = true;
      if ((ev.type === "item.completed" || ev.method === "item/completed") && item?.type === "agentMessage" && String(text ?? "").trim() === "OK") ok = true;
    } catch {}
  }
  if (result.status === 0 && ok) { console.log("OK"); return; }
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
const CODEX_DRIVER: SeatDriver = { name: "codex", launch: codexLaunch, probe: codexProbe, getState: (rec) => rpc(rec, { type: "get_state" }), prompt: (rec, message, streamingBehavior, timeoutMs = PROMPT_ACK_MS) => rpc(rec, promptCommand(message, streamingBehavior), timeoutMs), steer: (rec, text) => rpc(rec, { type: "steer", message: text }), stop: stopRecord };

function driverForSeat(name: string, entry: SeatEntry, operation: string): SeatDriver {
  const harness = harnessNameForSeat(name, entry);
  if (harness === "pi") return PI_DRIVER;
  if (harness === "claude-code") return CLAUDE_DRIVER;
  if (harness === "codex") return CODEX_DRIVER;
  requirePiHarness(name, entry, operation);
  return PI_DRIVER;
}
async function cmdSpawn(name: string, beadId?: string): Promise<void> {
  const entry = requireSeat(name);
  await driverForSeat(name, entry, "adapter spawn").launch(name, entry, null, beadId ? beadWorktreeDir(beadId) : ROOT);
}

function piProbe(name: string, entry: SeatEntry): void {
  const labelSuffix = accountLabelSuffix(entry);
  const accountDir = expandTilde(entry.account!.dir);
  if (!fs.existsSync(accountDir)) {
    die(`seat directory does not exist for seat "${name}"${labelSuffix}: ${accountDir}\n` +
      `      provision it first: seats/seat-env.sh <namespace> ${name} "${ROOT}"`);
  }
  if (!entry.provider || !entry.model) {
    die(`seat "${name}"${labelSuffix} has no provider/model pin in seats/seats.json — probe must test the exact roster pair`);
  }
  requireLaunchCredential(name, entry, accountDir, path.join(accountDir, "auth.json"), labelSuffix);
  const args = [
    "-p",
    "--no-session",
    "--provider", entry.provider,
    "--model", entry.model,
    "Reply with exactly the word OK. Use no tools.",
  ];
  const result = spawnSync("pi", args, {
    cwd: ROOT,
    env: { ...process.env, PATH: hostBudgetPath(ROOT), PI_CODING_AGENT_DIR: accountDir, BEADS_ACTOR: beadsActorFor(name) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) die(`probe failed to start pi for seat "${name}"${labelSuffix}: ${result.error.message}`);
  if (result.status === 0) {
    console.log("OK");
    return;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

function cmdProbe(name: string): void {
  const entry = requireSeat(name);
  return driverForSeat(name, entry, "adapter probe").probe(name, entry);
}

async function cmdResume(name: string): Promise<void> {
  const rec = readState().seats[name];
  if (!rec) die(`no record of seat "${name}" in seats/state.json — spawn it instead`);
  if (pidAlive(rec.pid, rec.fifo)) die(`seat "${name}" is already running (pid ${rec.pid})`);
  if (!rec.sessionFile) die(`seat "${name}" has no recorded session file — spawn it instead`);
  if (!fs.existsSync(rec.sessionFile)) {
    die(`recorded session file is gone: ${rec.sessionFile} — spawn a fresh seat instead`);
  }
  // Resuming keeps the seat where it was working, not the project root: the
  // cwd it was launched into last time, falling back to ROOT only for a
  // state.json record from before this field existed. If that cwd was pruned,
  // resume uses the same fresh-session mechanics as dispatch: prefer the
  // current bead's worktree when it still exists, else recover at ROOT.
  const resumeCwd = rec.cwd ?? ROOT;
  if (!fs.existsSync(resumeCwd) || !fs.statSync(resumeCwd).isDirectory()) {
    const beadCwd = rec.lastBead ? beadWorktreeDir(rec.lastBead) : "";
    const fallbackCwd = beadCwd && fs.existsSync(beadCwd) && fs.statSync(beadCwd).isDirectory() ? beadCwd : ROOT;
    console.log(
      `seat ${name}: recorded seat cwd is gone: ${resumeCwd}; ` +
        `session continuity intentionally dropped; resuming fresh in ${fallbackCwd}`
    );
    const entry = requireSeat(name);
    await driverForSeat(name, entry, "adapter resume").launch(name, entry, null, fallbackCwd);
    return;
  }
  const entry = requireSeat(name);
  const wasMidTool = logHasUnfinishedToolCall(rec.log);
  await driverForSeat(name, entry, "adapter resume").launch(name, entry, rec.sessionFile, resumeCwd);
  if (wasMidTool) markSeatStalledAfterResume(name, rec.lastBead);
}

/**
 * reset = stop, discard the session, spawn cold. It exists for a context
 * that has stopped earning its keep — the initiative it was serving closed,
 * or the cache itself has gone stale — and it is deliberately NOT `stop` +
 * `spawn` by hand: a bare `spawn` right after `stop` would attach nothing,
 * but a bare `resume` would reattach the exact context reset means to drop,
 * so this is the one path that stops, forgets, and comes back cold as a
 * single command instead of a ritual two operators could get wrong two ways.
 *
 * Refuses loudly if the seat is mid-turn — the same rule stop's SIGTERM
 * documentation already states (Lifecycle: never stop a seat mid-turn, a
 * SIGTERM lands mid-turn and takes the running tool's whole process tree
 * with it) — checked with get_state's isStreaming, the protocol's own
 * busy signal, not a guess from the log.
 */
async function cmdReset(name: string): Promise<void> {
  const stateBefore = readState();
  const rec = stateBefore.seats[name];
  if (!rec) die(`no record of seat "${name}" — spawn it first`);
  const entry = requireSeat(name);
  if (pidAlive(rec.pid, rec.fifo)) {
    const st = await rpc(rec, { type: "get_state" });
    if (!st.success) {
      die(`get_state failed while checking seat "${name}" before reset: ${st.error}. stderr tail:\n${stderrTail(rec)}`);
    }
    if (st.data?.isStreaming) {
      die(
        `seat "${name}" is mid-turn (isStreaming) — reset refuses to interrupt a running turn. ` +
          `Wait for it to finish, or steer it, before resetting.`
      );
    }
    await cmdStop(name);
  }
  const cwd = rec.cwd ?? ROOT;
  // Discard the recorded session explicitly, ahead of the cold spawn below
  // that would overwrite it anyway: if reset dies between stop and spawn,
  // state.json must already show no session to resume into, not the stale
  // one reset was meant to drop. This also supports the documented upgrade
  // path where an operator stops an idle seat before changing its harness.
  const state = readState();
  if (state.seats[name]) {
    state.seats[name].sessionId = null;
    state.seats[name].sessionFile = null;
    state.seats[name].pid = null;
    writeState(state); // reset-record
  }
  await driverForSeat(name, entry, "adapter reset").launch(name, entry, null, cwd); // null sessionFile: cold, no --session
  console.log(`seat ${name}: reset — session discarded, respawned cold`);
}

function requireRunning(name: string): SeatRecord {
  const rec = readState().seats[name];
  if (!rec) die(`no record of seat "${name}" — spawn it first`);
  if (!pidAlive(rec.pid, rec.fifo)) die(`seat "${name}" is not running — resume or spawn it first`);
  return rec;
}

async function cmdDispatch(name: string, beadId: string, text: string): Promise<void> {
  let rec = requireRunning(name);
  const sameCwdDriver = driverForRunningSeat(name, "adapter dispatch");
  const targetCwd = beadWorktreeDir(beadId);
  if (rec.cwd !== targetCwd) {
    // Construction, not prompt discipline: a seat handed a DIFFERENT bead
    // than the one it is sitting in gets stopped and relaunched attached to
    // its own session, but rooted in the new bead's worktree, before the
    // prompt goes anywhere near it. Checked BEFORE stopping anything — a
    // missing worktree must refuse loudly with the seat left exactly as it
    // was, not stopped on the way to discovering the target doesn't exist.
    requireCwdDir(targetCwd);
    const st = await sameCwdDriver.getState(rec);
    if (!st.success) {
      die(`get_state failed while checking seat "${name}" before cross-bead dispatch: ${st.error}. stderr tail:\n${stderrTail(rec)}`);
    }
    const inFlight = rec.lastBead ?? "unknown bead";
    const force = process.env.WHEELHOUSE_DISPATCH_FORCE === "1";
    if (st.data?.isStreaming && !force) {
      die(
        `seat "${name}" is mid-turn on ${inFlight}; refusing cross-bead dispatch to ${beadId}. ` +
          `Wait for settle agent_end/isStreaming=false before dispatching another bead, or set WHEELHOUSE_DISPATCH_FORCE=1 to abandon the running turn.`
      );
    }
    if (st.data?.isStreaming && force) {
      console.log(
        `seat ${name}: WHEELHOUSE_DISPATCH_FORCE=1 — deliberately abandoning mid-turn bead ${inFlight}; ` +
          `old stop-and-relaunch escape will dispatch ${beadId}`
      );
    }
    const recordedCwd = rec.cwd ?? ROOT;
    const recordedCwdExists = fs.existsSync(recordedCwd) && fs.statSync(recordedCwd).isDirectory();
    await cmdStop(name);
    if (recordedCwdExists) {
      const entry = requireSeat(name);
      const driver = driverForSeat(name, entry, "adapter dispatch");
      const resumeFile = driver.name === "codex" ? (rec.sessionFile && fs.existsSync(rec.sessionFile) ? rec.sessionFile : null) : rec.sessionFile;
      if (driver.name === "codex" && rec.sessionFile && !resumeFile) console.log(`seat ${name}: recorded session file is gone or not yet written; session continuity intentionally dropped; starting fresh in ${targetCwd}`);
      await driver.launch(name, entry, resumeFile, targetCwd);
    } else {
      console.log(
        `seat ${name}: session continuity intentionally dropped because recorded cwd is gone: ${recordedCwd}; ` +
          `falling back to fresh spawn in dispatch target ${targetCwd}`
      );
      const entry = requireSeat(name);
      await driverForSeat(name, entry, "adapter dispatch").launch(name, entry, null, targetCwd);
    }
    rec = requireRunning(name);
  }
  // followUp: a new bead queues behind the current turn instead of erroring
  // if the seat is mid-stream. Mid-turn redirection is what steer is for.
  const promptText = `Bead ${beadId}\n\n${text}`;
  const state = readState();
  state.seats[name].lastBead = beadId;
  state.seats[name].lastDispatchAt = new Date().toISOString();
  state.seats[name].lastPrompt = promptText;
  delete state.seats[name].lastCapacityEvent; // a dispatch attempt to a new bead is the current seat fact
  delete state.seats[name].lastStalledEvent; // a new dispatch supersedes a prior resumed-cutoff stall
  writeState(state);
  let resp: any;
  try {
    resp = await sameCwdDriver.prompt(rec, promptText, "followUp", PROMPT_ACK_MS);
  } catch (e: any) {
    if (e?.code === "WHEELHOUSE_RPC_TIMEOUT" && promptDeliveredAfter(rec, Number(e.logOffset ?? 0), promptText)) {
      console.log(`WARNING: prompt delivered, ack late for ${beadId} to ${name}; watch ${rec.log}`);
      return;
    }
    die(`dispatch prompt failed for seat "${name}"${accountLabelSuffix(undefined, rec)}: ${e.message}. stderr tail:\n${stderrTail(rec)}`);
  }
  if (!resp.success) {
    // A failure that looks like an account limit is a CAPACITY fact worth
    // keeping: stamp it so `status` and the floor can surface it after this
    // process is gone. Anything else stays a plain failure.
    const blob = `${resp.error ?? ""}\n${stderrTail(rec)}`;
    if (QUOTA_RE.test(blob)) {
      const state = readState();
      const label = accountLabel(undefined, rec);
      state.seats[name].lastCapacityEvent = {
        at: new Date().toISOString(),
        detail: label ? `${String(resp.error ?? "quota-shaped stderr")} (account ${label})` : String(resp.error ?? "quota-shaped stderr"),
        ...(label ? { accountLabel: label } : {}),
      }; // capacity-record
      writeState(state);
    }
    die(`dispatch failed for seat "${name}"${accountLabelSuffix(undefined, rec)}: ${resp.error}. stderr tail:\n${stderrTail(rec)}`);
  }
  const landedState = readState();
  if (resp.data?.sessionId) landedState.seats[name].sessionId = resp.data.sessionId;
  if (resp.data?.sessionFile) landedState.seats[name].sessionFile = resp.data.sessionFile;
  if (resp.data?.model) landedState.seats[name].model = resp.data.model;
  landedState.seats[name].lastBead = beadId;
  landedState.seats[name].lastDispatchAt = new Date().toISOString();
  landedState.seats[name].lastPrompt = promptText;
  delete landedState.seats[name].lastCapacityEvent; // a dispatch that lands clears it
  delete landedState.seats[name].lastStalledEvent; // a dispatch that lands clears it
  writeState(landedState);
  console.log(`dispatched ${beadId} to ${name}; watch ${rec.log}`);
}

async function cmdSteer(name: string, text: string): Promise<void> {
  const rec = requireRunning(name);
  const driver = driverForRunningSeat(name, "adapter steer");
  let st: any;
  try {
    st = await driver.getState(rec);
  } catch (e: any) {
    if (!String(e.message || e).includes("timed out")) die(`steer preflight get_state failed: ${e.message}. stderr tail:\n${stderrTail(rec)}`);
    await fifoWrite(rec.fifo, promptCommand(text, "steer"));
    console.log(`queued steer for ${name}: preflight get_state timed out; wrote prompt with streamingBehavior=steer`);
    return;
  }
  if (!st.success) die(`steer preflight get_state failed: ${st.error}. stderr tail:\n${stderrTail(rec)}`);
  if (st.data?.isStreaming) {
    const resp = await driver.steer(rec, text);
    if (!resp.success) die(`steer failed: ${resp.error}`);
    console.log(`steered ${name} mid-turn`);
    return;
  }
  const resp = await driver.prompt(rec, text, "steer");
  if (!resp.success) die(`steer prompt failed: ${resp.error}`);
  console.log(`steered ${name} idle-started`);
}

interface ProcessRow { pid: number; ppid: number; startMs: number | null; command: string }
type OpenPathSnapshot = Map<number, string[]>;

function processRows(): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  try {
    const out = spawnSync("ps", ["axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout || "";
    for (const line of out.split(/\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/);
      if (!m) continue;
      const start = Date.parse(m[3]);
      rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), startMs: Number.isFinite(start) ? start : null, command: m[4] || "" });
    }
  } catch { /* ps should exist; absence only removes an extra status hint */ }
  return rows;
}

function isDescendantOf(pid: number, ancestor: number | null | undefined, rows: Map<number, ProcessRow>): boolean {
  if (!ancestor || pid === ancestor) return false;
  const seen = new Set<number>();
  let cur = rows.get(pid)?.ppid;
  while (cur && cur > 0 && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = rows.get(cur)?.ppid;
  }
  return false;
}

function processOpenPaths(): OpenPathSnapshot | null {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    const r = spawnSync(lsof, ["-Fn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (r.error) {
      if ((r.error as any).code === "ENOENT") continue;
      return null;
    }
    const out: OpenPathSnapshot = new Map();
    let pid: number | null = null;
    for (const line of (r.stdout || "").split(/\n/)) {
      if (line.startsWith("p")) {
        const n = Number(line.slice(1));
        pid = Number.isFinite(n) && n > 0 ? n : null;
        if (pid !== null && !out.has(pid)) out.set(pid, []);
      } else if (pid !== null && line.startsWith("n")) {
        out.get(pid)!.push(line.slice(1));
      }
    }
    return out;
  }
  return null;
}

function pathsMatch(openPaths: string[] | undefined, p: string | undefined): boolean {
  if (!p || !openPaths) return false;
  const wanted = new Set([p]);
  try { wanted.add(fs.realpathSync(p)); } catch {}
  return openPaths.some((n) => wanted.has(n));
}

function pidAliveFromSnapshot(pid: number | null, fifo: string | undefined, open: OpenPathSnapshot | null): boolean {
  if (!barePidAlive(pid)) return false;
  if (!fifo || open === null) return true;
  return pathsMatch(open.get(pid!), fifo);
}

function fifoHolderPids(fifo: string | undefined, open: OpenPathSnapshot | null): Set<number> {
  const out = new Set<number>();
  if (!fifo || !fs.existsSync(fifo) || open === null) return out;
  for (const [pid, paths] of open) if (pathsMatch(paths, fifo)) out.add(pid);
  return out;
}

function orphanCandidatesFor(name: string, rec: SeatRecord, rows: Map<number, ProcessRow>): Map<number, string> {
  const seen = new Map<number, string>();
  function add(pid: number, reason: string) {
    if (!Number.isFinite(pid) || pid <= 0 || pid === rec.pid || !barePidAlive(pid)) return;
    if (isDescendantOf(pid, rec.pid, rows)) return;
    const prev = seen.get(pid);
    seen.set(pid, prev ? `${prev},${reason}` : reason);
  }
  const needles = [rec.accountDir, rec.cwd].filter((s): s is string => Boolean(s));
  if (needles.length) {
    for (const row of rows.values()) {
      const cmd = row.command;
      const looksLikePiSeat = /(^|[ /])pi( |$)/.test(cmd) && cmd.includes("--mode rpc");
      const looksLikeClaudeSeat = cmd.includes("drivers/claude-code/shim.ts") && cmd.includes("--account-dir") && cmd.includes("--cwd");
      if (!looksLikePiSeat && !looksLikeClaudeSeat) continue;
      if (needles.some((n) => cmd.includes(n))) add(row.pid, "argv/cwd/account match");
    }
  }
  return seen;
}

function orphanMatchesFor(name: string, rec: SeatRecord, rows: Map<number, ProcessRow>): { pid: number; reason: string }[] {
  const first = orphanCandidatesFor(name, rec, rows);
  if (first.size === 0) return [];
  if (ORPHAN_CONFIRM_MS > 0) sleepMs(ORPHAN_CONFIRM_MS);
  const confirmed: { pid: number; reason: string }[] = [];
  for (const [pid, reason] of first) {
    if (barePidAlive(pid)) confirmed.push({ pid, reason });
  }
  return confirmed.sort((a, b) => a.pid - b.pid);
}

function lastEvent(log: string): string {
  try {
    const r = logLinesFrom(log, 0);
    for (let i = r.lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(r.lines[i]);
        if (obj.type) return obj.type;
      } catch { /* skip */ }
    }
    return r.truncated ? "log too large to parse" : "-";
  } catch {
    return "log too large to parse";
  }
}

function agentSettledEvent(ev: string): boolean { return ev === "agent_end" || ev === "turn_end" || ev === "agent_settled"; }

function logHasUnfinishedToolCall(log: string): boolean {
  try {
    const r = logLinesFrom(log, 0);
    let lastToolStart = -1;
    let lastToolEndOrSettle = -1;
    for (let i = 0; i < r.lines.length; i++) {
      try {
        const obj = JSON.parse(r.lines[i]);
        if (obj?.type === "tool_execution_start") lastToolStart = i;
        if (obj?.type === "tool_execution_end" || agentSettledEvent(obj?.type)) lastToolEndOrSettle = i;
      } catch { /* skip */ }
    }
    return lastToolStart >= 0 && lastToolStart > lastToolEndOrSettle;
  } catch {
    return false;
  }
}

function appendSeatLog(log: string, obj: any): void {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, `${JSON.stringify(obj)}\n`);
}

function markSeatStalledAfterResume(name: string, bead: string | undefined): void {
  const state = readState();
  const rec = state.seats[name];
  if (!rec) return;
  const at = new Date().toISOString();
  const detail = `resume detected prior turn was cut off during a tool call${bead ? ` for bead ${bead}` : ""}; commander must redispatch or reset`;
  rec.lastStalledEvent = { at, detail };
  writeState(state);
  appendSeatLog(rec.log, { type: "agent_settled", state: "stalled", message: detail, bead: bead ?? null, at });
  console.log(`seat ${name}: STALLED — ${detail}`);
}

function logLastStalledEvent(log: string): boolean {
  try {
    const r = logLinesFrom(log, 0);
    for (let i = r.lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(r.lines[i]);
        if (obj?.type === "agent_settled" && obj?.state === "stalled") return true;
        if (obj?.type === "agent_end" || obj?.type === "turn_end" || obj?.type === "tool_execution_end") return false;
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return false;
}

function hostBudgetWorktreeCount(): number {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) return 0;
  return (r.stdout ?? "").split(/\n/).filter((l) => l.startsWith("worktree ") && !l.endsWith(` ${ROOT}`)).length;
}

function hostBudgetPruneRows(): { rows: any[]; scanFile: string } | null {
  const scan = spawnSync("bun", ["seats/prune.ts", "scan", "--format", "json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (scan.status !== 0) {
    console.log(`HOST-BUDGET worktree cap: prune scan failed (${scan.status ?? scan.signal}): ${(scan.stderr ?? scan.stdout ?? "").trim().slice(-1000)}`);
    return null;
  }
  const scanFile = path.join(ROOT, "seats", "logs", "prune-worktree-cap-scan.json");
  fs.mkdirSync(path.dirname(scanFile), { recursive: true });
  fs.writeFileSync(scanFile, scan.stdout ?? "[]");
  let rows: any[] = [];
  try { rows = JSON.parse(scan.stdout || "[]"); } catch { rows = []; }
  return { rows, scanFile };
}

function reportHostBudgetWorktreeCap(): void {
  const cap = hostBudgetMaxWorktrees(ROOT);
  if (cap == null) return;
  const count = hostBudgetWorktreeCount();
  if (count <= cap) return;
  const scan = hostBudgetPruneRows();
  if (!scan) return;
  const safe = scan.rows.filter((r) => r?.category === "merged-worktree" && r?.safe === 1 && r?.action === "worktree");
  console.log(`HOST-BUDGET worktree cap exceeded: count=${count} max_worktrees=${cap}`);
  if (safe.length === 0) {
    console.log("HOST-BUDGET prune scan found no safe merged-worktree rows; inspect seats/prune-worktree-cap-scan.json");
    return;
  }
  for (const r of safe) console.log(`HOST-BUDGET safe merged-worktree ${r.branch || "(detached)"} ${r.path} ${r.size_human ?? ""} — ${r.reason ?? ""}`);
  const cmd = `bun seats/prune.ts prune --from-file ${path.relative(ROOT, scan.scanFile)} --yes --categories merged-worktree`;
  console.log(`HOST-BUDGET prune command: ${cmd}`);
  if (hostBudgetAutoPrune(ROOT)) {
    const pr = spawnSync("bun", ["seats/prune.ts", "prune", "--from-file", path.relative(ROOT, scan.scanFile), "--yes", "--categories", "merged-worktree"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(pr.stdout ?? "");
    if (pr.status !== 0) console.log(`HOST-BUDGET auto_prune failed (${pr.status ?? pr.signal}): ${(pr.stderr ?? "").trim()}`);
  }
}

function rotateLogIfSafe(log: string, last: string): void {
  if (!fs.existsSync(log) || !agentSettledEvent(last)) return;
  const cap = LOG_ROTATE_BYTES;
  if (cap <= 0 || fs.statSync(log).size < cap) return;
  // Copy-truncate, not rename: a settled seat can still be alive with stdout
  // holding this inode open. The launch redirection is `>>`, which opens the
  // log with O_APPEND, so after truncate the live writer's next append lands in
  // the current log path. A rename would strand stdout on .jsonl.1 and blind
  // rpc(), status, and dispatch. Herald is rotation-aware: when a log shrinks
  // below its saved offset, readCompleteLines resets that offset.
  for (let i = LOG_ROTATE_KEEP; i >= 1; i--) {
    const src = `${log}.${i}`;
    const dst = `${log}.${i + 1}`;
    if (i >= LOG_ROTATE_KEEP) fs.rmSync(src, { force: true });
    else if (fs.existsSync(src)) fs.renameSync(src, dst);
  }
  fs.copyFileSync(log, `${log}.1`);
  fs.truncateSync(log, 0);
}

function cmdStatus(): void {
  const state = readState();
  const names = Object.keys(state.seats);
  if (names.length === 0) {
    console.log("no seats recorded in seats/state.json");
    return;
  }
  const roster = fs.existsSync(ROSTER_FILE) ? readRoster() : {};
  const rows = processRows();
  let sawSettled = false;
  for (const name of names) {
    const rec = state.seats[name];
    syncCapacityFromLog(name, rec, state, roster);
    const alive = barePidAlive(rec.pid);
    // A seat nobody stopped whose pid is gone DIED — that is a failure, and
    // rendering it as the same calm STOPPED a graceful stop earns would be
    // a failure conflated into a normal state. Say which one it is.
    const died = !alive && rec.pid != null && !rec.stoppedAt;
    const parkedQuota = Boolean(rec.lastCapacityEvent);
    const stalled = Boolean(rec.lastStalledEvent) || logLastStalledEvent(rec.log);
    const word = parkedQuota ? "PARKED" : alive && stalled ? "STALLED" : alive ? "RUNNING" : died ? "DIED" : "STOPPED";
    const pid = alive ? `pid ${rec.pid}` : died ? `pid ${rec.pid} gone` : "stopped";
    const bead = rec.lastBead ? `  bead ${rec.lastBead}` : "";
    const label = accountLabel(roster[name], rec);
    const labelText = label ? `  account ${label}` : "";
    const role = `${rec.role}${roster[name]?.shadow === true ? " (shadow)" : ""}`;
    const last = lastEvent(rec.log);
    if (agentSettledEvent(last)) sawSettled = true;
    console.log(`${name.padEnd(16)} ${role.padEnd(17)} ${word.padEnd(7)}  ${pid.padEnd(11)} last-event ${last}${bead}${labelText}`);
    rotateLogIfSafe(rec.log, last);
    if (died) {
      console.log(`${" ".repeat(16)} DIED: pid ${rec.pid} is gone and nobody stopped it — check ${rec.log.replace(/\.jsonl$/, ".stderr.log")}`);
    }
    if (rec.lastCapacityEvent) {
      console.log(`${" ".repeat(16)} CAPACITY: QUOTA at ${rec.lastCapacityEvent.at} — ${rec.lastCapacityEvent.detail}`);
      console.log(`${" ".repeat(16)} RE-PROBE: bun seats/adapter.ts probe ${name}`);
    }
    if (stalled && rec.lastStalledEvent) {
      console.log(`${" ".repeat(16)} STALLED: ${rec.lastStalledEvent.detail}`);
    }
    for (const orphan of orphanMatchesFor(name, rec, rows)) {
      console.log(`${" ".repeat(16)} ORPHAN: pid ${orphan.pid} also matches rostered seat ${name}; recorded pid ${rec.pid ?? "none"}; reason: ${orphan.reason}; remedy: inspect pid ${orphan.pid}, then stop it or run bun seats/recover.ts`);
    }
  }
  if (sawSettled) reportHostBudgetWorktreeCap();
}

async function stopRecord(state: State, name: string, rec: SeatRecord): Promise<string> {
  // SIGTERM is pi's graceful path: it flushes stdout and exits 143. No
  // SIGKILL fallback here — a seat that ignores SIGTERM is worth looking at,
  // not shooting.
  process.kill(rec.pid!, "SIGTERM");
  const deadline = Date.now() + TIMEOUT_MS;
  while (pidAlive(rec.pid, rec.fifo) && Date.now() < deadline) await sleep(100);
  if (pidAlive(rec.pid, rec.fifo)) {
    throw new Error(`pid ${rec.pid} is still alive after SIGTERM and ${TIMEOUT_MS}ms — look at it before escalating`);
  }
  rec.pid = null;
  rec.stoppedAt = new Date().toISOString();
  writeState(state);
  return `seat ${name} stopped; session ${rec.sessionId} kept for resume`;
}

async function cmdStop(name: string): Promise<void> {
  const state = readState();
  const rec = state.seats[name];
  if (!rec) die(`no record of seat "${name}"`);
  if (!pidAlive(rec.pid, rec.fifo)) {
    console.log(`seat ${name} is not running`);
    return;
  }
  const driver = driverForRunningSeat(name, "adapter stop");
  console.log(await driver.stop(state, name, rec));
}

async function cmdStopAll(): Promise<void> {
  const roster = readRoster();
  const state = readState();
  const names = Object.keys(roster).filter((name) => !roster[name].external).sort();
  if (names.length === 0) {
    console.log("stop-all: no local rostered seats");
    return;
  }
  for (const name of names) {
    const rec = state.seats[name];
    if (!rec) {
      console.log(`seat ${name}: no state record — not running`);
      continue;
    }
    if (!pidAlive(rec.pid, rec.fifo)) {
      console.log(`seat ${name}: not running; session ${rec.sessionId ?? "-"} kept for resume`);
      continue;
    }
    let driver: SeatDriver;
    try {
      driver = driverForSeat(name, roster[name], "adapter stop-all");
    } catch (e: any) {
      console.log(`seat ${name}: REPORT ${e.message}; left running (pid ${rec.pid})`);
      continue;
    }
    let st: any;
    try {
      st = await driver.getState(rec);
    } catch (e: any) {
      console.log(`seat ${name}: REPORT unable to check idle state; left running (pid ${rec.pid}) — ${e.message}`);
      continue;
    }
    if (!st.success) {
      console.log(`seat ${name}: REPORT get_state failed; left running (pid ${rec.pid}) — ${st.error}`);
      continue;
    }
    if (st.data?.isStreaming) {
      console.log(`seat ${name}: BUSY mid-turn; NOT stopped (pid ${rec.pid}); session ${rec.sessionId ?? "-"} left resumable`);
      continue;
    }
    try {
      console.log(await driver.stop(state, name, rec));
    } catch (e: any) {
      console.log(`seat ${name}: REPORT stop failed; left for human inspection — ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case "spawn":
      if (rest.length !== 1 && rest.length !== 2) die("usage: adapter.ts spawn <seat> [bead-id]");
      return cmdSpawn(validateSeatName(rest[0]), rest[1] !== undefined ? validateSegment("bead id", rest[1]) : undefined);
    case "probe":
      if (rest.length !== 1) die("usage: adapter.ts probe <seat>");
      return cmdProbe(validateSeatName(rest[0]));
    case "dispatch":
      if (rest.length !== 3) die("usage: adapter.ts dispatch <seat> <bead-id> <text>");
      return cmdDispatch(validateSeatName(rest[0]), validateSegment("bead id", rest[1]), rest[2]);
    case "steer":
      if (rest.length !== 2) die("usage: adapter.ts steer <seat> <text>");
      return cmdSteer(validateSeatName(rest[0]), rest[1]);
    case "status":
      return cmdStatus();
    case "stop":
      if (rest.length !== 1) die("usage: adapter.ts stop <seat>");
      return cmdStop(validateSeatName(rest[0]));
    case "stop-all":
      if (rest.length !== 0) die("usage: adapter.ts stop-all");
      return cmdStopAll();
    case "resume":
      if (rest.length !== 1) die("usage: adapter.ts resume <seat>");
      return cmdResume(validateSeatName(rest[0]));
    case "reset":
      if (rest.length !== 1) die("usage: adapter.ts reset <seat>");
      return cmdReset(validateSeatName(rest[0]));
    default:
      die("usage: adapter.ts spawn|probe|dispatch|steer|status|stop|stop-all|resume|reset ...");
  }
}

main().catch((e) => die(e.message));
