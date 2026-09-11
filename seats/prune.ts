#!/usr/bin/env bun
/**
 * prune.ts — scan and reclaim safe Wheelhouse/dev-machine debris.
 *
 * Usage:
 *   bun seats/prune.ts scan [--root <dir>]... [--format tsv|json] [--include-optional]
 *   bun seats/prune.ts prune --from-file <scan.tsv|scan.json> [--yes] [--categories a,b]
 *   bun seats/prune.ts categories
 *
 * Dry-run is the default. `prune` only acts from a reviewed scan file and only
 * with --yes. Rows marked needs-review or seat-anchor are never acted on.
 * Scratch cleanup is closed-bead-only: bead-named scratch for open or
 * in-progress beads is emitted as needs-review and never pruned.
 * Build-cache rows are only directories a clean build regenerates at a project
 * root or package root: .wheelhouse-build, dist, build, .next, out, .build,
 * target, .NET bin/obj, and Xcode DerivedData when explicitly under a scanned
 * root. A directory below a dependency tree (node_modules, vendor, .venv,
 * venv, Pods, or a dependency-like path segment) is never a safe build-cache.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_CONTAINERS = [".wheelhouse-worktrees", ".worktrees"];
const INTEGRATION_REFS = ["main", "master", "develop", "staging", "production", "release/"];
const DEPENDENCY_SEGMENTS = new Set(["node_modules", "vendor", ".venv", "venv", "Pods"]);
const NEVER = new Set(["needs-review", "seat-anchor"]);

interface Row {
  category: string;
  safe: 0 | 1;
  repo: string;
  path: string;
  branch: string;
  size_bytes: number;
  size_human: string;
  action: "rm" | "worktree" | "branch" | "simctl" | "xctest-devices" | "none";
  reason: string;
}

const CATEGORIES: Record<string, string> = {
  "merged-worktree": "registered fleet worktree: clean, closed bead, tip merged to an integration ref and present on a remote ref",
  "detached-snapshot": "registered detached worktree: clean and tip present on a remote ref",
  "orphaned-worktree": "directory under a worktree container that git no longer registers",
  "stale-branch": "local fleet branch with no worktree, closed bead, tip merged to an integration ref and present on a remote ref",
  "build-cache": "regenerable build output at a project/package root: .wheelhouse-build, dist, build, .next, out, .build, target, .NET bin/obj, DerivedData; never below dependency dirs",
  "bench-junk": "stale .wheelhouse-bench.lock.stale.* bench lock directories",
  "bead-runs": "closed bead scratch under .wheelhouse-runs/<bead>*",
  "bead-tmp": "closed bead scratch under /private/tmp/<bead>-*",
  "bead-simulator": "simctl device named <closed-bead>-*",
  "xctest-devices": "idle XCTestDevices simctl set; pruned with simctl --set ... delete all",
  "seat-anchor": "worktree currently recorded in seats/state.json; never pruned",
  "needs-review": "dirty tree, open bead, unmerged/unpushed work, occupied seat, or unverifiable state; never pruned",
  "node-modules": "opt-in regenerable dependency install tree",
};

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), code: r.status };
}
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function subdirs(p: string): string[] { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name)); } catch { return []; } }
function bytes(p: string): number { const r = run("du", ["-sk", p]); const n = Number((r.out.split(/\s+/)[0] ?? "0")); return Number.isFinite(n) ? n * 1024 : 0; }
function human(n: number): string { const u = ["B", "K", "M", "G", "T"]; let v = n, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(1)}${u[i]}`; }
function rel(root: string, p: string): string { const r = path.relative(root, p); return r && !r.startsWith("..") ? r : p; }
function row(category: string, safe: boolean, repo: string, p: string, branch: string, action: Row["action"], reason: string, sizeOverride?: number): Row {
  const b = sizeOverride ?? (fs.existsSync(p) ? bytes(p) : 0);
  return { category, safe: safe ? 1 : 0, repo, path: p, branch, size_bytes: b, size_human: human(b), action, reason };
}
function stop(message: string): never { console.error(`STOP: ${message}`); process.exit(1); }

function repositories(root: string): string[] {
  const out = new Set<string>();
  if (run("git", ["rev-parse", "--is-inside-work-tree"], root).ok) {
    const top = run("git", ["rev-parse", "--show-toplevel"], root).out;
    if (top) out.add(top);
  }
  for (const d of subdirs(root)) if (run("git", ["rev-parse", "--is-inside-work-tree"], d).ok) out.add(run("git", ["rev-parse", "--show-toplevel"], d).out);
  return [...out].filter(Boolean);
}

function worktrees(repo: string): { path: string; branch: string; sha: string }[] {
  const r = run("git", ["worktree", "list", "--porcelain"], repo);
  const out: { path: string; branch: string; sha: string }[] = [];
  let cur: any = {};
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) { if (cur.path) out.push(cur); cur = { path: line.slice(9), branch: "", sha: "" }; }
    else if (line.startsWith("HEAD ")) cur.sha = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  if (cur.path) out.push(cur);
  return out.filter((w) => path.resolve(w.path) !== path.resolve(repo));
}
function clean(repo: string, wt: string): boolean { return run("git", ["-C", wt, "status", "--porcelain"]).out === ""; }
function isFleetBranch(b: string): boolean { return b.startsWith("fleet/"); }
function integrated(repo: string, sha: string): boolean {
  const refs = run("git", ["for-each-ref", "--contains", sha, "--format=%(refname:short)", "refs/heads", "refs/remotes"], repo).out.split("\n").filter(Boolean);
  return refs.some((ref) => INTEGRATION_REFS.some((i) => ref === i || ref.endsWith(`/${i}`) || ref.includes(`/${i}/`) || ref.startsWith(i)));
}
function onRemote(repo: string, sha: string): boolean { return run("git", ["branch", "-r", "--contains", sha], repo).out.split("\n").some((l) => l.trim() && !l.includes("->")); }

function beadStatuses(root: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!isDir(path.join(root, ".beads"))) return m;
  for (const st of ["open", "in_progress", "blocked", "deferred", "closed"]) {
    const r = run("bd", ["list", `--status=${st}`, "--json", "--limit", "5000"], root);
    if (!r.ok || !r.out) continue;
    try { for (const b of JSON.parse(r.out)) if (b?.id) m.set(String(b.id), String(b.status ?? st)); } catch {}
  }
  return m;
}
function beadFor(name: string, beads: Map<string, string>): [string, string] | null {
  let best: [string, string] | null = null;
  for (const [id, st] of beads) if (name.includes(id) && (!best || id.length > best[0].length)) best = [id, st];
  return best;
}
function beadPrefix(name: string, beads: Map<string, string>, sep = ""): [string, string] | null {
  let best: [string, string] | null = null;
  for (const [id, st] of beads) if (name.startsWith(`${id}${sep}`) && (!best || id.length > best[0].length)) best = [id, st];
  return best;
}
function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}
function processCwd(pid: number): string | null {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      const out = run(lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = out.out.split("\n").find((l) => l.startsWith("n"));
      if (line) return path.resolve(line.slice(1));
    } catch {}
  }
  try {
    const procCwd = `/proc/${pid}/cwd`;
    if (fs.existsSync(procCwd)) return path.resolve(fs.realpathSync(procCwd));
  } catch {}
  return null;
}
function sessionCwds(sessionFile: string): string[] {
  const out = new Set<string>();
  if (!fs.existsSync(sessionFile)) return [];
  const visit = (v: any) => {
    if (typeof v === "string") return;
    if (!v || typeof v !== "object") return;
    for (const [k, child] of Object.entries<any>(v)) {
      if ((k === "cwd" || k === "workingDirectory") && typeof child === "string" && path.isAbsolute(child)) out.add(path.resolve(child));
      else visit(child);
    }
  };
  try {
    for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { visit(JSON.parse(line)); } catch {}
    }
  } catch {}
  return [...out];
}
function seatAnchors(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const f = path.join(root, "seats", "state.json");
  if (!fs.existsSync(f)) return out;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const [name, s] of Object.entries<any>(j.seats ?? {})) {
      if (s?.cwd) out.set(path.resolve(String(s.cwd)), `recorded cwd for seat ${name}`);
      const live = pidAlive(Number(s?.pid ?? 0)) ? processCwd(Number(s.pid)) : null;
      if (live) out.set(live, `live cwd for seat ${name} pid ${s.pid}`);
      if (s?.sessionFile) for (const cwd of sessionCwds(String(s.sessionFile))) out.set(cwd, `session history cwd for seat ${name}`);
    }
  } catch {}
  return out;
}
function seatCwds(root: string): Map<string, string> { return seatAnchors(root); }

function scanWorktrees(root: string, repo: string, seats: Map<string, string>, beads: Map<string, string>): Row[] {
  const rows: Row[] = [];
  const registered = new Set<string>();
  for (const w of worktrees(repo)) {
    const p = path.resolve(w.path); registered.add(p);
    const seat = seats.get(p);
    if (seat) { rows.push(row("seat-anchor", false, repo, p, w.branch, "none", `occupied by seat ${seat}`)); continue; }
    if (!clean(repo, p)) { rows.push(row("needs-review", false, repo, p, w.branch, "none", "worktree has uncommitted changes")); continue; }
    const b = beadFor(w.branch || path.basename(p), beads);
    if (b && b[1] !== "closed") { rows.push(row("needs-review", false, repo, p, w.branch, "none", `bead ${b[0]} is ${b[1]}`)); continue; }
    if (w.branch && isFleetBranch(w.branch)) {
      const safe = integrated(repo, w.sha) && onRemote(repo, w.sha) && !!b && b[1] === "closed";
      rows.push(row(safe ? "merged-worktree" : "needs-review", safe, repo, p, w.branch, safe ? "worktree" : "none", safe ? "clean, closed bead, merged to integration ref and present on remote ref" : !b ? "no closed bead record found for this fleet branch" : b[1] !== "closed" ? `bead ${b[0]} is ${b[1]}` : "fleet branch is not both merged and present on a remote ref"));
    } else if (!w.branch) {
      const safe = onRemote(repo, w.sha);
      rows.push(row(safe ? "detached-snapshot" : "needs-review", safe, repo, p, "", safe ? "worktree" : "none", safe ? "detached clean snapshot present on remote ref" : "detached snapshot not found on a remote ref"));
    }
  }
  return rows;
}

function scanOrphans(root: string, registered: Set<string>, seats: Map<string, string>): Row[] {
  const rows: Row[] = [];
  for (const c of DEFAULT_CONTAINERS.map((n) => path.join(root, n)).filter(isDir)) {
    for (const d of subdirs(c)) {
      const p = path.resolve(d);
      if (registered.has(p) || fs.existsSync(path.join(p, ".git"))) continue;
      const seat = seats.get(p);
      if (seat) rows.push(row("seat-anchor", false, root, p, "", "none", seat));
      else rows.push(row("orphaned-worktree", true, root, p, "", "rm", "directory under worktree container is not registered and has no .git"));
    }
  }
  return rows;
}

function scanBranches(repo: string, root: string, beads: Map<string, string>, registeredBranches: Set<string>): Row[] {
  const rows: Row[] = [];
  const refs = run("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/fleet"], repo).out.split("\n").filter(Boolean);
  for (const line of refs) {
    const [branch, sha] = line.split(/\s+/);
    if (!branch || registeredBranches.has(branch)) continue;
    const b = beadFor(branch, beads);
    const safe = integrated(repo, sha) && onRemote(repo, sha) && !!b && b[1] === "closed";
    rows.push(row(safe ? "stale-branch" : "needs-review", safe, repo, repo, branch, safe ? "branch" : "none", safe ? "local fleet branch has no worktree, closed bead, merged and present on remote ref" : !b ? "no closed bead record found for this fleet branch" : b[1] !== "closed" ? `bead ${b[0]} is ${b[1]}` : "branch is not both merged and present on a remote ref", safe ? 0 : undefined));
  }
  return rows;
}


function scanBeadRuns(root: string, beads: Map<string, string>): Row[] {
  const runs = path.join(root, ".wheelhouse-runs");
  if (!isDir(runs)) return [];
  const rows: Row[] = [];
  for (const d of subdirs(runs)) {
    const b = beadPrefix(path.basename(d), beads);
    if (!b) continue;
    const safe = b[1] === "closed";
    rows.push(row(safe ? "bead-runs" : "needs-review", safe, root, d, "", safe ? "rm" : "none", safe ? `scratch belongs to closed bead ${b[0]}` : `scratch belongs to bead ${b[0]} which is ${b[1]}`));
  }
  return rows;
}

function scanPrivateTmp(root: string, beads: Map<string, string>): Row[] {
  const tmpRoots = [...new Set(["/private/tmp", path.resolve(os.tmpdir())])].filter(isDir);
  const rows: Row[] = [];
  for (const tmpRoot of tmpRoots) {
    for (const d of subdirs(tmpRoot)) {
      const base = path.basename(d);
      const b = beadPrefix(base, beads, "-");
      if (!b) continue;
      const safe = b[1] === "closed";
      rows.push(row(safe ? "bead-tmp" : "needs-review", safe, root, d, "", safe ? "rm" : "none", safe ? `tmp scratch belongs to closed bead ${b[0]}` : `tmp scratch belongs to bead ${b[0]} which is ${b[1]}`));
    }
  }
  return rows;
}

function simctlJson(args: string[]): any | null {
  const r = run("xcrun", ["simctl", ...args]);
  if (!r.ok || !r.out) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

function scanSimulators(root: string, beads: Map<string, string>): Row[] {
  if (beads.size === 0 || !run("xcrun", ["simctl", "help"]).ok) return [];
  const j = simctlJson(["list", "devices", "--json", "all"]);
  const rows: Row[] = [];
  for (const devs of Object.values<any>(j?.devices ?? {})) {
    if (!Array.isArray(devs)) continue;
    for (const d of devs) {
      const name = String(d?.name ?? "");
      const udid = String(d?.udid ?? "");
      const b = beadPrefix(name, beads, "-");
      if (!b || !udid) continue;
      const size = d?.dataPath && fs.existsSync(String(d.dataPath)) ? bytes(String(d.dataPath)) : 0;
      const safe = b[1] === "closed";
      rows.push(row(safe ? "bead-simulator" : "needs-review", safe, root, `simctl:${udid}`, name, safe ? "simctl" : "none", safe ? `simulator belongs to closed bead ${b[0]}` : `simulator belongs to bead ${b[0]} which is ${b[1]}`, size));
    }
  }
  return rows;
}

function xcodebuildRunning(): boolean {
  const r = run("pgrep", ["-x", "xcodebuild"]);
  return r.ok && r.out.trim() !== "";
}

function scanXCTestDevices(root: string): Row[] {
  const set = path.join(os.homedir(), "Library", "Developer", "XCTestDevices");
  if (!isDir(set)) return [];
  if (xcodebuildRunning()) return [row("needs-review", false, root, set, "", "none", "xcodebuild is running; XCTestDevices set is not idle")];
  if (!run("xcrun", ["simctl", "help"]).ok) return [row("needs-review", false, root, set, "", "none", "xcrun simctl is unavailable")];
  const j = simctlJson(["--set", set, "list", "devices", "--json"]);
  const booted = Object.values<any>(j?.devices ?? {}).some((devs) => Array.isArray(devs) && devs.some((d) => String(d?.state ?? "") === "Booted"));
  return [row(booted ? "needs-review" : "xctest-devices", !booted, root, set, "", booted ? "none" : "xctest-devices", booted ? "XCTestDevices set has a booted simulator" : "XCTestDevices set is idle: no xcodebuild process and no booted simulator")];
}

function benchInProgress(root: string): boolean { return isDir(path.join(root, ".wheelhouse-bench.lock")); }

function scanBenchJunk(root: string): Row[] {
  return subdirs(root)
    .filter((d) => path.basename(d).startsWith(".wheelhouse-bench.lock.stale."))
    .map((d) => row("bench-junk", true, root, d, "", "rm", "stale bench lock directory"));
}

function scanCaches(root: string, includeOptional: boolean, activeBench: boolean): Row[] {
  const names = [".wheelhouse-build", "DerivedData", "target", "bin", "obj", ".build", "dist", "build", ".next", "out"];
  const dependencyBins = new Set([".bin"]);
  const rows: Row[] = [];
  const isDependencySegment = (segment: string): boolean => DEPENDENCY_SEGMENTS.has(segment) || /^node[-_]?modules$/i.test(segment);
  const cacheRow = (child: string, category: "build-cache" | "node-modules", reason: string) => {
    if (activeBench) rows.push(row("needs-review", false, root, child, "", "none", `bench lock present at ${path.join(root, ".wheelhouse-bench.lock")}; ${reason}`));
    else rows.push(row(category, true, root, child, "", "rm", reason));
  };
  const dependencyReviewRow = (child: string, dependencySegment: string, base: string) => {
    rows.push(row("needs-review", false, root, child, "", "none", `${base} is below dependency directory ${dependencySegment}; dependency package contents are never safe build-cache`));
  };
  const walk = (d: string, depth: number, dependencySegment: string | null) => {
    if (depth > 3) return;
    for (const child of subdirs(d)) {
      const base = path.basename(child);
      const childDependency = dependencySegment ?? (isDependencySegment(base) ? base : null);
      if (childDependency && (names.includes(base) || dependencyBins.has(base))) dependencyReviewRow(child, childDependency, base);
      else if (names.includes(base)) cacheRow(child, "build-cache", `${base} is regenerable build output at a project/package root`);
      else if (includeOptional && base === "node_modules") cacheRow(child, "node-modules", "opt-in dependency install tree");
      if (![".git", ".beads", "seats"].includes(base)) walk(child, depth + 1, childDependency);
    }
  };
  walk(root, 0, null);
  return rows;
}

function scan(roots: string[], includeOptional: boolean): Row[] {
  const rows: Row[] = [];
  for (const root of roots.map((r) => path.resolve(r))) {
    const seats = seatCwds(root);
    const beads = beadStatuses(root);
    const registeredPaths = new Set<string>();
    for (const repo of repositories(root)) {
      const wts = worktrees(repo);
      for (const wt of wts) registeredPaths.add(path.resolve(wt.path));
      rows.push(...scanWorktrees(root, repo, seats, beads));
      rows.push(...scanBranches(repo, root, beads, new Set(wts.map((w) => w.branch).filter(Boolean))));
    }
    const activeBench = benchInProgress(root);
    rows.push(...scanOrphans(root, registeredPaths, seats));
    rows.push(...scanBeadRuns(root, beads));
    rows.push(...scanPrivateTmp(root, beads));
    rows.push(...scanSimulators(root, beads));
    rows.push(...scanXCTestDevices(root));
    rows.push(...scanBenchJunk(root));
    rows.push(...scanCaches(root, includeOptional, activeBench));
  }
  return rows.sort((a, b) => `${a.category}\t${a.path}`.localeCompare(`${b.category}\t${b.path}`));
}

function toTsv(rows: Row[]): string {
  return ["category\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason", ...rows.map((r) => [r.category, r.safe, r.repo, r.path, r.branch, r.size_bytes, r.size_human, r.action, r.reason].map((x) => String(x).replace(/\t|\n/g, " ")).join("\t"))].join("\n") + "\n";
}
function parseScan(file: string): Row[] {
  const text = fs.readFileSync(file, "utf8");
  if (/\.json$/i.test(file)) return JSON.parse(text);
  const [head, ...lines] = text.trimEnd().split("\n");
  const cols = head.split("\t");
  return lines.filter(Boolean).map((l) => {
    const v = l.split("\t"); const o: any = {};
    cols.forEach((c, i) => o[c] = v[i] ?? "");
    o.safe = Number(o.safe) as 0 | 1; o.size_bytes = Number(o.size_bytes); return o as Row;
  });
}
function readJsonlResponse(log: string, id: string, start: number, deadlineMs: number): any | null {
  while (Date.now() < deadlineMs) {
    try {
      const fd = fs.openSync(log, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size > start) {
          const buf = Buffer.alloc(size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          for (const line of buf.toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            try { const j = JSON.parse(line); if (j?.id === id && j?.type === "response") return j; } catch {}
          }
        }
      } finally { fs.closeSync(fd); }
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return null;
}
function getState(rec: any): any | null {
  if (!rec?.fifo || !rec?.log || !fs.existsSync(String(rec.fifo)) || !fs.existsSync(String(rec.log))) return null;
  const id = crypto.randomUUID();
  const start = fs.existsSync(String(rec.log)) ? fs.statSync(String(rec.log)).size : 0;
  try { fs.appendFileSync(String(rec.fifo), JSON.stringify({ id, type: "get_state" }) + "\n"); } catch { return null; }
  return readJsonlResponse(String(rec.log), id, start, Date.now() + 2000);
}
function rootsWithSeatState(rows: Row[]): string[] {
  const out = new Set<string>();
  const candidates = new Set<string>();
  for (const r of rows) {
    if (path.isAbsolute(r.repo)) candidates.add(path.resolve(r.repo));
  }
  for (const c of candidates) {
    if (!path.isAbsolute(c)) continue;
    let cur = fs.existsSync(c) && fs.statSync(c).isDirectory() ? c : path.dirname(c);
    while (true) {
      if (fs.existsSync(path.join(cur, "seats", "state.json"))) { out.add(cur); break; }
      const next = path.dirname(cur);
      if (next === cur) break;
      cur = next;
    }
  }
  return [...out];
}
function assertNoMidTurnSeats(rows: Row[]): void {
  for (const root of rootsWithSeatState(rows)) {
    let state: any;
    try { state = JSON.parse(fs.readFileSync(path.join(root, "seats", "state.json"), "utf8")); } catch { continue; }
    for (const [name, rec] of Object.entries<any>(state.seats ?? {})) {
      if (!pidAlive(Number(rec?.pid ?? 0))) continue;
      const st = getState(rec);
      if (st?.success && st?.data?.isStreaming) stop(`seat "${name}" is mid-turn per get_state; settle seats before prune --yes`);
    }
  }
}
function assertNoSelectedSeatAnchors(rows: Row[], cats: Set<string> | null): void {
  const anchors = new Map<string, string>();
  for (const root of rootsWithSeatState(rows)) for (const [p, reason] of seatAnchors(root)) anchors.set(path.resolve(p), reason);
  for (const r of rows) {
    if (cats && !cats.has(r.category)) continue;
    if (!r.safe || NEVER.has(r.category)) continue;
    const reason = anchors.get(path.resolve(r.path));
    if (reason) stop(`refusing to prune ${r.path}: ${reason}`);
  }
}
function localBranchSha(repo: string, branch: string): string {
  return run("git", ["rev-parse", "--verify", branch], repo).out.trim();
}
function deleteMergedBranchIfStillSafe(repo: string, branch: string): boolean {
  if (!branch || !isFleetBranch(branch)) return false;
  const sha = localBranchSha(repo, branch);
  if (!sha || !integrated(repo, sha) || !onRemote(repo, sha)) return false;
  const r = run("git", ["branch", "-d", branch], repo);
  return r.ok;
}
function prune(rows: Row[], yes: boolean, cats: Set<string> | null): void {
  if (yes) { assertNoMidTurnSeats(rows); assertNoSelectedSeatAnchors(rows, cats); }
  let touched = 0, skipped = 0, reclaimed = 0;
  for (const r of rows) {
    if (cats && !cats.has(r.category)) { skipped++; continue; }
    if (!r.safe || NEVER.has(r.category)) { skipped++; continue; }
    if (!yes) { reclaimed += r.size_bytes; console.log(`DRY-RUN ${r.action} ${r.category} ${r.path}`); continue; }
    if (r.action === "rm") fs.rmSync(r.path, { recursive: true, force: true });
    else if (r.action === "worktree") {
      const branch = r.branch;
      run("git", ["worktree", "remove", "--force", r.path], r.repo);
      if (r.category === "merged-worktree" && branch && deleteMergedBranchIfStillSafe(r.repo, branch)) console.log(`PRUNED branch merged-worktree ${branch}`);
    }
    else if (r.action === "branch") run("git", ["branch", "-d", r.branch], r.repo);
    else if (r.action === "simctl") run("xcrun", ["simctl", "delete", r.path.replace(/^simctl:/, "")]);
    else if (r.action === "xctest-devices") run("xcrun", ["simctl", "--set", r.path, "delete", "all"]);
    reclaimed += r.size_bytes;
    touched++;
    console.log(`PRUNED ${r.action} ${r.category} ${r.path}`);
  }
  console.log(`prune summary: touched=${touched} skipped=${skipped} dry_run=${yes ? 0 : 1} reclaimed_bytes=${reclaimed} reclaimed_human=${human(reclaimed)}`);
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || !["scan", "prune", "categories"].includes(cmd)) { console.error("usage: prune.ts scan|prune|categories ..."); process.exit(2); }
  if (cmd === "categories") { for (const [k, v] of Object.entries(CATEGORIES)) console.log(`${k}\t${v}`); return; }
  let format = "tsv", from = "", yes = false, includeOptional = false; const roots: string[] = []; let cats: Set<string> | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") roots.push(argv[++i]);
    else if (a === "--format") format = argv[++i];
    else if (a === "--from-file") from = argv[++i];
    else if (a === "--yes") yes = true;
    else if (a === "--include-optional") includeOptional = true;
    else if (a === "--categories") cats = new Set(argv[++i].split(",").filter(Boolean));
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (cmd === "scan") {
    const rows = scan(roots.length ? roots : [ROOT], includeOptional);
    process.stdout.write(format === "json" ? JSON.stringify(rows, null, 2) + "\n" : toTsv(rows));
  } else {
    if (!from) { console.error("prune requires --from-file <reviewed scan>"); process.exit(2); }
    prune(parseScan(from), yes, cats);
  }
}

if (import.meta.main) main();
