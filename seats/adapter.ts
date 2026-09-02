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
 *   dispatch <seat> <bead-id> <text>   send a prompt (queues if mid-turn)
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
 * it creates. dispatch transparently stops and relaunches (attached to the
 * same session) when the seat's cwd does not already match the bead.
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRoleBrief } from "./briefs";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const RUN_DIR = path.join(SEATS_DIR, "run");
const LOG_DIR = path.join(SEATS_DIR, "logs");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const WORKTREES_DIR = path.join(ROOT, ".wheelhouse-worktrees");

// One knob for every wait in this file; the selftest raises it for real pi.
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_RPC_TIMEOUT_MS || 20000);

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
  provider?: string;
  model?: string;
  external?: boolean;
  shadow?: boolean;
  account?: { dir: string; label?: string; authRoute?: string };
}

// The three routes BOOTSTRAP.md's question 8 offers: `oauth` for a
// subscription seat's REPL /login, `api_key` for a written auth.json entry,
// `env` for a provider env var exported in the spawning shell. Durable but
// optional — `seats/seats.json` written before this field existed has no
// `account.authRoute` at all, and that stays a valid roster.
const AUTH_ROUTES = ["oauth", "api_key", "env"] as const;

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

function validateShadow(seatName: string, entry: SeatEntry): void {
  if (entry.shadow === undefined) return; // absent means false
  if (typeof entry.shadow !== "boolean") {
    die(
      `seat "${seatName}" has an invalid shadow ${JSON.stringify(entry.shadow)} in seats/seats.json — ` +
        `must be boolean true or false (or omitted)`
    );
  }
}

interface SeatRecord {
  pid: number | null;
  startedAt: string;
  stoppedAt?: string;
  accountDir: string;
  accountLabel?: string;
  role: string;
  roleBrief: string;
  cwd: string;
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
  const seats: Record<string, SeatEntry> = raw.seats ?? {};
  for (const [name, entry] of Object.entries(seats)) {
    validateAuthRoute(name, entry);
    validateShadow(name, entry);
  }
  return seats;
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

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function providerEnvVar(provider: string): string | undefined {
  return PROVIDER_ENV_VARS[provider];
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

async function launch(name: string, entry: SeatEntry, sessionFile: string | null, cwd: string): Promise<void> {
  requireCwdDir(cwd);
  const labelSuffix = accountLabelSuffix(entry);
  const state = readState();
  const existing = state.seats[name];
  if (existing && pidAlive(existing.pid)) {
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
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: accountDir, BEADS_ACTOR: beadsActorFor(name) },
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
    die(`spawned pid ${pid} for seat "${name}"${labelSuffix} but ${e.message}. stderr tail:\n${stderrTail(probe)}`);
  }
  if (!st.success) die(`get_state failed on fresh seat "${name}"${labelSuffix}: ${st.error}. stderr tail:\n${stderrTail(probe)}`);

  state.seats[name] = {
    pid,
    startedAt: new Date().toISOString(),
    accountDir,
    ...(accountLabel(entry) ? { accountLabel: accountLabel(entry) } : {}),
    role: entry.role,
    roleBrief: brief,
    cwd,
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

async function cmdSpawn(name: string, beadId?: string): Promise<void> {
  await launch(name, requireSeat(name), null, beadId ? beadWorktreeDir(beadId) : ROOT);
}

function cmdProbe(name: string): void {
  const entry = requireSeat(name);
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
    env: { ...process.env, PI_CODING_AGENT_DIR: accountDir, BEADS_ACTOR: beadsActorFor(name) },
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

async function cmdResume(name: string): Promise<void> {
  const rec = readState().seats[name];
  if (!rec) die(`no record of seat "${name}" in seats/state.json — spawn it instead`);
  if (pidAlive(rec.pid)) die(`seat "${name}" is already running (pid ${rec.pid})`);
  if (!rec.sessionFile) die(`seat "${name}" has no recorded session file — spawn it instead`);
  if (!fs.existsSync(rec.sessionFile)) {
    die(`recorded session file is gone: ${rec.sessionFile} — spawn a fresh seat instead`);
  }
  // Resuming keeps the seat where it was working, not the project root: the
  // cwd it was launched into last time, falling back to ROOT only for a
  // state.json record from before this field existed. If that cwd was pruned,
  // a plain resume has no new dispatch target to fall back to, so STOP rather
  // than guessing a replacement and silently changing identity.
  const resumeCwd = rec.cwd ?? ROOT;
  if (!fs.existsSync(resumeCwd) || !fs.statSync(resumeCwd).isDirectory()) {
    die(
      `recorded seat cwd is gone: ${resumeCwd} — cannot resume recorded session. ` +
        `The pruned-cwd fallback intentionally drops session continuity only during dispatch, where the new bead worktree is the fallback target; spawn a fresh seat or dispatch to a bead with an existing worktree instead.`
    );
  }
  await launch(name, requireSeat(name), rec.sessionFile, resumeCwd);
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
  const rec = requireRunning(name);
  const entry = requireSeat(name);
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
  const cwd = rec.cwd ?? ROOT;
  await cmdStop(name);
  // Discard the recorded session explicitly, ahead of the cold spawn below
  // that would overwrite it anyway: if reset dies between stop and spawn,
  // state.json must already show no session to resume into, not the stale
  // one reset was meant to drop.
  const state = readState();
  if (state.seats[name]) {
    state.seats[name].sessionId = null;
    state.seats[name].sessionFile = null;
    writeState(state); // reset-record
  }
  await launch(name, entry, null, cwd); // null sessionFile: cold, no --session
  console.log(`seat ${name}: reset — session discarded, respawned cold`);
}

function requireRunning(name: string): SeatRecord {
  const rec = readState().seats[name];
  if (!rec) die(`no record of seat "${name}" — spawn it first`);
  if (!pidAlive(rec.pid)) die(`seat "${name}" is not running — resume or spawn it first`);
  return rec;
}

async function cmdDispatch(name: string, beadId: string, text: string): Promise<void> {
  let rec = requireRunning(name);
  const targetCwd = beadWorktreeDir(beadId);
  if (rec.cwd !== targetCwd) {
    // Construction, not prompt discipline: a seat handed a DIFFERENT bead
    // than the one it is sitting in gets stopped and relaunched attached to
    // its own session, but rooted in the new bead's worktree, before the
    // prompt goes anywhere near it. Checked BEFORE stopping anything — a
    // missing worktree must refuse loudly with the seat left exactly as it
    // was, not stopped on the way to discovering the target doesn't exist.
    requireCwdDir(targetCwd);
    const recordedCwd = rec.cwd ?? ROOT;
    const recordedCwdExists = fs.existsSync(recordedCwd) && fs.statSync(recordedCwd).isDirectory();
    await cmdStop(name);
    if (recordedCwdExists) {
      await launch(name, requireSeat(name), rec.sessionFile, targetCwd);
    } else {
      console.log(
        `seat ${name}: session continuity intentionally dropped because recorded cwd is gone: ${recordedCwd}; ` +
          `falling back to fresh spawn in dispatch target ${targetCwd}`
      );
      await launch(name, requireSeat(name), null, targetCwd);
    }
    rec = requireRunning(name);
  }
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
    die(`dispatch failed for seat "${name}"${accountLabelSuffix(undefined, rec)}: ${resp.error}. stderr tail:\n${stderrTail(rec)}`);
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
  const roster = fs.existsSync(ROSTER_FILE) ? readRoster() : {};
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
    const label = accountLabel(roster[name], rec);
    const labelText = label ? `  account ${label}` : "";
    const role = `${rec.role}${roster[name]?.shadow === true ? " (shadow)" : ""}`;
    console.log(`${name.padEnd(16)} ${role.padEnd(17)} ${word.padEnd(7)}  ${pid.padEnd(11)} last-event ${lastEvent(rec.log)}${bead}${labelText}`);
    if (died) {
      console.log(`${" ".repeat(16)} DIED: pid ${rec.pid} is gone and nobody stopped it — check ${rec.log.replace(/\.jsonl$/, ".stderr.log")}`);
    }
    if (rec.lastCapacityEvent) {
      console.log(`${" ".repeat(16)} CAPACITY: quota-shaped dispatch failure at ${rec.lastCapacityEvent.at} — ${rec.lastCapacityEvent.detail}`);
    }
  }
}

async function stopRecord(state: State, name: string, rec: SeatRecord): Promise<string> {
  // SIGTERM is pi's graceful path: it flushes stdout and exits 143. No
  // SIGKILL fallback here — a seat that ignores SIGTERM is worth looking at,
  // not shooting.
  process.kill(rec.pid!, "SIGTERM");
  const deadline = Date.now() + TIMEOUT_MS;
  while (pidAlive(rec.pid) && Date.now() < deadline) await sleep(100);
  if (pidAlive(rec.pid)) {
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
  if (!pidAlive(rec.pid)) {
    console.log(`seat ${name} is not running`);
    return;
  }
  console.log(await stopRecord(state, name, rec));
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
    if (!pidAlive(rec.pid)) {
      console.log(`seat ${name}: not running; session ${rec.sessionId ?? "-"} kept for resume`);
      continue;
    }
    let st: any;
    try {
      st = await rpc(rec, { type: "get_state" });
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
      console.log(await stopRecord(state, name, rec));
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
