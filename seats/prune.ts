#!/usr/bin/env bun
/**
 * prune.ts — scan and reclaim safe Wheelhouse/dev-machine debris.
 *
 * Usage:
 *   bun seats/prune.ts scan [--root <dir>]... [--format tsv|json|jsonl] [--include-optional]
 *   bun seats/prune.ts prune --from-file <scan.tsv|scan.json> [--yes] [--categories a,b]
 *   bun seats/prune.ts cleanup [--dry-run] [--deadline <unix-seconds>] [--log <file>] [--bead <id>] [--wait <seconds>] [--root <dir>]
 *   bun seats/prune.ts categories
 *
 * `scan` is read-only. `prune` acts only from a reviewed scan file and only
 * with --yes; it is the exceptions path a person drives. `cleanup` is the
 * automatic path: the adapter runs it for one bead the moment a seat leaves
 * that bead, and the nightly reaper runs it for the whole fleet. Rows marked
 * needs-review or seat-anchor are never acted on by either.
 *
 * Never-lose-work rules cleanup enforces, in order, before it removes anything:
 *   - only paths under <root>/.wheelhouse-worktrees/ and <root>/.wheelhouse-runs/;
 *     interactive `.worktrees/*` and out-of-root checkouts are never touched
 *   - a worktree with real uncommitted changes is kept ("uncommitted changes");
 *     deletions of once-committed build output (.cargo-target-shared/,
 *     car-rs/.wt-target/) are not real changes ("build output only")
 *   - a path a live process has its cwd inside is kept ("live process has its cwd")
 *   - a seat's recorded/live/session cwd is a seat-anchor, never removed
 *   - a worktree named in wheelhouse/ISA.md is kept ("named by wheelhouse/ISA.md")
 *   - a worktree whose seat is mid-push is kept ("deferred: push in progress")
 *   - when lsof is unavailable nothing is removed ("cannot verify: lsof unavailable")
 *   - a path with a symlink component is kept ("path mismatch")
 *   - a worktree whose commits are on no remote ref gets an archive/<name>
 *     tag first; a branch ref is never deleted by cleanup
 *   - a bead counts as done when its tip is an ancestor of an integration ref
 *     (origin/main, mayline/main, origin/fleet/ootb-agent, seats/integration-refs.txt
 *     entries), is patch-equivalent to one (`git cherry`), or was squash-merged
 *     (the branch's cumulative diff has the same patch-id as one commit on the
 *     integration ref; the reason names that commit). Size never changes a category.
 *
 * Extra integration refs may be listed in seats/integration-refs.txt, one ref
 * per line. Blank lines and # comments are ignored. These install-owned refs
 * match containing refs exactly by branch name (ref === listed or
 * ref.endsWith("/" + listed), e.g. fleet/goal-x and origin/fleet/goal-x);
 * listing fleet/goal-x never widens matching to every fleet/* branch.
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
import { PLACEHOLDER_MARKER, phantomOnlyStatus, porcelainStatus } from "./seat-worktree";

const ROOT = path.resolve(import.meta.dir, "..");
const FLEET_CONTAINER = ".wheelhouse-worktrees";
const RUNS_DIRNAME = ".wheelhouse-runs";
const DEFAULT_CONTAINERS = [FLEET_CONTAINER, ".worktrees"];
const INTEGRATION_REFS = ["main", "master", "develop", "staging", "production", "release/", "fleet/ootb-agent"];
const DEPENDENCY_SEGMENTS = new Set(["node_modules", "vendor", ".venv", "venv", "Pods"]);
const NEVER = new Set(["needs-review", "seat-anchor"]);
const CATEGORY_ALIASES: Record<string, string> = { "bead-runs": "run-scratch" };
const SQUASH_LOG_DEPTH = Number(process.env.WHEELHOUSE_SQUASH_LOG_DEPTH || 2000);

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
  "merged-worktree": "registered fleet worktree: clean, closed bead, tip merged to an integration ref (ancestor, patch-equivalent, or squash-merged); archive-tagged first when its commits are on no remote ref",
  "zero-commit-worktree": "registered fleet worktree: open bead, zero commits beyond its integration ref, clean, no seat; removing it loses nothing because the branch ref stays",
  "detached-snapshot": "registered detached worktree: clean and tip present on a remote ref",
  "orphaned-worktree": "directory under a worktree container that git no longer registers",
  "stale-branch": "local fleet branch with no worktree, closed bead, tip merged to an integration ref and present on a remote ref (prune only; cleanup never deletes a branch ref)",
  "build-cache": "regenerable build output at a project/package root: .wheelhouse-build, dist, build, .next, out, .build, target, .NET bin/obj, DerivedData; never below dependency dirs",
  "bench-junk": "stale .wheelhouse-bench.lock.stale.* bench lock directories",
  "run-scratch": "closed bead scratch under .wheelhouse-runs/<bead>* with no live process cwd inside (alias: bead-runs)",
  "bead-tmp": "closed bead scratch under /private/tmp/<bead>-* (prune only; outside the fleet root)",
  "bead-simulator": "simctl device named <closed-bead>-*",
  "xctest-devices": "idle XCTestDevices simctl set; pruned with simctl --set ... delete all",
  "seat-anchor": "worktree or scratch currently recorded as a seat's cwd in seats/state.json; never pruned",
  "needs-review": "dirty tree, open bead, unmerged work, live process cwd, ISA anchor, push in progress, unverifiable state, or an interactive checkout outside .wheelhouse-worktrees; never pruned",
  "node-modules": "opt-in regenerable dependency install tree",
};

function run(cmd: string, args: string[], cwd?: string, input?: string): { ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), code: r.status };
}
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function subdirs(p: string): string[] { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name)); } catch { return []; } }
function bytes(p: string): number { const r = run("du", ["-sk", p]); const n = Number((r.out.split(/\s+/)[0] ?? "0")); return Number.isFinite(n) ? n * 1024 : 0; }
function human(n: number): string { const u = ["B", "K", "M", "G", "T"]; let v = n, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(1)}${u[i]}`; }
function row(category: string, safe: boolean, repo: string, p: string, branch: string, action: Row["action"], reason: string, sizeOverride?: number): Row {
  const b = sizeOverride ?? (fs.existsSync(p) ? bytes(p) : 0);
  return { category, safe: safe ? 1 : 0, repo, path: p, branch, size_bytes: b, size_human: human(b), action, reason };
}
function stop(message: string): never { console.error(`STOP: ${message}`); process.exit(1); }
function realpathOr(p: string): string | null { try { return fs.realpathSync(p); } catch { return null; } }
function insideOf(child: string, parent: string): boolean { return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/"); }

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
/** Phantom-aware cleanliness: deletions of once-committed build output do not count. */
function treeState(repo: string, wt: string): { clean: boolean; phantomOnly: boolean; detail: string } {
  const r = porcelainStatus(wt);
  if (!r.ok) return { clean: false, phantomOnly: false, detail: `git status failed: ${r.err}` };
  const st = phantomOnlyStatus(r.out);
  return { clean: st.clean, phantomOnly: st.phantomOnly, detail: st.real[0] ?? "" };
}
function clean(repo: string, wt: string): boolean { return treeState(repo, wt).clean; }
function isFleetBranch(b: string): boolean { return b.startsWith("fleet/"); }
function extraIntegrationRefs(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    try {
      const file = path.join(path.resolve(root), "seats", "integration-refs.txt");
      if (!fs.existsSync(file)) continue;
      for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
        const ref = raw.replace(/#.*/, "").trim();
        if (ref) out.add(ref);
      }
    } catch {}
  }
  return [...out];
}
function extraRefMatches(ref: string, listed: string): boolean { return ref === listed || ref.endsWith(`/${listed}`); }
function listedIntegrationRef(branch: string, extra: string[]): boolean { return extra.includes(branch); }
function isIntegrationRefName(ref: string, extra: string[]): boolean {
  return INTEGRATION_REFS.some((i) => ref === i || ref.endsWith(`/${i}`) || ref.includes(`/${i}/`) || ref.startsWith(i)) || extra.some((i) => extraRefMatches(ref, i));
}
function integrated(repo: string, sha: string, extra: string[] = []): boolean { return integratedRef(repo, sha, extra) !== null; }
/** The first integration ref containing `sha` as an ancestor, remote refs preferred. */
function ancestorRef(repo: string, sha: string, extra: string[]): string | null {
  const refs = run("git", ["for-each-ref", "--contains", sha, "--format=%(refname:short)", "refs/remotes", "refs/heads"], repo).out.split("\n").filter(Boolean);
  return refs.find((ref) => isIntegrationRefName(ref, extra)) ?? null;
}
/** Every integration ref that exists in this repo, remote refs first. */
const integrationRefCache = new Map<string, string[]>();
function integrationRefsPresent(repo: string, extra: string[]): string[] {
  const key = `${repo}\0${extra.join(",")}`;
  const cached = integrationRefCache.get(key);
  if (cached) return cached;
  const refs = run("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes", "refs/heads"], repo).out.split("\n").filter(Boolean);
  const out = refs.filter((ref) => !ref.endsWith("/HEAD") && isIntegrationRefName(ref, extra));
  integrationRefCache.set(key, out);
  return out;
}
const patchIdCache = new Map<string, Map<string, string>>();
function patchIdsOn(repo: string, ref: string): Map<string, string> {
  const key = `${repo}\0${ref}`;
  const cached = patchIdCache.get(key);
  if (cached) return cached;
  const map = new Map<string, string>();
  const log = spawnSync("git", ["log", "--format=commit %H", "--no-merges", "-p", "-n", String(SQUASH_LOG_DEPTH), ref], { cwd: repo, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 1024 });
  if (log.status === 0 && log.stdout?.length) {
    const ids = spawnSync("git", ["patch-id", "--stable"], { cwd: repo, input: log.stdout, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    for (const line of (ids.stdout ?? "").split("\n")) {
      const [id, sha] = line.trim().split(/\s+/);
      if (id && sha && !map.has(id)) map.set(id, sha);
    }
  }
  patchIdCache.set(key, map);
  return map;
}
/** How a tip landed: ancestor of, patch-equivalent (git cherry) to, or squash-merged into an integration ref. */
function integratedRef(repo: string, sha: string, extra: string[] = []): { ref: string; how: string } | null {
  const anc = ancestorRef(repo, sha, extra);
  if (anc) return { ref: anc, how: `tip is an ancestor of ${anc}` };
  for (const ref of integrationRefsPresent(repo, extra)) {
    const cherry = run("git", ["cherry", ref, sha], repo);
    if (!cherry.ok) continue;
    const lines = cherry.out.split("\n").filter(Boolean);
    if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) return { ref, how: `patch-equivalent to ${ref} (git cherry)` };
  }
  for (const ref of integrationRefsPresent(repo, extra)) {
    const mb = run("git", ["merge-base", ref, sha], repo).out;
    if (!mb || mb === sha) continue;
    const diff = spawnSync("git", ["diff", mb, sha], { cwd: repo, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 1024 });
    if (diff.status !== 0 || !diff.stdout?.length) continue;
    const id = spawnSync("git", ["patch-id", "--stable"], { cwd: repo, input: diff.stdout, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).stdout?.trim().split(/\s+/)[0];
    if (!id) continue;
    const hit = patchIdsOn(repo, ref).get(id);
    if (hit) return { ref, how: `squash-merged as ${hit.slice(0, 12)} on ${ref}` };
  }
  return null;
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
/** Every live process's cwd, or null when lsof cannot be run (then nothing is removable). */
let liveCwdCache: { at: number; set: Set<string> | null } | null = null;
function liveCwds(fresh = false): Set<string> | null {
  if (!fresh && liveCwdCache && Date.now() - liveCwdCache.at < 5000) return liveCwdCache.set;
  // WHEELHOUSE_LSOF names the binary (selftests point it at a missing path to
  // prove that an unverifiable row is never removed); otherwise PATH, then the
  // macOS/Linux homes, so a minimal PATH does not turn every row unverifiable.
  const candidates = process.env.WHEELHOUSE_LSOF ? [process.env.WHEELHOUSE_LSOF] : ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"];
  let set: Set<string> | null = null;
  for (const lsof of candidates) {
    const r = spawnSync(lsof, ["-d", "cwd", "-Fpn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    if (r.error || typeof r.stdout !== "string" || r.stdout.length === 0) continue;
    set = new Set<string>();
    for (const line of r.stdout.split("\n")) if (line.startsWith("n")) set.add(line.slice(1));
    break;
  }
  liveCwdCache = { at: Date.now(), set };
  return set;
}
function liveCwdInside(p: string, live: Set<string>): string | null {
  const wanted = [path.resolve(p)];
  const rp = realpathOr(p); if (rp && rp !== wanted[0]) wanted.push(rp);
  for (const cwd of live) for (const w of wanted) if (insideOf(cwd, w)) return cwd;
  return null;
}
/** Commands that look like a push in flight, with their cwd (from the same lsof pass). */
function pushInProgress(root: string, p: string, live: Set<string> | null): string | null {
  const runDir = path.join(root, "seats", "run");
  try {
    for (const f of fs.readdirSync(runDir)) {
      if (!/^push\..+\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
        if (j?.worktree && path.resolve(String(j.worktree)) === path.resolve(p) && pidAlive(Number(j.pid ?? 0))) return `seat ${j.seat ?? "?"} is pushing ${j.branch ?? ""}`;
      } catch {}
    }
  } catch {}
  const ps = spawnSync("ps", ["axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout || "";
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m || !/\bgit(-remote-\w+)?\b.*\bpush\b/.test(m[2])) continue;
    const cwd = processCwd(Number(m[1]));
    if (cwd && (insideOf(cwd, path.resolve(p)) || insideOf(cwd, realpathOr(p) ?? p))) return `pid ${m[1]} is running git push`;
  }
  void live;
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
const seatAnchorCache = new Map<string, { at: number; map: Map<string, string> }>();
function seatAnchors(root: string): Map<string, string> {
  const cached = seatAnchorCache.get(root);
  if (cached && Date.now() - cached.at < 5000) return cached.map;
  const out = new Map<string, string>();
  const f = path.join(root, "seats", "state.json");
  if (fs.existsSync(f)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const [name, s] of Object.entries<any>(j.seats ?? {})) {
        if (s?.cwd) out.set(path.resolve(String(s.cwd)), `recorded cwd for seat ${name}`);
        const live = pidAlive(Number(s?.pid ?? 0)) ? processCwd(Number(s.pid)) : null;
        if (live) out.set(live, `live cwd for seat ${name} pid ${s.pid}`);
        if (s?.sessionFile) for (const cwd of sessionCwds(String(s.sessionFile))) out.set(cwd, `session history cwd for seat ${name}`);
      }
    } catch {}
  }
  // A rostered seat's own worktree (`.wheelhouse-worktrees/<seat>`) is an anchor
  // even before state.json records it: it carries the seat's warm build.
  try {
    const roster = JSON.parse(fs.readFileSync(path.join(root, "seats", "seats.json"), "utf8"));
    for (const name of Object.keys(roster.seats ?? {})) {
      const p = path.join(root, FLEET_CONTAINER, name);
      if (!out.has(path.resolve(p)) && fs.existsSync(p)) out.set(path.resolve(p), `worktree of rostered seat ${name}`);
    }
  } catch {}
  seatAnchorCache.set(root, { at: Date.now(), map: out });
  return out;
}
function seatCwds(root: string): Map<string, string> { return seatAnchors(root); }
/** A seat anchor at or below `p` (a seat sitting inside a run folder counts). */
function seatAnchorWithin(p: string, seats: Map<string, string>): string | null {
  const rp = path.resolve(p);
  const direct = seats.get(rp);
  if (direct) return direct;
  for (const [cwd, reason] of seats) if (insideOf(cwd, rp)) return reason;
  return null;
}
/** Worktree names an ISA anchors: any `.wheelhouse-worktrees/<name>` token in wheelhouse/ISA.md or ISA.md. */
function isaAnchors(root: string): Set<string> {
  const out = new Set<string>();
  for (const f of [path.join(root, "wheelhouse", "ISA.md"), path.join(root, "ISA.md")]) {
    try {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/\.wheelhouse-worktrees\/([^\s`'"),;:]+)/g)) out.add(m[1].replace(/\/+$/, ""));
    } catch {}
  }
  return out;
}
function isFleetContainerPath(root: string, p: string): boolean {
  const dir = path.join(root, FLEET_CONTAINER);
  const parent = path.dirname(path.resolve(p));
  return parent === path.resolve(dir) || parent === realpathOr(dir);
}

function scanWorktrees(root: string, repo: string, seats: Map<string, string>, beads: Map<string, string>, extra: string[], live: Set<string> | null, isa: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const w of worktrees(repo)) {
    const p = path.resolve(w.path);
    const seat = seats.get(p);
    if (seat) { rows.push(row("seat-anchor", false, repo, p, w.branch, "none", `occupied by seat ${seat}`)); continue; }
    if (!isFleetContainerPath(root, p)) {
      if (!w.branch || isFleetBranch(w.branch)) rows.push(row("needs-review", false, repo, p, w.branch, "none", `interactive checkout outside ${FLEET_CONTAINER}/; never touched by automatic cleanup`));
      continue;
    }
    if (isa.has(path.basename(p))) { rows.push(row("needs-review", false, repo, p, w.branch, "none", "named by wheelhouse/ISA.md")); continue; }
    if (fs.existsSync(path.join(p, PLACEHOLDER_MARKER))) { rows.push(row("needs-review", false, repo, p, w.branch, "none", `${PLACEHOLDER_MARKER} left for the adapter to recreate; never removed`)); continue; }
    const tree = treeState(repo, p);
    if (!tree.clean) { rows.push(row("needs-review", false, repo, p, w.branch, "none", `worktree has uncommitted changes (${tree.detail})`)); continue; }
    const phantom = tree.phantomOnly ? "; build output only" : "";
    if (live === null) { rows.push(row("needs-review", false, repo, p, w.branch, "none", "cannot verify: lsof unavailable")); continue; }
    const cwd = liveCwdInside(p, live);
    if (cwd) { rows.push(row("needs-review", false, repo, p, w.branch, "none", `live process has its cwd ${cwd === p ? "here" : `in ${cwd}`}`)); continue; }
    const pushing = pushInProgress(root, p, live);
    if (pushing) { rows.push(row("needs-review", false, repo, p, w.branch, "none", `deferred: push in progress (${pushing})`)); continue; }
    const b = beadFor(w.branch || path.basename(p), beads);
    if (w.branch && isFleetBranch(w.branch)) {
      if (listedIntegrationRef(w.branch, extra)) { rows.push(row("needs-review", false, repo, p, w.branch, "none", "listed integration ref in seats/integration-refs.txt")); continue; }
      const done = integratedRef(repo, w.sha, extra);
      const remote = onRemote(repo, w.sha) ? "" : "; commits on no remote ref: archive tag before removal";
      if (b && b[1] === "closed" && done) { rows.push(row("merged-worktree", true, repo, p, w.branch, "worktree", `clean, closed bead ${b[0]}, ${done.how}${remote}${phantom}`)); continue; }
      if (b && b[1] === "open" && done && done.how.startsWith("tip is an ancestor")) { rows.push(row("zero-commit-worktree", true, repo, p, w.branch, "worktree", `zero commits beyond ${done.ref}; bead ${b[0]} is open; no seat holds this worktree${phantom}`)); continue; }
      if (b && b[1] !== "closed") { rows.push(row("needs-review", false, repo, p, w.branch, "none", `bead ${b[0]} is ${b[1]}`)); continue; }
      rows.push(row("needs-review", false, repo, p, w.branch, "none", !b ? "no bead record found for this fleet branch" : "closed bead but the branch is not merged to an integration ref (not merged, patch-equivalent, or squash-merged)"));
    } else if (!w.branch) {
      if (b && b[1] !== "closed") { rows.push(row("needs-review", false, repo, p, w.branch, "none", `bead ${b[0]} is ${b[1]}`)); continue; }
      const safe = onRemote(repo, w.sha);
      rows.push(row(safe ? "detached-snapshot" : "needs-review", safe, repo, p, "", safe ? "worktree" : "none", safe ? `detached clean snapshot present on remote ref${phantom}` : "detached snapshot not found on a remote ref"));
    }
  }
  return rows;
}

function scanOrphans(root: string, registered: Set<string>, seats: Map<string, string>, live: Set<string> | null): Row[] {
  const rows: Row[] = [];
  for (const c of DEFAULT_CONTAINERS.map((n) => path.join(root, n)).filter(isDir)) {
    // A symbolic link under a container is never followed or removed: the path
    // cleanup would act on is not the directory it resolves to.
    try {
      for (const e of fs.readdirSync(c, { withFileTypes: true })) {
        if (!e.isSymbolicLink()) continue;
        const link = path.join(c, e.name);
        rows.push(row("needs-review", false, root, link, "", "none", `path mismatch: ${link} is a symbolic link to ${realpathOr(link) ?? "a missing target"}`, 0));
      }
    } catch {}
    for (const d of subdirs(c)) {
      const p = path.resolve(d);
      if (registered.has(p) || registered.has(realpathOr(p) ?? p) || fs.existsSync(path.join(p, ".git"))) continue;
      const seat = seatAnchorWithin(p, seats);
      if (seat) { rows.push(row("seat-anchor", false, root, p, "", "none", seat)); continue; }
      if (fs.existsSync(path.join(p, PLACEHOLDER_MARKER))) { rows.push(row("needs-review", false, root, p, "", "none", `${PLACEHOLDER_MARKER} left for the adapter to recreate; never removed`)); continue; }
      if (live === null) { rows.push(row("needs-review", false, root, p, "", "none", "cannot verify: lsof unavailable")); continue; }
      const cwd = liveCwdInside(p, live);
      if (cwd) { rows.push(row("needs-review", false, root, p, "", "none", `live process has its cwd in ${cwd}`)); continue; }
      rows.push(row("orphaned-worktree", true, root, p, "", "rm", "directory under worktree container is not registered and has no .git"));
    }
  }
  return rows;
}

function scanBranches(repo: string, root: string, beads: Map<string, string>, registeredBranches: Set<string>, extra: string[]): Row[] {
  const rows: Row[] = [];
  const refs = run("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/fleet"], repo).out.split("\n").filter(Boolean);
  for (const line of refs) {
    const [branch, sha] = line.split(/\s+/);
    if (!branch || registeredBranches.has(branch)) continue;
    if (listedIntegrationRef(branch, extra)) { rows.push(row("needs-review", false, repo, repo, branch, "none", "listed integration ref in seats/integration-refs.txt")); continue; }
    const b = beadFor(branch, beads);
    const safe = integrated(repo, sha, extra) && onRemote(repo, sha) && !!b && b[1] === "closed";
    rows.push(row(safe ? "stale-branch" : "needs-review", safe, repo, repo, branch, safe ? "branch" : "none", safe ? "local fleet branch has no worktree, closed bead, merged and present on remote ref" : !b ? "no closed bead record found for this fleet branch" : b[1] !== "closed" ? `bead ${b[0]} is ${b[1]}` : "branch is not both merged and present on a remote ref", safe ? 0 : undefined));
  }
  return rows;
}


function scanBeadRuns(root: string, beads: Map<string, string>, seats: Map<string, string>, live: Set<string> | null): Row[] {
  const rows: Row[] = [];
  for (const runs of [path.join(root, RUNS_DIRNAME), path.join(root, ".wheelhouse-build")].filter(isDir)) {
    for (const d of subdirs(runs)) {
      const b = beadPrefix(path.basename(d), beads);
      if (!b) continue;
      const seat = seatAnchorWithin(d, seats);
      if (seat) { rows.push(row("seat-anchor", false, root, d, "", "none", seat)); continue; }
      if (b[1] !== "closed") { rows.push(row("needs-review", false, root, d, "", "none", `scratch belongs to bead ${b[0]} which is ${b[1]}`)); continue; }
      if (live === null) { rows.push(row("needs-review", false, root, d, "", "none", "cannot verify: lsof unavailable")); continue; }
      const cwd = liveCwdInside(d, live);
      if (cwd) { rows.push(row("needs-review", false, root, d, "", "none", `live process has its cwd in ${cwd}; scratch belongs to closed bead ${b[0]}`)); continue; }
      rows.push(row("run-scratch", true, root, d, "", "rm", `scratch belongs to closed bead ${b[0]}`));
    }
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
      if (![".git", ".beads", "seats", FLEET_CONTAINER, ".worktrees", RUNS_DIRNAME].includes(base)) walk(child, depth + 1, childDependency);
    }
  };
  walk(root, 0, null);
  return rows;
}

function scan(roots: string[], includeOptional: boolean): Row[] {
  const rows: Row[] = [];
  const resolvedRoots = roots.map((r) => realpathOr(path.resolve(r)) ?? path.resolve(r));
  const extra = extraIntegrationRefs(resolvedRoots);
  const live = liveCwds(true);
  for (const root of resolvedRoots) {
    const seats = seatCwds(root);
    const beads = beadStatuses(root);
    const isa = isaAnchors(root);
    const registeredPaths = new Set<string>();
    for (const repo of repositories(root)) {
      const wts = worktrees(repo);
      for (const wt of wts) registeredPaths.add(path.resolve(wt.path));
      rows.push(...scanWorktrees(root, repo, seats, beads, extra, live, isa));
      rows.push(...scanBranches(repo, root, beads, new Set(wts.map((w) => w.branch).filter(Boolean)), extra));
    }
    const activeBench = benchInProgress(root);
    rows.push(...scanOrphans(root, registeredPaths, seats, live));
    rows.push(...scanBeadRuns(root, beads, seats, live));
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
  if (/\.jsonl$/i.test(file)) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
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
function rootsWithInstallFiles(rows: Row[]): string[] {
  const out = new Set<string>();
  const candidates = new Set<string>();
  for (const r of rows) {
    if (path.isAbsolute(r.repo)) candidates.add(path.resolve(r.repo));
    if (path.isAbsolute(r.path)) candidates.add(path.resolve(r.path));
  }
  for (const c of candidates) {
    if (!path.isAbsolute(c)) continue;
    let cur = fs.existsSync(c) && fs.statSync(c).isDirectory() ? c : path.dirname(c);
    while (true) {
      if (fs.existsSync(path.join(cur, "seats"))) { out.add(cur); break; }
      const next = path.dirname(cur);
      if (next === cur) break;
      cur = next;
    }
  }
  return [...out];
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
function deleteMergedBranchIfStillSafe(repo: string, branch: string, extra: string[]): boolean {
  if (!branch || !isFleetBranch(branch)) return false;
  if (listedIntegrationRef(branch, extra)) return false;
  const sha = localBranchSha(repo, branch);
  if (!sha || !integrated(repo, sha, extra) || !onRemote(repo, sha)) return false;
  const r = run("git", ["branch", "-D", branch], repo);
  return r.ok;
}
/** `archive/<worktree-basename>` at the tip, so nothing is unreachable after removal. */
function archiveTag(repo: string, wt: string, sha: string): string | null {
  if (!sha || onRemote(repo, sha)) return null;
  const base = `archive/${path.basename(wt)}`;
  let name = base;
  const existing = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${name}^{commit}`], repo).out;
  if (existing && existing !== sha) name = `${base}-${sha.slice(0, 7)}`;
  if (existing !== sha) {
    const r = run("git", ["tag", "-f", name, sha], repo);
    if (!r.ok) throw new Error(`archive tag ${name} failed: ${r.err || r.out}`);
  }
  return name;
}
function normalizeCats(cats: Set<string> | null): Set<string> | null {
  if (!cats) return null;
  return new Set([...cats].map((c) => CATEGORY_ALIASES[c] ?? c));
}
function prune(rows: Row[], yes: boolean, cats: Set<string> | null): void {
  const extra = extraIntegrationRefs(rootsWithInstallFiles(rows));
  if (yes) { assertNoMidTurnSeats(rows); assertNoSelectedSeatAnchors(rows, cats); }
  let touched = 0, skipped = 0, reclaimed = 0;
  for (const r of rows) {
    r.category = CATEGORY_ALIASES[r.category] ?? r.category;
    if (cats && !cats.has(r.category)) { skipped++; continue; }
    if (!r.safe || NEVER.has(r.category)) { skipped++; continue; }
    if (!yes) { reclaimed += r.size_bytes; console.log(`DRY-RUN ${r.action} ${r.category} ${r.path}`); continue; }
    if (r.action === "rm") fs.rmSync(r.path, { recursive: true, force: true });
    else if (r.action === "worktree") {
      const branch = r.branch;
      const sha = run("git", ["rev-parse", "HEAD"], r.path).out;
      const tag = archiveTag(r.repo, r.path, sha);
      if (tag) console.log(`TAGGED ${tag} ${sha.slice(0, 12)} before removing ${r.path}`);
      run("git", ["worktree", "remove", "--force", r.path], r.repo);
      if (r.category === "merged-worktree" && branch && deleteMergedBranchIfStillSafe(r.repo, branch, extra)) console.log(`PRUNED branch merged-worktree ${branch}`);
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

// ---------------------------------------------------------------------------
// cleanup — the automatic path (bead close, nightly)
// ---------------------------------------------------------------------------

const CLEANUP_CATEGORIES = new Set(["merged-worktree", "zero-commit-worktree", "orphaned-worktree", "detached-snapshot", "run-scratch"]);

interface CleanupOptions { root: string; dryRun: boolean; deadline: number | null; log: string; bead: string | null; wait: number }

function nowIso(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function acquireCleanupLock(root: string, waitSeconds: number): (() => void) | null {
  const dir = path.join(root, "seats", "run", "cleanup.lock");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const until = Date.now() + waitSeconds * 1000;
  while (true) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), `${process.pid}\n`);
      return () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let owner = 0;
      try { owner = Number(fs.readFileSync(path.join(dir, "pid"), "utf8").trim()); } catch {}
      if (owner && !pidAlive(owner)) { try { fs.rmSync(dir, { recursive: true, force: true }); continue; } catch {} }
      if (!owner) {
        // a lock dir with no pid yet: give the taker a moment; treat as stale after 10 s
        try { if (Date.now() - fs.statSync(dir).mtimeMs > 10000) { fs.rmSync(dir, { recursive: true, force: true }); continue; } } catch {}
      }
      if (Date.now() >= until) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
function rowIsForBead(r: Row, bead: string): boolean {
  const base = path.basename(r.path);
  return r.branch === `fleet/${bead}` || base === bead || base.startsWith(`${bead}-`) || base.startsWith(`${bead}_`);
}
function underAllowed(root: string, p: string): boolean {
  const rp = path.resolve(p);
  return [FLEET_CONTAINER, RUNS_DIRNAME, ".wheelhouse-build"].some((d) => insideOf(rp, path.join(root, d)) && rp !== path.join(root, d));
}

function cleanup(o: CleanupOptions): number {
  const root = realpathOr(path.resolve(o.root)) ?? path.resolve(o.root);
  fs.mkdirSync(path.dirname(o.log), { recursive: true });
  const emit = (line: string) => { const l = `${nowIso()} ${line}`; console.log(l); if (!o.dryRun) fs.appendFileSync(o.log, l + "\n"); };
  const release = acquireCleanupLock(root, o.wait);
  if (!release) { console.log("already running"); return 0; }
  let removed = 0, kept = 0, freed = 0, failed = 0;
  const pastDeadline = () => o.deadline !== null && Date.now() / 1000 >= o.deadline;
  try {
    let rows = scan([root], false).filter((r) => CLEANUP_CATEGORIES.has(r.category) || NEVER.has(r.category));
    if (o.bead) rows = rows.filter((r) => rowIsForBead(r, o.bead!));
    const dry = o.dryRun ? "dry-run " : "";
    const inContainer = (p: string) => underAllowed(root, p) || DEFAULT_CONTAINERS.some((d) => insideOf(path.resolve(p), path.join(root, d)));
    for (const r of rows) {
      if (NEVER.has(r.category)) {
        // kept lines only for what cleanup could otherwise have touched: worktrees and bead scratch
        if (inContainer(r.path)) { emit(`${dry}kept ${r.category} ${r.path} reason=${r.category === "seat-anchor" ? `seat-anchor: ${r.reason}` : r.reason}`); kept++; }
        continue;
      }
      if (!underAllowed(root, r.path)) { emit(`${dry}kept ${r.category} ${r.path} reason=outside ${FLEET_CONTAINER}/ and ${RUNS_DIRNAME}/; never touched by cleanup`); kept++; continue; }
      const real = realpathOr(r.path);
      if (real && real !== path.resolve(r.path)) { emit(`${dry}kept ${r.category} ${r.path} reason=path mismatch: real path is ${real}`); kept++; continue; }
      if (pastDeadline()) { emit(`${dry}cleanup deadline reached removed=${removed} kept=${kept} bytes=${freed}`); return failed ? 1 : 0; }
      // verify again right before acting: the world may have moved since the scan
      if (!fs.existsSync(r.path)) { emit(`${dry}already removed ${r.path}`); continue; }
      const live = liveCwds(true);
      if (live === null) { emit(`${dry}kept ${r.category} ${r.path} reason=cannot verify: lsof unavailable`); kept++; continue; }
      const cwd = liveCwdInside(r.path, live);
      if (cwd) { emit(`${dry}kept ${r.category} ${r.path} reason=live process has its cwd in ${cwd}`); kept++; continue; }
      const anchor = seatAnchorWithin(r.path, seatAnchors(root));
      if (anchor) { emit(`${dry}kept ${r.category} ${r.path} reason=seat-anchor: ${anchor}`); kept++; continue; }
      if (r.action === "worktree") {
        const pushing = pushInProgress(root, r.path, live);
        if (pushing) { emit(`${dry}kept ${r.category} ${r.path} reason=deferred: push in progress (${pushing})`); kept++; continue; }
        const tree = treeState(r.repo, r.path);
        if (!tree.clean) { emit(`${dry}kept ${r.category} ${r.path} reason=uncommitted changes (${tree.detail})`); kept++; continue; }
      }
      if (o.dryRun) { emit(`dry-run would remove ${r.category} ${r.path} bytes=${r.size_bytes} reason=${r.reason}`); removed++; freed += r.size_bytes; continue; }
      try {
        let tagged = "";
        if (r.action === "worktree") {
          const sha = run("git", ["rev-parse", "HEAD"], r.path).out;
          const tag = archiveTag(r.repo, r.path, sha);
          if (tag) tagged = `; archived as ${tag}`;
          const rm = run("git", ["worktree", "remove", "--force", r.path], r.repo);
          if (!rm.ok) {
            if (!fs.existsSync(r.path)) { emit(`already removed ${r.path}`); continue; }
            throw new Error(rm.err || rm.out || `git worktree remove exited ${rm.code}`);
          }
          if (fs.existsSync(r.path)) fs.rmSync(r.path, { recursive: true, force: true });
        } else {
          if (!fs.existsSync(r.path)) { emit(`already removed ${r.path}`); continue; }
          fs.rmSync(r.path, { recursive: true, force: true });
        }
        emit(`removed ${r.category} ${r.path} bytes=${r.size_bytes} reason=${r.reason}${tagged}`);
        removed++; freed += r.size_bytes;
      } catch (e: any) {
        if (!fs.existsSync(r.path)) { emit(`already removed ${r.path}`); continue; }
        emit(`failed ${r.category} ${r.path} reason=${String(e?.message ?? e).replace(/\s+/g, " ")}`);
        failed++;
      }
    }
    if (!o.dryRun) for (const repo of repositories(root)) run("git", ["worktree", "prune"], repo);
    emit(`${dry}cleanup done removed=${removed} kept=${kept} bytes=${freed}${failed ? ` failed=${failed}` : ""}`);
    return failed ? 1 : 0;
  } finally {
    release();
  }
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || !["scan", "prune", "cleanup", "categories"].includes(cmd)) { console.error("usage: prune.ts scan|prune|cleanup|categories ..."); process.exit(2); }
  if (cmd === "categories") { for (const [k, v] of Object.entries(CATEGORIES)) console.log(`${k}\t${v}`); return; }
  let format = "tsv", from = "", yes = false, includeOptional = false, dryRun = false, deadline: number | null = null, bead: string | null = null, wait = 0;
  let log = process.env.WHEELHOUSE_CLEANUP_LOG || "";
  const roots: string[] = []; let cats: Set<string> | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") roots.push(argv[++i]);
    else if (a === "--format") format = argv[++i];
    else if (a === "--from-file") from = argv[++i];
    else if (a === "--yes") yes = true;
    else if (a === "--include-optional") includeOptional = true;
    else if (a === "--categories") cats = normalizeCats(new Set(argv[++i].split(",").filter(Boolean)));
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--deadline") deadline = Number(argv[++i]);
    else if (a === "--log") log = argv[++i];
    else if (a === "--bead") bead = argv[++i];
    else if (a === "--wait") wait = Number(argv[++i]) || 0;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (cmd === "scan") {
    const rows = scan(roots.length ? roots : [ROOT], includeOptional);
    if (format === "json") process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    else if (format === "jsonl") process.stdout.write(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    else process.stdout.write(toTsv(rows));
  } else if (cmd === "cleanup") {
    if (roots.length > 1) { console.error("cleanup takes at most one --root"); process.exit(2); }
    const root = roots[0] ? path.resolve(roots[0]) : ROOT;
    const code = cleanup({ root, dryRun, deadline: Number.isFinite(deadline as number) ? deadline : null, log: log || path.join(root, "seats", "logs", "cleanup.log"), bead, wait });
    process.exit(code);
  } else {
    if (!from) { console.error("prune requires --from-file <reviewed scan>"); process.exit(2); }
    prune(parseScan(from), yes, cats);
  }
}

if (import.meta.main) main();
