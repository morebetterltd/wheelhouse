// Completed-work health, shared by the herald's heartbeat/status and its
// external supervisor. Delivery/seat diagnostics NEVER enter the verdict.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function text(file: string, limit = 65536, offset = 0): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd); if (!st.isFile()) return "";
    const b = Buffer.alloc(Math.min(limit, Math.max(0, st.size - offset)));
    return b.subarray(0, fs.readSync(fd, b, 0, b.length, offset)).toString("utf8");
  } catch (e: any) { if (["ENOENT", "ELOOP", "EACCES"].includes(e.code)) return ""; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(file: string): any { try { return JSON.parse(text(file)); } catch { return null; } }
function atomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (e: any) { if (e.code !== "ENOENT") throw e; } }
}
function pid(file: string): number { const s = text(file, 64).trim(); return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) > 1 ? Number(s) : 0; }
function alive(n: number): boolean {
  if (n <= 1) return false;
  try { process.kill(n, 0); return true; } catch (e: any) { if (e.code === "ESRCH" || e.code === "EPERM") return false; throw e; }
}
export function scanClock(): number {
  const raw = process.env.WHEELHOUSE_SUPERVISOR_NOW;
  const n = raw ? Date.parse(raw) : Date.now();
  if (!Number.isFinite(n)) throw Error("invalid WHEELHOUSE_SUPERVISOR_NOW"); return n;
}
export function scanStallMs(root: string): number {
  const setting = text(path.join(root, "wheelhouse/.template-source")).split(/\r?\n/).filter(s => s.startsWith("scan-stall-minutes=")).pop()?.split("=").slice(1).join("=").trim();
  const raw = process.env.WHEELHOUSE_SCAN_STALL_MS;
  if (raw !== undefined && raw.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return setting && Number.isFinite(Number(setting)) && Number(setting) >= 0 ? Number(setting) * 60000 : 300000;
}
function seconds(n: number): number { return Math.max(0, Math.floor(n / 1000)); }
function tail(file: string): string {
  let size = 0; try { size = fs.statSync(file).size; } catch { return ""; }
  return text(file, 8192, Math.max(0, size - 8192)).trim().split(/\r?\n/).slice(-5).join("; ");
}
export interface HeraldHeartbeat {
  pid: number; startedAt: string; at: string; scanCount: number;
  inboxBytes: number; drainCursor: number; undrainedRows: number;
  lastPoke: { outcome: string; at: string } | null; alertsLastLaunchAt: string | null;
}
export function writeHeraldHeartbeat(root: string, facts: Pick<HeraldHeartbeat, "startedAt" | "scanCount" | "lastPoke" | "alertsLastLaunchAt">, force: boolean): boolean {
  const file = path.join(root, "seats/run/herald.heartbeat.json"), prior = json(file), now = Date.now();
  const raw = process.env.WHEELHOUSE_HERALD_HEARTBEAT_MS;
  const interval = raw !== undefined && raw.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 10000;
  const age = now - Date.parse(prior?.at);
  if (!force && prior?.pid === process.pid && age >= 0 && age < interval) return false;
  const inbox = path.join(root, "seats/inbox.jsonl"); let inboxBytes = 0;
  try { inboxBytes = fs.statSync(inbox).size; } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  const rawCursor = Number(text(path.join(root, "seats/inbox.cursor"), 64).trim() || 0);
  const drainCursor = Number.isFinite(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
  let undrainedRows = 0;
  if (drainCursor < inboxBytes) {
    const fd = fs.openSync(inbox, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (!fs.fstatSync(fd).isFile()) throw Error("heartbeat inbox is not a regular file");
      const chunk = Buffer.alloc(65536); let offset = drainCursor, content = false;
      while (offset < inboxBytes) {
        const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, inboxBytes - offset), offset); if (!bytes) break;
        offset += bytes;
        for (const byte of chunk.subarray(0, bytes)) {
          if (byte === 10) { if (content) undrainedRows++; content = false; }
          else if (byte !== 13 && byte !== 32 && byte !== 9) content = true;
        }
      }
    } finally { fs.closeSync(fd); }
  }
  atomic(file, { pid: process.pid, ...facts, at: new Date(now).toISOString(), inboxBytes, drainCursor, undrainedRows });
  return true;
}
function diagnostics(root: string, hb: any, now: number): string {
  const wake = hb?.lastPoke;
  const lastWake = wake && Number.isFinite(Date.parse(wake.at)) ? `${wake.outcome} ${seconds(now - Date.parse(wake.at))}s ago` : "none";
  const streams = json(path.join(root, "seats/state.json"))?.seats || {};
  const events = Object.entries(streams).slice(0, 32).map(([seat, value]: [string, any]) => {
    const line = value?.log ? tail(path.resolve(root, value.log)).split("; ").pop() : "";
    try {
      const ev = JSON.parse(line || "{}");
      const phase = ev.type === "tool_execution_start" ? "tool wait" : ["message_start", "message_update"].includes(ev.type) ? "model" : "unknown";
      return `${seat} ${phase} (last event ${ev.type || "unknown"})`;
    } catch { return `${seat} last event unknown`; }
  }).join(", ");
  let lag = "unknown";
  try {
    const first = text(path.join(root, "seats/inbox.jsonl"), 65536, hb?.drainCursor || 0).split("\n").find(line => line.trim());
    const at = first ? Date.parse(JSON.parse(first).at) : NaN;
    if (Number.isFinite(at)) lag = `${seconds(now - at)}s`;
  } catch { /* diagnostic only, never grounds for a restart */ }
  return `undrained rows ${hb?.undrainedRows ?? "unknown"} · last wake ${lastWake} · inbox lag ${lag}${streams && events ? " · " + events : ""}`;
}
export function scanHealth(root: string, now = scanClock()) {
  const run = path.join(root, "seats/run"), limit = scanStallMs(root), heraldPid = pid(path.join(run, "herald.pid"));
  const hb = json(path.join(run, "herald.heartbeat.json"));
  const matching = alive(heraldPid) && hb?.pid === heraldPid && Number.isFinite(Date.parse(hb?.at));
  const heraldAgeMs = matching ? now - Date.parse(hb.at) : 0;
  const heraldStalled = matching && heraldAgeMs >= limit;
  const detail = diagnostics(root, matching ? hb : null, now);
  const heraldLine = heraldStalled ? `herald STALLED pid ${heraldPid} · no completed scan for ${seconds(heraldAgeMs)}s · ${detail}` :
    alive(heraldPid) ? `herald RUNNING pid ${heraldPid} · ${matching ? `last scan ${seconds(heraldAgeMs)}s ago · ${detail}` : "scan health unknown (no heartbeat from this pid)"}` : `herald DEAD pid ${heraldPid || "?"}`;
  const snapshot = json(path.join(run, "fleet-snapshot.json")), snapshotAt = snapshot?.at;
  const snapshotKnown = Number.isFinite(Date.parse(snapshotAt));
  const snapshotAgeMs = snapshotKnown ? now - Date.parse(snapshotAt) : 0;
  const interval = Number.isFinite(snapshot?.intervalMs) && snapshot.intervalMs >= 0 ? snapshot.intervalMs : 60000;
  const missingOld = !fs.existsSync(path.join(run, "fleet-snapshot.json")) && matching && Number.isFinite(Date.parse(hb.startedAt)) && now - Date.parse(hb.startedAt) >= limit;
  const alertsStalled = snapshotKnown ? snapshotAgeMs >= Math.max(limit, 3 * interval) : missingOld;
  const alertsPid = pid(path.join(run, "alerts.lock")), passAlive = alive(alertsPid);
  const logs = [tail(path.join(root, "seats/logs/alerts.stderr.log")), tail(path.join(root, "seats/logs/alerts.out.log"))].filter(Boolean).join("; ") || "no retained output";
  const snapshotAge = snapshotKnown ? `snapshot ${seconds(snapshotAgeMs)}s old` : "snapshot missing";
  const alertsLine = alertsStalled ? `alerts ${passAlive ? "STALLED" : "FAILING"} ${snapshotAge} · ${passAlive ? `pass pid ${alertsPid} wedged` : `no live pass · last: ${logs}`}` : snapshotKnown ? `alerts OK ${snapshotAge}` : "alerts NONE yet";
  return { now, limit, hb, heraldPid, matching, heraldAgeMs, heraldStalled, heraldLine, detail,
    snapshotAt, alertsStalled, alertsPid, passAlive, logs, alertsLine, alertsEpisode: snapshotKnown ? snapshotAt : `missing:${matching ? hb.startedAt : "unknown"}` };
}
type Escalation = { kind: "alert" | "need" | "retiring"; name: string; first: string; detail: string };
function signal(n: number, name: "SIGTERM" | "SIGKILL"): boolean {
  if (n <= 1 || n === process.pid || n === process.ppid) throw Error("refusing unsafe health signal target");
  try { process.kill(n, name); return true; } catch (e: any) { if (e.code === "ESRCH") return false; throw e; }
}
function appendStall(root: string, name: string, episode: string, now: number, detail: string): boolean {
  const inbox = path.join(root, "seats/inbox.jsonl"), id = createHash("sha256").update(`daemon-stalled\0${name}\0${episode}`).digest("hex");
  // Match ids as JSON records, not substrings in terminal-rendered output.
  const body = fs.existsSync(inbox) ? fs.readFileSync(inbox, "utf8") : "";
  if (body.split("\n").some(line => { try { return JSON.parse(line).id === id; } catch { return false; } })) return false;
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.appendFileSync(inbox, JSON.stringify({ id, at: new Date(now).toISOString(), seat: "supervisor", class: "daemon-stalled", state: "failed", title: `${name} stalled`, detail }) + "\n");
  return true;
}
export function tickScanHealth(root: string): Escalation[] {
  const h = scanHealth(root), stateFile = path.join(root, "seats/run/supervisor.state.json"), state = json(stateFile) || {};
  state.daemons ||= {}; const actions: Escalation[] = []; let changed = false;
  const log = (s: string) => { const f = path.join(root, "seats/logs/supervisor.out.log"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `${new Date(h.now).toISOString()} ${s}\n`); };
  for (const name of ["herald", "alerts"]) {
    const rec = state.daemons[name] ||= {}, holder = name === "herald" ? h.heraldPid : h.alertsPid, pending = rec.stallKill;
    if (pending && pending.pid === holder && alive(holder)) {
      if (pending.signal === "TERM") {
        if (signal(holder, "SIGKILL")) log(`${name} stall KILL pid ${holder}`);
        pending.signal = "KILL"; changed = true;
        // Observe retirement on the following tick, before the existing
        // launcher can replace this herald in the same kill turn.
        if (name === "herald") actions.push({ kind: "retiring", name, first: String(holder), detail: "KILL sent" });
      }
      continue;
    }
    if (pending) { delete rec.stallKill; changed = true; }
    if (rec.crashLoop) continue;
    const stalled = name === "herald" ? h.heraldStalled : h.alertsStalled;
    if (!stalled) continue;
    const episode = name === "herald" ? `${h.heraldPid}:${h.hb.at}` : h.alertsEpisode;
    const detail = name === "herald" ? `No completed scan for ${seconds(h.heraldAgeMs)}s; pid ${holder}; ${h.detail}. Cost: fleet updates may be delayed. Next: the supervisor will retire and restart the herald; inspect seats/logs/herald.out.log if this repeats.` :
      `${h.alertsLine}. Cost: fleet health updates are stale. Next: ${h.passAlive ? "the supervisor will retire the wedged pass; inspect seats/logs/alerts.out.log if this repeats" : "inspect seats/logs/alerts.out.log and repair the failing alerts check"}. Last output: ${h.logs}`;
    if ((name === "herald" || h.passAlive) && alive(holder)) {
      if (!signal(holder, "SIGTERM")) continue;
      rec.stallKill = { pid: holder, at: new Date(h.now).toISOString(), episode, signal: "TERM" }; changed = true;
      log(`${name} stalled: ${detail}`); appendStall(root, name, episode, h.now, detail);
      if (name === "alerts") {
        rec.restarts = (rec.restarts || []).filter((at: string) => Date.parse(at) >= h.now - 300000 && Date.parse(at) <= h.now);
        rec.restarts.push(new Date(h.now).toISOString()); rec.crashLoop = rec.restarts.length >= 3;
        if (rec.crashLoop) actions.push({ kind: "alert", name, first: rec.restarts[0], detail });
      }
    } else if (name === "alerts") {
      if (appendStall(root, name, episode, h.now, detail)) log(`alerts failing: ${detail}`);
      // A previously wedged pass can become a no-live-pass failure without a
      // new snapshot. Notification dedupe is independent of the inbox row.
      if (rec.failingEpisode !== episode) {
        rec.failingEpisode = episode; changed = true;
        actions.push({ kind: "need", name, first: episode, detail });
      }
    }
  }
  if (changed) atomic(stateFile, state);
  return actions;
}
if (import.meta.main) {
  const [mode, root] = process.argv.slice(2); if (!root) throw Error("scan-health requires an install root");
  if (mode === "--tick") for (const a of tickScanHealth(root)) console.log([a.kind, a.name, a.first, a.detail].map(s => s.replace(/[\x1f\r\n]/g, " ")).join("\x1f"));
  else if (mode === "--herald-status") console.log(scanHealth(root).heraldLine);
  else if (mode === "--alerts-status") console.log(scanHealth(root).alertsLine);
  else throw Error("unknown scan-health mode");
}
