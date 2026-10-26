// Last completed full run and last missed attempt are separate: a missed
// attempt must never erase a red result or release the full-review brake.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface NightlyCompleted {
  date: string;
  tip: string;
  rc: number;
  logPath: string;
  elapsedMs: number;
  failedSuites: string[];
}
export interface NightlyResult extends NightlyCompleted {
  filtered?: boolean;
  lastCompleted?: NightlyCompleted;
}
export interface NightlyMissed { date: string; reason: string; tip?: string }
export type NightlyRead<T> = { value: T | null; error?: string };
const stamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const tip = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
export function nightlyNow(): string {
  const raw = process.env.WHEELHOUSE_SUPERVISOR_NOW;
  const date = raw ? new Date(raw) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid supervisor clock for nightly sweep");
  return date.toISOString();
}
export function nightlyPath(root: string, missed = false): string {
  return path.join(root, "seats", "run", missed ? "nightly-sweep-missed.json" : "nightly-sweep.json");
}
function read<T>(file: string, valid: (v: any) => boolean): NightlyRead<T> {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256 * 1024) throw new Error("not a bounded regular record");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!valid(value)) throw new Error("invalid record schema");
    return { value };
  } catch (e: any) {
    const reason = e instanceof SyntaxError ? "invalid JSON" : e.code || e.message;
    return e.code === "ENOENT" ? { value: null } : { value: null, error: `cannot read ${path.basename(file)}: ${reason}` };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validCompleted(v: any): boolean {
  return v && stamp(v.date) && tip(v.tip) && (v.rc === 0 || v.rc === 1) &&
    typeof v.logPath === "string" && !!v.logPath && Number.isSafeInteger(v.elapsedMs) && v.elapsedMs >= 0 &&
    Array.isArray(v.failedSuites) && v.failedSuites.every((n: unknown) => typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.selftest\.sh$/.test(n));
}
export function readNightlyResult(root: string): NightlyRead<NightlyResult> {
  return read(nightlyPath(root), v => validCompleted(v) && (v.filtered === undefined || typeof v.filtered === "boolean") &&
    (v.lastCompleted === undefined || (validCompleted(v.lastCompleted) && !v.lastCompleted.filtered)));
}
export function completedNightly(v: NightlyResult | null): NightlyCompleted | null {
  const full = v?.filtered ? v.lastCompleted : v;
  return full ? { date: full.date, tip: full.tip, rc: full.rc, logPath: full.logPath, elapsedMs: full.elapsedMs, failedSuites: full.failedSuites } : null;
}
export function readNightlyMissed(root: string): NightlyRead<NightlyMissed> {
  return read(nightlyPath(root, true), v => v && stamp(v.date) && typeof v.reason === "string" && !!v.reason && (v.tip === undefined || tip(v.tip)));
}
export function writeNightlyJson(file: string, value: NightlyResult | NightlyMissed): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (e: any) { if (e.code !== "ENOENT") throw e; } }
}
export function recordNightlyMissed(root: string, reason: string, currentTip?: string): void {
  writeNightlyJson(nightlyPath(root, true), { date: nightlyNow(), reason, ...(currentTip ? { tip: currentTip } : {}) });
}
export function nightlyBrake(root: string): string | null {
  const result = readNightlyResult(root);
  if (result.error) return `nightly state invalid: ${result.error}`;
  const completed = completedNightly(result.value);
  if (completed && completed.rc !== 0) return `nightly red ${completed.date} ${completed.tip}`;
  return result.value?.filtered ? `nightly filtered ${result.value.date} ${result.value.tip}` : null;
}
export function nightlyConditions(root: string) {
  const result = readNightlyResult(root), missed = readNightlyMissed(root);
  const completed = completedNightly(result.value);
  const red = !!completed && completed.rc !== 0;
  const filtered = result.value?.filtered ? "latest nightly used a filtered fixture selection, not full coverage" : "";
  const missedOn = !!(result.error || missed.error || filtered || (missed.value && (!result.value || missed.value.date >= result.value.date)));
  return {
    result: result.value, completed, missed: missed.value,
    red: { on: red, sig: "nightly-sweep-red", detail: completed ? `date=${completed.date}; tip=${completed.tip}; failed suites=${completed.failedSuites.join(", ") || "none"}; log=${completed.logPath}` : "" },
    unavailable: { on: missedOn, sig: "nightly-sweep-missed", detail: result.error || missed.error || filtered || (missed.value ? `date=${missed.value.date}; reason=${missed.value.reason}` : "") },
  };
}

// Read-only preflight. Never repair, delete, signal or wait on someone else's
// lock. The runner's no-wait admission closes the check/start race as well.
export function nightlySkipReason(root: string): string | null {
  const pause = path.resolve(root, process.env.WHEELHOUSE_SUPERVISOR_PAUSE_FILE || "seats/run/paused");
  try { fs.lstatSync(pause); return "fleet pause marker present"; } catch (e: any) { if (e.code !== "ENOENT") return `cannot inspect fleet pause marker: ${e.code || e.message}`; }
  const lock = path.resolve(process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK || "/tmp/wheelhouse-selftest-sweep.lock");
  let fd: number | undefined;
  try {
    const st = fs.lstatSync(lock);
    if (!st.isDirectory() || st.isSymbolicLink()) return "host sweep lock is not a regular ownership directory";
    fd = fs.openSync(path.join(lock, "pid"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 32) return "host sweep lock has no bounded owner pid";
    const text = fs.readFileSync(fd, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) return "host sweep lock has an invalid owner pid";
    try { process.kill(Number(text), 0); return `host sweep lock busy (pid ${text})`; }
    catch (e: any) { if (e.code === "ESRCH") return null; return `host sweep lock owner is live or unverifiable (pid ${text})`; }
  } catch (e: any) {
    if (e.code === "ENOENT") {
      try { fs.lstatSync(lock); return "host sweep lock has incomplete ownership"; } catch (absent: any) { if (absent.code === "ENOENT") return null; }
    }
    return `cannot inspect host sweep lock: ${e.code || e.message}`;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
if (import.meta.main) {
  const root = path.resolve(process.env.WHEELHOUSE_NIGHTLY_ROOT || path.join(import.meta.dir, ".."));
  if (process.argv[2] === "--missed" && process.argv[3]) {
    recordNightlyMissed(root, process.argv[3]); console.log(`nightly sweep skipped: ${process.argv[3]}`); process.exitCode = 75;
  } else if (process.argv[2] !== "--check") { console.error("usage: nightly-state.ts --check | --missed <reason>"); process.exitCode = 2; }
  else {
    const reason = nightlySkipReason(root);
    if (reason) { recordNightlyMissed(root, reason); console.log(`nightly sweep skipped: ${reason}`); process.exitCode = 75; }
  }
}
