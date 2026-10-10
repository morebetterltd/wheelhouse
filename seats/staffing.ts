#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { hasPool, loadPool, seatEntryFor, staffedSeatName, type Pool } from "./pool";
import { effectiveRoster, staffingPath, type StaffingFile } from "./roster";
import { fleetSnapshot, freeWorkers, freeReviewers, readyWorkNobodyOnIt, type Snapshot } from "./fleet-snapshot";
import { pidAlive } from "./seat-activity";
import { removeSeatWorktree } from "./seat-worktree";
import { QUOTA_RE } from "./quota";
import { askChoice, jevConfig } from "./jev";
import { acquirePidLock, releasePidLock } from "./lock";

const ROOT = path.resolve(import.meta.dir, "..");
const RUN_DIR = path.join(ROOT, "seats", "run");
const LOG_FILE = path.join(ROOT, "seats", "logs", "staffing.log");
const LOCK_FILE = path.join(RUN_DIR, "staffing.lock");
type Role = "workers" | "reviewers";
type DecisionKind = "add-worker" | "add-reviewer" | "drop-seat" | "nothing";
export interface Decision { kind: DecisionKind; role?: Role; seat?: string; entry?: string; reason: string; decider: string; confidence?: number }

function stop(msg: string): never { console.error(`STOP: ${msg}`); process.exit(2); }
function sleep(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeJsonAtomic(file: string, value: any): void { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n"); fs.renameSync(tmp, file); }
function emptyStaffing(): StaffingFile { return { version: 1, seats: {}, rateLimited: {} }; }
function readStaffing(root = ROOT): StaffingFile { const v = readJson(staffingPath(root)); return v && v.version === 1 ? { version: 1, seats: v.seats ?? {}, rateLimited: v.rateLimited ?? {}, lastCheck: v.lastCheck } : emptyStaffing(); }
function writeStaffing(root: string, s: StaffingFile) { writeJsonAtomic(staffingPath(root), s); }
function acquireLock(): number | null { return acquirePidLock(LOCK_FILE); }
function releaseLock(fd: number | null) { releasePidLock(LOCK_FILE, fd); }
function canon(p?: string): string | null { if (!p) return null; const x = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p; try { return fs.realpathSync(x); } catch { return path.resolve(x); } }
function occupiedEntries(root: string, staffing: StaffingFile): Set<string> {
  const out = new Set<string>();
  for (const s of Object.values(staffing.seats ?? {})) out.add(s.entry);
  return out;
}
function syncRateLimitedFromState(root: string, staffing: StaffingFile) {
  const state = readJson(path.join(root, "seats", "state.json"))?.seats ?? {};
  staffing.rateLimited ??= {};
  for (const [seat, rec] of Object.entries<any>(state)) if (rec?.lastCapacityEvent && staffing.seats?.[seat]?.entry) {
    staffing.rateLimited[staffing.seats[seat].entry] = { at: rec.lastCapacityEvent.at ?? new Date().toISOString(), detail: rec.lastCapacityEvent.detail ?? "capacity event" };
  }
}
export function placeSeat(pool: Pool, staffing: StaffingFile, role: Role): { seat: string; entry: string } | null {
  const roleDef = pool.roles[role]; if (!roleDef) return null;
  const occupied = occupiedEntries(pool.root, staffing);
  const occupiedDirs = new Set<string>();
  for (const e of Object.values<any>(staffing.seats ?? {})) occupiedDirs.add(canon(pool.entries[e.entry]?.account?.dir) ?? "");
  // Fixed roster/effective roster entries also reserve their account dir.
  try { for (const e of Object.values<any>(JSON.parse(fs.readFileSync(path.join(pool.root, "seats", "seats.json"), "utf8")).seats ?? {})) occupiedDirs.add(canon(e.account?.dir) ?? ""); } catch {}
  for (const entry of roleDef.entries) {
    if (occupied.has(entry)) continue;
    if (staffing.rateLimited?.[entry]) continue;
    const dir = canon(pool.entries[entry]?.account?.dir);
    if (dir && occupiedDirs.has(dir)) continue;
    return { seat: staffedSeatName(role, entry), entry };
  }
  return null;
}
function liveCount(snap: Snapshot, role: Role): number { return role === "workers" ? snap.workers.live.length : snap.reviewers.live.length; }
function freeCount(snap: Snapshot, role: Role): number { return role === "workers" ? freeWorkers(snap).length : freeReviewers(snap).length; }
export function decide(snap: Snapshot, pool: Pool, staffing: StaffingFile, override?: DecisionKind): Decision {
  const workerRole = pool.roles.workers, reviewerRole = pool.roles.reviewers;
  if (override) return { kind: override, role: override.includes("worker") || override === "drop-seat" ? "workers" : override.includes("reviewer") ? "reviewers" : undefined, reason: "manual override", decider: "rule" };
  const readyAndNobodyOnIt = readyWorkNobodyOnIt(snap);
  if (workerRole && snap.readyCount > 0 && freeWorkers(snap).length === 0 && liveCount(snap, "workers") < workerRole.max) return { kind: "add-worker", role: "workers", reason: readyAndNobodyOnIt ? "ready work and nobody on it" : "ready work and no free worker", decider: "rule" };
  const needsEligibleReviewer = snap.reviewBacklog.some((item) => !freeReviewers(snap).some((r) => r.accountDir && item.authorAccountDir && r.accountDir !== item.authorAccountDir));
  if (reviewerRole && snap.reviewBacklog.length > 0 && needsEligibleReviewer && liveCount(snap, "reviewers") < reviewerRole.max) return { kind: "add-reviewer", role: "reviewers", reason: "review backlog and no eligible free reviewer", decider: "rule" };
  const idleMinutes = pool.idle_drop_minutes ?? 30;
  const cutoff = Date.now() - idleMinutes * 60_000;
  const idle = snap.workers.live.filter((w) => !w.busy && w.lastActivityAt && Date.parse(w.lastActivityAt) < cutoff);
  idle.sort((a, b) => Date.parse(a.lastActivityAt!) - Date.parse(b.lastActivityAt!) || a.name.localeCompare(b.name));
  // Commander ruling: do not drop idle workers while ready work exists; the
  // idle worker should receive work, and dropping it would fight scale-out.
  if (workerRole && snap.readyCount === 0 && snap.workers.live.length > workerRole.min && idle[0]) return { kind: "drop-seat", role: "workers", seat: idle[0].name, entry: idle[0].entry ?? undefined, reason: "idle past drop window", decider: "rule" };
  const idleReviewer = snap.reviewers.live.filter((r) => !r.busy && r.entry && Date.parse(staffing.seats?.[r.name]?.addedAt ?? "") < cutoff).sort((a,b)=>String(staffing.seats?.[a.name]?.addedAt).localeCompare(String(staffing.seats?.[b.name]?.addedAt)))[0];
  if (reviewerRole && snap.reviewers.live.length > reviewerRole.min && idleReviewer) return { kind: "drop-seat", role: "reviewers", seat: idleReviewer.name, entry: idleReviewer.entry ?? undefined, reason: "idle past drop window", decider: "rule" };
  return { kind: "nothing", reason: "nothing to do", decider: "rule" };
}
function truncTitle(s: string): string { return s.length <= 80 ? s : `${s.slice(0, 77)}...`; }
function freeSubscriptions(pool: Pool, staffing: StaffingFile, role: Role): number {
  const roleDef = pool.roles[role]; if (!roleDef) return 0;
  const occupied = occupiedEntries(pool.root, staffing);
  return roleDef.entries.filter((e) => !occupied.has(e) && !staffing.rateLimited?.[e]).length;
}
function jevContext(snap: Snapshot, pool: Pool, staffing: StaffingFile) {
  const w = pool.roles.workers, r = pool.roles.reviewers;
  return {
    counts: {
      ready: snap.readyCount,
      chained: snap.chainedCount,
      overlapping: snap.overlapCount,
      reviewBacklog: snap.reviewBacklog.length,
      workers: { live: snap.workers.live.length, idle: snap.workers.idle, busy: snap.workers.busy, min: w?.min ?? 0, max: w?.max ?? 0, freeSubscriptions: freeSubscriptions(pool, staffing, "workers") },
      reviewers: { live: snap.reviewers.live.length, idle: snap.reviewers.idle, busy: snap.reviewers.busy, min: r?.min ?? 0, max: r?.max ?? 0, freeSubscriptions: freeSubscriptions(pool, staffing, "reviewers") },
    },
    changes: { isaChangedSinceLastCheck: snap.changes.isaChanged, newEpicsSinceLastCheck: snap.changes.newEpics },
    ready: snap.ready.map((x) => ({ title: truncTitle(x.title), chained: x.chained, group: x.groupKey ?? null })),
  };
}
function choiceDecision(choice: string): DecisionKind | null {
  if (choice === "add_worker") return "add-worker";
  if (choice === "add_reviewer") return "add-reviewer";
  if (choice === "drop_seat") return "drop-seat";
  if (choice === "nothing") return "nothing";
  return null;
}
function roleForKind(kind: DecisionKind): Role | undefined { return kind === "add-worker" ? "workers" : kind === "add-reviewer" ? "reviewers" : kind === "drop-seat" ? "workers" : undefined; }
async function decideWithJev(snap: Snapshot, pool: Pool, staffing: StaffingFile, override?: DecisionKind): Promise<Decision> {
  const rule = decide(snap, pool, staffing, override);
  if (override) return rule;
  const cfg = jevConfig();
  if (!cfg.configured) return { ...rule, reason: `jev skipped: ${cfg.why}; ${rule.reason}` };
  const ans = await askChoice({
    text: "Given this fleet state, should we add a worker, add a reviewer, drop a seat, or do nothing this check?",
    options: [
      { id: "add_worker", label: "add worker" },
      { id: "add_reviewer", label: "add reviewer" },
      { id: "drop_seat", label: "drop seat" },
      { id: "nothing", label: "nothing" },
    ],
    context: jevContext(snap, pool, staffing),
  });
  if (!ans.ok) return { ...rule, reason: `jev skipped: ${ans.why}; ${rule.reason}` };
  if (ans.choice === "other") return { ...rule, reason: `jev skipped: other; ${rule.reason}` };
  if (ans.confidence < 0.5) return { ...rule, reason: `jev skipped: low confidence ${ans.confidence.toFixed(2)}; ${rule.reason}` };
  const kind = choiceDecision(ans.choice);
  if (!kind) return { ...rule, reason: `jev skipped: unknown choice; ${rule.reason}` };
  const role = roleForKind(kind);
  const seat = kind === "drop-seat" ? snap.workers.live.filter((w) => !w.busy).sort((a,b)=>String(a.lastActivityAt ?? "").localeCompare(String(b.lastActivityAt ?? "")))[0]?.name : undefined;
  return { kind, role, seat, reason: `jev choice ${ans.choice} probabilities=${JSON.stringify(ans.probabilities)}`, decider: "jev", confidence: ans.confidence };
}

export function clamp(decision: Decision, snap: Snapshot, pool: Pool, staffing: StaffingFile): Decision {
  if (decision.kind === "add-worker") {
    const role = pool.roles.workers; if (!role) return { kind: "nothing", reason: "workers not pooled", decider: decision.decider };
    if (snap.workers.live.length >= role.max) return { kind: "nothing", reason: `at limit: workers ${snap.workers.live.length}/${role.max}`, decider: decision.decider };
    const placed = placeSeat(pool, staffing, "workers");
    if (!placed) return { kind: "nothing", reason: "no free subscription for workers", decider: decision.decider };
    return { ...decision, ...placed, role: "workers" };
  }
  if (decision.kind === "add-reviewer") {
    const role = pool.roles.reviewers; if (!role) return { kind: "nothing", reason: "reviewers not pooled", decider: decision.decider };
    if (snap.reviewers.live.length >= role.max) return { kind: "nothing", reason: `at limit: reviewers ${snap.reviewers.live.length}/${role.max}`, decider: decision.decider };
    const placed = placeSeat(pool, staffing, "reviewers");
    if (!placed) return { kind: "nothing", reason: "no free subscription for reviewers", decider: decision.decider };
    return { ...decision, ...placed, role: "reviewers" };
  }
  if (decision.kind === "drop-seat") {
    const role = decision.role === "reviewers" ? pool.roles.reviewers : pool.roles.workers; if (!role) return { kind: "nothing", reason: `${decision.role ?? "workers"} not pooled`, decider: decision.decider };
    if (!decision.seat) return { kind: "nothing", reason: "drop needs a seat", decider: decision.decider };
    const live = decision.role === "reviewers" ? snap.reviewers.live.length : snap.workers.live.length;
    if (live <= role.min) return { kind: "nothing", reason: `at minimum: ${decision.role ?? "workers"} ${live}/${role.min}`, decider: decision.decider };
  }
  return decision;
}
function lineFor(decision: Decision, snap: Snapshot, pool: Pool): string {
  const w = pool.roles.workers, r = pool.roles.reviewers;
  const esc = decision.reason.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  const conf = Math.max(0, Math.min(1, decision.confidence ?? 0)).toFixed(2);
  return `${new Date().toISOString()} decision=${decision.kind} decider=${decision.decider} conf=${conf} ready=${snap.readyCount} chained=${snap.chainedCount} overlap=${snap.overlapCount} backlog=${snap.reviewBacklog.length} workers=${snap.workers.live.length}/${w?.min ?? 0}..${w?.max ?? 0} reviewers=${snap.reviewers.live.length}/${r?.min ?? 0}..${r?.max ?? 0} seat=${decision.seat ?? "-"} entry=${decision.entry ?? "-"} reason="${esc}"`;
}
function logDecision(line: string) { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + "\n"); console.log(line); }
function lastDecisionLine(root = ROOT): string | null { try { return fs.readFileSync(path.join(root, "seats", "logs", "staffing.log"), "utf8").split(/\r?\n/).filter(Boolean).at(-1) ?? null; } catch { return null; } }
function roleModel(role: any, entry: string): string { return typeof role?.model === "string" ? role.model : role?.model?.[entry] ?? "-"; }
function subscriptionLabel(pool: Pool, entry: string | null): string { if (!entry) return "-"; return pool.entries[entry]?.account?.label || entry; }
function fixedSubscriptionLabel(entry: any, seat: string): string { return entry?.account?.label || entry?.provider || seat; }
function ageSince(iso?: string | null): string { if (!iso) return "unknown"; const ms = Math.max(0, Date.now() - Date.parse(iso)); if (!Number.isFinite(ms)) return "unknown"; const m = Math.floor(ms / 60000); if (m < 1) return "now"; if (m < 60) return `${m}m`; const h = Math.floor(m / 60); if (h < 48) return `${h}h`; return `${Math.floor(h / 24)}d`; }
function statusObject(root: string, pool: Pool, staffing: StaffingFile, snap: Snapshot) {
  const roster = effectiveRoster(root) as Record<string, any>;
  const live = [
    ...snap.workers.live.map((s) => ({ ...s, roleKey: "workers" as Role, role: "worker", idleSince: s.lastActivityAt })),
    ...snap.reviewers.live.map((s) => ({ ...s, roleKey: "reviewers" as Role, role: "verifier", idleSince: null })),
  ].filter((s) => (s.entry && staffing.seats?.[s.name]) || !pool.roles[s.roleKey]);
  const seats = live.sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
    const staffed = s.entry && staffing.seats?.[s.name];
    if (staffed) {
      const entry = s.entry!;
      const poolEntry = pool.entries[entry];
      const roleDef = pool.roles[s.roleKey];
      return { seat: s.name, role: s.role, harness: poolEntry?.harness ?? "-", model: roleModel(roleDef, entry), subscription: subscriptionLabel(pool, entry), state: s.busy ? "busy" : `idle since ${ageSince(s.idleSince)}`, source: "staffed" };
    }
    const fixed = roster[s.name];
    return { seat: s.name, role: s.role, harness: fixed?.harness ?? "-", model: fixed?.model ?? "-", subscription: fixedSubscriptionLabel(fixed, s.name), state: s.busy ? "busy" : `idle since ${ageSince(s.idleSince)}`, source: "fixed" };
  });
  const roles = Object.fromEntries((["workers", "reviewers"] as Role[]).map((role) => {
    const def = pool.roles[role];
    const used = role === "workers" ? snap.workers.live.length : snap.reviewers.live.length;
    const rateLimited = def?.entries.filter((e) => staffing.rateLimited?.[e]).length ?? 0;
    return [role, { used, min: def?.min ?? 0, max: def?.max ?? 0, freeSubscriptions: freeSubscriptions(pool, staffing, role), rateLimited }];
  }));
  return { seats, roles, lastDecision: lastDecisionLine(root), jev: jevConfig().configured ? "configured" : "not configured" };
}
function printStatus(root: string, pool: Pool, staffing: StaffingFile, snap: Snapshot, json: boolean): void {
  const status = statusObject(root, pool, staffing, snap);
  if (json) { console.log(JSON.stringify(status, null, 2)); return; }
  for (const s of status.seats) console.log(`${s.seat} | ${s.role} | ${s.harness} | ${s.model} | ${s.subscription} | ${s.state} | ${s.source}`);
  for (const role of ["workers", "reviewers"] as const) {
    const r = status.roles[role];
    console.log(`${role}: ${r.used} live of ${r.min}..${r.max} (free subscriptions: ${r.freeSubscriptions}, rate-limited: ${r.rateLimited})`);
  }
  console.log(`last decision: ${status.lastDecision ?? "-"}`);
  console.log(`jev: ${status.jev}`);
}
function runAdapter(args: string[]): { status: number; text: string } { const r = spawnSync("bun", ["seats/adapter.ts", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { status: r.status ?? 1, text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }; }
function registerSeat(root: string, staffing: StaffingFile, role: Role, seat: string, entry: string) { staffing.seats[seat] = { role: role === "workers" ? "worker" : "verifier", entry, addedAt: new Date().toISOString() }; writeStaffing(root, staffing); }
function unregisterSeat(root: string, staffing: StaffingFile, seat: string) { delete staffing.seats[seat]; writeStaffing(root, staffing); }
function applyAdd(root: string, pool: Pool, staffing: StaffingFile, d: Decision): Decision {
  if (!d.role || !d.seat || !d.entry) return d;
  registerSeat(root, staffing, d.role, d.seat, d.entry);
  if (d.role === "reviewers") return d;
  const r = runAdapter(["spawn", d.seat]);
  if (r.status !== 0) {
    unregisterSeat(root, staffing, d.seat);
    if (QUOTA_RE.test(r.text)) { staffing.rateLimited ??= {}; staffing.rateLimited[d.entry] = { at: new Date().toISOString(), detail: r.text.split("\n")[0] ?? "quota-shaped failure" }; writeStaffing(root, staffing); }
    return { kind: "nothing", decider: d.decider, reason: `spawn failed: ${r.text || r.status}`, seat: d.seat, entry: d.entry };
  }
  return d;
}
function statePath(root: string): string { return path.join(root, "seats", "state.json"); }
function removeState(root: string, seat: string) { const st = readJson(statePath(root)) ?? { seats: {} }; if (st.seats) delete st.seats[seat]; writeJsonAtomic(statePath(root), st); try { fs.rmSync(path.join(root, "seats", "run", `${seat}.stdin`), { force: true }); } catch {} }
function applyDrop(root: string, staffing: StaffingFile, d: Decision, snap: Snapshot): Decision {
  if (!d.seat) return d;
  const live = [...snap.workers.live, ...snap.reviewers.live].find((s) => s.name === d.seat);
  if (live?.busy) return { ...d, kind: "nothing", reason: `drop refused: ${d.seat} is busy` };
  if (d.role === "reviewers") { unregisterSeat(root, staffing, d.seat); return d; }
  const r = runAdapter(["stop", d.seat]);
  const deadline = Date.now() + Number(process.env.WHEELHOUSE_STAFFING_STOP_MS ?? 30000);
  while (Date.now() < deadline) { const rec = readJson(statePath(root))?.seats?.[d.seat]; if (!rec?.pid || !pidAlive(rec.pid, rec.fifo, rec.startedAt)) break; sleep(50); }
  const rec = readJson(statePath(root))?.seats?.[d.seat];
  if (rec?.pid && pidAlive(rec.pid, rec.fifo, rec.startedAt)) return { ...d, kind: "nothing", reason: `drop deferred: ${d.seat} still exiting` };
  try { removeSeatWorktree(root, d.seat); } catch (e: any) { return { ...d, kind: "nothing", reason: `drop refused: ${e.message}` }; }
  removeState(root, d.seat); unregisterSeat(root, staffing, d.seat);
  return r.status === 0 ? d : { ...d, reason: `dropped after stop report: ${r.text || r.status}` };
}
function usage(): never { stop("usage: staffing.ts check [--dry-run] [--json] | add <workers|reviewers> | drop <seat> | probe <entry> | flag <entry> --reason <text> | status"); }

export async function main(argv = process.argv.slice(2), root = ROOT): Promise<void> {
  const cmd = argv[0] ?? "check";
  if (!hasPool(root)) { console.log("staffing: no pool (fixed roster)"); return; }
  const pool = loadPool(root), dry = argv.includes("--dry-run"), json = argv.includes("--json");
  let staffing = readStaffing(root); syncRateLimitedFromState(root, staffing); writeStaffing(root, staffing);
  if (cmd === "status") { const snap = fleetSnapshot(root, { since: { isaHead: staffing.lastCheck?.isaHead ?? null, at: staffing.lastCheck?.at } }); printStatus(root, pool, staffing, snap, json); return; }
  const fd = acquireLock(); if (fd === null) { console.log("staffing: check already running"); return; }
  try {
    if (cmd === "flag") { const entry = argv[1]; const reason = argv.slice(argv.indexOf("--reason") + 1).join(" ") || "manual flag"; staffing.rateLimited ??= {}; staffing.rateLimited[entry] = { at: new Date().toISOString(), detail: reason }; writeStaffing(root, staffing); console.log(`staffing: flagged ${entry}: ${reason}`); return; }
    if (cmd === "probe") { const entry = argv[1]; if (!entry) usage(); const r = runAdapter(["probe", "--entry", entry]); if (r.status === 0) { delete staffing.rateLimited?.[entry]; writeStaffing(root, staffing); } console.log(r.text || (r.status === 0 ? "OK" : `probe failed ${r.status}`)); process.exitCode = r.status === 0 ? 0 : r.status; return; }
    const snap = fleetSnapshot(root, { since: { isaHead: staffing.lastCheck?.isaHead ?? null, at: staffing.lastCheck?.at } });
    let d: Decision;
    if (cmd === "add") { const role = argv[1] as Role; d = clamp({ kind: role === "reviewers" ? "add-reviewer" : "add-worker", role, reason: "manual add", decider: "rule" }, snap, pool, staffing); }
    else if (cmd === "drop") { const role = (staffing.seats?.[argv[1]]?.role === "verifier" ? "reviewers" : "workers") as Role; d = clamp({ kind: "drop-seat", role, seat: argv[1], reason: "manual drop", decider: "rule" }, snap, pool, staffing); }
    else if (cmd === "check") d = clamp(await decideWithJev(snap, pool, staffing, argv.includes("--decision") ? argv[argv.indexOf("--decision") + 1] as DecisionKind : undefined), snap, pool, staffing);
    else usage();
    if (!dry) {
      if (d.kind === "add-worker" || d.kind === "add-reviewer") d = applyAdd(root, pool, staffing, d);
      else if (d.kind === "drop-seat") d = applyDrop(root, staffing, d, snap);
      staffing = readStaffing(root); staffing.lastCheck = { at: new Date().toISOString(), isaHead: snap.changes.isaHead, decision: d }; writeStaffing(root, staffing);
    }
    const line = lineFor(d, snap, pool); logDecision(line); if (json) console.log(JSON.stringify({ decision: d, snapshot: snap }, null, 2));
  } finally { releaseLock(fd); }
}
if (import.meta.main) main().catch((e) => stop(e.message));
