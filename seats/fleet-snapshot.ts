#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { effectiveRoster, type StaffingFile } from "./roster";
import { agentSettledEvent, lastActivityAt, lastEvent, pidAlive } from "./seat-activity";

const ROOT = path.resolve(import.meta.dir, "..");
const RUN_DIR = path.join(ROOT, "seats", "run");

export interface ReadyItem { id: string; title: string; chained: boolean; groupKey: string | null }
export interface BacklogItem { id: string; title: string; authorSeat: string | null; authorAccountDir: string | null }
export interface LiveWorker { name: string; entry: string | null; accountDir: string | null; busy: boolean; lastBead?: string; lastActivityAt: string | null }
export interface LiveReviewer { name: string; entry: string | null; accountDir: string | null; busy: boolean }
export interface Snapshot { at: string; ready: ReadyItem[]; readyCount: number; chainedCount: number; overlapCount: number; reviewBacklog: BacklogItem[]; workers: { live: LiveWorker[]; idle: number; busy: number }; reviewers: { live: LiveReviewer[]; idle: number; busy: number }; changes: { isaHead: string | null; isaChanged: boolean; newEpics: number } }

function stop(msg: string): never { console.error(`STOP: ${msg}`); process.exit(2); }
function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function runBd(root: string, args: string[]): any[] {
  const r = spawnSync("bd", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) stop(`bd ${args.join(" ")} failed (${r.status ?? r.error?.message}): ${(r.stderr || r.stdout || "").trim()}`);
  try { return JSON.parse(r.stdout || "[]"); } catch (e: any) { stop(`bd ${args.join(" ")} did not return JSON: ${e.message}`); }
}
function idOf(x: any): string { return String(x?.id ?? x?.key ?? x?.name ?? ""); }
function titleOf(x: any): string { return String(x?.title ?? x?.summary ?? x?.description ?? ""); }
function labelsOf(x: any): string[] { return Array.isArray(x?.labels) ? x.labels.map(String) : []; }
function statusOf(x: any): string { return String(x?.status ?? "").toLowerCase(); }
function assigneeOf(x: any): string | null { const v = x?.assignee ?? x?.owner ?? x?.assigned_to; return typeof v === "string" && v ? v : null; }
function parentOf(x: any): string | null { const v = x?.parent ?? x?.parent_id ?? x?.parentId; return typeof v === "string" && v ? v : null; }
function bodyOf(x: any): string { return [x?.description, x?.body, x?.notes].filter((v) => typeof v === "string").join("\n"); }
function integrationLine(x: any): string | null { const m = bodyOf(x).match(/^\s*Integration:\s*(\S+)/m); return m?.[1] ?? null; }
function groupKey(x: any): string | null { return integrationLine(x) ?? parentOf(x); }
function normalizeList(rows: any): any[] { return Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : Array.isArray(rows?.issues) ? rows.issues : []; }
function canonicalDir(raw: string | undefined): string | null { if (!raw) return null; const p = raw.startsWith("~/") ? path.join(process.env.HOME ?? "", raw.slice(2)) : raw; try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

function allIssues(root: string): any[] { return normalizeList(runBd(root, ["list", "--json", "--limit", "5000"])); }
function readyIssues(root: string): any[] { return normalizeList(runBd(root, ["ready", "--json"])); }
// Measured for bd 1.2.2: `bd show <id> --json` carries dependency/blocker fields in JSON; this parser accepts blocks/dependents/dependencies names from that output and from `bd list --json` rows.
function dependentIds(row: any): string[] {
  const xs = row?.blocks ?? row?.dependents ?? row?.blocked_by_me ?? row?.children ?? [];
  return Array.isArray(xs) ? xs.map((v) => typeof v === "string" ? v : idOf(v)).filter(Boolean) : [];
}
function chainedReadyIds(ready: any[], all: any[]): Set<string> {
  const readyIds = new Set(ready.map(idOf));
  const out = new Set<string>();
  for (const row of all) for (const dep of dependentIds(row)) if (readyIds.has(dep)) out.add(dep);
  return out;
}

function readState(root: string): any { return readJson(path.join(root, "seats", "state.json"))?.seats ?? {}; }
function readStaffing(root: string): StaffingFile | null { return readJson(path.join(root, "seats", "staffing.json")); }
function entryForSeat(staffing: StaffingFile | null, name: string): string | null { return staffing?.seats?.[name]?.entry ?? null; }
function verifyMarkerLive(root: string, seat: string): boolean {
  const file = path.join(root, "seats", "run", `verify.${seat}.json`);
  const marker = readJson(file);
  return !!marker?.pid && pidAlive(Number(marker.pid));
}
function anyVerifyMarkerForBead(root: string, bead: string): boolean {
  const runDir = path.join(root, "seats", "run");
  if (!fs.existsSync(runDir)) return false;
  for (const f of fs.readdirSync(runDir)) if (f.startsWith("verify.") && f.endsWith(".json")) {
    const m = readJson(path.join(runDir, f));
    if (m?.bead === bead && m?.pid && pidAlive(Number(m.pid))) return true;
  }
  return false;
}
function isaHead(root: string): string | null { try { return execFileSync("git", ["log", "-1", "--format=%H", "--", "wheelhouse/ISA.md"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; } }

export function fleetSnapshot(root: string = ROOT, opts: { since?: { isaHead?: string | null; at?: string } } = {}): Snapshot {
  const at = new Date().toISOString();
  const readyRaw = readyIssues(root);
  const all = allIssues(root);
  const statuses = new Map(all.map((x) => [idOf(x), { status: statusOf(x), labels: labelsOf(x), assignee: assigneeOf(x), title: titleOf(x) }]));
  const chained = chainedReadyIds(readyRaw, all);
  const groups = new Map<string, number>();
  for (const r of readyRaw) { const g = groupKey(r); if (g) groups.set(g, (groups.get(g) ?? 0) + 1); }
  const ready = readyRaw.map((r) => { const g = groupKey(r); return { id: idOf(r), title: titleOf(r), chained: chained.has(idOf(r)), groupKey: g }; });
  const roster = effectiveRoster(root) as Record<string, any>;
  const state = readState(root);
  const staffing = readStaffing(root);
  const authorDirs = new Map<string, string | null>();
  for (const [name, entry] of Object.entries(roster)) authorDirs.set(name, canonicalDir((entry as any).account?.dir));

  const reviewBacklog: BacklogItem[] = all.filter((x) => labelsOf(x).includes("needs-review") && !anyVerifyMarkerForBead(root, idOf(x))).map((x) => {
    const seat = assigneeOf(x); return { id: idOf(x), title: titleOf(x), authorSeat: seat && roster[seat] ? seat : null, authorAccountDir: seat ? (authorDirs.get(seat) ?? null) : null };
  });

  const workerLive: LiveWorker[] = [];
  for (const [name, rec] of Object.entries<any>(state)) {
    const entry = roster[name];
    if (!entry || entry.external || entry.role !== "worker") continue;
    if (!pidAlive(rec.pid, rec.fifo, rec.startedAt)) continue;
    const st = rec.lastBead ? statuses.get(rec.lastBead) : undefined;
    const inReviewOrRework = !!st && (st.status === "open" || st.status === "in_progress" || st.labels.includes("needs-review"));
    const settled = agentSettledEvent(lastEvent(rec.log));
    const busy = !settled || inReviewOrRework;
    workerLive.push({ name, entry: entryForSeat(staffing, name), accountDir: authorDirs.get(name) ?? null, busy, lastBead: rec.lastBead, lastActivityAt: lastActivityAt(rec.log)?.toISOString() ?? null });
  }
  const reviewersLive: LiveReviewer[] = [];
  for (const [name, entry] of Object.entries<any>(roster)) {
    if (entry.external || entry.role !== "verifier") continue;
    reviewersLive.push({ name, entry: entryForSeat(staffing, name), accountDir: authorDirs.get(name) ?? null, busy: verifyMarkerLive(root, name) });
  }
  const head = isaHead(root);
  const newEpics = all.filter((x) => String(x?.type ?? "").toLowerCase() === "epic" && (!opts.since?.at || Date.parse(String(x?.created ?? x?.created_at ?? 0)) > Date.parse(opts.since.at))).length;
  return {
    at,
    ready,
    readyCount: ready.length,
    chainedCount: ready.filter((r) => r.chained).length,
    overlapCount: ready.filter((r) => r.groupKey && (groups.get(r.groupKey) ?? 0) > 1).length,
    reviewBacklog,
    workers: { live: workerLive, busy: workerLive.filter((w) => w.busy).length, idle: workerLive.filter((w) => !w.busy).length },
    reviewers: { live: reviewersLive, busy: reviewersLive.filter((r) => r.busy).length, idle: reviewersLive.filter((r) => !r.busy).length },
    changes: { isaHead: head, isaChanged: !!opts.since && !!opts.since.isaHead && head !== opts.since.isaHead, newEpics },
  };
}

export function readyWorkNobodyOnIt(snap: Snapshot): boolean { return snap.readyCount > 0 && snap.workers.busy === 0; }
export function freeWorkers(snap: Snapshot): LiveWorker[] { return snap.workers.live.filter((w) => !w.busy); }
export function freeReviewers(snap: Snapshot): LiveReviewer[] { return snap.reviewers.live.filter((r) => !r.busy); }

if (import.meta.main) {
  const json = process.argv.includes("--json");
  const snap = fleetSnapshot(ROOT);
  if (json) console.log(JSON.stringify(snap, null, 2));
  else console.log(`ready ${snap.readyCount} (${snap.chainedCount} chained, ${snap.overlapCount} overlapping) · review backlog ${snap.reviewBacklog.length} · workers ${snap.workers.live.length} live/${snap.workers.idle} idle · reviewers ${snap.reviewers.live.length} live/${snap.reviewers.idle} idle · nobody-on-it=${readyWorkNobodyOnIt(snap) ? "yes" : "no"}`);
}
