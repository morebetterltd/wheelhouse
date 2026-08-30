#!/usr/bin/env bun
/**
 * verify.ts — commander-facing dispatch of the EPHEMERAL verifier pass.
 *
 * One invocation = one verdict. It spawns a one-shot `pi -p --no-session`
 * on the VERIFIER seat's own agent directory, with contracts/VERIFIER.md
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
 * Usage: bun seats/verify.ts <bead-id> <branch> <author-seat> [verifier-seat]
 *
 * Exit: 0 APPROVE | 2 BOUNCE | 3 DISCOVER | 1 anything else (including a
 * malformed or missing verdict — the machine must never mistake an error
 * for a judgment).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const STATE_FILE = path.join(SEATS_DIR, "state.json");
const VERDICTS_DIR = path.join(SEATS_DIR, "verdicts");
const BRIEF = path.join(ROOT, "contracts", "VERIFIER.md");

// One-shot verification reads a diff and maybe runs a bench; give it room.
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_VERIFY_TIMEOUT_MS || 900000);

function die(msg: string): never {
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(1);
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
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
  account?: { dir: string };
}

function readRoster(): Record<string, SeatEntry> {
  if (!fs.existsSync(ROSTER_FILE)) {
    die(`no ${ROSTER_FILE} — copy seats/seats.json.example to seats/seats.json and edit it`);
  }
  const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
  return raw.seats ?? {};
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
  const [beadId, branch, authorSeat, verifierArg] = process.argv.slice(2);
  if (!beadId || !branch || !authorSeat) {
    die("usage: verify.ts <bead-id> <branch> <author-seat> [verifier-seat]");
  }

  if (!fs.existsSync(BRIEF)) die(`no verifier brief at ${BRIEF}`);

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
  if (!authIsIdentity(path.join(verifierDir, "auth.json"))) {
    die(
      `verifier seat "${verifierSeat}" has no identity — log it in once:\n` +
        `      PI_CODING_AGENT_DIR="${verifierDir}" pi /login`
    );
  }

  // --- the branch must resolve; the verdict is about a SHA, not a name ------
  let tip: string;
  try {
    tip = execFileSync("git", ["rev-parse", "--verify", `${branch}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    die(`branch "${branch}" does not resolve to a commit in ${ROOT} — nothing to verify`);
  }

  // --- the one-shot ---------------------------------------------------------
  const prompt = [
    `You are dispatched as the EPHEMERAL verifier for bead ${beadId}.`,
    ``,
    `Branch under review: ${branch}`,
    `Tip SHA at dispatch: ${tip}`,
    `Author seat: ${authorSeat} (account-distinctness from you was asserted before this spawn)`,
    ``,
    beadClaim(beadId),
    ``,
    `Verify whether the bead's stated done holds at that SHA, per your brief.`,
    `Confirm the branch still resolves to the SHA above before relying on your reading.`,
    `End with exactly one line: VERDICT: APPROVE | BOUNCE | DISCOVER, with your`,
    `evidence above it. If you cannot deliver a verdict, emit no VERDICT: line at all.`,
  ].join("\n");

  const args = ["-p", "--no-session", "--append-system-prompt", BRIEF];
  if (entry.provider) args.push("--provider", entry.provider);
  if (entry.model) args.push("--model", entry.model);
  args.push(prompt);

  const res = spawnSync("pi", args, {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: verifierDir },
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
      `pi exited ${res.status ?? `signal ${res.signal}`} — no verdict. stderr tail:\n` +
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

  // --- record, then report --------------------------------------------------
  fs.mkdirSync(VERDICTS_DIR, { recursive: true });
  const verdictFile = path.join(VERDICTS_DIR, `${beadId}.md`);
  const record = [
    `# Verdict — bead ${beadId}`,
    ``,
    `- bead: ${beadId}`,
    `- branch: ${branch}`,
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
    ``,
    `## Verifier output`,
    ``,
    stdout.trimEnd(),
    ``,
  ].join("\n");
  fs.writeFileSync(verdictFile, record); // verdict-write

  console.log(`VERDICT: ${verdictShown}  (bead ${beadId}, tip ${tip.slice(0, 12)}, verifier ${verifierSeat})`);
  console.log(`  full output -> ${verdictFile}`);
  if (verdict === "DISCOVER") {
    console.log(`  DISCOVER files no beads — the proposal waits in the verdict file for the commander.`);
  }
  process.exit(verdict === "APPROVE" ? 0 : verdict === "BOUNCE" ? 2 : 3);
}

main();
