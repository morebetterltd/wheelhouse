#!/usr/bin/env bun
/**
 * verify.ts — commander-facing dispatch of the EPHEMERAL reviewer pass.
 *
 * One invocation = one verdict. It spawns a one-shot `pi -p --no-session`
 * on the REVIEWER seat's own agent directory, with the REVIEWER crew brief
 * appended to the system prompt, hands it the bead claim and the branch's
 * tip SHA, and parses the single `VERDICT:` and `PUSH:` lines out of what comes back.
 * A refused answer is kept as diagnostic JSON, never as a verdict. One
 * corrective attempt may replay that answer and the refusal within this
 * invocation, on the same identity/scratch and without rerunning the sweep.
 * No persisted harness session or cross-invocation memory is introduced.
 *
 * The precondition this file exists to enforce: the reviewer's account is
 * not the author's. Same account.dir means same auth.json means same
 * account, and a verdict from the author's own account is not a verdict.
 * The comparison happens BEFORE anything is spawned, against canonicalized
 * paths, and an identical pair is a loud STOP, not a warning.
 *
 * The reviewer process sees a read-only `bd` shim first on PATH so it cannot
 * write any host graph by accident. For machine-local benches that need their
 * own fixture graph, verify.ts also exports `WHEELHOUSE_REAL_BD` as the absolute
 * path to the real bd binary the shim delegates to; benches must pair it with
 * their own scratch BEADS_DIR rather than calling bare `bd` through PATH.
 *
 * The verdict and the reviewer's full output land in
 * seats/verdicts/<bead-id>.md — a WORKING COPY for the commander, not an
 * evidence home. wheelhouse/GRAPH.md names the two homes evidence may live
 * in (the bead, or a committed path the bead names); this file is neither,
 * it is per-machine runtime state like state.json, and git ignores it. The
 * commander transcribes the decisive extract onto the bead before citing it.
 *
 * DISCOVER never files beads. The proposal is recorded in the verdict file
 * and printed; acting on it is the commander's decision.
 *
 * HETEROGENEOUS EVIDENCE: when the bead's done requires artifacts no shell
 * assertion stands in for — a screenshot, a bench log, a deployment probe's
 * captured output — the commander names them with --evidence as repo-relative
 * paths in the branch's PRODUCT repo. Each is read from the TIP SHA
 * (`git cat-file blob <tip>:<path>`), never from a checkout: GRAPH.md admits
 * committed paths as an evidence home, and a file that exists only in someone's
 * worktree is not one. Per artifact,
 * a FLOOR check runs before the spawn — exists at the SHA, non-empty, and
 * type-probed (.png: magic bytes + IHDR dimensions; anything else: non-empty)
 * — and the results go into the prompt and the verdict record. The floor is
 * not the judgment: the reviewer still opens each artifact and judges its
 * content against the claim. But an APPROVE while any floor check fails is
 * MALFORMED — exit 1, mirroring the NOT BENCHED parser rule — never exit 0.
 *
 * Why an argument rather than parsing `Evidence:` lines out of `bd show`:
 * the contract gate reads bead text, but artifact selection is explicit.
 * The commander reads the
 * bead and restates its requirement as arguments — the same relationship the
 * bead claim itself already has to the dispatch.
 *
 * Usage: bun seats/verify.ts <bead-id> <branch> <author-seat> [reviewer-seat] [--fallback-promotion <comment-id>]
 *          [--repo <path-to-branch-repo>] [--evidence <path>[,<path>...]]
 *          [--timeout-ms <ms>] [--first-output-timeout-ms <ms>]
 *          [--no-event-timeout-ms <ms>] [--batch-sweep <passing-full-sweep-log>]
 *
 * Timeout knobs are liveness watchdogs, not a wall-clock cap on the whole
 * reviewer turn. --first-output-timeout-ms bounds silence before the first
 * output. After output begins, each stream event resets the stall watchdog;
 * the effective quiet-period limit is the smaller of --timeout-ms (default
 * 900000 ms) and --no-event-timeout-ms (default 600000 ms), so the default
 * post-output stall limit is 600000 ms. To allow a longer quiet period, raise
 * --no-event-timeout-ms too; for quiet periods over 900000 ms, raise both.
 *
 * Single-repo installs need no configuration: --repo defaults to ROOT. Umbrella
 * installs with wheelhouse/.template-source product-repo= also need no
 * configuration: omitted --repo defaults to that product repository. Explicit
 * --repo still wins. Evidence paths stay relative to the selected repository.
 *
 * Exit: 0 APPROVE | 2 BOUNCE | 3 DISCOVER | 4 reviewer busy/retry |
 * 5 no-verdict (reviewer ended its turn without a judgment) | 6 refused: not a contract |
 * 1 other errors (including a malformed verdict — the machine must never mistake
 * an error for a judgment).
 * A no-verdict outcome is recorded, never treated as an approval or timeout.
 */

import * as crypto from "node:crypto";
import { checkBeadContract, contractRemedy, parseContract, repoDeclarations } from "./contract";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { completedExecFileSync as execFileSync, completedSpawnSync as spawnSync } from "./native-command";
import { resolveRoleBrief, scratchPromptLines } from "./briefs";
import { parseQuarantine, type QuarantineEntry } from "./quarantine";
import { hostBudgetEnabled, hostBudgetPath } from "./host-budget";
import { heavyTestEntry } from "./heavy-test-entry";
import { harnessNameForSeat, oneShotCommandForHarness, oneShotEnvForHarness, type HarnessName } from "./harness";
import { effectiveRoster } from "./roster";
import { hasPool } from "./pool";
import { finalAssistantText, liveLineCandidates, type FinalLineCandidate } from "./final-assistant-message";
import { installReviewSignals, reviewCancelling, reviewChildrenStopped, reviewScratchCleanups, trackReviewChild } from "./verify-cancellation";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const VERDICTS_DIR = path.join(SEATS_DIR, "verdicts");

// One-shot verification reads a diff and maybe runs a bench; give it room.
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 120000;
const DEFAULT_NO_EVENT_TIMEOUT_MS = 600000;

function hostBuildLockPath(): string {
  return process.env.WHEELHOUSE_BUILD_LOCK || path.join(os.homedir(), ".cache", "wheelhouse-build.lock");
}

function assertHostBuildLockAvailable(): void {
  if (!hostBudgetEnabled(ROOT) || process.env.WHEELHOUSE_BUILD_LOCK_HELD === "1") return;
  const lock = hostBuildLockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const probe = spawnSync("perl", ["-MFcntl=:flock,LOCK_EX,LOCK_NB", "-e", "open(my $fh, '>>', $ARGV[0]) or die $!; exit(flock($fh, LOCK_EX|LOCK_NB) ? 0 : 75)", lock], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error) die(`host build budget is enabled but verify cannot probe ${lock}: ${probe.error.message}`);
  if (probe.status === 75) die(`host build lock is held by another bead (${lock}); refusing to start reviewer until the build lock is free so --timeout-ms is not spent queued on the host build lock`);
  if (probe.status !== 0) die(`host build budget is enabled but verify cannot probe ${lock}: ${(probe.stderr || probe.stdout || "unknown error").trim()}`);
}

/**
 * A throwaway git worktree, used ONLY as the one-shot reviewer spawn's
 * process cwd — construction, not contract discipline. REVIEWER.md already
 * says "read-only on the work," but that is a rule the model can ignore;
 * the same hazard class adapter.ts's per-bead cwd (see seats/README.md,
 * "Running a seat") closes for a confused WORKER applies to a confused or
 * adversarial reviewer turn that runs a bare `write`/`edit` against a
 * relative path — with cwd: ROOT that lands in the live checkout, exactly
 * the checkout every other seat and the commander depend on.
 *
 * It has to be a real worktree of THIS repository, not an arbitrary empty
 * directory: the reviewer's own default reading mechanism (REVIEWER.md,
 * "Reading a branch without disturbing it") is bare `git diff`/`git show`
 * with no `-C` flag, so its cwd must already be a valid working directory
 * sharing this repository's object database and refs, or every git command
 * the reviewer runs fails before it reads a single line of the branch.
 * verify.ts's OWN git calls (branch resolution, checkEvidence) are
 * unaffected either way — they pass an explicit cwd for the branch's git
 * repository (`--repo` when an umbrella install needs one), which has nothing
 * to do with the spawned pi PROCESS's cwd.
 *
 * Detached at a commit object (`<tip>^{commit}` for verify, `HEAD^{commit}` for
 * verifier walks) so git never creates a branch named by the reviewed SHA.
 * The checked-out content isolates reviewer searches and dispatcher-run
 * suites at the pinned SHA; stray writes have somewhere harmless to land.
 * Cleanup is attempted on every exit path; failed identity checks or Git
 * refusal leave the path intact and report why. `process.on("exit", ...)`
 * still fires synchronous cleanup
 * when `die()` calls `process.exit()` mid-run. TERM/INT/HUP instead join the
 * groups we started before invoking these cleanups. The one path that skips
 * "exit" — a SIGKILL of the dispatcher — is handled by
 * sweepStaleScratchWorktrees() below, run once at the top of every
 * invocation, not by anything here.
 *
 * Named `wheelhouse-verify-<owning-pid>-<random>` or
 * `wheelhouse-review-<owning-pid>-<random>` so a later sweep can tell which
 * process made it. Ownership is recorded in this linked worktree's Git admin
 * directory; a matching name alone never authorizes later deletion.
 */
interface ScratchOwner {
  version: 1;
  dir: string;
  dev: number;
  ino: number;
  pid: number;
  kind: "verify" | "review";
}
const createdScratchCwds = new Map<string, ScratchOwner>();

function scratchWorktreeInfo(repoRoot: string, dir: string): { ownerFile: string; canonical: string; stat: fs.Stats } | null {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return null;
    const canonical = fs.realpathSync(dir);
    const tmp = fs.realpathSync(os.tmpdir());
    const rel = path.relative(tmp, canonical);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    const gitFile = path.join(canonical, ".git");
    if (!fs.lstatSync(gitFile).isFile()) return null; // never a primary checkout or symlink
    const gitdir = fs.readFileSync(gitFile, "utf8").trim().match(/^gitdir: (.+)$/)?.[1];
    if (!gitdir) return null;
    const admin = fs.realpathSync(path.resolve(canonical, gitdir));
    const commonRaw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const common = fs.realpathSync(path.resolve(repoRoot, commonRaw));
    if (path.dirname(admin) !== path.join(common, "worktrees")) return null;
    const backlink = fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim();
    if (fs.realpathSync(backlink) !== fs.realpathSync(gitFile)) return null;
    return { ownerFile: path.join(admin, "wheelhouse-scratch.json"), canonical, stat: fs.lstatSync(canonical) };
  } catch { return null; }
}

function scratchOwner(repoRoot: string, dir: string): ScratchOwner | null {
  const info = scratchWorktreeInfo(repoRoot, dir);
  if (!info) return null;
  try {
    const owner: ScratchOwner = createdScratchCwds.get(info.canonical) ?? JSON.parse(fs.readFileSync(info.ownerFile, "utf8"));
    const name = path.basename(info.canonical).match(/^wheelhouse-(verify|review)-(\d+)-/);
    if (owner.version !== 1 || owner.dir !== info.canonical || owner.dev !== info.stat.dev || owner.ino !== info.stat.ino
        || !name || owner.kind !== name[1] || owner.pid !== Number(name[2]) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
    return owner;
  } catch { return null; }
}

interface CoreWorktreeConfig { present: boolean; value: string }

function readCoreWorktreeConfig(repoRoot: string): CoreWorktreeConfig {
  const r = spawnSync("git", ["-C", repoRoot, "config", "--local", "--get", "core.worktree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? { present: true, value: (r.stdout ?? "").trimEnd() } : { present: false, value: "" };
}

function restoreCoreWorktreeConfig(repoRoot: string, before: CoreWorktreeConfig): void {
  const after = readCoreWorktreeConfig(repoRoot);
  if (after.present === before.present && after.value === before.value) return;
  try {
    if (before.present) execFileSync("git", ["-C", repoRoot, "config", "--local", "core.worktree", before.value], { stdio: "ignore" });
    else execFileSync("git", ["-C", repoRoot, "config", "--local", "--unset", "core.worktree"], { stdio: "ignore" });
  } catch {}
}

export function makeScratchCwd(repoRoot: string, kind: "verify" | "review" = "verify", tip = "HEAD"): string {
  if (import.meta.main) installReviewSignals();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wheelhouse-${kind}-${process.pid}-`)));
  const stat = fs.lstatSync(dir);
  const owner: ScratchOwner = { version: 1, dir, dev: stat.dev, ino: stat.ino, pid: process.pid, kind };
  createdScratchCwds.set(dir, owner);
  const coreWorktreeBefore = readCoreWorktreeConfig(repoRoot);
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", dir, `${tip}^{commit}`], { stdio: "pipe" });
    const info = scratchWorktreeInfo(repoRoot, dir);
    if (!info) throw new Error("scratch worktree identity could not be verified");
    fs.writeFileSync(info.ownerFile, JSON.stringify(owner) + "\n", { flag: "wx", mode: 0o600 });
  } catch (e: any) {
    restoreCoreWorktreeConfig(repoRoot, coreWorktreeBefore);
    if (fs.existsSync(path.join(dir, ".git"))) removeScratchWorktree(repoRoot, dir);
    else {
      // Only the empty directory allocated above; never recursively remove a
      // partially populated path after Git refused creation.
      try { if (fs.lstatSync(dir).ino === owner.ino && fs.lstatSync(dir).dev === owner.dev) fs.rmdirSync(dir); } catch {}
    }
    createdScratchCwds.delete(dir);
    die(`could not create a detached scratch worktree for the ${kind} one-shot in ${repoRoot}: ${(e.stderr ?? e.message).toString().trim()}`);
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || (reviewCancelling && !reviewChildrenStopped)) return;
    cleaned = true;
    // A verifier may have clobbered core.worktree: restore the main checkout's
    // identity before asking Git which registered worktree is primary.
    restoreCoreWorktreeConfig(repoRoot, coreWorktreeBefore);
    reviewScratchCleanups.delete(cleanup);
    removeScratchWorktree(repoRoot, dir);
    sweepShaNamedBranches(repoRoot);
  };
  reviewScratchCleanups.add(cleanup);
  process.on("exit", cleanup);
  // Importers such as walk.ts keep their existing scratch-only behavior;
  // this coordinator owns only the dispatcher entry point's child groups.
  if (!import.meta.main) for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { cleanup(); process.exit(sig === "SIGINT" ? 130 : 143); });
  return dir;
}

function makeWritableRecursive(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    try { fs.chmodSync(p, st.mode | 0o200); } catch {}
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) makeWritableRecursive(path.join(p, name));
  } catch {}
}

function removeScratchWorktree(repoRoot: string, dir: string): boolean {
  if (!fs.existsSync(dir)) { createdScratchCwds.delete(dir); return true; }
  const owner = scratchOwner(repoRoot, dir);
  if (!owner) {
    process.stderr.write(`scratch cleanup: skipped unowned or ineligible path ${dir}; left in place\n`);
    return false;
  }
  try {
    const primary = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n").find(l => l.startsWith("worktree "))?.slice(9);
    if (!primary || fs.realpathSync(primary) === owner.dir) {
      process.stderr.write(`scratch cleanup: skipped main checkout ${dir}; left in place\n`);
      return false;
    }
    if (!scratchOwner(repoRoot, dir)) {
      process.stderr.write(`scratch cleanup: ownership changed for ${dir}; left in place\n`);
      return false;
    }
    makeWritableRecursive(dir);
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], { stdio: "pipe" });
    createdScratchCwds.delete(owner.dir);
    return true;
  } catch (e: any) {
    process.stderr.write(`scratch cleanup: Git refused removal of ${dir}; left in place: ${(e.stderr ?? e.message).toString().trim()}\n`);
    return false;
  }
}

function checkedOutBranches(repoRoot: string): Set<string> {
  const out = new Set<string>();
  try {
    const listing = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of listing.split("\n")) {
      const m = line.match(/^branch refs\/heads\/(.+)$/);
      if (m) out.add(m[1]);
    }
  } catch {}
  return out;
}

function sweepShaNamedBranches(repoRoot: string): void {
  let refs = "";
  try {
    refs = execFileSync("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" });
  } catch {
    return;
  }
  const checkedOut = checkedOutBranches(repoRoot);
  for (const name of refs.split("\n").filter(Boolean)) {
    if (!/^[0-9a-fA-F]{40}$/.test(name)) continue;
    if (checkedOut.has(name)) continue;
    try {
      execFileSync("git", ["-C", repoRoot, "branch", "-D", name], { stdio: "ignore" });
      process.stderr.write(`swept: deleted stale SHA-named branch ${name}\n`);
    } catch {}
  }
}

function barePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists, not ours to signal — still alive
  }
}

function pidAlive(pid: number): boolean {
  return barePidAlive(pid);
}

/**
 * Reclaims scratch worktrees a SIGKILLed dispatcher left behind —
 * makeScratchCwd()'s process.on("exit") cleanup cannot fire on SIGKILL,
 * so a killed run orphans both the tmp directory and its `git worktree`
 * registration. Run once at the top of every invocation, before anything
 * else, so a diagnosis-only run that STOPs early still sweeps up after
 * whichever prior run left a mess.
 *
 * Asks git itself which worktrees are registered against the branch's repo
 * rather than globbing the tmp directory: `os.tmpdir()` is shared machine-wide,
 * and a DIFFERENT project's verify.ts (or a whole other wheelhouse fleet on the
 * same box) can leave same-prefixed scratch dirs there — `git worktree list`
 * only ever names worktrees that belong to THIS repository, so nothing gets
 * touched that the branch repository does not already confirm is its own.
 * Filters those to the `wheelhouse-verify-<pid>-*` and
 * `wheelhouse-review-<pid>-*` naming makeScratchCwd() uses, and reclaims only
 * the ones whose stamped pid is no longer alive, whose realpath is beneath
 * the current temp root, and whose linked-worktree admin record proves the
 * directory identity was allocated by makeScratchCwd(). Legacy unrecorded
 * paths are deliberately left for inspection rather than adopted by name.
 *
 * No fd-based cross-check the way recover.ts's fixture sweep needs one:
 * that sweep KILLS live processes, so a reused pid is a real hazard it
 * has to rule out before pulling the trigger. This sweep never touches a
 * process, only a directory and a worktree registration — a dead pid
 * means the verify.ts invocation that owned this scratch worktree has
 * already exited, full stop, whether or not the OS later handed that pid
 * to something unrelated. The asymmetry runs the safe way: a wrong
 * reading here means "swept one run late," never "swept a worktree still
 * in use" — an alive pid is always treated as still owning its worktree,
 * reused or not.
 */
export function sweepStaleScratchWorktrees(repoRoot: string): void {
  let listing: string;
  try {
    listing = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch {
    return; // nothing to sweep if the branch repository itself will not answer
  }
  const worktreePaths = listing
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  for (const [index, p] of worktreePaths.entries()) {
    const m = path.basename(p).match(/^wheelhouse-(?:verify|review)-(\d+)-/);
    if (!m) continue;
    let primary = index === 0;
    try { primary ||= fs.lstatSync(path.join(p, ".git")).isDirectory(); } catch {}
    if (primary) {
      process.stderr.write(`sweep: skipped main checkout ${p}; left in place\n`);
      continue;
    }
    let underTmp = false;
    try {
      const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(p));
      underTmp = !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    } catch {}
    if (!underTmp) {
      process.stderr.write(`sweep: skipped path outside current temp directory ${p}; left in place\n`);
      continue;
    }
    const owner = scratchOwner(repoRoot, p);
    if (!owner) {
      process.stderr.write(`sweep: skipped unrecorded or changed scratch worktree ${p}; left in place\n`);
      continue;
    }
    if (pidAlive(owner.pid)) continue;
    if (removeScratchWorktree(repoRoot, p)) process.stderr.write(`swept: removed orphaned scratch worktree ${p} (owner pid ${owner.pid} is gone)\n`);
  }
  sweepShaNamedBranches(repoRoot);
}

let gateBeadId: string | null = null;
let gateSourceLog = "seats/verify.ts";
let gateInboxWrote = false;

// Legacy gate identifiers stay stable for walk.ts and installed inbox consumers.
export function setVerifierGateBead(beadId: string, sourceLog = "seats/verify.ts"): void {
  gateBeadId = beadId;
  gateSourceLog = sourceLog;
}

function gateInboxId(beadId: string, eventClass: "settle" | "distress", detail: string): string {
  return crypto.createHash("sha256")
    .update(`verifier-gate\0${process.pid}\0${Date.now()}\0${beadId}\0${eventClass}\0${detail}\0${crypto.randomBytes(16).toString("hex")}`)
    .digest("hex");
}

export function appendVerifierGateInbox(beadId: string, eventClass: "settle" | "distress", title: string, detail: string, sourceType = "verifier-gate", sourceLog = "seats/verify.ts", detailLimit = 1200): void {
  fs.mkdirSync(SEATS_DIR, { recursive: true });
  const row = {
    id: gateInboxId(beadId, eventClass, detail),
    at: new Date().toISOString(),
    seat: "verifier-gate",
    class: eventClass,
    state: eventClass === "distress" ? "failed" : "terminal",
    title,
    detail: detail.replace(/\s+$/g, "").slice(0, detailLimit),
    source: { log: sourceLog, offset: 0, type: sourceType },
  };
  fs.appendFileSync(path.join(SEATS_DIR, "inbox.jsonl"), JSON.stringify(row) + "\n");
}

export function die(msg: string, code = 1): never {
  if (gateBeadId && !gateInboxWrote) {
    gateInboxWrote = true;
    try { appendVerifierGateInbox(gateBeadId, "distress", `verifier gate STOP — ${gateBeadId}`, `STOP: ${msg}`, "verifier-gate", gateSourceLog); } catch {}
  }
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(code);
}

function liveVerdictCandidates(stdout: string, harness: HarnessName): FinalLineCandidate[] {
  return liveLineCandidates(stdout, harness, "VERDICT");
}

function livePushCandidates(stdout: string, harness: HarnessName): FinalLineCandidate[] {
  return liveLineCandidates(stdout, harness, "PUSH");
}

function sawFinalReviewerResult(stdout: string, harness: HarnessName): boolean {
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(raw);
      if (harness === "claude-code") {
        if (event?.type === "result") return true;
      } else if (harness === "codex") {
        if (event?.type === "turn.completed") return true;
      } else {
        if (event?.type === "agent_end" && event?.willRetry !== true) return true;
      }
    } catch {}
  }
  return false;
}

class RefusedReviewerOutput extends Error {
  constructor(reason: string, readonly file: string, readonly retryAllowed = true) { super(reason); }
}

function writeRefusedReviewerOutput(beadId: string, detail: Record<string, unknown>): string {
  // Diagnostics are NOT verdict Markdown: neither canonical <bead>.md readers
  // nor recursive *.md inventories may count a refused APPROVE as a verdict.
  const dir = path.join(VERDICTS_DIR, "refused");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${beadId}.${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...detail, status: "REFUSED", notAVerdict: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return file;
}

function currentBranchTip(repoRoot: string, branch: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function benchGapNotices(notBenched: string | undefined): string[] {
  if (!notBenched) return [];
  const notices: string[] = [];
  const expiry = notBenched.match(/\b(?:expires|expiry|until)\s*[:=]\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1];
  const target = notBenched.match(/\b(?:coverage[- ]?target|target|coverage)\s*[:=]\s*([^;]+)/i)?.[1]?.trim();
  if (expiry) {
    const today = new Date().toISOString().slice(0, 10);
    if (expiry < today) notices.push(`BENCH GAP EXPIRED: NOT BENCHED gap expired ${expiry}; BENCH.md says this is a funding/scope nudge at the gate, not a silent pass.`);
    else notices.push(`BENCH GAP: NOT BENCHED gap declared until ${expiry}.`);
  }
  if (target) notices.push(`BENCH GAP TARGET: ${target}`);
  if (!expiry && !target) notices.push("BENCH GAP STANDING: NOT BENCHED has no expires=YYYY-MM-DD or target=... marker; treat this as the standing answer and fund/define the bench rather than letting it pass silently.");
  return notices;
}

function appendedCommitCount(repoRoot: string, fromTip: string, toTip: string): number | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", fromTip, toTip], { cwd: repoRoot, stdio: "ignore" });
    const out = execFileSync("git", ["rev-list", "--count", `${fromTip}..${toTip}`], { cwd: repoRoot, encoding: "utf8" }).trim();
    return Number(out);
  } catch {
    return null;
  }
}

function lastReviewerPhase(stdout: string): string {
  let phase = "spawned reviewer; waiting for output";
  for (const line of stdout.split(/\r?\n/)) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === "tool_execution_start") phase = `tool ${obj.toolName ?? "unknown"} started${obj.args ? ` ${JSON.stringify(obj.args).slice(0, 300)}` : ""}`;
    else if (obj?.type) phase = String(obj.type);
  }
  return phase;
}

function reviewerEventLogTail(stdout: string, stderr: string): string {
  const events: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type) events.push(line);
    } catch { /* stdout may also contain final prose */ }
  }
  const tail = events.slice(-40).join("\n");
  if (tail) return tail;
  const stderrTail = stderr.trim().slice(-4000);
  return stderrTail ? `no JSON event lines on stdout; stderr tail:\n${stderrTail}` : "no JSON event lines reached stdout or stderr before timeout";
}

function writePartialReviewerOutput(beadId: string, stdout: string, stderr: string, phase: string, elapsedMs: number, timeoutMs: number): string {
  fs.mkdirSync(VERDICTS_DIR, { recursive: true });
  const partialFile = path.join(VERDICTS_DIR, `${beadId}.partial.md`);
  fs.writeFileSync(partialFile, [
    `# Partial reviewer output — ${beadId}`,
    ``,
    `- elapsed_ms: ${elapsedMs}`,
    `- timeout_ms: ${timeoutMs}`,
    `- last_phase: ${phase}`,
    ``,
    `## seat tool-call/event log tail`,
    "```jsonl",
    reviewerEventLogTail(stdout, stderr),
    "```",
    ``,
    `## stdout`,
    "```",
    stdout,
    "```",
    ``,
    `## stderr`,
    "```",
    stderr,
    "```",
    ``,
  ].join("\n"));
  return partialFile;
}

interface OneShotRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error & { code?: string };
  outcome?: "no-verdict";
}

function runOneShot(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; firstOutputTimeoutMs: number; noEventTimeoutMs: number; maxBuffer: number; harness: HarnessName; marker?: { seat: string; bead: string } }
): Promise<OneShotRunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const markerFile = opts.marker ? path.join(ROOT, "seats", "run", `verify.${opts.marker.seat}.json`) : null;
    if (markerFile) {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, JSON.stringify({ pid: child.pid, bead: opts.marker!.bead, startedAt: new Date().toISOString() }, null, 2) + "\n");
    }
    const owned = trackReviewChild(child, { marker: markerFile ?? undefined });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let done = false;
    let sawOutput = false;
    let sawFinalVerdictMessage = false;
    let finalKillTimer: ReturnType<typeof setTimeout> | null = null;
    let noEventTimer: ReturnType<typeof setTimeout> | null = null;
    const out = () => Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
    const err = () => Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
    const cancelTimers = () => {
      clearTimeout(firstOutputTimer);
      if (noEventTimer) clearTimeout(noEventTimer);
      if (finalKillTimer) clearTimeout(finalKillTimer);
    };
    const finish = (result: Partial<OneShotRunResult>) => {
      if (done || reviewCancelling) return;
      done = true;
      cancelTimers();
      if (markerFile) { try { fs.unlinkSync(markerFile); } catch {} }
      resolve({ stdout: out(), stderr: err(), status: result.status ?? null, signal: result.signal ?? null, error: result.error, outcome: result.outcome });
    };
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (!child.pid || reviewCancelling) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
    };
    const killFor = (code: string, message: string) => {
      const error: Error & { code?: string } = new Error(message);
      error.code = code;
      killProcessGroup("SIGTERM");
      setTimeout(() => killProcessGroup("SIGKILL"), 1000).unref?.();
      finish({ error });
    };
    const reapAfterFinalVerdict = () => {
      if (sawFinalVerdictMessage || done) return;
      const stdout = out();
      if (!sawFinalReviewerResult(stdout, opts.harness)) return;
      if (liveVerdictCandidates(stdout, opts.harness).length === 0) { // no-verdict-terminal
        killProcessGroup("SIGTERM");
        setTimeout(() => killProcessGroup("SIGKILL"), 1000).unref?.();
        finish({ status: 0, outcome: "no-verdict" });
        return;
      }
      if (livePushCandidates(stdout, opts.harness).length === 0) return;
      sawFinalVerdictMessage = true;
      finalKillTimer = setTimeout(() => {
        killProcessGroup("SIGTERM");
        setTimeout(() => killProcessGroup("SIGKILL"), 1000).unref?.();
      }, 100);
      finalKillTimer.unref?.();
    };
    const firstOutputTimer = setTimeout(() => {
      if (!sawOutput) killFor("WHEELHOUSE_FIRST_OUTPUT_TIMEOUT", `no reviewer output within ${opts.firstOutputTimeoutMs}ms`);
    }, opts.firstOutputTimeoutMs);
    owned.onCancel = cancelTimers;
    const resetNoEventTimer = () => {
      if (noEventTimer) clearTimeout(noEventTimer);
      const stallMs = Math.min(opts.noEventTimeoutMs, opts.timeoutMs);
      const code = opts.timeoutMs <= opts.noEventTimeoutMs ? "ETIMEDOUT" : "WHEELHOUSE_NO_EVENT_TIMEOUT";
      const message = code === "ETIMEDOUT" ? `timed out after ${opts.timeoutMs}ms with no reviewer stream event` : `model stalled after ${opts.noEventTimeoutMs}ms with no reviewer stream event`;
      noEventTimer = setTimeout(() => killFor(code, message), stallMs);
    };
    const collect = (chunks: Buffer[], current: () => number, setBytes: (n: number) => void, chunk: Buffer) => {
      if (done || reviewCancelling) return;
      sawOutput = true;
      clearTimeout(firstOutputTimer);
      resetNoEventTimer();
      const next = current() + chunk.length;
      if (next > opts.maxBuffer) {
        killFor("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", `reviewer output exceeded ${opts.maxBuffer} bytes`);
        return;
      }
      chunks.push(chunk);
      setBytes(next);
      reapAfterFinalVerdict();
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, () => stdoutBytes, (n) => { stdoutBytes = n; }, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, () => stderrBytes, (n) => { stderrBytes = n; }, chunk));
    child.on("error", (error: Error & { code?: string }) => finish({ error }));
    child.on("close", (status, signal) => finish(sawFinalVerdictMessage && (signal || status === 143) ? { status: 0, signal: null } : { status, signal }));
  });
}

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Same mechanism as adapter.ts's beadsActorFor, and for the same reason: the
 * ephemeral reviewer's own pi process must carry BEADS_ACTOR=<reviewer seat>
 * so its bd comment lands authored as the reviewer, regardless of whether
 * the operator or commander shell that invoked this dispatcher happened to
 * export it. WHEELHOUSE_BEADS_ACTOR_<SEAT> (seat name upper-cased, non
 * [A-Z0-9] turned into "_") overrides it; unset, the seat name is used as-is.
 */
function beadsActorEnvVar(name: string): string {
  return `WHEELHOUSE_BEADS_ACTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function beadsActorFor(name: string): string {
  const override = process.env[beadsActorEnvVar(name)];
  return override && override.length > 0 ? override : name;
}

/**
 * Bead ids and seat names are used as single path segments here — the
 * verdict file is verdicts/<bead-id>.md, and seat names index the roster
 * whose account dirs get spawned on. Anything that is not one plain
 * segment is refused loudly, naming the offending value.
 */
export function validateSegment(kind: string, value: string): string {
  const bad =
    value.length === 0 ? "empty" :
    value === "." || value === ".." ? "a dot segment" :
    /[/\\]/.test(value) ? "a path separator" :
    /\s/.test(value) ? "whitespace" :
    /['"`]/.test(value) ? "a quote character" :
    null;
  if (bad !== null) {
    die(`invalid ${kind} ${JSON.stringify(value)} (${bad}) — must be a single path segment: no /, no .., no whitespace, no quotes`);
  }
  return value;
}

/**
 * Evidence paths are repo-relative and become `git cat-file blob <tip>:<path>`
 * arguments. Absolute paths, dot segments, whitespace, and quotes are refused
 * loudly — an evidence path escaping the repository is not evidence on the
 * branch under review.
 */
function defaultRepoArgFromTemplateSource(): string | undefined {
  const source = path.join(ROOT, "wheelhouse", ".template-source");
  let text = "";
  try { text = fs.readFileSync(source, "utf8"); } catch { return undefined; }
  for (const line of text.split("\n")) {
    const m = line.match(/^(?:product-repo|product-repos|product_repo|product_repos)=(.*)$/);
    if (!m) continue;
    const first = m[1].split(/[,;]/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }
  return undefined;
}

function repoDeclarationFromClaim(claim: string): string | null {
  return repoDeclarations(claim)?.[0] ?? null;
}

function repoArgFromClaim(claim: string): string | undefined {
  const declared = repoDeclarationFromClaim(claim);
  if (!declared) return undefined;
  if (/^UMBRELLA$/i.test(declared)) return ".";
  return declared;
}

export function resolveRepoRoot(repoArg: string | undefined, claim?: string): string {
  const effectiveRepoArg = repoArg ?? (claim ? repoArgFromClaim(claim) : undefined) ?? defaultRepoArgFromTemplateSource();
  if (!effectiveRepoArg) return ROOT;
  const expanded = expandTilde(effectiveRepoArg);
  const abs = path.resolve(ROOT, expanded);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    die(`--repo ${JSON.stringify(effectiveRepoArg)} does not exist (resolved from ${ROOT})`);
  }
  let inside = "";
  try {
    inside = execFileSync("git", ["-C", real, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim();
  } catch {
    die(`--repo ${JSON.stringify(effectiveRepoArg)} is not a git worktree (resolved to ${real})`);
  }
  if (inside !== "true") die(`--repo ${JSON.stringify(effectiveRepoArg)} is not inside a git worktree (resolved to ${real})`);
  try {
    return execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    die(`could not resolve git top-level for --repo ${JSON.stringify(effectiveRepoArg)} (resolved to ${real})`);
  }
}

function validateEvidencePath(p: string): string {
  const bad =
    p.length === 0 ? "empty" :
    p.startsWith("/") ? "absolute" :
    /\\/.test(p) ? "a backslash" :
    p.split("/").some((s) => s === "." || s === ".." || s === "") ? "a dot or empty segment" :
    /\s/.test(p) ? "whitespace" :
    /['"`]/.test(p) ? "a quote character" :
    null;
  if (bad !== null) {
    die(`invalid evidence path ${JSON.stringify(p)} (${bad}) — must be repo-relative: no leading /, no .., no whitespace, no quotes`);
  }
  return p;
}

interface EvidenceCheck {
  path: string;
  exists: boolean;
  bytes: number;
  probe: string;   // what the type probe concluded, human-readable
  ok: boolean;     // the floor: exists, non-empty, right type
  source: string;  // committed blob, excluded disk + manifest, or why neither satisfied it
}

/**
 * The type probe: .png gets a real check — PNG magic bytes, then width and
 * height out of the IHDR — because a screenshot is the artifact most worth
 * faking accidentally (a zero-byte capture, a text file renamed .png). Every
 * other extension gets the non-empty floor; deepening a probe for a new
 * artifact kind belongs here, next to this comment.
 */
function probeArtifact(p: string, buf: Buffer): { ok: boolean; probe: string } {
  if (buf.length === 0) return { ok: false, probe: "EMPTY (0 bytes)" };
  if (/\.png$/i.test(p)) {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 24 || !buf.subarray(0, 8).equals(magic)) {
      return { ok: false, probe: "NOT a PNG (magic bytes wrong)" };
    }
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w === 0 || h === 0) return { ok: false, probe: `degenerate PNG (${w}x${h})` };
    return { ok: true, probe: `PNG ${w}x${h}` };
  }
  return { ok: true, probe: "non-empty" };
}

/** Read each named artifact from the tip SHA and run its floor check. A path
 * that is not a blob at that SHA can only be satisfied from disk when Git says
 * the path is intentionally excluded and a colocated SHA-256 manifest verifies. */
function checkEvidence(repoRoot: string, tip: string, paths: string[]): EvidenceCheck[] {
  return paths.map((p) => {
    let buf: Buffer;
    try {
      buf = execFileSync("git", ["cat-file", "blob", `${tip}:${p}`], {
        cwd: repoRoot,
        maxBuffer: 256 * 1024 * 1024,
      });
      const { ok, probe } = probeArtifact(p, buf);
      return { path: p, exists: true, bytes: buf.length, probe, ok, source: "committed blob at tip" };
    } catch {
      return checkExcludedDiskEvidence(repoRoot, p);
    }
  });
}

function checkExcludedDiskEvidence(repoRoot: string, p: string): EvidenceCheck {
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", p], { cwd: repoRoot, stdio: "ignore" });
  if (ignored.status === 1) return { path: p, exists: false, bytes: 0, probe: "MISSING at the tip SHA; not a git-excluded evidence path", ok: false, source: "none" };
  if (ignored.status !== 0) return { path: p, exists: false, bytes: 0, probe: `git check-ignore failed with exit ${ignored.status ?? "signal"}`, ok: false, source: "instrument failure" };

  const abs = path.join(repoRoot, p);
  if (!fs.existsSync(abs)) return { path: p, exists: false, bytes: 0, probe: "git-excluded evidence path is absent on disk", ok: false, source: "excluded disk + SHA-256 manifest" };
  if (!fs.statSync(abs).isDirectory()) return { path: p, exists: true, bytes: fs.statSync(abs).size, probe: "git-excluded evidence path is not a directory with a SHA-256 manifest", ok: false, source: "excluded disk + SHA-256 manifest" };

  const manifest = "cited-evidence.sha256";
  if (!fs.existsSync(path.join(abs, manifest))) return { path: p, exists: true, bytes: dirBytes(abs), probe: "git-excluded evidence directory has no cited-evidence.sha256 manifest", ok: false, source: "excluded disk + SHA-256 manifest" };
  const manifestPath = path.join(abs, manifest);
  const entries = parseSha256Manifest(fs.readFileSync(manifestPath, "utf8"));
  if (entries.length === 0) return { path: p, exists: true, bytes: dirBytes(abs), probe: `${path.join(p, manifest)} has no artifact entries`, ok: false, source: "excluded disk + SHA-256 manifest" };
  for (const entry of entries) {
    const target = path.resolve(abs, entry);
    if (!(target === abs || target.startsWith(abs + path.sep))) {
      return { path: p, exists: true, bytes: dirBytes(abs), probe: `${path.join(p, manifest)} entry escapes evidence directory: ${entry}`, ok: false, source: "excluded disk + SHA-256 manifest" };
    }
  }
  const verified = spawnSync("shasum", ["-a", "256", "-c", manifest], { cwd: abs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (verified.status !== 0) {
    const detail = (verified.stdout + verified.stderr).trim().split(/\r?\n/).filter(Boolean).slice(-3).join("; ") || `exit ${verified.status ?? "signal"}`;
    return { path: p, exists: true, bytes: dirBytes(abs), probe: `${path.join(p, manifest)} failed shasum -a 256 -c (${detail})`, ok: false, source: "excluded disk + SHA-256 manifest" };
  }
  for (const entry of entries) {
    const target = path.join(abs, entry);
    const b = fs.readFileSync(target);
    const probed = probeArtifact(entry, b);
    if (!probed.ok) return { path: p, exists: true, bytes: dirBytes(abs), probe: `${entry}: ${probed.probe}`, ok: false, source: "excluded disk + SHA-256 manifest" };
  }
  return { path: p, exists: true, bytes: dirBytes(abs), probe: `${path.join(p, manifest)} verified ${entries.length} artifact(s) with shasum -a 256 -c`, ok: true, source: "excluded disk + SHA-256 manifest" };
}

function parseSha256Manifest(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^[a-fA-F0-9]{64}\s+[ *]?(.+)$/);
    if (!m) return [];
    out.push(m[1]);
  }
  return out;
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isFile()) total += st.size;
  }
  return total;
}

function evidenceLines(checks: EvidenceCheck[]): string[] {
  return checks.map(
    (c) =>
      `- ${c.path} — ${c.exists ? `exists, ${c.bytes} bytes, ${c.probe}` : c.probe} — ${c.ok ? `OK (SATISFIED via ${c.source})` : `UNSATISFIED (source: ${c.source})`}`
  );
}

/** Canonical form for comparing two account dirs: tilde-expanded, resolved,
 * and realpath'd when the directory exists — /tmp vs /private/tmp must not
 * read as two different accounts. */
function canonicalDir(p: string): string {
  const abs = path.resolve(expandTilde(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

interface SeatEntry {
  role: string;
  harness?: string;
  provider?: string;
  model?: string;
  external?: boolean;
  shadow?: boolean;
  account?: { dir: string; label?: string; authRoute?: string };
  allowedTools?: string;
  disallowedTools?: string;
}

function readRoster(): Record<string, SeatEntry> {
  if (hasPool(ROOT)) return effectiveRoster(ROOT) as Record<string, SeatEntry>;
  if (!fs.existsSync(ROSTER_FILE)) {
    die(`no ${ROSTER_FILE} — copy seats/seats.json.example to seats/seats.json and edit it`);
  }
  const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
  return raw.seats ?? {};
}

function accountLabel(entry: SeatEntry | undefined): string | undefined {
  const label = entry?.account?.label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

function accountLabelSuffix(entry: SeatEntry | undefined): string {
  const label = accountLabel(entry);
  return label ? ` (account label: ${label})` : "";
}

/** An account dir for a seat name: the roster is authoritative; state.json
 * is the fallback for a seat that once ran here but left the roster. A seat
 * found in neither is a STOP — distinctness cannot be established against
 * an account nobody can name. */
function accountDirFor(name: string, reject: (message: string) => never = die): string {
  const entry = readRoster()[name];
  if (entry) {
    if (entry.external) {
      reject(`seat "${name}" is external — it has no Pi account dir, so account-distinctness cannot be established against it`);
    }
    if (!entry.account?.dir) reject(`seat "${name}" has no account.dir in seats/seats.json`);
    return entry.account.dir;
  }
  if (fs.existsSync(STATE_FILE)) {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const rec = st.seats?.[name];
    if (rec?.accountDir) return rec.accountDir;
  }
  reject(`no seat named "${name}" in seats/seats.json or seats/state.json — cannot establish whose account authored this`);
}

/** Shared author-account gate; default reviewer behavior and canary anchor stay intact. */
export function requireDistinctAccount(authorSeat: string, reviewerSeat: string, accountDir: string,
  reject: (message: string) => never = die, role = "reviewer"): string {
  return requireDifferentAccountDirs(authorSeat, accountDirFor(authorSeat, reject), reviewerSeat, accountDir, reject, role);
}

/** Compare a recorded account, not a possibly changed live roster entry. */
export function requireDifferentAccountDirs(authorSeat: string, authorAccountDir: string, reviewerSeat: string, accountDir: string,
  reject: (message: string) => never = die, role = "reviewer", authorRole = "author"): string {
  const authorDir = canonicalDir(authorAccountDir);
  const reviewerDir = canonicalDir(accountDir);
  if (authorDir === reviewerDir) { // distinctness-gate
    reject(
      `${role} seat "${reviewerSeat}" and ${authorRole} seat "${authorSeat}" resolve to the SAME account directory:\n` +
        `        ${reviewerDir}\n` +
        `      Same directory means same auth.json means same account, and a verdict\n` +
        `      from the author's own account is not a verdict. Nothing was spawned.`
    );
  }
  return reviewerDir;
}

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
};
function providerEnvVar(provider: string): string | undefined { return PROVIDER_ENV_VARS[provider]; }

function findOnPath(bin: string, searchPath = process.env.PATH ?? ""): string | null {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

export function readonlyBdPath(root: string, basePath: string, scratchCwd: string): string {
  const realBd = findOnPath("bd", basePath);
  if (!realBd) return basePath;
  const shimDir = path.join(scratchCwd, ".wheelhouse-readonly-bin");
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, "bd");
  fs.writeFileSync(shim, `#!/usr/bin/env bash
exec ${JSON.stringify(realBd)} --readonly "$@"
`);
  fs.chmodSync(shim, 0o755);
  return `${shimDir}${path.delimiter}${basePath}`;
}

// Same rule as adapter.ts: pi auto-creates an empty {} auth.json on a first
// headless run, and a seat with only that has never been logged in.
function authIsIdentity(authFile: string): boolean {
  if (!fs.existsSync(authFile)) return false;
  const body = fs.readFileSync(authFile, "utf8").replace(/[{}\s]/g, "");
  return body.length > 0;
}
function claudeOauthIsIdentity(configDir: string): boolean {
  const config = path.join(configDir, ".claude.json");
  if (!fs.existsSync(config)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(config, "utf8"));
    const acct = j?.oauthAccount;
    if (!acct || typeof acct !== "object") return false;
    return Object.values(acct).some((v) => typeof v === "string" ? v.trim().length > 0 : v != null);
  } catch {
    return false;
  }
}
export interface ReviewRecord {
  bead: string; branch: string; tip: string; verdict: "APPROVE" | "BOUNCE" | "DISCOVER";
  push: string; reviewerSeat: string; reviewerDir: string; at: string;
}

/** Only the completed dispatcher header is a verdict. Output/sweep prose is not. */
export function readReviewRecord(root: string, beadId: string): ReviewRecord | null {
  if (!beadId || beadId === "." || beadId === ".." || /[\\/\s'"`]/.test(beadId)) return null;
  const file = path.join(root, "seats", "verdicts", `${beadId}.md`);
  let text: string;
  try { if (!fs.lstatSync(file).isFile()) return null; text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== `# Verdict — bead ${beadId}`) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = /^- ([a-z-]+): (.*)$/.exec(line);
    if (!m) break;
    const key = m[1] === "verifier-seat" ? "reviewer-seat" : m[1];
    if (fields.has(key)) return null;
    fields.set(key, m[2]);
  }
  const tip = fields.get("tip"), shown = fields.get("verdict"), seatLine = fields.get("reviewer-seat");
  const verdict = shown?.split(/\s+/)[0];
  const seat = seatLine && /^(\S+) \((.+)\)$/.exec(seatLine);
  if (!tip || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip) || !["APPROVE", "BOUNCE", "DISCOVER"].includes(verdict ?? "") || !seat) return null;
  if (fields.get("bead") !== beadId || !fields.get("branch") || !fields.get("push") || !fields.get("at") || !Number.isFinite(Date.parse(fields.get("at")!))) return null;
  return { bead: beadId, branch: fields.get("branch")!, tip, verdict: verdict as ReviewRecord["verdict"], push: fields.get("push")!,
    reviewerSeat: seat[1], reviewerDir: seat[2], at: fields.get("at")! };
}

function authRouteIdentity(name: string, entry: SeatEntry, authFile: string, harness: HarnessName, accountDir: string): boolean {
  const route = entry.account?.authRoute;
  if (route === "env") {
    if (!entry.provider) die(`reviewer seat "${name}" uses account.authRoute=env but has no provider in seats/seats.json`);
    const envVar = providerEnvVar(entry.provider);
    if (!envVar) die(`reviewer seat "${name}" uses account.authRoute=env for provider ${JSON.stringify(entry.provider)}, but this reviewer does not know that provider's env var`);
    return !!process.env[envVar];
  }
  if (harness === "claude-code") return claudeOauthIsIdentity(accountDir);
  return authIsIdentity(authFile);
}

function verifyMarkerLive(seat: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, "seats", "run", `verify.${seat}.json`), "utf8"));
    return !!m?.pid && (() => { try { process.kill(Number(m.pid), 0); return true; } catch { return false; } })();
  } catch { return false; }
}

function requireReviewerSeat(explicit: string | undefined, authorSeat: string, promotionId?: string): { name: string; entry: SeatEntry } {
  const roster = readRoster();
  for (const [name, entry] of Object.entries(roster)) {
    if (entry.role === "reviewer" && entry.shadow !== undefined && typeof entry.shadow !== "boolean") die(`reviewer seat "${name}" has invalid shadow ${JSON.stringify(entry.shadow)} — use a boolean; absent means false`);
  }
  if (explicit) {
    const entry = roster[explicit];
    if (!entry) die(`no seat named "${explicit}" in seats/seats.json`);
    if (entry.role !== "reviewer") {
      die(`seat "${explicit}" has role "${entry.role}", not "reviewer" — verify.ts reviews diffs; walk.ts uses verifier seats. If this is a legacy review seat, fix: set seats/seats.json seats[${JSON.stringify(explicit)}].role to "reviewer"`);
    }
    if (entry.shadow === true && !promotionId) die(`reviewer seat "${explicit}" is shadow: true and never gates by default — the commander must record a per-outage promotion on this bead and supply --fallback-promotion <comment-id>; see runbooks/RUNNING_THE_LOOP.md: Gating reviewer down`);
    return { name: explicit, entry };
  }
  const reviewers = Object.entries(roster).filter(([, e]) => e.role === "reviewer" && !e.external);
  if (reviewers.length === 0) {
    const legacy = Object.entries(roster).filter(([, e]) => e.role === "verifier" && !e.external)
      .map(([name]) => `seat "${name}": if it reviews diffs, fix: set seats/seats.json seats[${JSON.stringify(name)}].role to "reviewer"; keep "verifier" only for walk.ts`).join("\n");
    die(`no seat with role "reviewer" in seats/seats.json — add one (its account.dir must differ from every author's)${legacy ? `\n${legacy}` : ""}`);
  }
  const gating = reviewers.filter(([, entry]) => entry.shadow !== true);
  if (gating.length === 0) die(`no non-shadow reviewer eligible for automatic selection — shadow seats never gate by default; name a reviewer explicitly with a per-outage --fallback-promotion <comment-id> recorded by the commander on this bead`);
  const authorDir = canonicalDir(accountDirFor(authorSeat));
  const distinct = gating.filter(([, e]) => e.account?.dir && canonicalDir(e.account.dir) !== authorDir);
  if (distinct.length === 0) die(`reviewer seat and author seat "${authorSeat}" resolve to the SAME account directory; waiting for a reviewer on a different subscription. Same directory means same auth.json means same account, and a verdict from the author's own account is not a verdict. Nothing was spawned.`);
  const free = distinct.find(([n]) => !verifyMarkerLive(n));
  if (!free) { console.error(`all eligible reviewer seats busy (${distinct.map(([n]) => n).join(", ")}) — retry later`); process.exit(4); }
  return { name: free[0], entry: free[1] };
}

interface FallbackPromotion { commentId: string; author: string; seat: string; tip: string; outage: string; distinctAccountBasis: string }
function readFallbackPromotion(beadId: string, seat: string, tip: string, commentId: string): FallbackPromotion {
  // Schema captured with bd comments <bead> --json. Actor attribution is a
  // procedural check, not authentication: this remains a commander-facing CLI.
  let rows: any;
  try { rows = JSON.parse(execFileSync("bd", ["comments", beadId, "--json"], { cwd: ROOT, encoding: "utf8", timeout: 30000 })); }
  catch (e: any) { die(`cannot read fallback promotion ${commentId} on bead ${beadId}: ${e.message}`); }
  if (!Array.isArray(rows)) die("fallback promotion requires a JSON comment array from bd comments");
  const matches = rows.filter((row: any) => row && String(row.id) === commentId);
  if (matches.length !== 1) die(`fallback promotion comment ${commentId} not uniquely found on bead ${beadId}`);
  const comment = matches[0];
  if (comment.issue_id !== beadId) die("fallback promotion comment belongs to a different bead");
  if (comment.author !== beadsActorFor("commander")) die(`fallback promotion must be recorded by commander actor ${JSON.stringify(beadsActorFor("commander"))}, not ${JSON.stringify(comment.author)}`);
  const text = typeof comment.text === "string" ? comment.text.trim() : "";
  if (!text.startsWith("FALLBACK GATE: ")) die("fallback promotion comment must be one FALLBACK GATE: <JSON> record; see runbooks/RUNNING_THE_LOOP.md: Gating reviewer down");
  let value: any;
  try { value = JSON.parse(text.slice("FALLBACK GATE: ".length)); }
  catch { die("fallback promotion comment has invalid JSON"); }
  const keys = ["seat", "tip", "outage", "distinctAccountBasis"];
  if (!value || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()) || keys.some(k => typeof value[k] !== "string" || !value[k].trim() || value[k].length > 2000 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value[k]))) die("fallback promotion requires exactly nonempty single-line seat, tip, outage and distinctAccountBasis strings");
  if (value.seat !== seat) die("fallback promotion names a different reviewer seat");
  if (value.tip !== tip) die("fallback promotion is for a different tip; record a fresh promotion for this diff");
  return { commentId, author: comment.author, ...value, outage: value.outage.trim(), distinctAccountBasis: value.distinctAccountBasis.trim() };
}
function fallbackLeadIn(promotion: FallbackPromotion): string {
  return `FALLBACK GATE: promotion comment ${promotion.commentId}; outage: ${promotion.outage}; distinct-account basis: ${promotion.distinctAccountBasis}`;
}

function beadClaim(beadId: string): string {
  // Contract validation reads selected JSON fields; reviewers still need the
  // full bd show record, including comments, labels and dependency context.
  try {
    const out = execFileSync("bd", ["show", beadId], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    return `The bead, as \`bd show ${beadId}\` prints it from the dispatcher's machine:\n\n${out.trim()}`;
  } catch {
    return `The dispatcher could not run \`bd show ${beadId}\` — read the bead yourself (\`bd show ${beadId}\`) before judging anything against it.`;
  }
}

function refuseUncontractedReview(beadId: string, errors: string[]): void {
  if (errors.length) die(contractRemedy(beadId, errors), 6);
}

interface SourceDeclaration { original: string; absolute: string }
interface SourceSnapshot { original: string; mountedAt: string; bytes: number }

function sourceDeclarationLines(claim: string): string[] {
  const lines = claim.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:read-only\s+)?source paths\s*\(read-only\)\s*:\s*$/i.test(trimmed) || /^read-only source paths\s*:\s*$/i.test(trimmed)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      out.push(bullet[1].trim());
      continue;
    }
    if (trimmed === "") continue;
    break;
  }
  return out;
}

function parseSourceDeclarations(claim: string, repoRoot: string): SourceDeclaration[] {
  const seen = new Set<string>();
  const out: SourceDeclaration[] = [];
  for (const raw of sourceDeclarationLines(claim)) {
    const cleaned = raw.replace(/\s+#.*$/, "").trim();
    const bad =
      cleaned.length === 0 ? "empty" :
      /["'`]/.test(cleaned) ? "a quote character" :
      /\0/.test(cleaned) ? "NUL" :
      null;
    if (bad !== null) die(`invalid read-only source path ${JSON.stringify(raw)} (${bad}) — use an absolute path or a path relative to the branch repository, with no quotes`);
    const abs = path.resolve(repoRoot, expandTilde(cleaned));
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      die(`read-only source path ${JSON.stringify(cleaned)} does not exist (resolved from ${repoRoot} to ${abs})`);
    }
    const st = fs.statSync(real);
    if (!st.isDirectory() && !st.isFile()) die(`read-only source path ${JSON.stringify(cleaned)} is not a file or directory: ${real}`);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ original: cleaned, absolute: real });
  }
  return out;
}

function chmodReadOnly(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    fs.chmodSync(p, 0o555);
    for (const name of fs.readdirSync(p)) chmodReadOnly(path.join(p, name));
  } else if (st.isFile()) {
    fs.chmodSync(p, 0o444);
  } else if (st.isSymbolicLink()) {
    return;
  }
}

function treeBytes(p: string): number {
  const st = fs.lstatSync(p);
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of fs.readdirSync(p)) total += treeBytes(path.join(p, name));
  return total;
}

function materializeReadOnlySources(scratchCwd: string, declarations: SourceDeclaration[]): SourceSnapshot[] {
  if (declarations.length === 0) return [];
  // Use read-only snapshots instead of harness-specific allow flags: Claude's
  // --add-dir has no exact Pi/Codex twin, and bind mounts need host-specific
  // privileges. A copied, chmod-read-only tree inside the scratch worktree is
  // visible through the same cwd/prompt path for pi, claude-code, and codex,
  // and writes aimed at the supplied path fail without risking the original.
  const root = path.join(scratchCwd, ".wheelhouse-verify-sources");
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const snapshots: SourceSnapshot[] = [];
  for (const decl of declarations) {
    const base = path.basename(decl.absolute).replace(/[^A-Za-z0-9._-]/g, "_") || "source";
    const suffix = crypto.createHash("sha256").update(decl.absolute).digest("hex").slice(0, 12);
    const mountedAt = path.join(root, `${base}-${suffix}`);
    fs.cpSync(decl.absolute, mountedAt, { recursive: true, dereference: true, errorOnExist: true, force: false, preserveTimestamps: true });
    chmodReadOnly(mountedAt);
    snapshots.push({ original: decl.original, mountedAt, bytes: treeBytes(mountedAt) });
  }
  try { fs.chmodSync(root, 0o555); } catch {}
  return snapshots;
}

function sourceAccessPromptLines(snapshots: SourceSnapshot[]): string[] {
  if (snapshots.length === 0) return [];
  return [
    ``,
    `Read-only source snapshots declared by the bead and materialized by the dispatcher:`,
    ...snapshots.map((s) => `- ${s.original} — mounted read-only at ${s.mountedAt} (${s.bytes} bytes copied)`),
    `Use these mounted paths when judging work that depends on source outside the branch repository.`,
    `They are read-only snapshots: a write there should fail, and no undeclared sibling repository is mounted for this one-shot.`,
  ];
}

export type SweepTier = "core" | "full";
export interface SweepChoice { tier: SweepTier; reason: string; manifest?: CoreManifest }
export interface CoreManifest { sha256: string; suites: string[] }
export function parseCoreManifest(raw: Buffer | string, available: readonly string[]): CoreManifest {
  const suites: string[] = [], seen = new Set<string>();
  for (const row of raw.toString().split(/\n/)) {
    const name = row.replace(/#.*$/, "").trim();
    if (!name) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.selftest\.sh$/.test(name)) throw new Error(`core manifest: invalid suite name: ${name}`);
    if (seen.has(name)) throw new Error(`core manifest: duplicate suite: ${name}`);
    if (!available.includes(name)) throw new Error(`core manifest: missing suite: ${name}`);
    seen.add(name); suites.push(name);
  }
  if (!suites.length) throw new Error("core manifest: empty inventory");
  return { sha256: crypto.createHash("sha256").update(raw).digest("hex"), suites: suites.sort() };
}
function tierGit(root: string, ...args: string[]): Buffer {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], { env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}
function tierInventory(root: string, tip: string): string[] {
  return tierGit(root, "ls-tree", "-r", "-z", "--name-only", tip, "--", "seats").toString().split("\0")
    .filter(name => /^seats\/[^/]+\.selftest\.sh$/.test(name)).map(name => path.basename(name));
}
function manifestAt(root: string, tip: string): CoreManifest {
  return parseCoreManifest(tierGit(root, "show", `${tip}:seats/selftest-core.list`), tierInventory(root, tip));
}
export function chooseSweepTier(root: string, tip: string, claim: string): SweepChoice {
  const base = tierGit(root, "merge-base", "refs/heads/main", tip).toString().trim();
  if (!base) throw new Error("cannot establish main merge base for sweep tier");
  const knownSuites = [...new Set([...tierInventory(root, base), ...tierInventory(root, tip)])];
  // A deleted core suite still has its policy identity. Do not turn the
  // dispatcher's existing missing-runner/no-runnable-suite diagnostics into a
  // selector exception; the actual core runner validates current readability.
  const manifest = parseCoreManifest(tierGit(root, "show", `${tip}:seats/selftest-core.list`), knownSuites), core = new Set(manifest.suites);
  const names = knownSuites
    .map(name => name.replace(/\.selftest\.sh$/, "")).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const harness = new Set(["selftest-sweep.sh", "selftest-lib.sh", "selftest-sweep-lock.ts", "selftest-herald.sh", "python-invocations.ts", "selftest-core.list", "selftest-quarantine.list", "quarantine.ts", "adapter.ts", "seat-worktree.ts", "verify.ts", "heavy-test.sh", "heavy-test-entry.ts"].map(name => `seats/${name}`));
  // --no-renames includes both sides of deletions/renames; no pretty-printed
  // quoting, terminal wrapping or GIT_* redirect can hide a touched path.
  const touched = tierGit(root, "diff", "--name-only", "--no-renames", "-z", base, tip).toString().split("\0").filter(Boolean).sort();
  for (const file of touched) {
    if (/[\r\n]/.test(file)) throw new Error("control character in sweep tier path");
    if (harness.has(file) || (/^seats\/[^/]+\.selftest\.sh$/.test(file) && !core.has(path.basename(file)))) return { tier: "full", reason: file, manifest };
    if (file.startsWith("seats/fixtures/")) {
      const component = file.slice("seats/fixtures/".length).split("/")[0];
      // Longest known suite wins: adapter-rpc is full, not adapter's core fixture.
      const owner = names.find(name => component === name || component.startsWith(name + ".") || component.startsWith(name + "-"));
      if (!owner || !core.has(`${owner}.selftest.sh`)) return { tier: "full", reason: file, manifest };
    }
  }
  if (claimRequiresSweepCitation(claim)) return { tier: "full", reason: "Done line", manifest };
  return { tier: "core", reason: "default", manifest };
}
interface SuiteTiming { suite: string; seconds: number; quarantined?: boolean }
interface QuarantineResult extends QuarantineEntry { result: "PASS" | "FAIL" }
interface SweepTimings { tier: SweepTier; manifest?: string; tierLine: string; footer: string; totalSeconds: number; suites: SuiteTiming[]; slowest: SuiteTiming[]; quarantine: QuarantineResult[] }
function quarantineAt(root: string, tip: string): QuarantineEntry[] {
  if (!tierGit(root, "ls-tree", "--name-only", tip, "--", "seats/selftest-quarantine.list").length) return [];
  return parseQuarantine(tierGit(root, "show", `${tip}:seats/selftest-quarantine.list`).toString(), tierInventory(root, tip));
}
function assertSweepQuarantine(timings: SweepTimings, entries: QuarantineEntry[]): void {
  const selected = entries.filter(e=>timings.suites.some(s=>s.suite===e.suite)).sort((a,b)=>a.suite.localeCompare(b.suite));
  const actual = [...timings.quarantine].sort((a,b)=>a.suite.localeCompare(b.suite));
  if (actual.length !== selected.length || selected.some((e,i)=>e.suite!==actual[i].suite || e.owner!==actual[i].owner || e.deadline!==actual[i].deadline)) throw new Error("dispatcher quarantine policy/summary mismatch");
}
function quarantineLines(sweep: SweepResult): string[] {
  return ["- quarantined failures:", ...(sweep.timings?.quarantine.filter(q=>q.result==="FAIL").map(q=>`  - ${q.suite} owner=${q.owner} until=${q.deadline}`) ?? [])];
}
interface SweepResult { required: boolean; rc: number | null; logPath: string | null; elapsedMs: number; tip: string; choice?: SweepChoice; requiredChoice?: SweepChoice; timings?: SweepTimings; error?: string; batch?: { tip: string; main: string; sha256: string } }
function assertSweepChoice(timings: SweepTimings, choice: SweepChoice): void {
  if (timings.tier !== choice.tier) throw new Error(`dispatcher tier mismatch: chose ${choice.tier} (${choice.reason}), log records ${timings.tier}`);
  if (choice.tier === "core" && (!choice.manifest || timings.manifest !== choice.manifest.sha256 || timings.suites.length !== choice.manifest.suites.length || timings.suites.some((s, i) => s.suite !== choice.manifest!.suites[i]))) throw new Error("dispatcher core manifest/inventory mismatch");
}

// Read only the outer runner's records. Nested fixture sweeps use other roots
// and must not contribute to this receipt's inventory, seconds or slowest five.
export function readSweepTimings(text: string): SweepTimings {
  const invalid = (why: string): never => { throw new Error(`invalid sweep timings: ${why}`); };
  const whole = (s: string): number => {
    if (!/^(0|[1-9][0-9]*)$/.test(s) || !Number.isSafeInteger(Number(s))) invalid("seconds/count must be safe whole numbers");
    return Number(s);
  };
  const tier = /^selftest-sweep: tier=(full suites=([1-9][0-9]*)|core suites=([1-9][0-9]*) manifest=([0-9a-f]{64}))$/m.exec(text);
  const footers = [...text.matchAll(/^selftest-sweep: (?:PASS \(([1-9][0-9]*) suite\(s\), ([0-9]+)s\)|FAIL \(([1-9][0-9]*) failure\(s\) of ([1-9][0-9]*) suite\(s\), ([0-9]+)s\))$/gm)];
  const footer = footers.at(-1);
  const lastSummary = [...text.matchAll(/^selftest-sweep: (?:PASS|FAIL) \([^\n]*\)$/gm)].at(-1);
  const firstStart = /^selftest-sweep: START /m.exec(text);
  if (!tier || !footer || !lastSummary || lastSummary.index !== footer.index || tier.index >= footer.index! || (firstStart && firstStart.index < tier.index)) invalid("missing tier/full completed footer");
  const count = whole(tier![2] ?? tier![3]), totalSeconds = whole(footer![2] ?? footer![5]);
  if (count !== whole(footer![1] ?? footer![4])) invalid("inventory/summary mismatch");
  const body = text.slice(tier!.index + tier![0].length, footer!.index);
  const first = /^selftest-sweep: START (.+\/seats\/)([^/\n]+\.selftest\.sh)$/m.exec(body);
  if (!first) invalid("inventory/summary mismatch");
  const prefix = first![1], suites: SuiteTiming[] = [], seen = new Set<string>();
  let pending: string | undefined, failures = 0;
  const quarantined = new Set<string>();
  for (const line of body.split("\n")) {
    if (line.startsWith(`selftest-sweep: START ${prefix}`)) {
      const name = line.slice(`selftest-sweep: START ${prefix}`.length);
      if (pending || !/^[^/\n]+\.selftest\.sh$/.test(name) || seen.has(name)) invalid("duplicate or unordered outer suite records");
      pending = name;
    } else if (["PASS", "FAIL", "QUARANTINED-FAIL"].some(kind => line.startsWith(`selftest-sweep: ${kind} ${prefix}`))) {
      const pass = `selftest-sweep: PASS ${prefix}${pending} elapsed=`;
      const fail = `selftest-sweep: FAIL ${prefix}${pending} `;
      const quarantineFail = `selftest-sweep: QUARANTINED-FAIL ${prefix}${pending} `;
      let seconds: string | undefined;
      if (pending && line.startsWith(quarantineFail)) {
        const result = /^rc=([1-9][0-9]*) elapsed=(0|[1-9][0-9]*)s$/.exec(line.slice(quarantineFail.length));
        seconds = result?.[2]; if (result) quarantined.add(pending);
      }
      else if (pending && line.startsWith(pass)) seconds = /^(0|[1-9][0-9]*)s$/.exec(line.slice(pass.length))?.[1];
      else if (pending && line.startsWith(fail)) {
        seconds = /^(?:rc=[0-9]+|timed out after [1-9][0-9]*s \(TERM then KILL after [1-9][0-9]*s grace; rc=[0-9]+\)) elapsed=(0|[1-9][0-9]*)s$/.exec(line.slice(fail.length))?.[1];
        failures++;
      }
      if (seconds === undefined) invalid("missing, malformed or failed outer suite records");
      suites.push({ suite: pending!, seconds: whole(seconds!), ...(quarantined.has(pending!) ? {quarantined:true} : {}) }); seen.add(pending!); pending = undefined;
    }
  }
  if (pending || suites.length !== count) invalid("missing or filtered outer suite records");
  if (failures !== (footer![3] ? whole(footer![3]) : 0)) invalid("failed outer suite records disagree with footer");
  const sum = suites.reduce((n, s) => n + s.seconds, 0);
  if (!Number.isSafeInteger(sum) || totalSeconds < sum) invalid("total seconds below per-suite sum");
  const tail = body.trimEnd().split("\n"); const summaries: string[] = [];
  while (tail.at(-1)?.startsWith("selftest-sweep: quarantine: ")) summaries.unshift(tail.pop()!);
  const quarantine: QuarantineResult[] = [];
  if (summaries.includes("selftest-sweep: quarantine: none")) {
    if (summaries.length !== 1) invalid("mixed empty quarantine summary");
  } else for (const row of summaries) {
    const q = /^selftest-sweep: quarantine: ([A-Za-z0-9][A-Za-z0-9._-]*\.selftest\.sh) owner=([A-Za-z0-9][A-Za-z0-9._-]*) until=(\d{4}-\d{2}-\d{2}) result=(PASS|FAIL)$/.exec(row);
    if (!q || quarantine.some(e=>e.suite===q[1]) || !seen.has(q[1]) || (q[4]==="FAIL") !== quarantined.has(q[1])) invalid("invalid quarantine summary/result");
    quarantine.push({suite:q![1],owner:q![2],deadline:q![3],result:q![4] as "PASS"|"FAIL"});
  }
  if ([...quarantined].some(name=>!quarantine.some(q=>q.suite===name))) invalid("quarantined failure missing summary");
  const slowest = [...suites].sort((a, b) => b.seconds - a.seconds || a.suite.localeCompare(b.suite)).slice(0, 5);
  return { tier: tier![4] ? "core" : "full", manifest: tier![4], tierLine: tier![0], footer: footer![0], totalSeconds, suites, slowest, quarantine };
}

function sweepTimingLines(sweep: SweepResult): string[] {
  if (!sweep.timings) return [];
  return [
    `- ${sweep.timings.tierLine}`,
    `- ${sweep.timings.footer}`,
    `- totalSeconds: ${sweep.timings.totalSeconds}`,
    `- slowest suites (whole seconds, descending):`,
    ...sweep.timings.slowest.map(s => `  - ${s.suite}: ${s.seconds}s`),
    ...quarantineLines(sweep),
  ];
}

// Opt-in only. Read the existing dispatcher's envelope, not arbitrary terminal
// text that happens to contain PASS/rc=0. Never execute a sweep in this path.
export function readBatchSweep(repoRoot: string, reviewedTip: string, logArg: string, requiredChoice = chooseSweepTier(repoRoot, reviewedTip, "")): SweepResult {
  const refuse = (why: string): never => { throw new Error(`batch sweep refused: ${why}`); };
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete gitEnv[key];
  const git = (...args: string[]) => execFileSync("git", ["--no-replace-objects", "-C", repoRoot, ...args], { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const file = path.resolve(logArg);
  let fd: number | undefined;
  let text: string, stat: fs.Stats, logPath: string, sha256: string;
  try {
    if (!fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) refuse("safe log-open flags unavailable");
    const beforeLeaf = fs.lstatSync(file);
    if (!beforeLeaf.isFile() || beforeLeaf.isSymbolicLink() || beforeLeaf.nlink !== 1) refuse("log must be a single-link regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > 64 * 1024 * 1024) refuse("log must be a nonempty single-link regular file, at most 64MiB");
    const bytes = fs.readFileSync(fd);
    sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    text = bytes.toString("utf8").replace(/\r\n/g, "\n");
    const after = fs.fstatSync(fd), leaf = fs.lstatSync(file);
    if (!leaf.isFile() || leaf.isSymbolicLink() || [after, leaf].some(s => s.dev !== stat.dev || s.ino !== stat.ino || s.size !== stat.size || s.mtimeMs !== stat.mtimeMs || s.ctimeMs !== stat.ctimeMs || s.nlink !== 1)) refuse("log changed while reading");
    // Keep the absolute supplied path. Never realpath the leaf: it can be
    // replaced with a FIFO after lstat even though our descriptor is regular.
    logPath = file;
  } catch (e: any) { return refuse(`cannot read safe log: ${e.message}`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const header = /^tip=([0-9a-f]{40}|[0-9a-f]{64})\ncommand=bash seats\/selftest-sweep\.sh --tier (core|full)\ntier=(core|full) reason=([^\n]+)\nWHEELHOUSE_SKIP_REAL_PI=1 \(hermetic suites; no live login borrowed\)\npreparedTip=([0-9a-f]{40}|[0-9a-f]{64})\nscratchGraph=isolated nested repository\n/.exec(text!);
  const footer = /\nselftest-sweep: PASS \(([1-9][0-9]*) suite\(s\), ([0-9]+)s\)\nfinalTip=([0-9a-f]{40}|[0-9a-f]{64})\n\nrc=0\nelapsedMs=([0-9]+)\n$/.exec(text!);
  if (!header || !footer || header[1] !== header[5] || header[1] !== footer[3] || header[2] !== header[3] || text!.includes("\0")) refuse("not a completed passing hermetic full-sweep envelope (tip/prepared/final/command/rc)");
  const batchTip = header![1], elapsedMs = Number(footer![4]);
  if (!Number.isSafeInteger(elapsedMs)) refuse("invalid elapsedMs");
  let main: string, committedMs: number, expected: string[], batchManifest: CoreManifest | undefined;
  try {
    if (git("rev-parse", "--verify", `${batchTip}^{commit}`) !== batchTip || git("rev-parse", "--verify", `${reviewedTip}^{commit}`) !== reviewedTip) refuse("tips must name exact commits");
    main = git("rev-parse", "--verify", "refs/heads/main^{commit}");
    committedMs = Number(git("show", "-s", "--format=%ct", reviewedTip)) * 1000;
    expected = tierInventory(repoRoot, batchTip);
    if (header![3] === "core") { batchManifest = manifestAt(repoRoot, batchTip); expected = batchManifest.suites; }
    if (!git("rev-list", "--first-parent", batchTip).split("\n").includes(main)) refuse("batch first-parent chain does not reach current main");
  } catch (e: any) { return refuse(`cannot establish batch history: ${e.message}`); }
  const ancestor = spawnSync("git", ["--no-replace-objects", "-C", repoRoot, "merge-base", "--is-ancestor", reviewedTip, batchTip], { env: gitEnv, encoding: "utf8" });
  if (ancestor.error || ancestor.status !== 0) refuse(`reviewed tip is not a proven ancestor of batch tip (git status ${ancestor.status}; ${ancestor.error?.message ?? ancestor.stderr})`);
  if (!Number.isSafeInteger(committedMs!) || !Number.isFinite(stat!.mtimeMs) || stat!.mtimeMs < committedMs! || (stat!.birthtimeMs > 0 && stat!.birthtimeMs < committedMs!) || stat!.mtimeMs > Date.now() + 1) refuse("log is stale or future-dated relative to reviewed commit");
  // A filtered pass is not a full sweep. Match the outer runner's exact suite
  // set and serial START/PASS pairs; nested fixture runners have other roots.
  let timings: SweepTimings;
  try { timings = readSweepTimings(text!.slice(header![0].length)); }
  catch (e: any) { return refuse(e.message); }
  if (expected!.length === 0 || timings.suites.length !== expected!.length || timings.suites.some(s => !expected!.includes(s.suite))) refuse("full-suite inventory/summary mismatch");
  const choice: SweepChoice = { tier: header![3] as SweepTier, reason: header![4], manifest: batchManifest };
  try { assertSweepChoice(timings, choice); assertSweepQuarantine(timings, quarantineAt(repoRoot, batchTip)); } catch (e: any) { refuse(e.message); }
  if (requiredChoice.tier === "full" && choice.tier !== "full") refuse(`full tier required by ${requiredChoice.reason}; a core batch cannot cover this candidate`);
  return { required: true, rc: 0, logPath: logPath!, elapsedMs, tip: reviewedTip, choice, requiredChoice, timings, batch: { tip: batchTip, main: main!, sha256: sha256! } };
}

// Wording controls extra reviewer citations, never execution of the gate.
function claimRequiresSweepCitation(claim: string): boolean {
  return /full\s+(?:seats\/\*\.selftest\.sh\s+)?sweep\s+passes/i.test(claim) || /selftest-sweep\.sh/i.test(claim);
}

// The exported name remains for existing callers which explicitly request full.
export async function runDispatcherFullSweep(repoRoot: string, tip: string, realBd: string, basePath: string, choice: SweepChoice = { tier: "full", reason: "caller" }): Promise<SweepResult> {
  // Separate from the reviewer's cwd: no writable graph or bd wrapper reaches
  // that process. Suites create their OWN fixture graphs, not one redirected
  // global graph (which would invalidate graph-isolation selftests).
  const scratchCwd = makeScratchCwd(repoRoot, "review", tip);
  const groupsFile = path.join(scratchCwd, ".wheelhouse-review-groups");
  fs.writeFileSync(groupsFile, "", { flag: "wx", mode: 0o600 });
  const logDir = path.join(VERDICTS_DIR, "sweeps");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${tip}.${process.pid}.${Date.now()}.selftest-sweep.log`);
  const started = Date.now();
  // Keep logical and physical cwd consistent for sweep child processes.
  const env: NodeJS.ProcessEnv = { ...process.env, PWD: scratchCwd, PATH: basePath, WHEELHOUSE_REAL_BD: realBd, WHEELHOUSE_SKIP_REAL_PI: "1", WHEELHOUSE_SELFTEST_REVIEW_GROUPS: groupsFile };
  for (const key of ["BEADS_DIR", "BEADS_DB", "WHEELHOUSE_SELFTEST_BD_ROOT", "WHEELHOUSE_ROOT", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "WHEELHOUSE_SELFTEST_SWEEP_PATTERN", "WHEELHOUSE_SELFTEST_SWEEP_TIER"]) delete env[key];
  const actualTip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratchCwd, encoding: "utf8", env }).trim();
  if (actualTip !== tip) die(`sweep scratch tip ${actualTip} differs from reviewed tip ${tip}`);
  fs.writeFileSync(logPath, `tip=${actualTip}\ncommand=bash seats/selftest-sweep.sh --tier ${choice.tier}\ntier=${choice.tier} reason=${choice.reason}\nWHEELHOUSE_SKIP_REAL_PI=1 (hermetic suites; no live login borrowed)\n`);
  let rc = 1;
  let error: string | undefined;
  try {
    const runner = path.join(scratchCwd, "seats", "selftest-sweep.sh");
    if (!fs.existsSync(runner) || !fs.statSync(runner).isFile()) throw new Error("reviewed tip has no seats/selftest-sweep.sh runner; review is incomplete");
    const hasSuites = fs.readdirSync(path.join(scratchCwd, "seats")).some((name) =>
      !name.startsWith(".") && name.endsWith(".selftest.sh") && fs.statSync(path.join(scratchCwd, "seats", name)).isFile());
    if (!hasSuites) throw new Error("reviewed tip has no runnable seats/*.selftest.sh suites; review is incomplete");
    if (!realBd) throw new Error("bd is required for writable scratch fixture graphs");
    // bd init in a linked worktree can select its shared ancestor graph;
    // it can also commit setup files. Keep both operations in a fresh nested
    // primary repository, then expose only that graph at the sweep root.
    const graphRoot = path.join(scratchCwd, ".wheelhouse-sweep-graph");
    fs.mkdirSync(graphRoot);
    // Same switch/isolation as selftest_disable_bd_metrics: bd 1.2.2 uses
    // HOME/.config/bd even when XDG_CONFIG_HOME differs. Never edit the
    // operator's metrics preference or let an uploader inherit review cwd.
    env.HOME = path.join(graphRoot, "home");
    env.XDG_CONFIG_HOME = path.join(env.HOME, ".config");
    fs.mkdirSync(env.HOME);
    const metrics = spawnSync(realBd, ["metrics", "off"], { cwd: graphRoot, encoding: "utf8", env });
    if (metrics.error || metrics.signal || metrics.status !== 0) throw new Error(`could not disable scratch bd metrics: ${metrics.error?.message || metrics.stderr || metrics.stdout}`);
    execFileSync("git", ["init", "--quiet", "-b", "main", graphRoot], { env, stdio: "pipe" });
    const graphDir = path.join(graphRoot, ".beads");
    const init = spawnSync(realBd, ["init", "--non-interactive", "--skip-agents", "-p", "verify-sweep"], { cwd: graphRoot, encoding: "utf8", env: { ...env, PWD: graphRoot, BEADS_DIR: graphDir } });
    if (init.status !== 0) throw new Error(`scratch bd init failed: ${init.stderr || init.stdout}`);
    const sweepBeads = path.join(scratchCwd, ".beads");
    let existingBeads: fs.Stats | undefined;
    try { existingBeads = fs.lstatSync(sweepBeads); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (!existingBeads) fs.symlinkSync(graphDir, sweepBeads, "dir");
    else {
      // Umbrella trees may track .beads/config.yaml, hooks, etc. Keep those
      // bytes in place: bd's native redirect is local to this workspace, unlike
      // an inherited BEADS_DIR that would hijack suites' own fixture graphs.
      // Never follow a reviewed symlink or overwrite an existing redirect.
      if (!existingBeads.isDirectory()) throw new Error("reviewed .beads is not a directory; cannot expose the isolated sweep graph safely");
      fs.writeFileSync(path.join(sweepBeads, "redirect"), graphDir + "\n", { flag: "wx", mode: 0o600 });
    }
    const located = spawnSync(realBd, ["where", "--json"], { cwd: scratchCwd, encoding: "utf8", env });
    if (located.status !== 0 || fs.realpathSync(JSON.parse(located.stdout).path) !== fs.realpathSync(graphDir)) {
      throw new Error("sweep bd did not resolve its owned scratch graph");
    }
    const preparedTip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratchCwd, encoding: "utf8", env }).trim();
    if (preparedTip !== tip) throw new Error(`sweep setup changed reviewed tip from ${tip} to ${preparedTip}`);
    fs.appendFileSync(logPath, `preparedTip=${preparedTip}\nscratchGraph=isolated nested repository\n`);
    // Select the real binary without removing host-budget shims from PATH.
    const bin = path.join(scratchCwd, ".wheelhouse-sweep-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bash\nexec ${JSON.stringify(realBd)} "$@"\n`, { mode: 0o755 });
    env.PATH = `${bin}${path.delimiter}${basePath}`;
    const fd = fs.openSync(logPath, "a");
    try {
      // No wall-clock/model-command timeout: the runner owns H4 and waits for
      // its turn. Stream directly to disk even during a long lock wait.
      rc = await new Promise<number>((resolve) => {
        const child = spawn("bash", ["seats/selftest-sweep.sh", "--tier", choice.tier], { cwd: scratchCwd, env, stdio: ["ignore", fd, fd], detached: true });
        trackReviewChild(child, { sweep: {
          lock: path.resolve(scratchCwd, env.WHEELHOUSE_SELFTEST_SWEEP_LOCK || "/tmp/wheelhouse-selftest-sweep.lock"),
          helper: env.WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER || path.join(scratchCwd, "seats/selftest-sweep-lock.ts"),
          groupsFile,
        } });
        const finish = (code: number) => {
          if (!reviewCancelling) resolve(code);
        };
        child.once("error", (e) => { error = e.message; finish(1); });
        child.once("close", (code) => finish(code ?? 128));
      });
    } finally { fs.closeSync(fd); }
    // 0/1 are completed pass/fail results. Lock/setup refusal, interruption,
    // and exec failure are incomplete; retain a bounded runner diagnostic.
    if (rc > 1 && !error) {
      const reader = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      try {
        const st = fs.fstatSync(reader);
        if (!st.isFile()) throw new Error("dispatcher sweep log is not a regular file");
        const bytes = Buffer.alloc(Math.min(st.size, 512));
        const n = fs.readSync(reader, bytes, 0, bytes.length, st.size - bytes.length);
        error = `dispatcher runner could not complete (exit ${rc}): ${bytes.subarray(0, n).toString("utf8").trim().replace(/\s+/g, " ")}`;
      } finally { fs.closeSync(reader); }
    }
  } catch (e: any) { error = e.message; }
  try {
    const finalTip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratchCwd, encoding: "utf8", env }).trim();
    fs.appendFileSync(logPath, `finalTip=${finalTip}\n`);
    if (finalTip !== tip) { rc = 1; error = `sweep changed reviewed tip from ${tip} to ${finalTip}`; }
  } catch (e: any) { rc = 1; error = e.message; }
  let timings: SweepTimings | undefined;
  if (!error && (rc === 0 || rc === 1)) {
    try { timings = readSweepTimings(fs.readFileSync(logPath, "utf8")); assertSweepChoice(timings, choice); assertSweepQuarantine(timings, quarantineAt(repoRoot, tip)); }
    catch (e: any) { error = e.message; rc = 1; }
  }
  const elapsedMs = Date.now() - started;
  fs.appendFileSync(logPath, `\nrc=${rc}\nelapsedMs=${elapsedMs}\n${error ? `error=${error}\n` : ""}`);
  removeScratchWorktree(repoRoot, scratchCwd);
  return { required: true, rc, logPath, elapsedMs, tip, choice, timings, error };
}

function sweepPromptLines(sweep: SweepResult, requireCitation: boolean): string[] {
  if (!sweep.logPath) return [];
  return [
    ``,
    sweep.batch ? `Reused passing full sweep from a combined batch tree containing the reviewed tip:` : `Full selftest sweep run by the dispatcher at the exact reviewed tip before this reviewer spawn:`,
    ...(sweep.batch ? [`- batch-tip: ${sweep.batch.tip}`, `- batch-main: ${sweep.batch.main}`, `- batch-log-sha256: ${sweep.batch.sha256}`] : []),
    `- tip: ${sweep.tip}`,
    `- command: bash seats/selftest-sweep.sh --tier ${sweep.choice?.tier ?? "unknown"}`,
    `- tier: ${sweep.choice?.tier ?? "unknown"}; reason: ${sweep.choice?.reason ?? "missing"}`,
    ...(sweep.requiredChoice ? [`- candidate required tier: ${sweep.requiredChoice.tier}; reason: ${sweep.requiredChoice.reason}`] : []),
    `- rc: ${sweep.rc}`,
    `a quarantined failure does not block APPROVE; read it and BOUNCE if it looks caused by this change`,
    `- log: ${sweep.logPath}`,
    `- elapsedMs: ${sweep.elapsedMs}`,
    ...sweepTimingLines(sweep),
    ...(sweep.error ? [`- error: ${sweep.error}`] : []),
    sweep.batch ? `This is batch coverage, not a new sweep at the candidate alone. Reviewed tip ${sweep.tip} is an ancestor of batch tip ${sweep.batch.tip}, whose first-parent chain reaches current main. This reuses only the sweep, not another reviewer's judgment.` : `This dispatcher gate runs for every review, regardless of the bead's wording, outside your model command timeout in the detached scratch worktree at the reviewed tip. Its result is recorded with your verdict. If rc is not 0, you cannot approve.`,
    ...(requireCitation ? [`You must cite rc=${sweep.rc} and the exact log path in your final evidence.`] : []),
  ];
}

function sectionByHeading(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^#{2,3}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim() || null;
}

function integratorPathCandidates(root: string): string[] {
  return [
    path.join(root, "wheelhouse", "INTEGRATOR.md"),
    path.join(path.dirname(root), "wheelhouse", "INTEGRATOR.md"),
    path.join(path.dirname(path.dirname(root)), "wheelhouse", "INTEGRATOR.md"),
  ];
}

function pushAuthorityPromptLines(root: string): string[] {
  const p = integratorPathCandidates(root).find((candidate) => fs.existsSync(candidate));
  if (!p) return [``, `Install push authority: no wheelhouse/INTEGRATOR.md found from ${root}; if push authority is missing, HOLD with that reason.`];
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch { return [``, `Install push authority file exists but was not readable: ${p}; if push authority is missing, HOLD with that reason.`]; }
  const authority = sectionByHeading(text, "### Push authority and its scope");
  const reserved = sectionByHeading(text, "### Reserved list (principal-only, per action)");
  return [
    ``,
    `Install push authority for this reviewer run (read from ${p}):`,
    authority ?? `### Push authority and its scope\n<not found in ${p}>`,
    ``,
    reserved ?? `### Reserved list (principal-only, per action)\n<not found in ${p}>`,
  ];
}

function recordNoVerdict(beadId: string, branch: string, tip: string, reviewerSeat: string, realBd: string, scratchCwd: string, stdout: string, stderr: string): never {
  fs.mkdirSync(VERDICTS_DIR, { recursive: true });
  const reason = "Reviewer completed its turn without a live VERDICT line; no judgment was delivered. A collecting dispatch or human decision is owed, not a promise to return.";
  // Never overwrite a reviewer-authored interim, partial, or prior record.
  const preserved = [".interim.md", ".md", ".partial.md"]
    .map((suffix) => path.join(VERDICTS_DIR, `${beadId}${suffix}`)).filter((file) => fs.existsSync(file));
  // A relative interim written in the disposable checkout must also survive
  // makeScratchCwd's exit cleanup. Copy known records without following links
  // outside that checkout or overwriting an install-local record.
  for (const suffix of [".interim.md", ".md", ".partial.md"]) {
    const source = path.join(scratchCwd, "seats", "verdicts", `${beadId}${suffix}`);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) continue;
    if (!fs.realpathSync(source).startsWith(fs.realpathSync(scratchCwd) + path.sep)) continue;
    const retained = path.join(VERDICTS_DIR, `${beadId}.retained.${crypto.randomUUID()}${suffix}`);
    fs.copyFileSync(source, retained, fs.constants.COPYFILE_EXCL);
    preserved.push(retained);
  }
  const file = path.join(VERDICTS_DIR, `${beadId}.no-verdict.${crypto.randomUUID()}.md`);
  const relative = path.relative(ROOT, file);
  const detail = ["outcome: no-verdict", `reason: ${reason}`, `bead: ${beadId}`, `branch: ${branch}`, `tip: ${tip}`, `verifier-seat: ${reviewerSeat}`, `working record: ${relative}`,
    ...preserved.map((p) => `interim/previous record preserved: ${path.relative(ROOT, p)}`)].join("\n");
  fs.writeFileSync(file, [`# No-verdict — ${beadId}`, "", detail, "", "> Working copy, not a verdict or an evidence home.", "", "## Reviewer stdout", "```jsonl", stdout, "```", "", "## Reviewer stderr", "```", stderr, "```", ""].join("\n"), { flag: "wx" });
  const posted = realBd ? spawnSync(realBd, ["comment", beadId, "--stdin"], {
    cwd: ROOT, env: { ...process.env, PWD: ROOT, BEADS_ACTOR: "verifier-gate" }, input: `${detail}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000,
  }) : null;
  const delivery = posted?.status === 0 ? "task comment recorded" : `TASK COMMENT FAILED: ${posted?.error?.message || posted?.stderr || posted?.stdout || "bd unavailable"}`;
  fs.appendFileSync(file, `\n## Task notification\n${delivery}\n`);
  try {
    appendVerifierGateInbox(beadId, "distress", `verifier gate no-verdict — ${beadId}`, `${delivery}\n${detail}`, "verifier-no-verdict", relative);
    gateInboxWrote = true;
  } catch (error: any) {
    fs.appendFileSync(file, `\nINBOX NOTIFICATION FAILED: ${error.message}\n`);
    process.stderr.write(`NO-VERDICT inbox notification failed: ${error.message}\n`);
  }
  console.error(`NO-VERDICT: ${reason}\n  working record: ${relative}\n  ${delivery}`);
  process.exit(5);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const evidencePaths: string[] = [];
  let repoArg: string | undefined;
  let timeoutArg: string | undefined;
  let firstOutputTimeoutArg: string | undefined;
  let noEventTimeoutArg: string | undefined;
  let batchSweepArg: string | undefined;
  let promotionArg: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--evidence") {
      const v = argv[++i];
      if (!v) die("--evidence requires <path>[,<path>...]");
      for (const p of v.split(",")) evidencePaths.push(validateEvidencePath(p.trim()));
    } else if (argv[i] === "--repo") {
      repoArg = argv[++i];
      if (!repoArg) die("--repo requires <path-to-branch-repo>");
    } else if (argv[i] === "--batch-sweep") {
      if (batchSweepArg !== undefined) die("--batch-sweep may be supplied only once");
      batchSweepArg = argv[++i];
      if (!batchSweepArg || batchSweepArg.startsWith("--")) die("--batch-sweep requires <passing-full-sweep-log>");
    } else if (argv[i] === "--fallback-promotion") {
      if (promotionArg !== undefined) die("--fallback-promotion may be supplied only once");
      promotionArg = argv[++i];
      if (!promotionArg || promotionArg.startsWith("--")) die("--fallback-promotion requires <comment-id>");
    } else if (argv[i] === "--timeout-ms") {
      timeoutArg = argv[++i];
      if (!timeoutArg || !/^\d+$/.test(timeoutArg)) die("--timeout-ms requires a positive integer millisecond budget");
    } else if (argv[i] === "--first-output-timeout-ms") {
      firstOutputTimeoutArg = argv[++i];
      if (!firstOutputTimeoutArg || !/^\d+$/.test(firstOutputTimeoutArg)) die("--first-output-timeout-ms requires a positive integer millisecond budget");
    } else if (argv[i] === "--no-event-timeout-ms") {
      noEventTimeoutArg = argv[++i];
      if (!noEventTimeoutArg || !/^\d+$/.test(noEventTimeoutArg)) die("--no-event-timeout-ms requires a positive integer millisecond budget");
    } else {
      positional.push(argv[i]);
    }
  }
  const earlyRepoRoot = resolveRepoRoot(repoArg);
  sweepStaleScratchWorktrees(earlyRepoRoot);
  const [beadId, branch, authorSeat, reviewerArg] = positional;
  if (!beadId || !branch || !authorSeat) {
    die("usage: verify.ts <bead-id> <branch> <author-seat> [reviewer-seat] [--fallback-promotion <comment-id>] [--repo <path-to-branch-repo>] [--evidence <path>[,<path>...]] [--timeout-ms <ms>] [--first-output-timeout-ms <ms>] [--no-event-timeout-ms <ms>] [--batch-sweep <passing-full-sweep-log>]  # timeout knobs are stall watchdogs, not a wall-clock cap");
  }
  setVerifierGateBead(beadId);
  validateSegment("bead id", beadId);
  validateSegment("seat name", authorSeat);
  if (reviewerArg) validateSegment("seat name", reviewerArg);
  if (promotionArg && !reviewerArg) die("--fallback-promotion requires an explicit reviewer-seat; automatic selection never promotes a shadow");
  if (promotionArg) validateSegment("promotion comment id", promotionArg);
  const contract = checkBeadContract(ROOT, beadId);
  refuseUncontractedReview(beadId, contract.errors); // contract-gate: before reviewer identity or harness spawn
  const claim = [
    beadClaim(beadId),
    ``,
    `Parsed work contract (validated before reviewer spawn):`,
    JSON.stringify(parseContract(contract.text ?? ""), null, 2),
  ].join("\n");
  const repoRoot = resolveRepoRoot(repoArg, claim);
  if (path.resolve(repoRoot) !== path.resolve(earlyRepoRoot)) sweepStaleScratchWorktrees(repoRoot);
  const timeoutMs = Number(timeoutArg || process.env.WHEELHOUSE_VERIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const firstOutputTimeoutMs = Number(firstOutputTimeoutArg || process.env.WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS || DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
  const noEventTimeoutMs = Number(noEventTimeoutArg || process.env.WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS || DEFAULT_NO_EVENT_TIMEOUT_MS);
  let brief: string;
  try {
    brief = resolveRoleBrief(ROOT, "reviewer");
  } catch (e: any) {
    die(e.message);
  }

  const { name: reviewerSeat, entry } = requireReviewerSeat(reviewerArg, authorSeat, promotionArg);
  let reviewerHarness: ReturnType<typeof harnessNameForSeat>;
  try {
    reviewerHarness = harnessNameForSeat(reviewerSeat, entry);
  } catch (e: any) {
    die(e.message);
  }
  if (!entry.account?.dir) die(`reviewer seat "${reviewerSeat}" has no account.dir in seats/seats.json`);

  // --- account distinctness, before anything is spawned ---------------------
  const reviewerDir = requireDistinctAccount(authorSeat, reviewerSeat, entry.account.dir);

  if (!fs.existsSync(reviewerDir)) {
    die(
      `reviewer seat directory does not exist: ${reviewerDir}\n` +
        `      provision it first: seats/seat-env.sh <namespace> ${reviewerSeat} "${ROOT}"`
    );
  }
  const reviewerAuthFile = path.join(reviewerDir, "auth.json");
  if (!authRouteIdentity(reviewerSeat, entry, reviewerAuthFile, reviewerHarness, reviewerDir)) {
    const envVar = entry.account?.authRoute === "env" && entry.provider ? providerEnvVar(entry.provider) : undefined;
    const oauthLine = reviewerHarness === "claude-code"
      ? `      OAuth: CLAUDE_CONFIG_DIR="${reviewerDir}" claude, then type /login and exit after the browser flow\n`
      : `      OAuth: PI_CODING_AGENT_DIR="${reviewerDir}" pi, then type /login in the REPL and /exit after the browser flow\n`;
    const keyLine = reviewerHarness === "claude-code"
      ? `      oauth record: ${path.join(reviewerDir, ".claude.json")} must contain oauthAccount\n`
      : `      api_key: write ${reviewerAuthFile}\n`;
    die(
      `reviewer seat "${reviewerSeat}" has no identity — give it credentials once:\n` +
        oauthLine +
        keyLine +
        `      env: set account.authRoute=env and export ${envVar ?? "the provider env var"} in the shell that spawns this reviewer`
    );
  }

  // --- the branch must resolve; the verdict is about a SHA, not a name ------
  let tip: string;
  try {
    tip = execFileSync("git", ["rev-parse", "--verify", `${branch}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    die(`branch "${branch}" does not resolve to a commit in ${repoRoot} — nothing to verify`);
  }

  const promotion = promotionArg ? readFallbackPromotion(beadId, reviewerSeat, tip, promotionArg) : undefined;

  // --- evidence floor checks, against the SHA the verdict is about ----------
  const evidence = checkEvidence(repoRoot, tip, evidencePaths);
  const evidenceUnsatisfied = evidence.filter((c) => !c.ok);
  const evidencePrompt =
    evidence.length === 0
      ? []
      : [
          ``,
          `Evidence the bead names, floor-checked by the dispatcher at ${tip}:`,
          ...evidenceLines(evidence),
          `The floor (exists, non-empty, right type) is not the judgment: open each`,
          `artifact (git -C ${repoRoot} cat-file blob ${tip}:<path>) and judge its content against`,
          `the claim it supports, recording what you inspected. While any check above`,
          `reads UNSATISFIED, the done does not hold as stated and an APPROVE cannot`,
          `be delivered — the dispatcher will refuse it as malformed.`,
        ];

  const sourceDeclarations = parseSourceDeclarations(claim, repoRoot);

  // cwd is a throwaway scratch worktree, not ROOT and not a bead's
  // worktree — construction closing the confused-writer hazard, still
  // distinct from adapter.ts's per-bead worker seats (a worker's cwd needs
  // to BE the bead; the reviewer's cwd only needs to be A repository the
  // branch's ref resolves from, which any worktree of this repo is). The
  // deleted-path core.worktree leak came from the old reviewer launch that
  // exported GIT_DIR/GIT_WORK_TREE for this scratch worktree into the one-shot
  // reviewer process; any `git config --local core.worktree ...` the reviewer
  // ran with that environment wrote to the product repo's common config. That
  // environment leak is removed, and makeScratchCwd snapshots/restores the
  // product repo config in case a child still clobbers it mid-run. See
  // makeScratchCwd() above and seats/README.md, "Verifying a branch" for
  // the full reasoning.
  assertHostBuildLockAvailable();
  const basePath = hostBudgetPath(ROOT);
  const realBd = findOnPath("bd", basePath) ?? "";
  const scratchCwd = makeScratchCwd(repoRoot, "verify", tip);
  const sourceSnapshots = materializeReadOnlySources(scratchCwd, sourceDeclarations);
  const sourcePrompt = sourceAccessPromptLines(sourceSnapshots);
  const selectedTier = chooseSweepTier(repoRoot, tip, claim);
  const sweep = batchSweepArg ? readBatchSweep(repoRoot, tip, batchSweepArg, selectedTier) : await runDispatcherFullSweep(repoRoot, tip, realBd, basePath, selectedTier);
  const requireSweepCitation = !!sweep.batch || claimRequiresSweepCitation(claim);
  const sweepPrompt = sweepPromptLines(sweep, requireSweepCitation);

  // --- the one-shot ---------------------------------------------------------
  const prompt = [
    `You are dispatched as the EPHEMERAL reviewer for bead ${beadId}.`,
    ``,
    `Branch under review: ${branch}`,
    `Branch repository: ${repoRoot}`,
    `Install root for machine-local wheelhouse/ paths: ${ROOT} (also exported as WHEELHOUSE_ROOT)`,
    ...scratchPromptLines(ROOT, beadId),
    `Tip SHA at dispatch: ${tip}`,
    `Author seat: ${authorSeat} (account-distinctness from you was asserted before this spawn)`,
    ``,
    claim,
    ...(promotion ? [
      `Referenced per-outage promotion: bead ${beadId}, comment ${promotion.commentId}, recorded actor ${promotion.author}, reviewer ${reviewerSeat}, tip ${tip}.`,
      `This is a FALLBACK GATE, not a SHADOW verdict. The full REVIEWER.md contract and all ordinary evidence/account/sweep gates still apply.`,
      `Independently check the promotion's outage and distinct-account basis against every author; route any claim you cannot verify. The comment and actor field alone do not authenticate human assent.`,
      `In your final answer, include exactly this plain-text lead-in outside fences before VERDICT/PUSH:`,
      fallbackLeadIn(promotion),
    ] : []),
    ...evidencePrompt,
    ...sourcePrompt,
    ...sweepPrompt,
    ...pushAuthorityPromptLines(ROOT),
    ``,
    `Verify whether the bead's stated done holds at that SHA, per your brief.`,
    `Your process cwd is a detached scratch worktree for the branch repository. Prefer relative searches from this cwd.`,
    `Do not recursively grep the live Branch repository path's seats/logs or seats/verdicts runtime dirs; if you must search that path, exclude seats/logs and seats/verdicts/*.partial*.`,
    `Confirm the branch still resolves to the SHA above before relying on your reading.`,
    `Interview-mode bench is unavailable inside this reviewer sandbox: do not run bench.sh --mode interview or any equivalent interview-mode bench here. If the bead's done depends on interview-mode claims, do not accept the author's retained output as your own proof; route those claims to named non-author seat ${reviewerSeat} (distinct from author seat ${authorSeat}) for out-of-sandbox verification, and report that routing in the verdict evidence.`,
    `If the branch moves while you are reviewing but the pinned SHA remains an ancestor, render the verdict on the pinned SHA and name the move, for example:`,
    `VERDICT: APPROVE — at pinned tip ${tip}; branch has since moved to <new-tip> (<N> commits appended, history unrewritten)`,
    `PUSH: NOT CONSIDERED — branch moved; re-verify at <new-tip> before publish`,
    `DISCOVER is reserved for a discovery that displaces the judgment, not for an appended branch tip; the integrator/publisher refuses any tip other than the verdict's pinned SHA until the new tip is re-verified.`,
    `End with exactly one plain-text VERDICT line and exactly one plain-text PUSH line, never inside a Markdown code fence:`,
    `VERDICT: APPROVE | BOUNCE | DISCOVER`,
    `PUSH: APPROVE <remote> — verified: <what you checked> | HOLD — <why> | NOT CONSIDERED [<why>]`,
    `Evidence goes above those two closing lines. Fenced VERDICT: or PUSH: lines are ignored and make the gate STOP.`,
    `If a sweep cannot finish inside this turn, write an interim record at ${path.join(VERDICTS_DIR, `${beadId}.interim.md`)} before stopping: name the pinned SHA/artifact identity, what finished, what is still running, its output location, and the collecting dispatch owed.`,
    `The interim record carries no VERDICT or PUSH line. Stop after writing it; never end the turn with a promise to return when a background sweep finishes. The dispatcher records a distinct no-verdict outcome when your turn ends without a judgment.`,
    `If you cannot deliver a verdict, emit no VERDICT: or PUSH: line at all.`,
  ].join("\n");

  const oneShotPath = readonlyBdPath(ROOT, basePath, scratchCwd);
  const env = oneShotEnvForHarness(reviewerHarness, reviewerDir, {
    ...process.env,
    PATH: oneShotPath,
    WHEELHOUSE_ROOT: ROOT,
    WHEELHOUSE_REAL_BD: realBd,
    BEADS_ACTOR: beadsActorFor(reviewerSeat),
  });
  const refusedOutputs: string[] = [];
  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const oneShot = oneShotCommandForHarness(reviewerHarness, brief, entry.provider, entry.model, attemptPrompt, entry.allowedTools, entry.disallowedTools);
    const startedAt = Date.now();
    const res = await runOneShot(oneShot.bin, oneShot.args, {
      cwd: scratchCwd,
      env,
      timeoutMs,
      firstOutputTimeoutMs,
      noEventTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      harness: reviewerHarness,
      marker: { seat: reviewerSeat, bead: beadId },
    });
    const elapsedMs = Date.now() - startedAt;
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    const refuse = (reason: string, retryAllowed = true): never => {
      const file = writeRefusedReviewerOutput(beadId, {
        bead: beadId, branch, repoRoot, tip, verifierSeat: reviewerSeat, harness: reviewerHarness,
        provider: entry.provider, model: entry.model, attempt, at: new Date().toISOString(),
        reason, stdout, stderr, sweep,
        process: { status: res.status, signal: res.signal, error: res.error ? { message: res.error.message, code: res.error.code } : null },
      });
      refusedOutputs.push(file);
      throw new RefusedReviewerOutput(reason, file, retryAllowed);
    };

    try {
      // Main's completed-turn-without-judgment outcome remains distinct from
      // refusing a delivered answer: preserve its record/notification/exit5.
      if (res.outcome === "no-verdict") recordNoVerdict(beadId, branch, tip, reviewerSeat, realBd, scratchCwd, stdout, stderr);

      if (res.error) {
        if ((res.error as any).code === "WHEELHOUSE_FIRST_OUTPUT_TIMEOUT") {
          const phase = lastReviewerPhase(stdout);
          const partial = writePartialReviewerOutput(beadId, stdout, stderr, phase, elapsedMs, firstOutputTimeoutMs);
          refuse(`reviewer emitted no stdout/stderr within ${firstOutputTimeoutMs}ms (elapsed ${elapsedMs}ms; last phase: ${phase}; partial output: ${partial}). This is a first-output deadline, not the full verify timeout; retry with --first-output-timeout-ms <ms> if the reviewer is legitimately silent that long.`);
        }
        if ((res.error as any).code === "WHEELHOUSE_NO_EVENT_TIMEOUT") {
          const phase = lastReviewerPhase(stdout);
          const partial = writePartialReviewerOutput(beadId, stdout, stderr, phase, elapsedMs, noEventTimeoutMs);
          refuse(`model stalled after ${noEventTimeoutMs}ms with no reviewer stream event (elapsed ${elapsedMs}ms; last event: ${phase}; partial output: ${partial}). This is the no-event watchdog, not the full verify timeout; retry with --no-event-timeout-ms <ms> if the reviewer is legitimately quiet that long.`);
        }
        if ((res.error as any).code === "ETIMEDOUT") {
          const phase = lastReviewerPhase(stdout);
          const partial = writePartialReviewerOutput(beadId, stdout, stderr, phase, elapsedMs, timeoutMs);
          refuse(`could not run ${oneShot.bin}: timed out after ${timeoutMs}ms (elapsed ${elapsedMs}ms; last phase: ${phase}; partial output: ${partial})`);
        }
        refuse(`could not run ${oneShot.bin}: ${res.error.message}`);
      }
      if (res.status !== 0) {
        refuse(
          `${oneShot.bin} exited ${res.status ?? `signal ${res.signal}`} for reviewer seat "${reviewerSeat}"${accountLabelSuffix(entry)} — no verdict. stderr tail:\n` +
            stderr.slice(-2000)
        );
      }

      // --- parse: exactly one live VERDICT line, exactly one known value --------
      // A VERDICT quoted inside a triple-backtick Markdown fence is evidence text,
      // not the reviewer's machine verdict. Ordinary blockquotes are still live:
      // only fences classify a line inert.
      const verdictLines = liveVerdictCandidates(stdout, reviewerHarness);
      if (verdictLines.length === 0) {
        process.stderr.write(`--- reviewer output tail ---\n${stdout.slice(-2000)}\n`);
        refuse(`reviewer emitted no VERDICT: line outside fenced code blocks — per the brief that routes to a human, not to a verdict`);
      }
      if (verdictLines.length > 1) {
        refuse(
          `reviewer emitted ${verdictLines.length} live VERDICT: lines outside fenced code blocks — ambiguous, refusing to pick one. Candidates:\n` +
            verdictLines.map((v) => `      line ${v.lineNumber}: ${v.normalized}`).join("\n")
        );
      }
      const pushLines = livePushCandidates(stdout, reviewerHarness);
      if (pushLines.length === 0) {
        refuse(`reviewer emitted no PUSH: line outside fenced code blocks — REVIEWER.md requires exactly one PUSH line beside the verdict`);
      }
      if (pushLines.length > 1) {
        refuse(
          `reviewer emitted ${pushLines.length} live PUSH: lines outside fenced code blocks — ambiguous, refusing to pick one. Candidates:\n` +
            pushLines.map((v) => `      line ${v.lineNumber}: ${v.normalized}`).join("\n")
        );
      }
      if (!/^PUSH:\s*(APPROVE\s+\S+(?:\s+(?![—-]\s+verified:).+?)?\s+[—-]\s+verified:\s*\S.*|HOLD\s+[—-]\s+\S.*|NOT CONSIDERED(?:\s+\S.*)?)\s*$/.test(pushLines[0].normalized)) {
        refuse(`malformed PUSH line: "${pushLines[0].normalized}" — expected PUSH: APPROVE <remote> — verified: <what you checked> [detail] | HOLD — <why> [detail] | NOT CONSIDERED [detail]`);
      }
      if (promotion) {
        const badges = liveLineCandidates(stdout, reviewerHarness, "FALLBACK GATE");
        if (badges.length !== 1 || badges[0].normalized !== fallbackLeadIn(promotion)) refuse(`fallback review must include the exact live lead-in: ${fallbackLeadIn(promotion)}`);
        if (/^VERDICT:\s*(?:APPROVE|BOUNCE|DISCOVER)\s+[—-]\s+SHADOW(?:\s*$|\s*[-:—(]|\s+ONLY\b)/i.test(verdictLines[0].normalized)) refuse("fallback verdict must be gating, not a SHADOW verdict");
      }
      // The NOT BENCHED qualifier (REVIEWER.md, "When no bench covers the part
      // you are reviewing") belongs to APPROVE and to nothing else.
      const branchTipAfter = currentBranchTip(repoRoot, branch);
      const movedTo = branchTipAfter && branchTipAfter !== tip ? branchTipAfter : "";
      const appendedCount = movedTo ? appendedCommitCount(repoRoot, tip, movedTo) : null;
      const movedShape = movedTo && appendedCount !== null
        ? new RegExp(`^VERDICT:\\s*(APPROVE|BOUNCE)\\s+[—-]\\s+at pinned tip ${tip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; branch has since moved to ${movedTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${appendedCount} commits appended, history unrewritten\\)$`)
        : null;
      const movedMatch = movedShape?.exec(verdictLines[0].normalized) ?? null;
      const ordinaryMatch = verdictLines[0].normalized.match(/^VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)(?:\s+(.*))?$/);
      const notBenchedMatch = ordinaryMatch?.[2]?.match(/^[—-]{1,2}\s*NOT BENCHED:\s*(\S.*)$/);
      const m = movedMatch ?? ordinaryMatch;
      if (!m) {
        refuse(`malformed verdict line: "${verdictLines[0].normalized}" — expected VERDICT: APPROVE [— NOT BENCHED: <gap>] [detail] | BOUNCE [detail] | DISCOVER [detail]${movedTo && appendedCount !== null ? ` | APPROVE/BOUNCE — at pinned tip ${tip}; branch has since moved to ${movedTo} (${appendedCount} commits appended, history unrewritten)` : ""}`);
      }
      const verdict = m[1];
      const movedVerdictShown = movedMatch ? verdictLines[0].normalized.replace(/^VERDICT:\s*/, "") : "";
      const notBenched = notBenchedMatch?.[1]?.trim();
      if (notBenched && verdict !== "APPROVE") {
        refuse(`malformed verdict line: NOT BENCHED qualifies APPROVE and nothing else, got: "${verdictLines[0].normalized}"`);
      }
      if (movedTo) {
        if (appendedCount === null) {
          refuse(`branch "${branch}" moved during verification from ${tip} to ${movedTo}, but the pinned tip is no longer an ancestor — no verdict can be rendered without a fresh review`);
        }
        const expectedPush = `PUSH: NOT CONSIDERED — branch moved; re-verify at ${movedTo} before publish`;
        if (!movedVerdictShown) {
          refuse(`branch "${branch}" moved during verification from ${tip} to ${movedTo} (${appendedCount} commits appended, history unrewritten); verdict must judge the pinned tip and name the move, not switch to DISCOVER or omit the move note`);
        }
        if (pushLines[0].normalized !== expectedPush) {
          refuse(`branch "${branch}" moved during verification; PUSH must be exactly "${expectedPush}" so publish waits for re-verification at the moved tip`);
        }
      }
      const annotatedVerdictShown = verdictLines[0].normalized.replace(/^VERDICT:\s*/, "");
      const verdictShown = movedVerdictShown || (ordinaryMatch?.[2] ? annotatedVerdictShown : verdict);
      const benchGapNotes = benchGapNotices(notBenched);

      // An APPROVE over a missing, empty, or mistyped artifact the bead requires
      // is a defect in the verdict, not a judgment — same family as the NOT
      // BENCHED parser rule: malformed, exit 1, never a clean 0 the dispatcher
      // could merge on. BOUNCE and DISCOVER pass through: a failed floor check
      // is a fine BOUNCE reason, and the record below still carries the checks.
      if (verdict === "APPROVE" && evidenceUnsatisfied.length > 0) { // evidence-gate
        refuse(
          `verdict APPROVE with unsatisfied evidence — the bead names artifacts that fail the floor at ${tip}:\n` +
            evidenceLines(evidenceUnsatisfied).map((l) => `      ${l}`).join("\n") +
            `\n      An APPROVE cannot stand on evidence that is not there; this is malformed, not a judgment.`
        );
      }

      if (sweep.batch && batchSweepArg) {
        // Preserve main's before-publication revalidation. Input revocation is
        // not a formatting problem a corrective model answer can repair.
        let checked: SweepResult;
        try { checked = readBatchSweep(repoRoot, tip, batchSweepArg, selectedTier); }
        catch (error: any) { refuse(error?.message ?? String(error), false); }
        if (checked.batch!.sha256 !== sweep.batch.sha256) refuse("batch sweep log changed during review", false);
      }
      // Setup/spawn/pinning failures are not completed BOUNCE/DISCOVER
      // judgments. A cosmetic retry cannot repair a missing dispatcher run.
      if (sweep.error && verdict !== "APPROVE") {
        refuse(`INCOMPLETE review: dispatcher full sweep could not complete; rc=${sweep.rc}; log=${sweep.logPath ?? "missing"}; ${sweep.error}`, false);
      }
      // Fail closed before publishing authority, even if execution is ever
      // bypassed again. NOT BENCHED cannot waive a missing/failed receipt.
      if (verdict === "APPROVE") {
        let receiptExists = false;
        try { const st = fs.lstatSync(sweep.logPath!); receiptExists = st.isFile() && st.size > 0; } catch {}
        if (!Number.isInteger(sweep.rc) || sweep.tip !== tip || !receiptExists) {
          refuse(`INCOMPLETE review: cannot record APPROVE without a dispatcher full-sweep result at ${tip}; rc=${sweep.rc}; log=${sweep.logPath ?? "missing"}`, false);
        }
        if (sweep.rc !== 0 || sweep.error) refuse(`INCOMPLETE review: APPROVE with failed full sweep rc=${sweep.rc}; log=${sweep.logPath}${sweep.error ? `; ${sweep.error}` : ""}`, false);
        try {
          if (!sweep.choice) throw new Error("missing dispatcher tier choice");
          const retainedTimings = readSweepTimings(fs.readFileSync(sweep.logPath!, "utf8"));
          assertSweepChoice(retainedTimings, sweep.choice);
          assertSweepQuarantine(retainedTimings, quarantineAt(repoRoot, sweep.batch?.tip ?? tip));
        } catch (error: any) { refuse(`INCOMPLETE review: ${error.message}`, false); }
      }
      if (sweep.logPath && requireSweepCitation) {
        const evidenceText = finalAssistantText(stdout, reviewerHarness);
        if (!evidenceText.includes(`rc=${sweep.rc}`) || !evidenceText.includes(sweep.logPath)) refuse(`reviewer must cite full-sweep rc=${sweep.rc} and log=${sweep.logPath} in its final evidence`);
      }

      // --- record, then report --------------------------------------------------
      fs.mkdirSync(VERDICTS_DIR, { recursive: true });
      const verdictFile = path.join(VERDICTS_DIR, `${beadId}.md`);
      const record = [
        `# Verdict — bead ${beadId}`,
        ``,
        `- bead: ${beadId}`,
        `- branch: ${branch}`,
        `- branch-repo: ${repoRoot}`,
        `- tip: ${tip}`,
        `- author-seat: ${authorSeat}`,
        `- verifier-seat: ${reviewerSeat} (${reviewerDir})`,
        ...(promotion ? [
          `- fallback-promotion-comment: ${promotion.commentId}`,
          `- fallback-promotion-actor: ${promotion.author}`,
          `- fallback-outage: ${promotion.outage}`,
          `- fallback-distinct-account-basis: ${promotion.distinctAccountBasis}`,
        ] : []),
        `- at: ${new Date().toISOString()}`,
        `- verdict: ${verdictShown}`,
        `- push: ${pushLines[0].normalized.replace(/^PUSH:\s*/, "")}`,
        ...benchGapNotes.map((note) => `- ${note}`),
        ...refusedOutputs.map((file) => `- refused-output (not a verdict): ${path.relative(ROOT, file)}`),
        ``,
        `> Working copy only. Evidence the graph can cite lives on the bead —`,
        `> transcribe the decisive extract there before citing this verdict.`,
        verdict === "DISCOVER"
          ? `> DISCOVER: proposal recorded below for the commander; no beads were filed.`
          : ``,
        ...(evidence.length > 0
          ? [
              ``,
              `## Evidence checks`,
              ``,
              `Floor checks the dispatcher ran against ${tip} before the spawn`,
              `(exists, bytes, type probe). The reviewer's judgment of the content`,
              `is in its output below.`,
              ``,
              ...evidenceLines(evidence),
            ]
          : []),
        ...(sourceSnapshots.length > 0
          ? [
              ``,
              `## Read-only source snapshots`,
              ``,
              ...sourceSnapshots.map((s) => `- ${s.original} — mounted read-only at ${s.mountedAt} (${s.bytes} bytes copied)`),
            ]
          : []),
        ...(sweep.logPath
          ? [
              ``,
              `## Dispatcher full-sweep result`,
              ``,
              ...(sweep.batch ? [`- batch-tip: ${sweep.batch.tip}`, `- batch-main: ${sweep.batch.main}`, `- batch-log-sha256: ${sweep.batch.sha256}`] : []),
              `- tip: ${sweep.tip}`,
              `- command: bash seats/selftest-sweep.sh --tier ${sweep.choice?.tier ?? "unknown"}`,
              `- tier: ${sweep.choice?.tier ?? "unknown"}`,
              `- reason: ${sweep.choice?.reason ?? "missing"}`,
              ...(sweep.requiredChoice ? [`- candidate-required-tier: ${sweep.requiredChoice.tier}; reason: ${sweep.requiredChoice.reason}`] : []),
              `- rc: ${sweep.rc}`,
              `- log: ${sweep.logPath}`,
              `- elapsedMs: ${sweep.elapsedMs}`,
              ...sweepTimingLines(sweep),
            ]
          : []),
        ``,
        `## Reviewer output`,
        ``,
        stdout.trimEnd(),
        ``,
      ].join("\n");
      fs.writeFileSync(verdictFile, record); // verdict-write
      appendVerifierGateInbox(
        beadId,
        "settle",
        `verifier gate verdict — ${beadId}`,
        `VERDICT: ${verdictShown}\nPUSH: ${pushLines[0].normalized.replace(/^PUSH:\s*/, "")}\nbranch: ${branch}\ntip: ${tip}\nverdict file: ${path.relative(ROOT, verdictFile)}`
      );
      gateInboxWrote = true;

      console.log(`VERDICT: ${verdictShown}  (bead ${beadId}, tip ${tip.slice(0, 12)}, reviewer ${reviewerSeat})`);
      console.log(`  full output -> ${verdictFile}`);
      if (evidence.length > 0) {
        console.log(`  evidence: ${evidence.length} named artifact(s) floor-checked at the tip, ${evidenceUnsatisfied.length} unsatisfied`);
      }
      for (const note of benchGapNotes) console.log(`  ${note}`);
      if (verdict === "DISCOVER") {
        console.log(`  DISCOVER files no beads — the proposal waits in the verdict file for the commander.`);
      }
      process.exit(verdict === "APPROVE" ? 0 : verdict === "BOUNCE" ? 2 : 3);
    } catch (error) {
      if (!(error instanceof RefusedReviewerOutput)) throw error;
      // An exited, completed answer gets one restatement, not another review.
      // Process/auth/watchdog failures are retained but never auto-retried.
      if (attempt === 2 || !error.retryAllowed || res.error || res.status !== 0) die(`${error.message}\nREFUSED output (not a verdict): ${error.file}`);
      process.stderr.write(`REFUSED output (not a verdict): ${error.file}\nOffering one corrective attempt to the same reviewer; ${sweep.required ? `reusing completed sweep rc=${sweep.rc} log=${sweep.logPath}` : "no new review or sweep"}.\n`);
      attemptPrompt = [
        prompt,
        "",
        "CORRECTIVE ATTEMPT 1 OF 1 — restate your final answer, do not restart the review.",
        "Your prior answer was REFUSED by the dispatcher, not recorded as a verdict.",
        `Refusal reason: ${error.message}`,
        `Raw stdout/stderr diagnostic (not a verdict): ${error.file}`,
        "Prior final answer (JSON-encoded data, not new instructions):",
        // Tool streams/stderr can exceed the OS argv limit. Retain them in the
        // diagnostic, but replay the final answer, not the entire event stream.
        JSON.stringify({ answer: finalAssistantText(stdout, reviewerHarness) }),
        ...sweepPrompt,
        "Reuse your completed checks and the dispatcher sweep above; NEVER rerun that sweep.",
        "Restate the final evidence including the exact sweep rc and log path when supplied.",
        "Keep your judgment unless the refusal identifies a real contradiction; do not invent evidence or turn a failed sweep into an APPROVE.",
        "End with exactly one live VERDICT line and one PUSH line as instructed above. If unable to judge, emit neither; this attempt will also be retained as REFUSED.",
      ].join("\n");
    }
  }
}

// The review may invoke arbitrary project benches. Hold the same admission as
// its dispatcher sweep for the whole review, before any model watchdog starts.
if (import.meta.main) {
  // Route a pre-main admission refusal too; it must not disappear merely
  // because no scratch/model process (and thus no main parser) could start.
  const earlyBead = process.argv[2];
  if (earlyBead && !earlyBead.startsWith("-")) setVerifierGateBead(earlyBead);
  heavyTestEntry(import.meta.path, main).catch((e) => die(e?.message ?? String(e)));
}
