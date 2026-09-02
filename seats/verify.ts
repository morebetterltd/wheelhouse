#!/usr/bin/env bun
/**
 * verify.ts — commander-facing dispatch of the EPHEMERAL verifier pass.
 *
 * One invocation = one verdict. It spawns a one-shot `pi -p --no-session`
 * on the VERIFIER seat's own agent directory, with the VERIFIER crew brief
 * appended to the system prompt, hands it the bead claim and the branch's
 * tip SHA, and parses the single `VERDICT:` line out of what comes back.
 * Nothing persists on the verifier's side — no session, no memory — which
 * is the point: the verdict plus its printed evidence IS the whole output.
 *
 * The precondition this file exists to enforce: the verifier's account is
 * not the author's. Same account.dir means same auth.json means same
 * account, and a verdict from the author's own account is not a verdict.
 * The comparison happens BEFORE anything is spawned, against canonicalized
 * paths, and an identical pair is a loud STOP, not a warning.
 *
 * The verdict and the verifier's full output land in
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
 * not the judgment: the verifier still opens each artifact and judges its
 * content against the claim. But an APPROVE while any floor check fails is
 * MALFORMED — exit 1, mirroring the NOT BENCHED parser rule — never exit 0.
 *
 * Why an argument rather than parsing `Evidence:` lines out of `bd show`:
 * the bead text reaching this dispatcher is a human rendering (and bd may be
 * unreachable, which beadClaim already tolerates). The commander reads the
 * bead and restates its requirement as arguments — the same relationship the
 * bead claim itself already has to the dispatch.
 *
 * Usage: bun seats/verify.ts <bead-id> <branch> <author-seat> [verifier-seat]
 *          [--repo <path-to-branch-repo>] [--evidence <path>[,<path>...]]
 *
 * Single-repo installs need no configuration: --repo defaults to ROOT. Umbrella
 * installs pass --repo for the product repository that owns <branch>; evidence
 * paths stay relative to that product repository.
 *
 * Exit: 0 APPROVE | 2 BOUNCE | 3 DISCOVER | 1 anything else (including a
 * malformed or missing verdict — the machine must never mistake an error
 * for a judgment).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveRoleBrief } from "./briefs";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const VERDICTS_DIR = path.join(SEATS_DIR, "verdicts");

// One-shot verification reads a diff and maybe runs a bench; give it room.
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_VERIFY_TIMEOUT_MS || 900000);

/**
 * A throwaway git worktree, used ONLY as the one-shot verifier spawn's
 * process cwd — construction, not contract discipline. VERIFIER.md already
 * says "read-only on the work," but that is a rule the model can ignore;
 * the same hazard class adapter.ts's per-bead cwd (see seats/README.md,
 * "Running a seat") closes for a confused WORKER applies to a confused or
 * adversarial verifier turn that runs a bare `write`/`edit` against a
 * relative path — with cwd: ROOT that lands in the live checkout, exactly
 * the checkout every other seat and the commander depend on.
 *
 * It has to be a real worktree of THIS repository, not an arbitrary empty
 * directory: the verifier's own default reading mechanism (VERIFIER.md,
 * "Reading a branch without disturbing it") is bare `git diff`/`git show`
 * with no `-C` flag, so its cwd must already be a valid working directory
 * sharing this repository's object database and refs, or every git command
 * the verifier runs fails before it reads a single line of the branch.
 * verify.ts's OWN git calls (branch resolution, checkEvidence) are
 * unaffected either way — they pass an explicit cwd for the branch's git
 * repository (`--repo` when an umbrella install needs one), which has nothing
 * to do with the spawned pi PROCESS's cwd.
 *
 * Detached at the branch repo's own HEAD — an arbitrary, always-resolvable commit.
 * The checked-out content is never read by anyone; the worktree exists
 * only so a stray write has somewhere harmless to land, and so `git`
 * commands run from inside it resolve at all. Removed on every exit path
 * via `process.on("exit", ...)`, which still fires synchronous cleanup
 * when `die()` calls `process.exit()` mid-run. The one path that skips
 * "exit" — a SIGKILL of the dispatcher — is handled by
 * sweepStaleScratchWorktrees() below, run once at the top of every
 * invocation, not by anything here.
 *
 * Named `wheelhouse-verify-<owning-pid>-<random>` so a later sweep can
 * tell which process made it without asking anything but the path.
 */
function makeScratchCwd(repoRoot: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wheelhouse-verify-${process.pid}-`));
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"], { stdio: "pipe" });
  } catch (e: any) {
    fs.rmSync(dir, { recursive: true, force: true });
    die(`could not create a scratch worktree for the verifier spawn in ${repoRoot}: ${(e.stderr ?? e.message).toString().trim()}`);
  }
  process.on("exit", () => {
    try {
      execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], { stdio: "ignore" });
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
  return dir;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists, not ours to signal — still alive
  }
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
 * Filters those to the `wheelhouse-verify-<pid>-*` naming makeScratchCwd()
 * uses, and reclaims only the ones whose stamped pid is no longer alive.
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
function sweepStaleScratchWorktrees(repoRoot: string): void {
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
  for (const p of worktreePaths) {
    const m = path.basename(p).match(/^wheelhouse-verify-(\d+)-/);
    if (!m) continue; // not one of ours
    if (pidAlive(Number(m[1]))) continue; // owner still running — not stale
    try {
      execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", p], { stdio: "ignore" });
    } catch {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
      try { execFileSync("git", ["-C", repoRoot, "worktree", "prune"], { stdio: "ignore" }); } catch {}
    }
    process.stderr.write(`swept: removed orphaned scratch worktree ${p} (owner pid ${m[1]} is gone)\n`);
  }
}

function die(msg: string): never {
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(1);
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Same mechanism as adapter.ts's beadsActorFor, and for the same reason: the
 * ephemeral verifier's own pi process must carry BEADS_ACTOR=<verifier seat>
 * so its bd comment lands authored as the verifier, regardless of whether
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
function validateSegment(kind: string, value: string): string {
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
function resolveRepoRoot(repoArg: string | undefined): string {
  if (!repoArg) return ROOT;
  const expanded = expandTilde(repoArg);
  const abs = path.resolve(ROOT, expanded);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    die(`--repo ${JSON.stringify(repoArg)} does not exist (resolved from ${ROOT})`);
  }
  let inside = "";
  try {
    inside = execFileSync("git", ["-C", real, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim();
  } catch {
    die(`--repo ${JSON.stringify(repoArg)} is not a git worktree (resolved to ${real})`);
  }
  if (inside !== "true") die(`--repo ${JSON.stringify(repoArg)} is not inside a git worktree (resolved to ${real})`);
  try {
    return execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    die(`could not resolve git top-level for --repo ${JSON.stringify(repoArg)} (resolved to ${real})`);
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
 * that is not a blob at that SHA (missing, or a directory) reads as absent. */
function checkEvidence(repoRoot: string, tip: string, paths: string[]): EvidenceCheck[] {
  return paths.map((p) => {
    let buf: Buffer;
    try {
      buf = execFileSync("git", ["cat-file", "blob", `${tip}:${p}`], {
        cwd: repoRoot,
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      return { path: p, exists: false, bytes: 0, probe: "MISSING at the tip SHA", ok: false };
    }
    const { ok, probe } = probeArtifact(p, buf);
    return { path: p, exists: true, bytes: buf.length, probe, ok };
  });
}

function evidenceLines(checks: EvidenceCheck[]): string[] {
  return checks.map(
    (c) =>
      `- ${c.path} — ${c.exists ? `exists, ${c.bytes} bytes, ${c.probe}` : c.probe} — ${c.ok ? "OK" : "UNSATISFIED"}`
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
  provider?: string;
  model?: string;
  external?: boolean;
  account?: { dir: string; label?: string };
}

function readRoster(): Record<string, SeatEntry> {
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
function accountDirFor(name: string): string {
  const entry = readRoster()[name];
  if (entry) {
    if (entry.external) {
      die(`seat "${name}" is external — it has no Pi account dir, so account-distinctness cannot be established against it`);
    }
    if (!entry.account?.dir) die(`seat "${name}" has no account.dir in seats/seats.json`);
    return entry.account.dir;
  }
  if (fs.existsSync(STATE_FILE)) {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const rec = st.seats?.[name];
    if (rec?.accountDir) return rec.accountDir;
  }
  die(`no seat named "${name}" in seats/seats.json or seats/state.json — cannot establish whose account authored this`);
}

// Same rule as adapter.ts: pi auto-creates an empty {} auth.json on a first
// headless run, and a seat with only that has never been logged in.
function authIsIdentity(authFile: string): boolean {
  if (!fs.existsSync(authFile)) return false;
  const body = fs.readFileSync(authFile, "utf8").replace(/[{}\s]/g, "");
  return body.length > 0;
}

function requireVerifierSeat(explicit: string | undefined): { name: string; entry: SeatEntry } {
  const roster = readRoster();
  if (explicit) {
    const entry = roster[explicit];
    if (!entry) die(`no seat named "${explicit}" in seats/seats.json`);
    if (entry.role !== "verifier") {
      die(`seat "${explicit}" has role "${entry.role}", not "verifier" — a verdict from a non-verifier seat is not what the graph will read it as`);
    }
    return { name: explicit, entry };
  }
  const verifiers = Object.entries(roster).filter(([, e]) => e.role === "verifier" && !e.external);
  if (verifiers.length === 0) {
    die(`no seat with role "verifier" in seats/seats.json — add one (its account.dir must differ from every author's)`);
  }
  if (verifiers.length > 1) {
    die(`multiple verifier seats (${verifiers.map(([n]) => n).join(", ")}) — name one: verify.ts <bead-id> <branch> <author-seat> <verifier-seat>`);
  }
  return { name: verifiers[0][0], entry: verifiers[0][1] };
}

function beadClaim(beadId: string): string {
  // Best effort: embed the claim so the verdict file is self-contained. If
  // bd is not reachable from here, the verifier reads the bead itself — it
  // has a shell; this dispatcher having one is a convenience, not a premise.
  try {
    const out = execFileSync("bd", ["show", beadId], { encoding: "utf8", timeout: 30000 });
    return `The bead, as \`bd show ${beadId}\` prints it from the dispatcher's machine:\n\n${out.trim()}`;
  } catch {
    return `The dispatcher could not run \`bd show ${beadId}\` — read the bead yourself (\`bd show ${beadId}\`) before judging anything against it.`;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const evidencePaths: string[] = [];
  let repoArg: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--evidence") {
      const v = argv[++i];
      if (!v) die("--evidence requires <path>[,<path>...]");
      for (const p of v.split(",")) evidencePaths.push(validateEvidencePath(p.trim()));
    } else if (argv[i] === "--repo") {
      repoArg = argv[++i];
      if (!repoArg) die("--repo requires <path-to-branch-repo>");
    } else {
      positional.push(argv[i]);
    }
  }
  const repoRoot = resolveRepoRoot(repoArg);
  sweepStaleScratchWorktrees(repoRoot);
  const [beadId, branch, authorSeat, verifierArg] = positional;
  if (!beadId || !branch || !authorSeat) {
    die("usage: verify.ts <bead-id> <branch> <author-seat> [verifier-seat] [--repo <path-to-branch-repo>] [--evidence <path>[,<path>...]]");
  }
  validateSegment("bead id", beadId);
  validateSegment("seat name", authorSeat);
  if (verifierArg) validateSegment("seat name", verifierArg);

  let brief: string;
  try {
    brief = resolveRoleBrief(ROOT, "verifier");
  } catch (e: any) {
    die(e.message);
  }

  const { name: verifierSeat, entry } = requireVerifierSeat(verifierArg);
  if (!entry.account?.dir) die(`verifier seat "${verifierSeat}" has no account.dir in seats/seats.json`);

  // --- account distinctness, before anything is spawned ---------------------
  const authorDir = canonicalDir(accountDirFor(authorSeat));
  const verifierDir = canonicalDir(entry.account.dir);
  if (authorDir === verifierDir) { // distinctness-gate
    die(
      `verifier seat "${verifierSeat}" and author seat "${authorSeat}" resolve to the SAME account directory:\n` +
        `        ${verifierDir}\n` +
        `      Same directory means same auth.json means same account, and a verdict\n` +
        `      from the author's own account is not a verdict. Nothing was spawned.`
    );
  }

  if (!fs.existsSync(verifierDir)) {
    die(
      `verifier seat directory does not exist: ${verifierDir}\n` +
        `      provision it first: seats/seat-env.sh <namespace> ${verifierSeat} "${ROOT}"`
    );
  }
  const verifierAuthFile = path.join(verifierDir, "auth.json");
  if (!authIsIdentity(verifierAuthFile)) {
    die(
      `verifier seat "${verifierSeat}" has no identity — give it credentials once:\n` +
        `      OAuth: PI_CODING_AGENT_DIR="${verifierDir}" pi, then type /login in the REPL and /exit after the browser flow\n` +
        `      api_key: write ${verifierAuthFile} or export the provider env var in the shell that spawns this verifier`
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

  // --- the one-shot ---------------------------------------------------------
  const prompt = [
    `You are dispatched as the EPHEMERAL verifier for bead ${beadId}.`,
    ``,
    `Branch under review: ${branch}`,
    `Branch repository: ${repoRoot}`,
    `Tip SHA at dispatch: ${tip}`,
    `Author seat: ${authorSeat} (account-distinctness from you was asserted before this spawn)`,
    ``,
    beadClaim(beadId),
    ...evidencePrompt,
    ``,
    `Verify whether the bead's stated done holds at that SHA, per your brief.`,
    `Confirm the branch still resolves to the SHA above before relying on your reading.`,
    `End with exactly one line: VERDICT: APPROVE | BOUNCE | DISCOVER, with your`,
    `evidence above it. If you cannot deliver a verdict, emit no VERDICT: line at all.`,
  ].join("\n");

  const args = ["-p", "--no-session", "--append-system-prompt", brief];
  if (entry.provider) args.push("--provider", entry.provider);
  if (entry.model) args.push("--model", entry.model);
  args.push(prompt);

  // cwd is a throwaway scratch worktree, not ROOT and not a bead's
  // worktree — construction closing the confused-writer hazard, still
  // distinct from adapter.ts's per-bead worker seats (a worker's cwd needs
  // to BE the bead; the verifier's cwd only needs to be A repository the
  // branch's ref resolves from, which any worktree of this repo is). See
  // makeScratchCwd() above and seats/README.md, "Verifying a branch" for
  // the full reasoning.
  const scratchCwd = makeScratchCwd(repoRoot);
  const res = spawnSync("pi", args, {
    cwd: scratchCwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: verifierDir, BEADS_ACTOR: beadsActorFor(verifierSeat) },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    die(`could not run pi: ${(res.error as any).code === "ETIMEDOUT" ? `timed out after ${TIMEOUT_MS}ms` : res.error.message}`);
  }
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (res.status !== 0) {
    die(
      `pi exited ${res.status ?? `signal ${res.signal}`} for verifier seat "${verifierSeat}"${accountLabelSuffix(entry)} — no verdict. stderr tail:\n` +
        stderr.slice(-2000)
    );
  }

  // --- parse: exactly one VERDICT line, exactly one known value -------------
  const verdictLines = stdout.split("\n").filter((l) => /^VERDICT:/.test(l.trim()));
  if (verdictLines.length === 0) {
    process.stderr.write(`--- verifier output tail ---\n${stdout.slice(-2000)}\n`);
    die(`verifier emitted no VERDICT: line — per the brief that routes to a human, not to a verdict`);
  }
  if (verdictLines.length > 1) {
    die(`verifier emitted ${verdictLines.length} VERDICT: lines — ambiguous, refusing to pick one`);
  }
  // The NOT BENCHED qualifier (VERIFIER.md, "When no bench covers the part
  // you are verifying") belongs to APPROVE and to nothing else.
  const m = verdictLines[0]
    .trim()
    .match(/^VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)\s*(?:[—-]{1,2}\s*NOT BENCHED:\s*(\S.*))?$/);
  if (!m) {
    die(`malformed verdict line: "${verdictLines[0].trim()}" — expected VERDICT: APPROVE [— NOT BENCHED: <gap>] | BOUNCE | DISCOVER`);
  }
  const verdict = m[1];
  const notBenched = m[2]?.trim();
  if (notBenched && verdict !== "APPROVE") {
    die(`malformed verdict line: NOT BENCHED qualifies APPROVE and nothing else, got: "${verdictLines[0].trim()}"`);
  }
  const verdictShown = notBenched ? `${verdict} — NOT BENCHED: ${notBenched}` : verdict;

  // An APPROVE over a missing, empty, or mistyped artifact the bead requires
  // is a defect in the verdict, not a judgment — same family as the NOT
  // BENCHED parser rule: malformed, exit 1, never a clean 0 the dispatcher
  // could merge on. BOUNCE and DISCOVER pass through: a failed floor check
  // is a fine BOUNCE reason, and the record below still carries the checks.
  if (verdict === "APPROVE" && evidenceUnsatisfied.length > 0) { // evidence-gate
    die(
      `verdict APPROVE with unsatisfied evidence — the bead names artifacts that fail the floor at ${tip}:\n` +
        evidenceLines(evidenceUnsatisfied).map((l) => `      ${l}`).join("\n") +
        `\n      An APPROVE cannot stand on evidence that is not there; this is malformed, not a judgment.`
    );
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
    `- verifier-seat: ${verifierSeat} (${verifierDir})`,
    `- at: ${new Date().toISOString()}`,
    `- verdict: ${verdictShown}`,
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
          `(exists, bytes, type probe). The verifier's judgment of the content`,
          `is in its output below.`,
          ``,
          ...evidenceLines(evidence),
        ]
      : []),
    ``,
    `## Verifier output`,
    ``,
    stdout.trimEnd(),
    ``,
  ].join("\n");
  fs.writeFileSync(verdictFile, record); // verdict-write

  console.log(`VERDICT: ${verdictShown}  (bead ${beadId}, tip ${tip.slice(0, 12)}, verifier ${verifierSeat})`);
  console.log(`  full output -> ${verdictFile}`);
  if (evidence.length > 0) {
    console.log(`  evidence: ${evidence.length} named artifact(s) floor-checked at the tip, ${evidenceUnsatisfied.length} unsatisfied`);
  }
  if (verdict === "DISCOVER") {
    console.log(`  DISCOVER files no beads — the proposal waits in the verdict file for the commander.`);
  }
  process.exit(verdict === "APPROVE" ? 0 : verdict === "BOUNCE" ? 2 : 3);
}

main();
