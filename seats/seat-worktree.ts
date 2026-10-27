/**
 * seat-worktree.ts — one persistent git worktree per seat.
 *
 * A seat's product anchor is `<root>/.wheelhouse-worktrees/<seat-name>`;
 * declared umbrella tasks use a separate `umbrella-<seat-name>` anchor when
 * the primary belongs to the product. Each carries the seat across beads in
 * its own repository. Dispatching a bead does `git switch -c fleet/<bead>
 * <base>` (or `git switch fleet/<bead>` for a reopened bead) INSIDE that
 * worktree, so a warm build survives from one bead to the next and the fleet
 * applies the seats (+2 headroom) creation cap in each repository. The rules, in order:
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
import * as os from "node:os";
import * as path from "node:path";
import { completedSpawnSync as spawnSync, nativeJsonArray } from "./native-command";
import { effectiveRoster } from "./roster";
import { CREDENTIAL_SHAPE_RE } from "./credential-shapes";

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

/** Shared by adapter CLI and library callers. Same segment rule as verify.ts:
 * no empty/dot segments, separators, whitespace or shell quote characters. */
export function validateSegment(kind: string, value: string): string {
  const bad =
    typeof value !== "string" ? "not a string" :
    value.length === 0 ? "empty" :
    value === "." || value === ".." ? "a dot segment" :
    /[/\\]/.test(value) ? "a path separator" :
    /\s/.test(value) ? "whitespace" :
    /['"`]/.test(value) ? "a quote character" :
    null;
  if (bad !== null) refuse(`invalid ${kind} ${JSON.stringify(value)} (${bad}) — must be a single path segment: no /, no .., no whitespace, no quotes`);
  return value;
}

export function git(root: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync("git", args, { cwd: cwd ?? root, env: env ? { ...process.env, ...env } : process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && !r.signal && r.status === 0, out: (r.stdout ?? "").trim(), err: String(r.stderr || r.error?.message || r.signal || "").trim(), code: r.status ?? null };
}

export function worktreesDir(root: string): string { return path.join(root, WORKTREES_DIRNAME); }
export function seatWorktreeDir(root: string, seat: string): string { return path.join(worktreesDir(root), validateSegment("seat name", seat)); }
export function umbrellaSeatWorktreeDir(root: string, seat: string): string { return path.join(worktreesDir(root), `umbrella-${validateSegment("seat name", seat)}`); }

/** Keep the product anchor: a declared umbrella task uses its separate anchor
 * when the ordinary one belongs to another repo, or that alternate exists.
 * A fresh seat still follows the original primary-anchor path. */
function dispatchWorktreeDir(root: string, seat: string, umbrella: boolean): string {
  const primary = seatWorktreeDir(root, seat);
  if (!umbrella) return primary;
  const alternate = umbrellaSeatWorktreeDir(root, seat);
  if (fs.existsSync(alternate) || isSymlink(alternate)) return alternate;
  if (fs.existsSync(primary)) {
    const expected = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const actual = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], primary);
    if (expected.ok && actual.ok && !samePath(actual.out, expected.out)) return alternate;
  }
  return primary;
}
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

/** effective roster length + 2; WHEELHOUSE_MAX_LIVE_WORKTREES is a selftest override only. */
export function worktreeCap(root: string, roster?: Record<string, unknown>): { cap: number; seats: number } {
  let seats = 0;
  if (roster) seats = Object.keys(roster).length;
  else {
    try { seats = Object.keys(effectiveRoster(root)).length; } catch {
      try { seats = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "seats", "seats.json"), "utf8")).seats ?? {}).length; } catch {}
    }
  }
  const override = Number(process.env.WHEELHOUSE_MAX_LIVE_WORKTREES ?? "");
  if (Number.isSafeInteger(override) && override > 0) return { cap: override, seats };
  return { cap: seats + CAP_HEADROOM, seats };
}

function beadStatuses(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (process.env.WHEELHOUSE_SKIP_BD === "1" && !process.env.FIXTURE_BD_CLOSED_FILE) return out;
  for (const st of ["open", "in_progress", "blocked", "deferred", "closed"]) {
    const r = spawnSync("bd", ["list", `--status=${st}`, "--json", "--limit", "5000"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
    try { for (const b of nativeJsonArray(r, `bd list ${st}`, ["id"])) out.set(String(b.id), String(b.status ?? st)); }
    catch (e: any) { refuse(`cannot verify bead statuses: ${e.message}`); }
  }
  return out;
}

function isLegacyWorktree(root: string, p: string, roster?: Record<string, unknown>): boolean {
  if (!isFleetWorktreePath(root, p)) return false;
  const name = path.basename(p);
  return !(roster ? Object.keys(roster).some(seat => name === seat || name === `umbrella-${seat}`) : false);
}

function legacyBeadOpen(root: string, wt: RegisteredWorktree, state: StateLike, statuses: Map<string, string>): boolean {
  const name = path.basename(wt.path);
  const st = statuses.get(name);
  if (st) return st !== "closed";
  if (Object.values(state.seats ?? {}).some((rec) => rec?.cwd && pidAlive(rec.pid ?? null) && samePath(rec.cwd, wt.path))) return true;
  return true;
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

function templateSourceValue(root: string, key: string): string | null {
  try {
    const text = fs.readFileSync(path.join(root, "wheelhouse", ".template-source"), "utf8");
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    const value = m?.[1]?.trim() ?? "";
    return value || null;
  } catch { return null; }
}

function pushBaseCandidate(candidates: string[], ref: string | null): void {
  if (!ref) return;
  if (!ref.includes("/") && !ref.startsWith("refs/")) candidates.push(`origin/${ref}`);
  candidates.push(ref);
}

function pushIntegrationBaseCandidate(root: string, candidates: string[], ref: string | null): void {
  if (!ref) return;
  if (!ref.includes("/") || !refExists(root, ref)) candidates.push(`origin/${ref}`);
  candidates.push(ref);
}

/** Explicit wins. An Integration: ref is used unless it is strictly behind
 * the resolved default line; no goal ref is created, moved or published here.
 * Default precedence remains env, recorded merge target, origin HEAD,
 * origin/main, origin/master, main, master, HEAD. */
export function resolveBase(root: string, beadId: string, explicit?: string | null, bdRoot: string = root, note: (line: string) => void = () => {}): string {
  if (explicit && refExists(root, explicit)) return explicit;
  const integration: string[] = [];
  const fromBead = integrationLineFor(bdRoot, beadId);
  if (fromBead) pushIntegrationBaseCandidate(root, integration, fromBead);
  const goal = integration.find(ref => refExists(root, ref));
  const defaults: string[] = [];
  if (process.env.WHEELHOUSE_WORKTREE_BASE) defaults.push(process.env.WHEELHOUSE_WORKTREE_BASE);
  pushBaseCandidate(defaults, templateSourceValue(bdRoot, "merge-target"));
  const originHead = git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead.ok && originHead.out) defaults.push(originHead.out);
  defaults.push("origin/main", "origin/master", "main", "master", "HEAD");
  const defaultRef = defaults.find(ref => refExists(root, ref));
  if (goal) {
    if (defaultRef) {
      const goalSha = git(root, ["rev-parse", `${goal}^{commit}`]);
      const defaultSha = git(root, ["rev-parse", `${defaultRef}^{commit}`]);
      if (goalSha.ok && defaultSha.ok && goalSha.out !== defaultSha.out &&
          git(root, ["merge-base", "--is-ancestor", goal, defaultRef]).ok) {
        const unique = git(root, ["rev-list", "--count", `${defaultRef}..${goal}`]);
        if (unique.ok && unique.out === "0") {
          note(`Integration: ${fromBead} (${goal} at ${goalSha.out}) holds nothing the default line lacks; using ${defaultRef} at ${defaultSha.out} instead`);
          return defaultRef;
        }
      }
    }
    return goal;
  }
  if (defaultRef) return defaultRef;
  refuse(`no base ref resolves for bead ${beadId} (tried ${[...(explicit ? [explicit] : []), ...integration, ...defaults].join(", ")}); pass --base <ref>`);
}

function beadText(root: string, beadId: string): string {
  if (process.env.WHEELHOUSE_SKIP_BD === "1") return "";
  const r = spawnSync("bd", ["show", beadId, "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  try {
    const rows = nativeJsonArray(r, `bd show ${beadId}`, ["id"]);
    if (rows.length !== 1 || rows[0].id !== beadId) refuse(`bd show ${beadId} did not return the requested bead`);
    const b = rows[0];
    return [b.title, b.description, b.notes, b.design, b.body].filter((s) => typeof s === "string").join("\n");
  } catch (e: any) { refuse(`cannot verify bead metadata: ${e.message}`); }
}

function integrationLineFor(root: string, beadId: string): string | null {
  const m = beadText(root, beadId).match(/^\s*Integration:\s*([^\s`'"]+)/m);
  return m ? m[1] : null;
}

function repoLineFor(root: string, beadId: string): string | null {
  // Contracts also put the field after another sentence ("Closes: H7. Repo:").
  // Do not match ordinary prose such as "a task naming Repo: UMBRELLA".
  const m = beadText(root, beadId).match(/(?:^[ \t]*|[.;][ \t]+)Repo:[ \t]*([^\s`'",;]+)/mi);
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

/** Untrimmed `git status --porcelain`: the first line's leading space is part of its XY code. */
export function porcelainStatus(wt: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", wt, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  return { ok: !r.error && !r.signal && r.status === 0, out: r.stdout ?? "", err: String(r.stderr || r.error?.message || r.signal || "").trim() };
}

export function ensureSeatLocalExcludes(wt: string, skillEntries: string[] = []): void {
  const exclude = git(wt, ["rev-parse", "--git-path", "info/exclude"], wt);
  if (!exclude.ok || !exclude.out) {
    if (skillEntries.length) refuse(`cannot locate skill excludes in ${wt}: ${exclude.err}`);
    return;
  }
  const file = path.isAbsolute(exclude.out) ? exclude.out : path.join(wt, exclude.out);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    // A trailing slash matches a real directory, NOT a symlink. Exact entry
    // rules hide factory links without hiding the whole skills directory.
    const lines = ["/.wheelhouse-runs/", "/.wheelhouse-worktrees/", ...skillEntries.map(entry => `/${entry.replace(/([\\*?\[\] ])/g, "\\$1")}`)];
    const missing = lines.filter((line) => !current.split("\n").includes(line));
    if (missing.length) fs.appendFileSync(file, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${missing.join("\n")}\n`);
  } catch (e: any) {
    if (skillEntries.length) refuse(`cannot write skill excludes in ${wt}: ${e.message}`);
  }
}

const SKILL_LOCATIONS = [".agents/skills", ".claude/skills"];
const REQUIRED_FACTORY_SKILLS = ["intent", "outcomes", "create-verification", "maintain-verification"];

/** Only directories carrying SKILL.md are factory skills; notices are not. */
export function factorySkills(root: string): { name: string; source: string }[] {
  const dir = path.resolve(root, ".agents/skills");
  if (!fs.existsSync(dir)) return []; // Older installs and library fixtures.
  return fs.readdirSync(dir).sort().flatMap(name => {
    const source = path.join(dir, name);
    try {
      if (fs.statSync(source).isDirectory() && fs.statSync(path.join(source, "SKILL.md")).isFile()) {
        validateSegment("factory skill name", name);
        return [{ name, source }];
      }
    } catch (e: any) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
    return [];
  });
}

/** Link, do not copy: upgrades at the install root reach existing seats on the
 * next preparation. Product-owned directories and committed links win. */
export function linkFactorySkills(root: string, wt: string, note: (line: string) => void = () => {}): void {
  const skills = factorySkills(root);
  if (!skills.length) return;
  // Do not follow a planted parent into another tree while repairing links.
  for (const parent of [".agents", ".agents/skills", ".claude", ".claude/skills"]) {
    try {
      const stat = fs.lstatSync(path.join(wt, parent));
      if (!stat.isDirectory() || stat.isSymbolicLink()) refuse(`cannot link factory skills through non-directory or symlink parent ${parent} in ${wt}`);
    } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  const entries: string[] = [];
  for (const loc of SKILL_LOCATIONS) {
    fs.mkdirSync(path.join(wt, loc), { recursive: true });
    for (const { name, source } of skills) {
      const relative = `${loc}/${name}`, target = path.join(wt, relative);
      let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(target); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (stat?.isDirectory()) { note(`seat skills: keeping project directory ${relative}`); continue; }
      if (stat && !stat.isSymbolicLink()) refuse(`cannot replace non-symlink skill entry ${relative} in ${wt}`);
      if (stat) {
        const tracked = git(wt, ["ls-files", "--error-unmatch", "--", `:(literal)${relative}`]);
        if (tracked.ok) { note(`seat skills: keeping committed project link ${relative}`); continue; }
        if (tracked.code !== 1) refuse(`cannot check ownership of skill ${relative}: ${tracked.err}`);
        if (fs.readlinkSync(target) === source) { entries.push(relative); continue; }
        fs.unlinkSync(target); // Only the untracked symlink itself, never its target.
      }
      fs.symlinkSync(source, target);
      entries.push(relative);
    }
  }
  ensureSeatLocalExcludes(wt, entries);
}

/** Read-only discovery check. It never prepares/repairs links or changes state.
 * Check both Git paths even when the harness reads only one: a tracked manual
 * can be dirty through its canonical path while its Claude link is unchanged. */
export function checkSeatSkills(root: string, wt: string, harness: string): string[] {
  const inventory = factorySkills(root);
  for (const name of REQUIRED_FACTORY_SKILLS) if (!inventory.some(skill => skill.name === name)) refuse(`${name}: missing factory SKILL.md at the install root`);
  const names = new Set(inventory.map(skill => skill.name));
  const manuals = new Set<string>();
  for (const loc of SKILL_LOCATIONS) {
    const dir = path.join(wt, loc);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.startsWith("verify-")) continue;
      try { if (fs.statSync(path.join(dir, name)).isDirectory()) manuals.add(name); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
  }
  if (!manuals.size) refuse(`verify-*: missing project manual in ${wt}`);
  for (const name of manuals) names.add(name);
  const loc = harness === "claude-code" ? ".claude/skills" : ".agents/skills";
  for (const name of [...names].sort()) {
    const entry = path.join(wt, loc, name, "SKILL.md");
    try { if (!fs.statSync(entry).isFile()) refuse(`${name}: missing ${loc}/${name}/SKILL.md`); }
    catch (e: any) { if (e.code === "ENOENT" || e.code === "ENOTDIR") refuse(`${name}: missing ${loc}/${name}/SKILL.md`); throw e; }
    const status = git(wt, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...SKILL_LOCATIONS.map(dir => `:(literal)${dir}/${name}`)]);
    if (!status.ok || status.err) refuse(`${name}: git status failed: ${status.err}`);
    if (status.out) refuse(`${name}: dirty skill entry in ${wt}`);
  }
  return [...names].sort();
}

export function worktreeStatus(_root: string, wt: string): { clean: boolean; phantomOnly: boolean; real: string[] } {
  ensureSeatLocalExcludes(wt);
  const r = porcelainStatus(wt);
  if (!r.ok) return { clean: false, phantomOnly: false, real: [`git status failed: ${r.err}`] };
  return phantomOnlyStatus(r.out);
}

export function tipOnRemote(root: string, sha: string): boolean {
  const r = git(root, ["branch", "-r", "--contains", sha]);
  return r.ok && r.out.split("\n").some((l) => l.trim() && !l.includes("->"));
}

export function remoteTrackingTip(root: string, remote: string, branch: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}^{commit}`]);
  return r.ok && r.out ? r.out : null;
}

export function pushMarkerPath(root: string, seat: string): string { return path.join(root, "seats", "run", `push.${seat}.json`); }


export interface CredentialScanHit { commit: string; path: string; line: string; text: string }
export function credentialShapeHits(repo: string, base: string | null, headSha: string): CredentialScanHit[] {
  const args = base ? ["diff", "--unified=0", `${base}..${headSha}`, "--", "."] : ["show", "--format=", "--unified=0", headSha, "--", "."];
  const r = git(repo, args);
  if (!r.ok) return [{ commit: "scan", path: "git diff", line: "0", text: r.err || r.out || "credential scan failed" }];
  const hits: CredentialScanHit[] = [];
  const credentialRe = new RegExp(CREDENTIAL_SHAPE_RE);
  let file = "?";
  let nextLine = 0;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (line === "+++ /dev/null") { file = "?"; continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { nextLine = Number(h[1]); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      if (credentialRe.test(text)) hits.push({ commit: headSha, path: file, line: String(nextLine), text });
      nextLine++;
    } else if (!line.startsWith("-")) {
      nextLine++;
    }
  }
  return hits;
}

function remoteReachableRefs(repo: string, remote: string): string[] {
  const r = git(repo, ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}`]);
  if (!r.ok) return [];
  return r.out.split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/HEAD"));
}

function newlyPublishedCommits(repo: string, remote: string, headSha: string): string[] | null {
  const refs = remoteReachableRefs(repo, remote);
  if (refs.length === 0) return null;
  const r = git(repo, ["rev-list", "--reverse", headSha, "--not", ...refs]);
  if (!r.ok) return null;
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function credentialShapeHitsInPatch(patch: string, commit: string): CredentialScanHit[] {
  const hits: CredentialScanHit[] = [];
  const credentialRe = new RegExp(CREDENTIAL_SHAPE_RE);
  let file = "?";
  let nextLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (line === "+++ /dev/null") { file = "?"; continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { nextLine = Number(h[1]); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      if (credentialRe.test(text)) hits.push({ commit, path: file, line: String(nextLine), text });
      nextLine++;
    } else if (!line.startsWith("-") && nextLine > 0) {
      nextLine++;
    }
  }
  return hits;
}

export function credentialShapeHitsForPublish(repo: string, remote: string, branch: string, headSha: string): CredentialScanHit[] {
  const commits = newlyPublishedCommits(repo, remote, headSha);
  if (!commits) return credentialShapeHits(repo, diffBaseForPublish(repo, remote, branch, headSha), headSha);
  const hits: CredentialScanHit[] = [];
  for (const commit of commits) {
    const r = git(repo, ["show", "--format=", "--unified=0", commit, "--", "."]);
    if (!r.ok) return [{ commit: "scan", path: "git show", line: "0", text: r.err || r.out || "credential scan failed" }];
    hits.push(...credentialShapeHitsInPatch(r.out, commit));
  }
  return hits;
}

export function credentialScanSummary(repo: string, remote: string, branch: string, headSha: string): string | null {
  const hits = credentialShapeHitsForPublish(repo, remote, branch, headSha);
  if (hits.length === 0) return null;
  return hits.slice(0, 5).map((h) => `${h.path}:${h.line}`).join(", ");
}

export interface PublicStateScanHit { path: string; line: string; kind: string }

function diffBaseForPublish(repo: string, remote: string, branch: string, headSha: string): string | null {
  const remoteTip = remoteTrackingTip(repo, remote, branch);
  if (remoteTip) return remoteTip;
  for (const ref of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`, "main", "master"]) {
    const mb = git(repo, ["merge-base", headSha, ref]);
    if (mb.ok && mb.out) return mb.out;
  }
  return null;
}

function addedLineHitsInPatch(patch: string, patterns: { kind: string; re: RegExp }[]): PublicStateScanHit[] {
  const hits: PublicStateScanHit[] = [];
  let file = "?";
  let nextLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { nextLine = Number(h[1]); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      for (const p of patterns) if (p.re.test(text)) { hits.push({ path: file, line: String(nextLine), kind: p.kind }); break; }
      nextLine++;
    } else if (!line.startsWith("-") && nextLine > 0) {
      nextLine++;
    }
  }
  return hits;
}

function addedLineHits(repo: string, base: string | null, headSha: string, patterns: { kind: string; re: RegExp }[]): PublicStateScanHit[] {
  if (patterns.length === 0) return [];
  const args = base ? ["diff", "--unified=0", `${base}..${headSha}`, "--", "."] : ["show", "--format=", "--unified=0", headSha, "--", "."];
  const r = git(repo, args);
  if (!r.ok) return [{ path: "git diff", line: "0", kind: "state scan failed" }];
  return addedLineHitsInPatch(r.out, patterns);
}

function addedLineHitsForPublish(repo: string, remote: string, branch: string, headSha: string, patterns: { kind: string; re: RegExp }[]): PublicStateScanHit[] {
  if (patterns.length === 0) return [];
  const commits = newlyPublishedCommits(repo, remote, headSha);
  if (!commits) return addedLineHits(repo, diffBaseForPublish(repo, remote, branch, headSha), headSha, patterns);
  const hits: PublicStateScanHit[] = [];
  for (const commit of commits) {
    const r = git(repo, ["show", "--format=", "--unified=0", commit, "--", "."]);
    if (!r.ok) return [{ path: "git show", line: "0", kind: "state scan failed" }];
    hits.push(...addedLineHitsInPatch(r.out, patterns));
  }
  return hits;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function installBeadPrefixes(root: string): string[] {
  const env = (process.env.WHEELHOUSE_LEAK_BEAD_PREFIX || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const out = new Set(env);
  if (process.env.WHEELHOUSE_SKIP_BD !== "1") {
    const r = spawnSync("bd", ["list", "--limit", "20", "--json"], { cwd: root, encoding: "utf8", timeout: 10000 });
    try {
      for (const row of nativeJsonArray(r, "bd list for public-state guard", ["id"])) {
        const id = String(row.id);
        const m = id.match(/^(.+)-[a-z0-9]{4}(?:\.\d+)?$/);
        if (m) out.add(m[1]);
      }
    } catch (e: any) { refuse(`public-state guard cannot verify bead prefixes: ${e.message}`); }
  }
  return Array.from(out).filter((s) => /^[A-Za-z0-9_.-]+$/.test(s));
}

function publicStatePatterns(root: string): { kind: string; re: RegExp }[] {
  const patterns: { kind: string; re: RegExp }[] = [];
  for (const prefix of installBeadPrefixes(root)) patterns.push({ kind: "install bead id", re: new RegExp(`\\b${escapeRe(prefix)}-[a-z0-9]{4}(?:\\.\\d+)?\\b`, "i") });
  const home = os.homedir();
  if (home && home !== "/") patterns.push({ kind: "home path", re: new RegExp(escapeRe(home), "i") });
  const deny = path.join(root, "seats", "run", "leak-terms");
  try {
    for (const line of fs.readFileSync(deny, "utf8").split(/\r?\n/)) {
      const term = line.trim();
      if (term && !term.startsWith("#")) patterns.push({ kind: "deny term", re: new RegExp(escapeRe(term), "i") });
    }
  } catch { /* install-local deny file is optional and never committed */ }
  return patterns;
}

export function publicStateScanSummary(root: string, repo: string, remote: string, branch: string, headSha: string): string | null {
  const hits = addedLineHitsForPublish(repo, remote, branch, headSha, publicStatePatterns(root));
  if (hits.length === 0) return null;
  return hits.slice(0, 5).map((h) => `${h.path}:${h.line}`).join(", ");
}

export interface EnsureOptions {
  root: string;
  seat: string;
  beadId: string;
  base?: string | null;
  roster?: Record<string, unknown>;
  state: StateLike;
  remote?: string;
  seatPush?: "on" | "off";
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

/** Prepare the product or separate umbrella seat anchor on `fleet/<bead>`. Throws
 * SeatWorktreeError with an operator-readable message on any refusal. */
export function ensureSeatWorktree(o: EnsureOptions): EnsureResult {
  const root = path.resolve(o.root);
  // One declaration snapshot drives both path selection and repository choice.
  const declaredRepo = repoLineFor(root, o.beadId);
  const umbrella = /^UMBRELLA$/i.test(declaredRepo ?? "");
  const seatTarget = dispatchWorktreeDir(root, o.seat, umbrella);
  let target = seatTarget;
  let branch = beadBranch(o.beadId);
  const note = o.note ?? (() => {});
  const remote = o.remote ?? process.env.WHEELHOUSE_PUSH_REMOTE ?? "origin";
  const seatPush = o.seatPush ?? "on";
  const finish = (result: EnsureResult): EnsureResult => {
    linkFactorySkills(root, result.target, note);
    return result;
  };

  // 1. one live seat per worktree. Stopped/dead seats may retain stale cwd
  // records from crashes or older adapters; those records must not pin a
  // worktree forever.
  for (const [other, rec] of Object.entries(o.state.seats ?? {})) {
    if (other === o.seat || !rec?.cwd || !pidAlive(rec.pid ?? null)) continue;
    if (samePath(rec.cwd, seatTarget)) refuse(`worktree ${seatTarget} is occupied by seat ${other} (recorded cwd); two seats never share a worktree`);
  }

  const rec = o.state.seats?.[o.seat];
  const statuses = beadStatuses(root);
  const recordedLegacyBead = rec?.cwd && !samePath(rec.cwd, umbrellaSeatWorktreeDir(root, o.seat)) && isLegacyWorktree(root, rec.cwd, o.roster) ? path.basename(rec.cwd) : null;
  const recordedLegacy = rec?.cwd && recordedLegacyBead && statuses.get(recordedLegacyBead) !== "closed" && fs.existsSync(rec.cwd) ? rec.cwd : null;
  const namedLegacy = path.join(worktreesDir(root), o.beadId);
  const legacy = recordedLegacy ?? (fs.existsSync(namedLegacy) ? namedLegacy : null);
  // An umbrella declaration chooses its repo before considering a stale
  // product legacy cwd. Only registered legacy trees of that repo can follow.
  const repo = gitRepoFor(root, umbrella ? seatTarget : legacy ?? seatTarget, o.beadId, declaredRepo);
  const registered = registeredWorktrees(repo);
  const atLegacy = legacy ? registered.find((w) => samePath(w.path, legacy)) : undefined;
  // A task-named legacy directory may carry an intentional custom branch,
  // even after migration to the seat anchor. lastBead alone proves neither:
  // a stale dispatch record must not preserve an unrelated current branch.
  const legacyTaskBranch = atLegacy && path.basename(atLegacy.path) === o.beadId && (!rec?.lastBead || rec.lastBead === o.beadId) ? atLegacy.branch : null;
  if (atLegacy && (!rec?.pid || !pidAlive(rec.pid ?? null)) && !fs.existsSync(seatTarget)) {
    const mv = git(repo, ["worktree", "move", atLegacy.path, seatTarget]);
    if (mv.ok) {
      note(`seat ${o.seat}: adopted legacy worktree ${atLegacy.path} as ${seatTarget}`);
      target = seatTarget;
    } else {
      target = atLegacy.path;
      note(`seat ${o.seat}: keeping legacy worktree ${atLegacy.path} in place because git worktree move failed (${mv.err || mv.out})`);
    }
  } else if (atLegacy && (path.basename(atLegacy.path) === o.beadId || samePath(rec?.cwd ?? "", atLegacy.path))) {
    target = atLegacy.path;
  }
  let atTarget = registeredWorktrees(repo).find((w) => samePath(w.path, target));
  if (atTarget?.branch && legacyTaskBranch === atTarget.branch) branch = atTarget.branch;
  for (const [other, otherRec] of Object.entries(o.state.seats ?? {})) {
    if (other === o.seat || !otherRec?.cwd || !pidAlive(otherRec.pid ?? null)) continue;
    if (samePath(otherRec.cwd, target)) refuse(`worktree ${target} is occupied by seat ${other} (recorded cwd); two seats never share a worktree`);
  }
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

  const base = resolveBase(repo, o.beadId, o.base, root, note);
  const baseTip = git(repo, ["rev-parse", `${base}^{commit}`]).out;
  const elsewhere = registeredWorktrees(repo).find((w) => (w.branch === branch || w.branch === beadBranch(o.beadId)) && !samePath(w.path, target));
  if (elsewhere) refuse(`branch ${elsewhere.branch} is already checked out at ${elsewhere.path}; cannot prepare target ${target}: a branch can be in one worktree at a time`);
  const exists = branchExists(repo, branch);

  if (!atTarget) {
    // 3. cap gates creation only
    const live = fleetWorktrees(root, repo).filter((w) => {
      if (fs.existsSync(path.join(w.path, PLACEHOLDER_MARKER))) return false;
      if (!isLegacyWorktree(root, w.path, o.roster)) return true;
      return legacyBeadOpen(root, w, o.state, statuses);
    });
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
    return finish({ target, branch, base, created: true, switched: false, pushed: null, previousBranch: null });
  }

  // Worktree exists and is registered. Already on the bead's branch?
  const current = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], target);
  const currentBranch = current.ok && current.out ? current.out : null;
  if (currentBranch === branch) return finish({ target, branch, base, created: false, switched: false, pushed: null, previousBranch: currentBranch });

  // 4. push gate: the previous branch must be on the remote before the seat moves on
  const headSha = git(repo, ["rev-parse", "HEAD"], target).out;
  let pushed: string | null = null;
  const hasRemote = git(repo, ["remote", "get-url", remote]).ok;
  const reachableFromAnotherBranch = () => git(repo, ["branch", "--contains", headSha, "--format=%(refname:short)"]).out.split("\n").filter((b) => b && b !== currentBranch).length > 0;
  if (currentBranch && !tipOnRemote(repo, headSha) && seatPush === "off") {
    note(`seat ${o.seat}: seat_push=off; not pushing ${currentBranch} before leaving it`);
  } else if (currentBranch && !hasRemote && !tipOnRemote(repo, headSha)) {
    // Nowhere to push. That is fine only when the branch holds nothing of its own.
    if (!reachableFromAnotherBranch()) refuse(`push failed for ${currentBranch} in ${target}: no remote named ${remote} to push to, and its commits are on no other branch. The seat stays on ${currentBranch}.`);
  } else if (currentBranch && !tipOnRemote(repo, headSha)) {
    const credentialHits = credentialScanSummary(repo, remote, currentBranch, headSha);
    if (credentialHits) {
      const msg = `credential scan failed for ${currentBranch}: ${credentialHits}; refusing to push. The seat stays on ${currentBranch} in ${target}.`;
      note(`seat ${o.seat}: ${msg}`);
      refuse(msg);
    }
    const stateHits = publicStateScanSummary(root, repo, remote, currentBranch, headSha);
    if (stateHits) {
      const msg = `public state scan failed for ${currentBranch}: ${stateHits}; refusing to push. The seat stays on ${currentBranch} in ${target}.`;
      note(`seat ${o.seat}: ${msg}`);
      refuse(msg);
    }
    const markerFile = pushMarkerPath(root, o.seat);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ seat: o.seat, branch: currentBranch, worktree: target, startedAt: new Date().toISOString(), pid: process.pid }) + "\n");
    let push: ReturnType<typeof git>;
    try {
      const lease = currentBranch.startsWith("fleet/") ? remoteTrackingTip(repo, remote, currentBranch) : null;
      const pushArgs = ["push", "-u", ...(lease ? [`--force-with-lease=refs/heads/${currentBranch}:${lease}`] : []), remote, `${currentBranch}:${currentBranch}`];
      push = git(repo, pushArgs, target, { WHEELHOUSE_INTEGRATOR_PUSH: "1" });
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
  return finish({ target, branch, base, created: false, switched: true, pushed, previousBranch: currentBranch });
}

/** First product repository recorded by the install, when this root is an
 * umbrella container. Absolute paths are used as-is; relative paths are rooted
 * at the install root. */
export function productRepoFor(root: string): string | null {
  const source = path.join(root, "wheelhouse", ".template-source");
  let text = "";
  try { text = fs.readFileSync(source, "utf8"); } catch { return null; }
  const raw = text.split("\n")
    .map((line) => line.match(/^(?:product-repo|product-repos|product_repo|product_repos|repo|repos)=(.*)$/)?.[1] ?? "")
    .find((value) => value.trim().length > 0);
  if (!raw) return null;
  const first = raw.split(/[,;]/)[0].trim();
  if (!first) return null;
  return path.resolve(root, first);
}

/** The repository seat worktrees belong to. A single-repo install IS the
 * repository unless wheelhouse/.template-source records a product-repo= for an
 * umbrella layout. An explicit UMBRELLA declaration wins over an existing
 * target: silently reusing a product worktree would prepare the wrong repo.
 * Otherwise retain the existing target's repository, including hand-created
 * product worktrees when the umbrella itself is also a git repository. */
export function gitRepoFor(root: string, target: string, beadId?: string, declaredRepo?: string | null): string {
  const declaration = declaredRepo === undefined && beadId ? repoLineFor(root, beadId) : declaredRepo;
  if (/^UMBRELLA$/i.test(declaration ?? "")) {
    const umbrella = git(root, ["rev-parse", "--show-toplevel"]);
    const expected = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!umbrella.ok || !expected.ok) refuse(`${root} is not a git repository, but bead ${beadId} declares Repo: UMBRELLA`);
    if (fs.existsSync(target)) {
      const actual = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], target);
      if (actual.ok && !samePath(actual.out, expected.out)) {
        refuse(`bead ${beadId} declares Repo: UMBRELLA, but worktree ${target} belongs to another repository; refusing to create or switch its branch. The selected umbrella target must belong to the umbrella repository.`);
      }
    }
    return umbrella.out;
  }
  if (fs.existsSync(target)) {
    const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], target);
    if (common.ok && common.out) return path.dirname(common.out);
  }
  const product = productRepoFor(root);
  if (product) {
    if (!git(product, ["rev-parse", "--is-inside-work-tree"]).ok) refuse(`wheelhouse/.template-source names product repo ${product}, but it is not a git repository`);
    return git(product, ["rev-parse", "--show-toplevel"]).out || product;
  }
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).ok) return git(root, ["rev-parse", "--show-toplevel"]).out || root;
  refuse(`${root} is not a git repository (an umbrella install), and ${target} is not a worktree yet; create it once with \`git -C <product repo> worktree add ${target} <base>\`, then dispatch again`);
}

/** True when `p` is `<root>/.wheelhouse-worktrees/<something>`. */
export function isFleetWorktreePath(root: string, p: string): boolean {
  const dir = path.resolve(worktreesDir(root));
  const rp = path.resolve(p);
  return path.dirname(rp) === dir;
}

/** Remove a staffed seat's persistent worktree only when it is safe to discard. */
function adapterSeatPushSetting(root: string): "on" | "off" {
  const env = process.env.WHEELHOUSE_SEAT_PUSH;
  if (env === "on" || env === "off") return env;
  try {
    const text = fs.readFileSync(path.join(root, "wheelhouse", ".template-source"), "utf8");
    const m = text.match(/^\s*seat_push=(on|off)\s*$/m);
    if (m) return m[1] as "on" | "off";
  } catch { /* default below matches adapter.ts seatPushSetting() */ }
  return "on";
}

export function removeSeatWorktree(root: string, seat: string): void {
  const wt = seatWorktreeDir(root, seat);
  if (!fs.existsSync(wt)) return;
  // Only resolve directories: a final FIFO must never be opened by realpath.
  if (!fs.statSync(wt).isDirectory() || !fs.statSync(worktreesDir(root)).isDirectory()) refuse(`worktree ${wt} is not a directory; leaving seat registered`);
  const managed = fs.realpathSync(worktreesDir(root)), target = fs.realpathSync(wt);
  if (path.dirname(target) !== managed || path.basename(target) !== seat || fs.lstatSync(wt).isSymbolicLink()) {
    refuse(`worktree ${wt} is not the seat's direct child of ${managed}; leaving seat registered`);
  }
  const st = worktreeStatus(root, wt);
  if (!st.clean) refuse(`worktree ${wt} has real changes (${st.real[0]}); leaving seat registered`);
  const head = git(root, ["rev-parse", "HEAD"], wt).out;
  if (adapterSeatPushSetting(root) === "on" && head && !tipOnRemote(root, head)) refuse(`worktree ${wt} tip ${head.slice(0, 12)} is not on a remote; leaving seat registered`);
  const rm = git(root, ["worktree", "remove", "--force", wt]);
  if (!rm.ok) refuse(`git worktree remove failed for ${wt}: ${rm.err || rm.out}`);
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
}
