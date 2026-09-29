/**
 * seat-worktree.ts — one persistent git worktree per seat.
 *
 * A seat's worktree is `<root>/.wheelhouse-worktrees/<seat-name>`; it carries
 * the seat across beads. Dispatching a bead does `git switch -c fleet/<bead>
 * <base>` (or `git switch fleet/<bead>` for a reopened bead) INSIDE that
 * worktree, so a warm build survives from one bead to the next and the fleet
 * never holds more worktrees than seats (+2 headroom). The rules, in order:
 *
 *   1. Two seats never share a worktree: a target another seat's record
 *      already names is refused, naming the occupying seat.
 *   2. A `.pruned-placeholder` directory (the only entry) is recreated as a
 *      worktree; a placeholder with anything else inside is refused.
 *   3. Creating a NEW worktree is capped at (seats in seats.json + 2).
 *      Seats that run from the repo root take no slot. The refusal names the
 *      live count, the cap and which seat to wait for.
 *   4. Leaving a bead requires its branch to be on the remote first: a
 *      failed push is written to the seat log in plain words ("push failed")
 *      and blocks the move; the old branch stays checked out.
 *   5. Real uncommitted changes block the move (never lose work). Deletions
 *      of once-committed build output (`.cargo-target-shared/`,
 *      `car-rs/.wt-target/`) are not real changes.
 *   6. The base switch is clean: after `git switch`, `git status --porcelain`
 *      is empty and HEAD is the base tip (new bead) or the branch tip
 *      (reopened bead).
 *
 * adapter.ts splices this in at a handful of points (see SPLICE comments
 * there); prune.ts shares the phantom-diff rule through `phantomOnlyStatus`.
 * Nothing here talks to a seat process; it only prepares the directory the
 * adapter will launch or dispatch into.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const WORKTREES_DIRNAME = ".wheelhouse-worktrees";
export const PLACEHOLDER_MARKER = ".pruned-placeholder";
export const CAP_HEADROOM = 2;
/** Deletions under these prefixes are once-committed build output, not work. */
export const PHANTOM_BUILD_PREFIXES = [".cargo-target-shared/", "car-rs/.wt-target/"];

export interface RegisteredWorktree { path: string; branch: string | null; sha: string; detached: boolean }
export interface SeatRecordLike { pid?: number | null; cwd?: string; lastBead?: string; lastDispatchAt?: string }
export interface StateLike { seats: Record<string, SeatRecordLike> }

export class SeatWorktreeError extends Error {}
function refuse(msg: string): never { throw new SeatWorktreeError(msg); }

export function git(root: string, args: string[], cwd?: string): { ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync("git", args, { cwd: cwd ?? root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), code: r.status };
}

export function worktreesDir(root: string): string { return path.join(root, WORKTREES_DIRNAME); }
export function seatWorktreeDir(root: string, seat: string): string { return path.join(worktreesDir(root), seat); }
export function beadBranch(beadId: string): string { return `fleet/${beadId}`; }

export function registeredWorktrees(root: string): RegisteredWorktree[] {
  const r = git(root, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out: RegisteredWorktree[] = [];
  let cur: RegisteredWorktree | null = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) { if (cur) out.push(cur); cur = { path: line.slice(9), branch: null, sha: "", detached: false }; }
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.sha = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
  }
  if (cur) out.push(cur);
  return out;
}

function isSymlink(p: string): boolean { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

export function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

/** Registered worktrees that live directly under `<root>/.wheelhouse-worktrees/`. */
export function fleetWorktrees(root: string, repo: string = root): RegisteredWorktree[] {
  const dir = worktreesDir(root);
  let realDir = path.resolve(dir);
  try { realDir = fs.realpathSync(dir); } catch {}
  return registeredWorktrees(repo).filter((w) => {
    const parent = path.dirname(w.path);
    return parent === path.resolve(dir) || parent === realDir;
  });
}

/** seats.json length + 2; WHEELHOUSE_MAX_LIVE_WORKTREES is a selftest override only. */
export function worktreeCap(root: string, roster?: Record<string, unknown>): { cap: number; seats: number } {
  let seats = 0;
  if (roster) seats = Object.keys(roster).length;
  else {
    try { seats = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "seats", "seats.json"), "utf8")).seats ?? {}).length; } catch {}
  }
  const override = Number(process.env.WHEELHOUSE_MAX_LIVE_WORKTREES ?? "");
  if (Number.isSafeInteger(override) && override > 0) return { cap: override, seats };
  return { cap: seats + CAP_HEADROOM, seats };
}

/** Which seat a dispatcher should wait for when the cap is reached: a seat
 * holding a worktree that is not running, else the one dispatched longest ago. */
export function seatToWaitFor(root: string, state: StateLike, live: RegisteredWorktree[]): string | null {
  const holders: { seat: string; alive: boolean; at: number }[] = [];
  for (const [seat, rec] of Object.entries(state.seats ?? {})) {
    if (!rec?.cwd) continue;
    if (!live.some((w) => samePath(w.path, rec.cwd!))) continue;
    holders.push({ seat, alive: pidAlive(rec.pid ?? null), at: Date.parse(rec.lastDispatchAt ?? "") || 0 });
  }
  if (holders.length === 0) {
    // No seat record explains a live worktree: fall back to the worktree names, which are seat names by construction.
    const named = live.map((w) => path.basename(w.path)).sort();
    return named[0] ?? null;
  }
  holders.sort((a, b) => Number(a.alive) - Number(b.alive) || a.at - b.at || a.seat.localeCompare(b.seat));
  return holders[0].seat;
}

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export function branchExists(root: string, branch: string): boolean {
  return git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

export function refExists(root: string, ref: string): boolean {
  return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
}

/** Which base a bead branches from. Explicit wins, then the bead's own
 * `Integration:` line (via bd, when available), then the install's env
 * default, then the remote's default branch, then local main/master/HEAD. */
export function resolveBase(root: string, beadId: string, explicit?: string | null, bdRoot: string = root): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const fromBead = integrationLineFor(bdRoot, beadId);
  if (fromBead) {
    if (!fromBead.includes("/") || !refExists(root, fromBead)) candidates.push(`origin/${fromBead}`);
    candidates.push(fromBead);
  }
  if (process.env.WHEELHOUSE_WORKTREE_BASE) candidates.push(process.env.WHEELHOUSE_WORKTREE_BASE);
  const originHead = git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead.ok && originHead.out) candidates.push(originHead.out);
  candidates.push("origin/main", "origin/master", "main", "master", "HEAD");
  for (const c of candidates) if (refExists(root, c)) return c;
  refuse(`no base ref resolves for bead ${beadId} (tried ${candidates.join(", ")}); pass --base <ref>`);
}

function integrationLineFor(root: string, beadId: string): string | null {
  if (process.env.WHEELHOUSE_SKIP_BD === "1") return null;
  const r = spawnSync("bd", ["show", beadId, "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return null;
  let text = "";
  try {
    const j = JSON.parse(r.stdout);
    const b = Array.isArray(j) ? j[0] : j;
    text = [b?.title, b?.description, b?.notes, b?.design, b?.body].filter((s) => typeof s === "string").join("\n");
  } catch { text = r.stdout; }
  const m = text.match(/^\s*Integration:\s*([^\s`'"]+)/m);
  return m ? m[1] : null;
}

/** `git status --porcelain` lines that are real changes, ignoring deletions of
 * once-committed build output. Returns { clean, phantomOnly, lines }. */
export function phantomOnlyStatus(statusPorcelain: string): { clean: boolean; phantomOnly: boolean; real: string[] } {
  const lines = statusPorcelain.split("\n").filter((l) => l.length > 0);
  const real = lines.filter((l) => {
    const xy = l.slice(0, 2);
    const p = l.slice(3).replace(/^"|"$/g, "");
    const deletion = xy === " D" || xy === "D " || xy === "DD";
    return !(deletion && PHANTOM_BUILD_PREFIXES.some((pre) => p.startsWith(pre)));
  });
  return { clean: real.length === 0, phantomOnly: real.length === 0 && lines.length > 0, real };
}

export function worktreeStatus(root: string, wt: string): { clean: boolean; phantomOnly: boolean; real: string[] } {
  const r = git(root, ["status", "--porcelain", "--untracked-files=all"], wt);
  if (!r.ok) return { clean: false, phantomOnly: false, real: [`git status failed: ${r.err}`] };
  return phantomOnlyStatus(r.out);
}

export function tipOnRemote(root: string, sha: string): boolean {
  const r = git(root, ["branch", "-r", "--contains", sha]);
  return r.ok && r.out.split("\n").some((l) => l.trim() && !l.includes("->"));
}

export function pushMarkerPath(root: string, seat: string): string { return path.join(root, "seats", "run", `push.${seat}.json`); }

export interface EnsureOptions {
  root: string;
  seat: string;
  beadId: string;
  base?: string | null;
  roster?: Record<string, unknown>;
  state: StateLike;
  remote?: string;
  /** Called with a plain-words line for the seat log and console. */
  note?: (line: string) => void;
}

export interface EnsureResult {
  target: string;
  branch: string;
  base: string;
  created: boolean;
  switched: boolean;
  pushed: string | null;
  previousBranch: string | null;
}

/** Prepare `<root>/.wheelhouse-worktrees/<seat>` on `fleet/<bead>`. Throws
 * SeatWorktreeError with an operator-readable message on any refusal. */
export function ensureSeatWorktree(o: EnsureOptions): EnsureResult {
  const root = path.resolve(o.root);
  const target = seatWorktreeDir(root, o.seat);
  const branch = beadBranch(o.beadId);
  const note = o.note ?? (() => {});
  const remote = o.remote ?? process.env.WHEELHOUSE_PUSH_REMOTE ?? "origin";

  // 1. one seat per worktree
  for (const [other, rec] of Object.entries(o.state.seats ?? {})) {
    if (other === o.seat || !rec?.cwd) continue;
    if (samePath(rec.cwd, target)) refuse(`worktree ${target} is occupied by seat ${other} (recorded cwd); two seats never share a worktree`);
  }

  const repo = gitRepoFor(root, target);
  const registered = registeredWorktrees(repo);
  let atTarget = registered.find((w) => samePath(w.path, target));
  const marker = path.join(target, PLACEHOLDER_MARKER);
  const placeholder = fs.existsSync(marker);

  // 2. placeholder left by a prune: recreate, or refuse if it holds anything else
  if (placeholder) {
    const entries = fs.readdirSync(target);
    if (entries.length !== 1 || entries[0] !== PLACEHOLDER_MARKER) {
      refuse(`worktree target ${target} is a ${PLACEHOLDER_MARKER}, not a Git worktree; refusing to remove it because it contains entries besides ${PLACEHOLDER_MARKER}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    if (atTarget) { git(repo, ["worktree", "prune"]); atTarget = undefined; }
  } else if (atTarget && !fs.existsSync(target)) {
    // registration without a directory: a hand-removed worktree; prune the stale registration and recreate
    git(repo, ["worktree", "prune"]);
    atTarget = undefined;
  } else if (!atTarget && isSymlink(target)) {
    refuse(`worktree target ${target} exists but is not registered by git worktree list (it is a symbolic link); refusing to touch a directory that is not a Git worktree`);
  } else if (!atTarget && fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length > 0) refuse(`worktree target ${target} exists but is not registered by git worktree list; refusing to touch a directory that is not a Git worktree`);
    fs.rmdirSync(target);
  }

  const base = resolveBase(repo, o.beadId, o.base, root);
  const baseTip = git(repo, ["rev-parse", `${base}^{commit}`]).out;
  const elsewhere = registered.find((w) => w.branch === branch && !samePath(w.path, target));
  if (elsewhere) refuse(`branch ${branch} is already checked out at ${elsewhere.path}; a branch can be in one worktree at a time`);
  const exists = branchExists(repo, branch);

  if (!atTarget) {
    // 3. cap gates creation only
    const live = fleetWorktrees(root, repo).filter((w) => !fs.existsSync(path.join(w.path, PLACEHOLDER_MARKER)));
    const { cap, seats } = worktreeCap(root, o.roster);
    if (live.length >= cap) {
      const wait = seatToWaitFor(root, o.state, live);
      const foreign = live.filter((w) => !(o.roster ? Object.keys(o.roster) : []).includes(path.basename(w.path)));
      refuse(
        `live ${live.length} worktrees under ${WORKTREES_DIRNAME}/ at or over cap ${cap} (${seats} seats in seats/seats.json + ${CAP_HEADROOM}); ` +
          `refusing to create ${target}. Wait for seat ${wait ?? "(none recorded)"} to finish and be reset` +
          (foreign.length ? `, or run bun seats/prune.ts cleanup for the ${foreign.length} worktree(s) not named for a seat: ${foreign.map((w) => path.basename(w.path)).join(", ")}` : "") + "."
      );
    }
    fs.mkdirSync(worktreesDir(root), { recursive: true });
    const add = exists ? git(repo, ["worktree", "add", target, branch]) : git(repo, ["worktree", "add", "-b", branch, target, base]);
    if (!add.ok) refuse(`git worktree add failed for ${target}: ${add.err || add.out}`);
    note(`seat ${o.seat}: created worktree ${target} on ${branch}${exists ? " (existing branch, commits kept)" : ` from ${base}`}`);
    return { target, branch, base, created: true, switched: false, pushed: null, previousBranch: null };
  }

  // Worktree exists and is registered. Already on the bead's branch?
  const current = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], target);
  const currentBranch = current.ok && current.out ? current.out : null;
  if (currentBranch === branch) return { target, branch, base, created: false, switched: false, pushed: null, previousBranch: currentBranch };

  // 4. push gate: the previous branch must be on the remote before the seat moves on
  const headSha = git(repo, ["rev-parse", "HEAD"], target).out;
  let pushed: string | null = null;
  const hasRemote = git(repo, ["remote", "get-url", remote]).ok;
  const reachableFromAnotherBranch = () => git(repo, ["branch", "--contains", headSha, "--format=%(refname:short)"]).out.split("\n").filter((b) => b && b !== currentBranch).length > 0;
  if (currentBranch && !hasRemote && !tipOnRemote(repo, headSha)) {
    // Nowhere to push. That is fine only when the branch holds nothing of its own.
    if (!reachableFromAnotherBranch()) refuse(`push failed for ${currentBranch} in ${target}: no remote named ${remote} to push to, and its commits are on no other branch. The seat stays on ${currentBranch}.`);
  } else if (currentBranch && !tipOnRemote(repo, headSha)) {
    const markerFile = pushMarkerPath(root, o.seat);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ seat: o.seat, branch: currentBranch, worktree: target, startedAt: new Date().toISOString(), pid: process.pid }) + "\n");
    let push: ReturnType<typeof git>;
    try {
      push = git(repo, ["push", "-u", remote, `${currentBranch}:${currentBranch}`], target);
    } finally {
      try { fs.rmSync(markerFile, { force: true }); } catch {}
    }
    if (!push.ok) {
      const why = (push.err || push.out || "unknown error").split("\n").filter(Boolean).slice(-3).join(" | ");
      note(`seat ${o.seat}: push failed for ${currentBranch} (${why}); the seat stays on ${currentBranch} in ${target} and is not moved to ${branch}`);
      refuse(`push failed for ${currentBranch} in ${target}: ${why}. The seat stays on ${currentBranch}; fix the remote and dispatch again.`);
    }
    pushed = currentBranch;
    note(`seat ${o.seat}: pushed ${currentBranch} to ${remote} before leaving it`);
  } else if (!currentBranch) {
    const onBranch = git(repo, ["branch", "--contains", headSha, "--format=%(refname:short)"]).out.split("\n").filter(Boolean);
    if (onBranch.length === 0 && !tipOnRemote(repo, headSha)) refuse(`worktree ${target} is detached at ${headSha.slice(0, 12)} and that commit is on no branch or remote; put it on a branch before dispatching another bead`);
  }

  // 5. never lose work: real uncommitted changes block the move
  const st = worktreeStatus(repo, target);
  if (!st.clean) refuse(`worktree ${target} has uncommitted changes on ${currentBranch ?? "a detached HEAD"} (${st.real.length} entr${st.real.length === 1 ? "y" : "ies"}, e.g. ${st.real[0]}); commit or stash before dispatching ${o.beadId}`);
  // 6. clean base switch. Deletions of once-committed build output are not
  // work, so when they are all that differs the switch may discard them
  // rather than re-materialize gigabytes of build output from git objects.
  const switchArgs = exists ? ["switch", "--quiet", branch] : ["switch", "--quiet", "-c", branch, baseTip];
  let sw = git(repo, switchArgs, target);
  if (!sw.ok && st.phantomOnly) sw = git(repo, [switchArgs[0], "--discard-changes", ...switchArgs.slice(1)], target);
  if (!sw.ok) refuse(`git switch failed in ${target}: ${sw.err || sw.out}`);
  const after = worktreeStatus(repo, target);
  if (!after.clean) refuse(`worktree ${target} is not clean after switching to ${branch}: ${after.real[0]}`);
  const head = git(repo, ["rev-parse", "HEAD"], target).out;
  if (!exists && head !== baseTip) refuse(`worktree ${target} HEAD ${head.slice(0, 12)} is not the base tip ${baseTip.slice(0, 12)} after switching to ${branch}`);
  note(`seat ${o.seat}: switched ${target} from ${currentBranch ?? "detached"} to ${branch}${exists ? " (existing branch, commits kept)" : ` from ${base}`}`);
  return { target, branch, base, created: false, switched: true, pushed, previousBranch: currentBranch };
}

/** The repository seat worktrees belong to. A single-repo install IS the
 * repository. An umbrella install (the root is a container; product repos
 * sit below it) has no repository at the root, so the seat's worktree must
 * be created once by hand as a worktree of the right product repo; from then
 * on the adapter manages it through that repo like any other. */
export function gitRepoFor(root: string, target: string): string {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).ok) return git(root, ["rev-parse", "--show-toplevel"]).out || root;
  if (fs.existsSync(target)) {
    const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], target);
    if (common.ok && common.out) return path.dirname(common.out);
  }
  refuse(`${root} is not a git repository (an umbrella install), and ${target} is not a worktree yet; create it once with \`git -C <product repo> worktree add ${target} <base>\`, then dispatch again`);
}

/** True when `p` is `<root>/.wheelhouse-worktrees/<something>`. */
export function isFleetWorktreePath(root: string, p: string): boolean {
  const dir = path.resolve(worktreesDir(root));
  const rp = path.resolve(p);
  return path.dirname(rp) === dir;
}
