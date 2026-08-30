#!/usr/bin/env bun
/**
 * recover.ts — what is left of the fleet after an interruption?
 *
 * Run at commander start (or any time you are unsure what survived): it reads
 * seats/state.json, seats/run/, and each candidate process's open file table,
 * and tells you the truth about every recorded seat. It NEVER acts on that
 * truth beyond one safe janitorial step — removing FIFOs whose reader is gone.
 * It does not resume, spawn, dispatch, touch state.json, or call bd; resuming
 * is a decision, and decisions belong to the commander.
 *
 * Identity is established by FILE DESCRIPTORS, never by command lines. Pi
 * rewrites its process title: a live seat's ps line is exactly `pi` with no
 * argv (verified against pi 0.84.x — the selftest's real-binary probe
 * documents this premise), so anything that greps ps for the role brief or
 * a session path calls every live real seat dead. What a live seat CANNOT
 * hide is its open fds: the adapter starts every seat with stdin opened
 * read-write on seats/run/<seat>.stdin, so a process that holds that FIFO is
 * that seat, and a process that does not — whatever its pid or its title —
 * is not. This is also reuse-proof (a recycled pid after reboot does not
 * hold our FIFO) and spoof-proof (a `tail -f` on the role brief carries the
 * path in its argv but holds no FIFO).
 *
 * Classification, per seat in state.json:
 *
 *   RUNNING  the recorded pid is alive AND holds this seat's FIFO open
 *            (`lsof -p <pid>` names it).
 *   DEAD     the process is gone — or the pid is alive but does not hold
 *            the FIFO (reused/foreign) — and the recorded session file
 *            still exists. Resumable: for a seat with a lastBead, the exact
 *            resume command is printed alongside the bead id. Refused when
 *            something is already attached to the same session — resuming
 *            twice is how one session gets two writers.
 *   STALE    a state entry with no session artifacts on disk. Nothing to
 *            resume; spawn fresh when the seat is needed again.
 *
 * The only writes this tool performs are FIFO removals under seats/run/ for
 * seats that are not RUNNING (a FIFO with no reader blocks nothing but lies
 * to the next `ls`); each removal is printed. The adapter's launch path
 * recreates a missing FIFO, so removal never breaks a later resume.
 *
 * Requires `lsof` (present on macOS and virtually every Linux); a machine
 * without it gets a STOP, not a guess.
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

function die(msg: string): never {
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(1);
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

/** The n-lines (open file names) of `lsof -p <pid>`; [] for a dead pid. */
function openPaths(pid: number): string[] {
  let out: string;
  try {
    out = execFileSync("lsof", ["-Fn", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e: any) {
    if (e.code === "ENOENT") die("lsof is not on PATH — recover cannot establish process identity without it");
    return []; // lsof exits non-zero: pid gone, or nothing visible to us
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1));
}

/**
 * Does this pid hold this path open? Compared against both the recorded
 * path and its canonicalized form — lsof reports physical paths, and a
 * project reached through a symlink records the logical one.
 */
function pidHoldsPath(pid: number, p: string): boolean {
  const wanted = new Set([p]);
  try {
    wanted.add(fs.realpathSync(p));
  } catch {
    /* path gone from disk; raw compare still applies */
  }
  return openPaths(pid).some((n) => wanted.has(n));
}

/**
 * Pids (other than our own) holding a REGULAR file open, via `lsof <file>`.
 * By-path lsof is dependable for regular files (session files are), and
 * NOT for FIFOs — which is why seat identity above goes per-pid instead.
 */
function pidsHoldingFile(file: string): number[] {
  let out: string;
  try {
    out = execFileSync("lsof", ["-Fp", "--", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e: any) {
    if (e.code === "ENOENT") die("lsof is not on PATH — recover cannot establish process identity without it");
    return []; // exit 1: nobody holds it (or the file is gone)
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("p"))
    .map((l) => Number(l.slice(1)))
    .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
}

function classify(rec: SeatRecord): { cls: Cls; detail: string } {
  const alive = rec.pid != null && pidAlive(rec.pid);
  const ours = alive && !!rec.fifo && pidHoldsPath(rec.pid!, rec.fifo);
  const sessionIntact = !!rec.sessionFile && fs.existsSync(rec.sessionFile);

  if (ours) return { cls: "RUNNING", detail: `pid ${rec.pid} holds the seat FIFO` };

  let gone: string;
  if (alive) gone = `pid ${rec.pid} alive but not holding this seat's FIFO — reused or foreign, treated as gone`;
  else if (rec.pid == null && rec.stoppedAt) gone = `stopped gracefully at ${rec.stoppedAt}`;
  else gone = `pid ${rec.pid ?? "?"} gone`;

  if (sessionIntact) return { cls: "DEAD", detail: `${gone}; session intact` };
  return { cls: "STALE", detail: `${gone}; no session artifacts` };
}

/**
 * Something is already attached to this seat's session — another recorded
 * seat classified RUNNING on the same session file, or any live process
 * holding the session file open (best-effort: a resume the state never
 * recorded is only visible while the file is held). Either way a second
 * resume would give one session two writers, so the resume command is
 * refused, not printed.
 */
function sessionAttachment(name: string, rec: SeatRecord, rows: Row[]): string | null {
  if (!rec.sessionFile) return null;
  for (const r of rows) {
    if (r.name !== name && r.cls === "RUNNING" && r.rec.sessionFile === rec.sessionFile) {
      return `seat ${r.name} (pid ${r.rec.pid})`;
    }
  }
  const holders = pidsHoldingFile(rec.sessionFile);
  if (holders.length > 0) return `pid ${holders[0]} (holds the session file open)`;
  return null;
}

function main(): void {
  const state = readState();

  const rows: Row[] = Object.entries(state.seats).map(([name, rec]) => {
    const { cls, detail } = classify(rec);
    return { name, rec, cls, detail };
  });

  if (rows.length === 0) {
    console.log(`no seats recorded in ${STATE_FILE} — nothing to recover`);
  } else {
    console.log("seat classification (state.json + run/ + open-fd tables):");
    for (const { name, rec, cls, detail } of rows) {
      const bead = rec.lastBead ? `  bead ${rec.lastBead}` : "";
      console.log(`${name.padEnd(16)} ${cls.padEnd(8)} ${detail}${bead}`);
      if (cls === "DEAD") {
        const attachedBy = sessionAttachment(name, rec, rows); // attach-check
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
