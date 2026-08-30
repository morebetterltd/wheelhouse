#!/usr/bin/env bun
/**
 * recover.ts — what is left of the fleet after an interruption?
 *
 * Run at commander start (or any time you are unsure what survived): it reads
 * seats/state.json, seats/run/, and the live process table, and tells you the
 * truth about every recorded seat. It NEVER acts on that truth beyond one
 * safe janitorial step — removing FIFOs whose reader is gone. It does not
 * resume, spawn, dispatch, touch state.json, or call bd; resuming is a
 * decision, and decisions belong to the commander.
 *
 * Classification, per seat in state.json:
 *
 *   RUNNING  the recorded pid is alive AND its command line carries this
 *            seat's role brief — so it is our process, not a stranger that
 *            inherited the pid after a reboot (pids are dense; `kill -0`
 *            alone cannot tell a survivor from a reuse).
 *   DEAD     the process is gone (or the pid was reused) but the recorded
 *            session file still exists. Resumable: for a seat with a
 *            lastBead, the exact resume command is printed alongside the
 *            bead id. Refused when something is already attached to the
 *            same session — resuming twice is how one session gets two
 *            writers.
 *   STALE    a state entry with no session artifacts on disk. Nothing to
 *            resume; spawn fresh when the seat is needed again.
 *
 * The only writes this tool performs are FIFO removals under seats/run/ for
 * seats that are not RUNNING (a FIFO with no reader blocks nothing but lies
 * to the next `ls`); each removal is printed. The adapter's launch path
 * recreates a missing FIFO, so removal never breaks a later resume.
 *
 * Usage: bun seats/recover.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const RUN_DIR = path.join(SEATS_DIR, "run");
const ADAPTER = path.join(SEATS_DIR, "adapter.ts");

interface SeatRecord {
  pid: number | null;
  startedAt?: string;
  stoppedAt?: string;
  accountDir?: string;
  role?: string;
  roleBrief?: string;
  fifo?: string;
  log?: string;
  sessionId?: string | null;
  sessionFile?: string | null;
  model?: string;
  lastBead?: string;
  lastDispatchAt?: string;
}

interface State {
  seats: Record<string, SeatRecord>;
}

type Cls = "RUNNING" | "DEAD" | "STALE";

interface Row {
  name: string;
  rec: SeatRecord;
  cls: Cls;
  detail: string;
}

function readState(): State {
  if (!fs.existsSync(STATE_FILE)) return { seats: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
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

/**
 * One snapshot of the live process table: pid -> full command line. Taken
 * once, up front, so every judgment below reads the same instant. `kill -0`
 * answers "is this pid alive"; only the command line answers "is this pid
 * still the process we started" — after a machine restart every recorded pid
 * is stale, and some will be alive again as something else entirely.
 */
function psTable(): Map<number, string> {
  const out = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

/**
 * Is our seat process the one holding this pid? The adapter launches pi with
 * `--append-system-prompt <roleBrief>`, so the brief's absolute path sits in
 * the process's argv. A pid that is alive but whose command line does not
 * carry the brief is a reuse — a different process that inherited the number
 * — and must be treated as gone, never signalled or trusted.
 */
function classify(rec: SeatRecord, ps: Map<number, string>): { cls: Cls; detail: string } {
  const alive = rec.pid != null && pidAlive(rec.pid);
  const cmd = alive ? (ps.get(rec.pid!) ?? "") : "";
  const ours = alive && !!rec.roleBrief && cmd.includes(rec.roleBrief);
  const sessionIntact = !!rec.sessionFile && fs.existsSync(rec.sessionFile);

  if (ours) return { cls: "RUNNING", detail: `pid ${rec.pid}` };

  let gone: string;
  if (alive) gone = `pid ${rec.pid} reused by another process`;
  else if (rec.pid == null && rec.stoppedAt) gone = `stopped gracefully at ${rec.stoppedAt}`;
  else gone = `pid ${rec.pid ?? "?"} gone`;

  if (sessionIntact) return { cls: "DEAD", detail: `${gone}; session intact` };
  return { cls: "STALE", detail: `${gone}; no session artifacts` };
}

/**
 * Something is already attached to this seat's session — either another
 * recorded seat classified RUNNING on the same session file, or any live
 * process whose command line names the file (`--session <file>` from a
 * resume the state never recorded). Either way a second resume would give
 * one session two writers, so the resume command is refused, not printed.
 */
function sessionAttachment(
  name: string,
  rec: SeatRecord,
  rows: Row[],
  ps: Map<number, string>
): string | null {
  if (!rec.sessionFile) return null;
  for (const r of rows) {
    if (r.name !== name && r.cls === "RUNNING" && r.rec.sessionFile === rec.sessionFile) {
      return `seat ${r.name} (pid ${r.rec.pid})`;
    }
  }
  for (const [pid, cmd] of ps) {
    if (pid === process.pid) continue;
    if (cmd.includes(rec.sessionFile)) return `pid ${pid} (${cmd.slice(0, 120)})`;
  }
  return null;
}

function main(): void {
  const state = readState();
  const ps = psTable();

  const rows: Row[] = Object.entries(state.seats).map(([name, rec]) => {
    const { cls, detail } = classify(rec, ps);
    return { name, rec, cls, detail };
  });

  if (rows.length === 0) {
    console.log(`no seats recorded in ${STATE_FILE} — nothing to recover`);
  } else {
    console.log("seat classification (state.json + process table):");
    for (const { name, rec, cls, detail } of rows) {
      const bead = rec.lastBead ? `  bead ${rec.lastBead}` : "";
      console.log(`${name.padEnd(16)} ${cls.padEnd(8)} ${detail}${bead}`);
      if (cls === "DEAD") {
        const attachedBy = sessionAttachment(name, rec, rows, ps); // attach-check
        if (attachedBy) {
          console.log(`  REFUSED double-resume: session already attached by ${attachedBy}`);
        } else if (rec.lastBead) {
          console.log(`  resume: bun ${ADAPTER} resume ${name}   # bead ${rec.lastBead}`);
        } else {
          console.log(`  resumable (no bead in flight): bun ${ADAPTER} resume ${name}`);
        }
      }
      if (cls === "STALE") {
        console.log(`  nothing to resume; spawn fresh when needed: bun ${ADAPTER} spawn ${name}`);
      }
    }
  }

  // Janitorial: a FIFO whose seat is not RUNNING has no reader. Left in
  // place it only misleads; removed, the adapter recreates it at the next
  // spawn or resume. This is the ONLY write this tool makes.
  if (fs.existsSync(RUN_DIR)) {
    for (const f of fs.readdirSync(RUN_DIR).sort()) {
      if (!f.endsWith(".stdin")) continue;
      const fifoPath = path.join(RUN_DIR, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(fifoPath);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (!st.isFIFO()) continue;
      const seat = f.slice(0, -".stdin".length);
      const row = rows.find((r) => r.name === seat);
      if (row && row.cls === "RUNNING") continue;
      fs.unlinkSync(fifoPath); // fifo-clean
      console.log(`removed orphaned FIFO: ${fifoPath}${row ? "" : " (no state entry)"}`);
    }
  }
}

main();
