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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_CONTAINERS = [".wheelhouse-worktrees", ".worktrees"];
const INTEGRATION_REFS = ["main", "master", "develop", "staging", "production", "release/"];
const NEVER = new Set(["needs-review", "seat-anchor"]);

interface Row {
  category: string;
  safe: 0 | 1;
  repo: string;
  path: string;
  branch: string;
  size_bytes: number;
  size_human: string;
  action: "rm" | "worktree" | "branch" | "none";
  reason: string;
}

const CATEGORIES: Record<string, string> = {
  "merged-worktree": "registered fleet worktree: clean, closed bead, tip merged to an integration ref and present on a remote ref",
  "detached-snapshot": "registered detached worktree: clean and tip present on a remote ref",
  "orphaned-worktree": "directory under a worktree container that git no longer registers",
  "stale-branch": "local fleet branch with no worktree, closed bead, tip merged to an integration ref and present on a remote ref",
  "build-cache": "regenerable build output such as .wheelhouse-build, target, bin/obj, .build, dist/build/.next/out",
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
function row(category: string, safe: boolean, repo: string, p: string, branch: string, action: Row["action"], reason: string): Row {
  const b = fs.existsSync(p) ? bytes(p) : 0;
  return { category, safe: safe ? 1 : 0, repo, path: p, branch, size_bytes: b, size_human: human(b), action, reason };
}

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
function seatCwds(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const f = path.join(root, "seats", "state.json");
  if (!fs.existsSync(f)) return out;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const [name, s] of Object.entries<any>(j.seats ?? {})) if (s?.cwd) out.set(path.resolve(String(s.cwd)), String(name));
  } catch {}
  return out;
}

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

function scanOrphans(root: string, registered: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const c of DEFAULT_CONTAINERS.map((n) => path.join(root, n)).filter(isDir)) {
    for (const d of subdirs(c)) {
      const p = path.resolve(d);
      if (!registered.has(p) && !fs.existsSync(path.join(p, ".git"))) rows.push(row("orphaned-worktree", true, root, p, "", "rm", "directory under worktree container is not registered and has no .git"));
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
    rows.push(row(safe ? "stale-branch" : "needs-review", safe, repo, repo, branch, safe ? "branch" : "none", safe ? "local fleet branch has no worktree, closed bead, merged and present on remote ref" : !b ? "no closed bead record found for this fleet branch" : b[1] !== "closed" ? `bead ${b[0]} is ${b[1]}` : "branch is not both merged and present on a remote ref"));
  }
  return rows;
}

function scanCaches(root: string, includeOptional: boolean): Row[] {
  const names = [".wheelhouse-build", "target", ".build", "dist", "build", ".next", "out"];
  const rows: Row[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const child of subdirs(d)) {
      const base = path.basename(child);
      if (names.includes(base)) rows.push(row("build-cache", true, root, child, "", "rm", `${base} is regenerable build output`));
      else if (includeOptional && base === "node_modules") rows.push(row("node-modules", true, root, child, "", "rm", "opt-in dependency install tree"));
      else if (![".git", ".beads", "seats"].includes(base)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
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
    rows.push(...scanOrphans(root, registeredPaths));
    rows.push(...scanCaches(root, includeOptional));
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
function prune(rows: Row[], yes: boolean, cats: Set<string> | null): void {
  let touched = 0, skipped = 0;
  for (const r of rows) {
    if (cats && !cats.has(r.category)) { skipped++; continue; }
    if (!r.safe || NEVER.has(r.category)) { skipped++; continue; }
    if (!yes) { console.log(`DRY-RUN ${r.action} ${r.category} ${r.path}`); continue; }
    if (r.action === "rm") fs.rmSync(r.path, { recursive: true, force: true });
    else if (r.action === "worktree") run("git", ["worktree", "remove", "--force", r.path], r.repo);
    else if (r.action === "branch") run("git", ["branch", "-d", r.branch], r.repo);
    touched++;
    console.log(`PRUNED ${r.action} ${r.category} ${r.path}`);
  }
  console.log(`prune summary: touched=${touched} skipped=${skipped} dry_run=${yes ? 0 : 1}`);
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
