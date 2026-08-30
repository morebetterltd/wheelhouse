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
 * `pi /login` writes.
 *
 * Usage: bun seats/adapter.ts <command> [args]
 *
 *   spawn    <seat>                    start the seat from seats/seats.json
 *   dispatch <seat> <bead-id> <text>   send a prompt (queues if mid-turn)
 *   steer    <seat> <text>             redirect the current turn
 *   status                             liveness + last event, every seat
 *   stop     <seat>                    graceful SIGTERM; session survives
 *   resume   <seat>                    respawn attached to the recorded session
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const RUN_DIR = path.join(SEATS_DIR, "run");
const LOG_DIR = path.join(SEATS_DIR, "logs");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");

// One knob for every wait in this file; the selftest raises it for real pi.
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_RPC_TIMEOUT_MS || 20000);

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
 * and lands inside the quoted shell command that launches pi. Anything that
 * is not one plain segment — separators, dot-dirs, whitespace, quotes —
 * would write outside seats/ or break the launch line, so it is refused
 * loudly, naming the offending key.
 */
function validateSeatName(name: string): string {
  const bad =
    name.length === 0 ? "empty" :
    name === "." || name === ".." ? "a dot segment" :
    /[/\\]/.test(name) ? "a path separator" :
    /\s/.test(name) ? "whitespace" :
    /['"`]/.test(name) ? "a quote character" :
    null;
  if (bad !== null) {
    die(`invalid seat name ${JSON.stringify(name)} (${bad}) — a seat name must be a single path segment: no /, no .., no whitespace, no quotes`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Roster and state
// ---------------------------------------------------------------------------

interface SeatEntry {
  role: string;
  provider?: string;
  model?: string;
  external?: boolean;
  account?: { dir: string };
}

interface SeatRecord {
  pid: number | null;
  startedAt: string;
  stoppedAt?: string;
  accountDir: string;
  role: string;
  roleBrief: string;
  fifo: string;
  log: string;
  sessionId: string | null;
  sessionFile: string | null;
  model?: string;
  lastBead?: string;
  lastDispatchAt?: string;
  lastCapacityEvent?: { at: string; detail: string };
}

interface State {
  seats: Record<string, SeatRecord>;
}

function readRoster(): Record<string, SeatEntry> {
  if (!fs.existsSync(ROSTER_FILE)) {
    die(`no ${ROSTER_FILE} — copy seats/seats.json.example to seats/seats.json and edit it`);
  }
  const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
  return raw.seats ?? {};
}

function readState(): State {
  if (!fs.existsSync(STATE_FILE)) return { seats: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function writeState(state: State): void {
  // Write-then-rename so a crash mid-write cannot leave half a state file.
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists, not ours to signal — still alive
  }
}

// Same rule as seat-env.sh: pi auto-creates an empty {} auth.json on a first
// headless run, and a seat with only that has never been logged in.
function authIsIdentity(authFile: string): boolean {
  if (!fs.existsSync(authFile)) return false;
  const body = fs.readFileSync(authFile, "utf8").replace(/[{}\s]/g, "");
  return body.length > 0;
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

/** Read the log from a byte offset; return complete new lines + new offset. */
function logLinesFrom(log: string, offset: number): { lines: string[]; offset: number } {
  if (!fs.existsSync(log)) return { lines: [], offset };
  const size = fs.statSync(log).size;
  if (size <= offset) return { lines: [], offset };
  const fd = fs.openSync(log, "r");
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(size - offset);
    fs.readSync(fd, chunk, 0, chunk.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const text = chunk.toString("utf8");
  const lastLf = text.lastIndexOf("\n");
  if (lastLf === -1) return { lines: [], offset }; // partial line; come back
  return {
    lines: text.slice(0, lastLf).split("\n").filter((l) => l.length > 0),
    offset: offset + Buffer.byteLength(text.slice(0, lastLf + 1)),
  };
}

/**
 * Send a command and wait for its response line in the log. The log offset is
 * taken BEFORE the write so the response cannot land in a blind spot.
 */
async function rpc(
  rec: { fifo: string; log: string; pid: number | null },
  command: Record<string, unknown>,
  timeoutMs = TIMEOUT_MS
): Promise<any> {
  const id = crypto.randomUUID();
  let offset = fs.existsSync(rec.log) ? fs.statSync(rec.log).size : 0;
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
    if (!pidAlive(rec.pid)) {
      throw new Error(`seat process died while waiting for ${command.type} response — check the .stderr.log beside its event log`);
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${command.type} response`);
}

// Capacity visibility (visibility ONLY — nothing here meters or brokers
// quota). Same pattern the floor uses, kept in both places on purpose: the
// adapter stamps state.json when a dispatch fails quota-shaped, the floor
// renders from the stamp AND keeps scanning raw streams for what the
// adapter never saw.
const QUOTA_RE = /quota|rate.?limit|429|usage limit|exhaust|out of credits|insufficient.credit/i;

/** Last few KB of the seat's stderr log — where pi complains about limits. */
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
  if (!entry.account?.dir) die(`seat "${name}" has no account.dir in seats/seats.json`);
  return entry;
}

function roleBriefPath(role: string): string {
  const brief = path.join(ROOT, "contracts", `${role.toUpperCase()}.md`);
  if (!fs.existsSync(brief)) {
    die(`no crew brief for role "${role}" — expected ${brief}`);
  }
  return brief;
}

async function launch(name: string, entry: SeatEntry, sessionFile: string | null): Promise<void> {
  const state = readState();
  const existing = state.seats[name];
  if (existing && pidAlive(existing.pid)) {
    die(`seat "${name}" is already running (pid ${existing.pid}) — stop it first`);
  }

  const accountDir = expandTilde(entry.account!.dir);
  if (!fs.existsSync(accountDir)) {
    die(
      `seat directory does not exist: ${accountDir}\n` +
        `      provision it first: seats/seat-env.sh <namespace> ${name} "${ROOT}"`
    );
  }
  const authFile = path.join(accountDir, "auth.json");
  if (!authIsIdentity(authFile)) {
    die(
      `seat "${name}" has no identity — ${authFile} is missing or empty.\n` +
        `      log the seat in once: PI_CODING_AGENT_DIR="${accountDir}" pi /login`
    );
  }

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
  if (sessionFile) {
    args.push("--session", sessionFile); // resume-attach
  }

  // bash's `0<>` opens the FIFO read-write, so pi's stdin never sees EOF when
  // a writer closes; stdout appends to the log by redirection, so no pipe
  // ties pi's lifetime to ours. `exec` makes the child's pid pi's pid.
  const shellCmd =
    `exec pi ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")} ` +
    `0<> '${fifo}' >> '${log}' 2>> '${errLog}'`;
  const child = spawn("bash", ["-c", shellCmd], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: accountDir },
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
    die(`spawned pid ${pid} but ${e.message}`);
  }
  if (!st.success) die(`get_state failed on fresh seat: ${st.error}`);

  state.seats[name] = {
    pid,
    startedAt: new Date().toISOString(),
    accountDir,
    role: entry.role,
    roleBrief: brief,
    fifo,
    log,
    sessionId: st.data?.sessionId ?? null,
    sessionFile: st.data?.sessionFile ?? null,
    model: entry.model,
    ...(existing?.lastBead ? { lastBead: existing.lastBead } : {}),
  };
  writeState(state); // spawn-record
  console.log(`seat ${name}: pid ${pid}, session ${state.seats[name].sessionId}`);
  console.log(`  events -> ${log}`);
}

async function cmdSpawn(name: string): Promise<void> {
  await launch(name, requireSeat(name), null);
}

async function cmdResume(name: string): Promise<void> {
  const rec = readState().seats[name];
  if (!rec) die(`no record of seat "${name}" in seats/state.json — spawn it instead`);
  if (pidAlive(rec.pid)) die(`seat "${name}" is already running (pid ${rec.pid})`);
  if (!rec.sessionFile) die(`seat "${name}" has no recorded session file — spawn it instead`);
  if (!fs.existsSync(rec.sessionFile)) {
    die(`recorded session file is gone: ${rec.sessionFile} — spawn a fresh seat instead`);
  }
  await launch(name, requireSeat(name), rec.sessionFile);
}

function requireRunning(name: string): SeatRecord {
  const rec = readState().seats[name];
  if (!rec) die(`no record of seat "${name}" — spawn it first`);
  if (!pidAlive(rec.pid)) die(`seat "${name}" is not running — resume or spawn it first`);
  return rec;
}

async function cmdDispatch(name: string, beadId: string, text: string): Promise<void> {
  const rec = requireRunning(name);
  // followUp: a new bead queues behind the current turn instead of erroring
  // if the seat is mid-stream. Mid-turn redirection is what steer is for.
  const resp = await rpc(rec, {
    type: "prompt",
    message: `Bead ${beadId}\n\n${text}`,
    streamingBehavior: "followUp",
  });
  if (!resp.success) {
    // A failure that looks like an account limit is a CAPACITY fact worth
    // keeping: stamp it so `status` and the floor can surface it after this
    // process is gone. Anything else stays a plain failure.
    const blob = `${resp.error ?? ""}\n${stderrTail(rec)}`;
    if (QUOTA_RE.test(blob)) {
      const state = readState();
      state.seats[name].lastCapacityEvent = {
        at: new Date().toISOString(),
        detail: String(resp.error ?? "quota-shaped stderr"),
      }; // capacity-record
      writeState(state);
    }
    die(`dispatch failed: ${resp.error}`);
  }
  const state = readState();
  state.seats[name].lastBead = beadId;
  state.seats[name].lastDispatchAt = new Date().toISOString();
  delete state.seats[name].lastCapacityEvent; // a dispatch that lands clears it
  writeState(state);
  console.log(`dispatched ${beadId} to ${name}; watch ${rec.log}`);
}

async function cmdSteer(name: string, text: string): Promise<void> {
  const rec = requireRunning(name);
  const resp = await rpc(rec, { type: "steer", message: text });
  if (!resp.success) die(`steer failed: ${resp.error}`);
  console.log(`steered ${name}`);
}

function lastEvent(log: string): string {
  const r = logLinesFrom(log, 0);
  for (let i = r.lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(r.lines[i]);
      if (obj.type) return obj.type;
    } catch {
      /* skip */
    }
  }
  return "-";
}

function cmdStatus(): void {
  const state = readState();
  const names = Object.keys(state.seats);
  if (names.length === 0) {
    console.log("no seats recorded in seats/state.json");
    return;
  }
  for (const name of names) {
    const rec = state.seats[name];
    const alive = pidAlive(rec.pid);
    // A seat nobody stopped whose pid is gone DIED — that is a failure, and
    // rendering it as the same calm STOPPED a graceful stop earns would be
    // a failure conflated into a normal state. Say which one it is.
    const died = !alive && rec.pid != null && !rec.stoppedAt;
    const word = alive ? "RUNNING" : died ? "DIED" : "STOPPED";
    const pid = alive ? `pid ${rec.pid}` : died ? `pid ${rec.pid} gone` : "stopped";
    const bead = rec.lastBead ? `  bead ${rec.lastBead}` : "";
    console.log(`${name.padEnd(16)} ${word.padEnd(7)}  ${pid.padEnd(11)} last-event ${lastEvent(rec.log)}${bead}`);
    if (died) {
      console.log(`${" ".repeat(16)} DIED: pid ${rec.pid} is gone and nobody stopped it — check ${rec.log.replace(/\.jsonl$/, ".stderr.log")}`);
    }
    if (rec.lastCapacityEvent) {
      console.log(`${" ".repeat(16)} CAPACITY: quota-shaped dispatch failure at ${rec.lastCapacityEvent.at} — ${rec.lastCapacityEvent.detail}`);
    }
  }
}

async function cmdStop(name: string): Promise<void> {
  const state = readState();
  const rec = state.seats[name];
  if (!rec) die(`no record of seat "${name}"`);
  if (!pidAlive(rec.pid)) {
    console.log(`seat ${name} is not running`);
    return;
  }
  // SIGTERM is pi's graceful path: it flushes stdout and exits 143. No
  // SIGKILL fallback here — a seat that ignores SIGTERM is worth looking at,
  // not shooting.
  process.kill(rec.pid!, "SIGTERM");
  const deadline = Date.now() + TIMEOUT_MS;
  while (pidAlive(rec.pid) && Date.now() < deadline) await sleep(100);
  if (pidAlive(rec.pid)) {
    die(`pid ${rec.pid} is still alive after SIGTERM and ${TIMEOUT_MS}ms — look at it before escalating`);
  }
  rec.pid = null;
  rec.stoppedAt = new Date().toISOString();
  writeState(state);
  console.log(`seat ${name} stopped; session ${rec.sessionId} kept for resume`);
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case "spawn":
      if (rest.length !== 1) die("usage: adapter.ts spawn <seat>");
      return cmdSpawn(validateSeatName(rest[0]));
    case "dispatch":
      if (rest.length !== 3) die("usage: adapter.ts dispatch <seat> <bead-id> <text>");
      return cmdDispatch(validateSeatName(rest[0]), rest[1], rest[2]);
    case "steer":
      if (rest.length !== 2) die("usage: adapter.ts steer <seat> <text>");
      return cmdSteer(validateSeatName(rest[0]), rest[1]);
    case "status":
      return cmdStatus();
    case "stop":
      if (rest.length !== 1) die("usage: adapter.ts stop <seat>");
      return cmdStop(validateSeatName(rest[0]));
    case "resume":
      if (rest.length !== 1) die("usage: adapter.ts resume <seat>");
      return cmdResume(validateSeatName(rest[0]));
    default:
      die("usage: adapter.ts spawn|dispatch|steer|status|stop|resume ...");
  }
}

main().catch((e) => die(e.message));
