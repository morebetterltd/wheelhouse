import * as fs from "node:fs";
import { acquirePidLock } from "./lock";

// Cadences schedule retries/visibility only. Neither can expire a live owner.
const RETRY_MS = 25;
const REPORT_MS = 1000;

export class StateLockCancelled extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

function recordedHolder(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return "holder unknown (non-regular lock)";
    if (st.size > 64) return "holder unknown (invalid PID record)";
    const buf = Buffer.alloc(64);
    const raw = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8").trim();
    const pid = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(pid) && pid <= 0x7fffffff
      ? `recorded holder pid=${pid}`
      : `holder unknown (${raw ? "invalid PID record" : "empty/incomplete lock"})`;
  } catch (e: any) {
    return `holder unknown (${e?.code === "ENOENT" ? "lock absent" : e?.code === "ELOOP" ? "symlink lock" : "lock unreadable"})`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Injectable scheduling/observation lets tests advance reporting time without
// adding production environment knobs or host-time pass/fail deadlines.
export interface StateLockWaitOptions {
  now?: () => number;
  pause?: () => Promise<void>;
  report?: (message: string) => void;
}

export async function waitForStateLock(file: string, options: StateLockWaitOptions = {}): Promise<number> {
  const now = options.now ?? (() => performance.now());
  const report = options.report ?? ((message: string) => { process.stderr.write(message + "\n"); });
  let fd = acquirePidLock(file);
  if (fd !== null) return fd;
  const since = new Date().toISOString();
  let holder = recordedHolder(file), lastHolder = "", lastReport = -Infinity;
  let cancelled: NodeJS.Signals | null = null;
  let wake = () => {};
  const interrupt = () => { cancelled = "SIGINT"; wake(); };
  const terminate = () => { cancelled = "SIGTERM"; wake(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    while (true) {
      holder = recordedHolder(file);
      if (cancelled) {
        throw new StateLockCancelled(
          `state lock wait cancelled by ${cancelled}: ${file}; ${holder}; waiting since ${since}; owner's lock left untouched`,
          cancelled === "SIGINT" ? 130 : 143,
        );
      }
      const at = now();
      if (holder !== lastHolder || at - lastReport >= REPORT_MS) {
        report(`WAIT: ${file}; ${holder}; waiting since ${since}; no live-holder timeout (cancel with SIGINT or SIGTERM)`);
        lastHolder = holder;
        lastReport = at;
      }
      await (options.pause ? options.pause() : new Promise<void>(resolve => {
        const timer = setTimeout(resolve, RETRY_MS);
        wake = () => { clearTimeout(timer); resolve(); };
      }));
      // Cancellation wins over acquiring a newly released owner's lock.
      if (cancelled) continue;
      try { fd = acquirePidLock(file); }
      catch (e: any) {
        throw new Error(`state lock wait stopped: ${file}; ${recordedHolder(file)}; waiting since ${since}; ${e.message}`);
      }
      if (fd !== null) return fd;
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
