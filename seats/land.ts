#!/usr/bin/env bun
/**
 * land.ts — turns a reviewed APPROVE into merged, pushed, closed, answered and
 * next-review-dispatched, with no human in between, and refuses loudly otherwise.
 *
 * Usage:
 *   bun seats/land.ts <bead-id>   land one bead
 *   bun seats/land.ts --scan      land every bead whose verdict triggers
 *
 * Exit: 0 the run finished with nothing left to do (landed, already landed and
 * reconciled, or never triggered) | 2 a gate refused, and the reason is on the
 * row | 1 an unexpected error, INCLUDING anything this tool could not evaluate.
 * `verify.ts`'s own exit-code docstring sets the precedent: `0 APPROVE | 2
 * BOUNCE | 3 DISCOVER | 1 anything else including malformed — the machine must never mistake an error
 * for a judgment`. A gate refusal is a judgment about the work; a dependency
 * that returned something unreadable is not a judgment about anybody's branch
 * and must never be rendered as one.
 *
 * WHAT TRIGGERS IT, AND WHY IT IS THE POLL SCRIPT RATHER THAN THE HERALD.
 *
 * `seats/commander-inbox-poll.sh` calls `--scan` on every tick. Two reasons,
 * and the second is the one that decides it:
 *
 *   1. Durability. That script describes itself as "the correctness fallback"
 *      for when the herald's poke is missed, and it re-checks on a cursor
 *      rather than on an event. A merge that is lost to a missed poke is a
 *      branch nobody lands; the fallback path is the one that cannot lose it.
 *   2. The herald must not block. It is a log tailer on a poke budget, and
 *      gate 3 builds a scratch checkout and runs selftests in it. Putting that
 *      inside `classify()` stalls every other seat's wake path behind one
 *      merge.
 *
 * The herald does parse verdicts, but only on its exception path — class
 * `verdict-not-posted`, a verdict that reached final assistant text and never
 * became a bead comment. The AUTHORITATIVE verdict is the bead comment
 * (`contracts/REVIEWER.md`), and the herald never reads those. Hooking it there
 * would key landing off the one verdict shape the contract says does not count.
 *
 * WHAT A VERDICT AUTHORISES. `contracts/INTEGRATOR.md`: an APPROVE is not an
 * approval to push; merge on the VERDICT line, publish only on the PUSH line,
 * and only to the remote that line names. A missing PUSH line is unanswered,
 * "which is neither permission nor refusal", and `NOT CONSIDERED` "is an answer,
 * and it routes back rather than blocking". Neither is a grant and neither is a
 * refusal, so neither is a TRIGGER here: this tool fires only on PUSH APPROVE,
 * and a verdict carrying anything else leaves no row and writes nothing.
 *
 * "only to the remote that line names" is a RESTRICTION on where we may
 * publish. It is not a licence to treat any string in a bead comment as a
 * destination — see `resolvePushDestination()`.
 *
 * PUSH AUTHORITY IS PROSE, NOT A FIELD, AND WE READ IT MORE STRICTLY THAN THE
 * LINT DOES. `grantsPush()` carries the whole argument; read it before changing
 * anything there. In short: same source, same section, the lint's regex kept as
 * a necessary condition, plus a refusal when the matching sentence is a
 * prohibition. This is the one place this tool knowingly differs from
 * `seats/push-authority-lint.sh`, and it only ever refuses more often.
 *
 * NOTHING IS WRITTEN UNTIL EVERY GATE HAS PASSED, and the whole gate-and-write
 * section runs under `seats/land.lock` so two runs cannot both decide to merge.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(process.env.WHEELHOUSE_LAND_ROOT || path.join(import.meta.dir, ".."));
const SEATS_DIR = path.join(ROOT, "seats");
const LOG_DIR = path.join(SEATS_DIR, "logs");
const INBOX = path.join(SEATS_DIR, "inbox.jsonl");
const LOCK_FILE = path.join(SEATS_DIR, "land.lock");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const ADAPTER_STATE_FILE = path.join(SEATS_DIR, "state.json");
const ADAPTER_TS = path.join(SEATS_DIR, "adapter.ts");
const TRUNK = process.env.WHEELHOUSE_LAND_TRUNK || "main";
const BD_TIMEOUT_MS = 30_000;

/**
 * The four from the brief, plus two this tool adds. The additions are named
 * apart because the brief fixed the first four and a reader comparing the two
 * should see immediately which are ours.
 */
type RefusalReason =
  | "stale-tip"
  | "merge-conflict"
  | "selftest-red"
  | "not-in-review"
  // ours:
  | "push-destination" // the verdict names something that is not a configured remote
  | "malformed-verdict" // two verdicts, two push lines, or a line that is not the grammar
  | "sha-named-branch"; // a local branch is named like the object id we are about to publish

type LandClass = "landed" | "land-refused";

interface Verdict {
  approve: boolean;
  pushApprove: boolean;
  pushRemote: string | null;
  pinned: string | null;
  author: string | null;
  text: string;
}

interface Bead {
  id: string;
  title: string;
  status: string;
  labels: string[];
}

function die(msg: string): never {
  process.stderr.write(`STOP: ${msg}\n`);
  process.exit(1);
}

// --- small process helpers --------------------------------------------------

function git(args: string[], opts: { cwd?: string } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) die(`git ${args.join(" ")} could not run: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOrDie(args: string[], opts: { cwd?: string } = {}): string {
  const r = git(args, opts);
  if (r.status !== 0) die(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function bd(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bd", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: BD_TIMEOUT_MS,
  });
  // A bd that could not be spawned, timed out, or died on a signal has told us
  // nothing about the graph. Rendering that as "no comments" or "no labels"
  // turns a broken dependency into a verdict, which is the one thing the exit
  // codes exist to prevent.
  if (r.error) die(`bd ${args.join(" ")} could not run: ${(r.error as any).message ?? r.error}`);
  if (r.signal) die(`bd ${args.join(" ")} was killed by signal ${r.signal}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function have(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [cmd] : ["-v", cmd], {
    encoding: "utf8",
    shell: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (r.status ?? 1) === 0;
}

function parseJsonOrDie(raw: string, what: string): any {
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    die(`${what} returned unparseable JSON (${e.message}) — this tool cannot tell what the graph says, which is an error and not a judgment`);
  }
}

// --- the lock ---------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * One lander at a time. The gates take real time — gate 3 builds a scratch
 * worktree and runs a suite in it — so two runs (the poll tick and a commander
 * running the same command by hand, which the brief keeps supported) can both
 * pass the gates against the same pre-merge state. The second then merges
 * nothing, because git says "Already up to date" and exits 0 with no unmerged
 * paths — the exact shape of this tool's success condition — and goes on to
 * close the bead, comment the issue and dispatch the next review a SECOND time.
 *
 * `wx` is the whole mechanism: create-exclusive is atomic, so exactly one run
 * wins. A lock whose owner is gone is stale and gets taken, because a lander
 * killed mid-run holds nothing.
 */
function acquireLock(): { release: () => void } | null {
  fs.mkdirSync(SEATS_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return {
        release: () => {
          try {
            // Only ever remove OUR lock: a release that runs after a stale-steal
            // would otherwise delete the new owner's.
            if (fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) fs.rmSync(LOCK_FILE, { force: true });
          } catch {
            /* the lock is already gone, which is the state we wanted */
          }
        },
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") die(`could not take ${LOCK_FILE}: ${e.message}`);
      const holder = Number((fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, "utf8") : "").trim());
      if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) return null;
      fs.rmSync(LOCK_FILE, { force: true }); // stale: the owner is gone
    }
  }
  return null;
}

// --- push authority ---------------------------------------------------------

/** The lint's own regex, `seats/push-authority-lint.sh:15`, character for character. */
const LINT_GRANT_RE = /push(es|ing)?[ \t].*(main|origin|remote|repo|repositories)|standing[ \t-]+authori[sz].*push|commander.*pushes/i;

/**
 * A sentence that matches LINT_GRANT_RE while saying the opposite. Deliberately
 * broad: every term here makes this tool refuse to push, and refusing to push
 * costs a human one command while pushing wrongly cannot be undone.
 */
const PROHIBITION_RE =
  /\b(do not|don't|do nót|never|not[ \t]+authoris|not[ \t]+authoriz|unauthoris|unauthoriz|only[ \t]+the[ \t]+principal|principal[ \t-]?only|ask[ \t]+first|ask[ \t]+the[ \t]+principal|reserved|requires[ \t]+approval|must[ \t]+not|may[ \t]+not|cannot|can't|shall[ \t]+not|forbidden|prohibited|withheld|no[ \t]+standing)\b/i;

/**
 * Reads the same source, the same section and the same regex as
 * `seats/push-authority-lint.sh` — and then refuses in one case where that
 * script would not. This is a DELIBERATE DIVERGENCE from an existing repo tool.
 * It is written down here, in `seats/README.md`, and in the handback, because a
 * silent divergence is worse than either behaviour.
 *
 * Why diverge at all. The brief said to read the same SOURCE the lint reads. It
 * did not say to reproduce the regex's defects, and the regex has some.
 * Measured by running it against sentences:
 *
 *   "Do not push main to origin"                  -> GRANTS   (wrong)
 *   "Never push main. Ask the principal."          -> GRANTS   (wrong)
 *   "Only the principal may push main to origin"   -> GRANTS   (wrong)
 *   "Pushing to origin is reserved to the principal." -> GRANTS (wrong)
 *   "push authority is not authorised ... on main" -> GRANTS   (wrong)
 *   "The commander ... pushes main."               -> GRANTS   (right)
 *   "The fleet may publish commits to origin"      -> no grant (a real grant, missed)
 *
 * `push(es|ing)?[ \t].*(main|origin|...)` asks whether the words appear near
 * each other. It cannot see a negation, so every prohibition an install is most
 * likely to write reads as permission.
 *
 * Bug-compatibility would be the right call if the two callers did the same
 * thing with the answer. They do not, and the difference is the whole argument:
 * the lint FLAGS A CONTRADICTION for a human to read, and this tool PUBLISHES
 * IRREVERSIBLY. The same false positive costs a spurious warning there and an
 * unauthorised push here.
 *
 * So the divergence runs one way only:
 *   - The lint's regex stays a NECESSARY condition. Where it finds no grant,
 *     neither do we — we never publish somewhere the lint would not.
 *   - Where it matches, we additionally refuse if that same sentence carries a
 *     negation or a reservation.
 *   - Ambiguity — any matching sentence that is a prohibition — refuses, even
 *     if another sentence reads as a clean grant. An install whose authority
 *     section contradicts itself has not recorded its authority.
 *   - We do NOT newly grant where the lint does not. The "publish commits"
 *     miss above stays missed. Widening a grant is the dangerous direction, and
 *     under-granting costs a human one push.
 *
 * Fixing `push-authority-lint.sh` itself is out of scope here: it is an
 * existing contract surface with its own selftest, and changing the repo's
 * tools was not what this asked for. Its defect is reported instead.
 */
function grantsPush(): { granted: boolean; why: string } {
  let integrator = path.join(ROOT, "wheelhouse", "INTEGRATOR.md");
  if (!fs.existsSync(integrator)) integrator = path.join(ROOT, "contracts", "INTEGRATOR.md");
  if (!fs.existsSync(integrator)) {
    return { granted: false, why: "no wheelhouse/INTEGRATOR.md or contracts/INTEGRATOR.md — absent authority is not a grant" };
  }
  const lines = fs.readFileSync(integrator, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l === "## This project");
  if (start < 0) return { granted: false, why: `${path.relative(ROOT, integrator)} has no "## This project" section` };

  const matching = lines.slice(start + 1).filter((l) => LINT_GRANT_RE.test(l));
  if (matching.length === 0) {
    return { granted: false, why: `no sentence under "## This project" in ${path.relative(ROOT, integrator)} records a push grant` };
  }
  const prohibition = matching.find((l) => PROHIBITION_RE.test(l));
  if (prohibition) {
    return {
      granted: false,
      why:
        `the push-authority sentence in ${path.relative(ROOT, integrator)} reads as a prohibition, not a grant: ` +
        `"${prohibition.trim().slice(0, 160)}" (seats/push-authority-lint.sh's regex matches it as a grant; this tool ` +
        `refuses because it publishes on the answer and that script only warns on it)`,
    };
  }
  return { granted: true, why: `"${matching[0].trim().slice(0, 160)}"` };
}

// --- the push destination ---------------------------------------------------

/**
 * `pushRemote` is the first token after `PUSH: APPROVE` in a BEAD COMMENT — text
 * written by a reviewer seat, into a graph anything with the bd binary can
 * write to. Spawning git through argv stops shell injection and stops nothing
 * else: `git push https://elsewhere.example/x.git main` is a perfectly
 * well-formed command that publishes this repository's history to a stranger.
 *
 * INTEGRATOR.md's "only to the remote that line names" limits where we may
 * publish; it does not promise the string is a place we should publish to. So
 * the name must resolve to a remote THIS INSTALL has configured. A URL, a path,
 * an option-shaped token, or a name nobody configured is a refusal — the
 * install's own remote list is the authority on where it publishes, not a
 * sentence in a comment.
 */
function resolvePushDestination(named: string): { ok: true; remote: string } | { ok: false; why: string } {
  if (named.startsWith("-")) return { ok: false, why: `"${named}" is option-shaped, not a remote name` };
  if (/[:/\\]/.test(named)) return { ok: false, why: `"${named}" looks like a URL or path, not a configured remote name` };
  if (!/^[A-Za-z0-9._-]+$/.test(named)) return { ok: false, why: `"${named}" is not a well-formed remote name` };
  const configured = gitOrDie(["remote"]).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!configured.includes(named)) {
    return { ok: false, why: `"${named}" is not a remote configured in this install (has: ${configured.join(", ") || "none"})` };
  }
  return { ok: true, remote: named };
}

// --- verdict reading --------------------------------------------------------

interface RawComment {
  text: string;
  author: string | null;
}

/**
 * bd's comment rows, as text plus whatever names the author. `--json` shape is
 * read defensively because this tool has never been run against a real bd
 * (it is not installed on the machine this was written on) — but "unparseable"
 * is an error, never an empty list: an empty list reads as "no verdict", which
 * is a judgment we would have no basis for.
 */
function readComments(beadId: string): RawComment[] {
  const r = bd(["comments", beadId, "--json"]);
  if (r.status !== 0) die(`bd comments ${beadId} --json failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  const parsed = parseJsonOrDie(r.stdout, `bd comments ${beadId} --json`);
  const rows: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.comments) ? parsed.comments : [];
  return rows
    .map((row) => {
      if (typeof row === "string") return { text: row, author: null };
      let text = "";
      for (const key of ["text", "body", "comment", "content", "message"]) {
        if (typeof row?.[key] === "string") {
          text = row[key];
          break;
        }
      }
      let author: string | null = null;
      // The field bd puts BEADS_ACTOR into. contracts/GRAPH.md:11 says every
      // seat's process carries BEADS_ACTOR=<seat name> so "the bead's comment
      // author field says which seat spoke", but does not name the field, and
      // bd is not installed here to ask. See requireReviewerAuthored().
      for (const key of ["author", "actor", "author_name", "authorName", "created_by", "createdBy", "user"]) {
        const v = row?.[key];
        if (typeof v === "string" && v.trim()) {
          author = v.trim();
          break;
        }
        if (v && typeof v === "object" && typeof v.name === "string" && v.name.trim()) {
          author = v.name.trim();
          break;
        }
      }
      return { text, author };
    })
    .filter((c) => c.text.length > 0);
}

/**
 * One comment, parsed strictly. `contracts/REVIEWER.md` prescribes ONE verdict,
 * "exclusively", and `push-authority-lint.sh` already fails a VERDICT FILE that
 * does not carry exactly one `^PUSH:` line. That lint reads verdict files
 * written by verify.ts; this reads a bead comment, which is why ZERO push lines
 * is handled differently here (see below) and more than one is not. A comment carrying two of either is
 * not a verdict this tool may act on: taking the first and ignoring the rest is
 * how "VERDICT: APPROVE" followed by "VERDICT: BOUNCE" becomes an approval.
 *
 * The pinned SHA binds to the VERDICT line, not to free text anywhere in the
 * comment — a quoted example or a reviewer's prose about some other commit is
 * not this verdict's subject.
 */
/**
 * The lines of a comment that are SPEAKING, not quoting.
 *
 * `verify.ts`'s `liveLineCandidates` does exactly this and for the same reason:
 * "A VERDICT quoted inside a triple-backtick Markdown fence is evidence text."
 * `contracts/REVIEWER.md` prints the grammar inside fences, so a reviewer who
 * quotes the format they are following — or pastes a previous round's verdict
 * as context — would otherwise trip the duplicate-line refusal below. Leading
 * blockquote markers are stripped the same way, so a quoted `> VERDICT:` is
 * also not a second verdict.
 */
function liveLines(text: string, tag: "VERDICT" | "PUSH"): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const normalized = trimmed.replace(/^(>\s*)+/, "").trim();
    if (new RegExp(`^${tag}\\s*:`, "i").test(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * The grammar, as `contracts/REVIEWER.md` now states it — the annotation forms
 * `APPROVE [— <annotation>]`, `BOUNCE [— <annotation>]`, `DISCOVER
 * [— <annotation>]` on VERDICT, and `[<annotation>]` on each PUSH answer,
 * arrived upstream after the first version of this parser was written.
 *
 * Matching the KEYWORD POSITION rather than searching the line is the whole
 * point, and it is how `verify.ts` reads it too
 * (`^VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)(?:\s+(.*))?$`). The previous version
 * asked whether the words BOUNCE or DISCOVER appeared anywhere on the VERDICT
 * line, and whether HOLD or NOT CONSIDERED appeared anywhere on the PUSH line,
 * to catch a self-contradicting verdict. Under a grammar where the annotation
 * is free text that is a false refusal waiting to happen:
 * `VERDICT: APPROVE — the earlier BOUNCE is addressed` is a perfectly ordinary
 * approval, and so is
 * `PUSH: APPROVE origin — verified: base..tip is one commit; the earlier HOLD is resolved`.
 * The keyword after the colon is the answer; everything after the separator is
 * prose that this tool does not read.
 *
 * ONE DELIBERATE STRICTNESS over `verify.ts`: the annotation must be introduced
 * by the dash the grammar prints (`— ` or `- `). verify.ts accepts any
 * whitespace-separated remainder, which reads `VERDICT: APPROVE BOUNCE` as
 * APPROVE annotated "BOUNCE". Requiring the separator keeps that a refusal.
 * Same asymmetry as everywhere else here: verify.ts RECORDS a verdict, this
 * tool MERGES AND PUBLISHES on one, and the cost of refusing a reviewer who
 * omitted a dash is that a human lands it by hand.
 */
const VERDICT_LINE_RE = /^VERDICT\s*:\s*(APPROVE|BOUNCE|DISCOVER)(?:\s*[—–-]{1,2}\s*(\S.*))?\s*$/i;
const PUSH_LINE_RE = /^PUSH\s*:\s*(?:(APPROVE)\s+(\S+)\s+[—–-]{1,2}\s+verified:\s*\S.*|(HOLD)\s+[—–-]{1,2}\s+\S.*|(NOT CONSIDERED)(?:\s+\S.*)?)\s*$/i;

function parseVerdict(c: RawComment): { ok: true; verdict: Verdict } | { ok: false; why: string } {
  const verdictLines = liveLines(c.text, "VERDICT");
  const pushLines = liveLines(c.text, "PUSH");
  if (verdictLines.length !== 1) return { ok: false, why: `the comment carries ${verdictLines.length} VERDICT: lines; REVIEWER.md prescribes exactly one` };
  // MORE than one push answer is malformed — a comment that decided twice
  // decided nothing, and first-match-wins is how a later HOLD becomes an
  // approval. ZERO is a different thing entirely and must not be folded in
  // with it: contracts/INTEGRATOR.md:48 says a missing PUSH line "is
  // unanswered, which is neither permission nor refusal. Go and ask." That is
  // a documented, expected state, so it falls through with pushApprove false
  // and becomes a non-trigger — no row, no writes — exactly as
  // `PUSH: NOT CONSIDERED` does. Refusing it would report a decision about the
  // branch that nobody made, on a verdict whose author simply had no view on
  // publishing.
  if (pushLines.length > 1) return { ok: false, why: `the comment carries ${pushLines.length} PUSH: lines; REVIEWER.md requires exactly one` };

  const verdictLine = verdictLines[0];
  const pushLine = pushLines[0] ?? ""; // absent is legitimate; see above

  const vMatch = verdictLine.match(VERDICT_LINE_RE);
  if (!vMatch) {
    return { ok: false, why: `the VERDICT line does not match REVIEWER.md's grammar (APPROVE|BOUNCE|DISCOVER, optionally "— <annotation>"): "${verdictLine.slice(0, 160)}"` };
  }
  const approve = vMatch[1].toUpperCase() === "APPROVE";

  let pushApprove = false;
  let pushRemote: string | null = null;
  if (pushLine) {
    const pMatch = pushLine.match(PUSH_LINE_RE);
    if (!pMatch) {
      return { ok: false, why: `the PUSH line does not match REVIEWER.md's grammar (APPROVE <remote> — verified: <what> | HOLD — <why> | NOT CONSIDERED): "${pushLine.slice(0, 160)}"` };
    }
    if (pMatch[1]) {
      pushApprove = true;
      pushRemote = pMatch[2];
    }
  }

  // Bound to the VERDICT line, never to free text elsewhere in the comment: a
  // quoted example or a reviewer's prose about some other commit is not this
  // verdict's subject.
  const pinned = verdictLine.match(/\bat pinned(?:\s+tip)?\s+([0-9a-f]{7,40})\b/i)?.[1] ?? null;
  return { ok: true, verdict: { approve, pushApprove, pushRemote, pinned, author: c.author, text: c.text } };
}

/** The LATEST comment carrying a VERDICT line. Earlier rounds are history. */
function latestVerdictComment(beadId: string): RawComment | null {
  const comments = readComments(beadId);
  for (let i = comments.length - 1; i >= 0; i--) {
    // Selected on LIVE lines, the same reading parseVerdict uses. Selecting on
    // a raw match would pick a comment whose only VERDICT: sits inside a quoted
    // example, and then refuse it as malformed for having no verdict line.
    if (liveLines(comments[i].text, "VERDICT").length > 0) return comments[i];
  }
  return null;
}

function readBead(beadId: string): Bead {
  const r = bd(["show", beadId, "--json"]);
  if (r.status !== 0) die(`bd show ${beadId} --json failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  const parsed = parseJsonOrDie(r.stdout, `bd show ${beadId} --json`);
  const rec = Array.isArray(parsed) ? parsed[0] : (parsed?.issue ?? parsed?.bead ?? parsed);
  // A record with no status field at all has not told us the bead is out of the
  // review queue; it has told us we cannot read the bead. Gate 4 would render
  // that as `not-in-review`, which is a judgment about the work.
  if (typeof rec?.status !== "string") die(`bd show ${beadId} --json returned no status field — this tool cannot evaluate gate 4 against it`);
  if (rec.labels !== undefined && !Array.isArray(rec.labels)) die(`bd show ${beadId} --json returned a non-array labels field — this tool cannot evaluate gate 4 against it`);
  const labels = Array.isArray(rec.labels)
    ? rec.labels.map((l: any) => (typeof l === "string" ? l : String(l?.name ?? ""))).filter(Boolean)
    : [];
  return { id: String(rec?.id ?? beadId), title: typeof rec?.title === "string" ? rec.title : "", status: rec.status, labels };
}

/** Roster seats holding a role, excluding external and shadow seats. */
function seatsWithRole(...roles: string[]): string[] {
  if (!fs.existsSync(ROSTER_FILE)) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
  } catch {
    return [];
  }
  return Object.entries(parsed?.seats ?? {})
    .filter(([, e]: [string, any]) => roles.includes(e?.role) && !e?.external && !e?.shadow)
    .map(([name]) => name);
}

/**
 * The brief's trigger is "a reviewer/verifier settle whose latest verdict is
 * APPROVE" — the AUTHOR is part of the trigger, not decoration. Without this a
 * comment is a comment: a worker seat holding the bd binary can post
 * `VERDICT: APPROVE` / `PUSH: APPROVE origin` on its own bead and this tool
 * merges and publishes its own author's work. `contracts/REVIEWER.md` exists
 * because a verdict from the author's own account is not a verdict, and
 * `verify.ts`'s distinctness gate refuses that case loudly before it spawns.
 *
 * `contracts/GRAPH.md:11` is what makes this checkable: every seat's process
 * carries `BEADS_ACTOR=<seat name>`, so the comment records which seat spoke.
 *
 * WHAT IS UNSPECIFIED HERE, said plainly: the beads vendor's own published JSON
 * Output Schema Contract (https://beads.gascity.com/reference/json-schema.md,
 * read 2026-09-16) specifies `bd list`, `bd ready`, `bd blocked`, `bd show`,
 * `import` and `export`, and does NOT specify the comment object's fields at
 * all — zero occurrences of "author" on that page, with "comment" present on it
 * as a positive control. GRAPH.md does not name the field either, and bd is not
 * installed on the machine this was written on. So this is a documented absence,
 * not an unasked question: the candidate names in `readComments()` cover the
 * plausible spellings, and the failure is deliberately LOUD rather than
 * permissive — a comment with no recognisable author field exits 1 and lands
 * nothing, because a security gate that cannot read its input must not conclude
 * the input was fine. If your bd names the field something else, add it to that
 * list; the symptom will be this exact STOP, not a silent bypass.
 */
function requireReviewerAuthored(beadId: string, verdict: Verdict): void {
  const reviewers = seatsWithRole("reviewer", "verifier");
  if (reviewers.length === 0) {
    die(
      `${beadId}'s verdict triggers a land but seats/seats.json lists no reviewer or verifier seat, ` +
        `so this tool cannot tell an approval from a seat entitled to give one. Nothing was landed.`,
    );
  }
  if (!verdict.author) {
    die(
      `${beadId}'s latest verdict comment carries no author field this tool recognises, so it cannot check that a ` +
        `reviewer or verifier wrote it — and an approval whose author cannot be established is not an approval. ` +
        `contracts/GRAPH.md:11 says BEADS_ACTOR records the authoring seat; add your bd's field name to the ` +
        `candidate list in readComments() and re-run. Nothing was landed.`,
    );
  }
  if (!reviewers.includes(verdict.author)) {
    die(
      `${beadId}'s latest verdict was written by "${verdict.author}", which is not a reviewer or verifier seat ` +
        `(roster has: ${reviewers.join(", ")}). contracts/REVIEWER.md: a verdict from the author's own account is ` +
        `not a verdict. Nothing was landed.`,
    );
  }
}

// --- the herald row ---------------------------------------------------------

/**
 * herald.ts has no exports, so there is no writer to import; this appends a row
 * of the identical shape its own `appendInbox({ ... })` call site builds,
 * through the identical two calls `appendInbox()` makes (mkdirSync, then
 * appendFileSync of one JSON line). `state: "terminal"` for both classes — landed or
 * refused, the work has settled and nobody is being asked for input.
 */
function appendRow(eventClass: LandClass, beadId: string, title: string, detail: string): void {
  const id = crypto.createHash("sha256").update(`seats/land.ts\0${beadId}\0${eventClass}\0${detail}`).digest("hex");
  fs.mkdirSync(SEATS_DIR, { recursive: true });
  fs.appendFileSync(
    INBOX,
    JSON.stringify({
      id,
      at: new Date().toISOString(),
      seat: "land",
      class: eventClass,
      state: "terminal",
      title,
      detail,
      source: { log: "seats/land.ts", offset: 0, type: "land" },
    }) + "\n",
  );
}

class Refusal extends Error {
  constructor(readonly reason: RefusalReason, readonly detail: string) {
    super(`${reason}: ${detail}`);
  }
}

function refuse(reason: RefusalReason, detail: string): never {
  throw new Refusal(reason, detail);
}

// --- gate 3's scratch checkout ----------------------------------------------

/**
 * Reclaims scratch worktrees a killed run left behind, on `verify.ts`'s
 * reasoning: ask git which worktrees belong to THIS repository rather than
 * globbing a machine-wide tmp, and act only on a stamped pid that is gone. This
 * sweep removes a directory and a registration and never touches a process, so
 * a reused pid costs a sweep one run late, never a worktree pulled out from
 * under a live run.
 */
function sweepStaleScratch(): void {
  const listing = git(["worktree", "list", "--porcelain"]);
  if (listing.status !== 0) return;
  for (const line of listing.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length);
    const m = path.basename(p).match(/^wheelhouse-land-(\d+)-/);
    if (!m) continue;
    if (pidAlive(Number(m[1]))) continue;
    git(["worktree", "remove", "--force", p]);
  }
}

/** The sibling selftests the branch's own changes call for, by NAME only. */
function selftestNamesForBranch(tipSha: string, mergeBase: string): string[] {
  const touched = gitOrDie(["diff", "--name-only", `${mergeBase}..${tipSha}`]).split("\n").filter(Boolean);
  const wanted = new Set<string>();
  for (const file of touched) {
    if (!file.startsWith("seats/")) continue;
    if (file.endsWith(".selftest.sh")) {
      wanted.add(file);
      continue;
    }
    wanted.add(`seats/${path.basename(file).replace(/\.[^.]+$/, "")}.selftest.sh`);
  }
  return Array.from(wanted).sort();
}

/**
 * Builds the would-be merge in a scratch worktree, then discovers and runs the
 * selftests THERE.
 *
 * Existence is decided on the MERGED TREE, not on the branch. An earlier
 * version filtered by `git ls-tree <branch>` under a comment claiming it read
 * the merge, which is the defect this repo's contracts are most explicit about
 * — code asserting a mechanism it does not have. It also left a real hole: when
 * the trunk ADDS `seats/x.selftest.sh` after the branch forks and the branch
 * changes `seats/x.ts`, the selftest exists on the merge, is exactly the one
 * that would catch the integration, and was filtered out for not existing on
 * the branch.
 *
 * Never the live checkout: `contracts/INTEGRATOR.md` forbids pointing anyone at
 * a working tree they did not create, and a gate that dirties the tree it is
 * gating has already changed the thing it was asked to judge.
 */
function runSelftestsOnMerge(
  tipSha: string,
  trunkSha: string,
  wanted: string[],
): { failed: string | null; output: string; ran: string[] } {
  if (wanted.length === 0) return { failed: null, output: "", ran: [] };
  sweepStaleScratch();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `wheelhouse-land-${process.pid}-`));
  fs.rmdirSync(scratch); // git worktree add wants to create it
  const added = git(["worktree", "add", "--detach", scratch, trunkSha]);
  if (added.status !== 0) die(`could not create a scratch worktree at ${scratch}: ${(added.stderr || added.stdout).trim()}`);
  try {
    const merged = git(["merge", "--no-ff", "-m", "land gate probe", tipSha], { cwd: scratch });
    if (merged.status !== 0) {
      die(`the gate-3 probe merge failed in ${scratch} after merge-tree reported no conflict: ${(merged.stderr || merged.stdout).trim()}`);
    }
    const present = wanted.filter((rel) => fs.existsSync(path.join(scratch, rel)));
    for (const rel of present) {
      const r = spawnSync("bash", [rel], { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      // A selftest that could not be spawned, or died on a signal, has not
      // failed — we failed to run it. Calling that `selftest-red` would render
      // our own breakage as a verdict on someone's branch.
      if (r.error) die(`could not run ${rel} in the gate-3 scratch checkout: ${(r.error as any).message ?? r.error}`);
      if (r.signal) die(`${rel} was killed by signal ${r.signal} in the gate-3 scratch checkout — that is not a red selftest, it is an unfinished one`);
      if ((r.status ?? 1) !== 0) return { failed: rel, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 600), ran: present };
    }
    return { failed: null, output: "", ran: present };
  } finally {
    git(["worktree", "remove", "--force", scratch]);
  }
}

// --- the next review --------------------------------------------------------

function lastLogEvent(seat: string): string {
  const log = path.join(LOG_DIR, `${seat}.jsonl`);
  if (!fs.existsSync(log)) return "";
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (typeof obj?.type === "string") return obj.type;
    } catch {
      /* skip */
    }
  }
  return "";
}

/** adapter.ts's `agentSettledEvent()`, reimplemented — adapter.ts exports nothing. */
function settled(ev: string): boolean {
  return ev === "agent_end" || ev === "turn_end" || ev === "agent_settled";
}

/** What the adapter last dispatched to a seat — herald's `adapterSeatState()` reads the same file. */
function seatLastBead(seat: string): string | null {
  if (!fs.existsSync(ADAPTER_STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(ADAPTER_STATE_FILE, "utf8"));
    const v = parsed?.seats?.[seat]?.lastBead;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The one non-shadow reviewer seat, or null. Ambiguity skips the dispatch with
 * a note rather than picking: `verify.ts` refuses to guess between verifier
 * seats, and a dispatch is a write.
 */
function soleReviewerSeat(): string | null {
  const reviewers = seatsWithRole("reviewer");
  return reviewers.length === 1 ? reviewers[0] : null;
}

/**
 * The oldest OTHER bead in the review queue. "Oldest" is bd's own created
 * timestamp where it reports one, and bd's list order otherwise — named as an
 * assumption because this build of bd could not be asked (it is not installed
 * on the machine this was written on).
 */
function oldestOtherNeedsReview(exclude: string): string | null {
  const r = bd(["list", "--status", "in_progress", "--label", "needs-review", "--limit", "0", "--json"]);
  if (r.status !== 0) return null;
  const parsed = parseJsonOrDie(r.stdout, "bd list --status in_progress --label needs-review --json");
  const rows: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.issues) ? parsed.issues : [];
  const others = rows
    .map((row, i) => ({ id: String(row?.id ?? ""), when: String(row?.created_at ?? row?.created ?? row?.createdAt ?? ""), i }))
    .filter((row) => row.id && row.id !== exclude);
  if (others.length === 0) return null;
  others.sort((a, b) => (a.when && b.when ? a.when.localeCompare(b.when) : a.i - b.i));
  return others[0].id;
}

// --- the duties after the merge ---------------------------------------------

/**
 * Everything that follows a merge, each step checking its own observable state
 * before doing anything.
 *
 * Shared between the fresh path and the reconcile path on purpose. Ancestry
 * proves ONE thing — the merge commit exists — and an earlier version returned
 * 0 on it as though every later duty had also happened. A run that died after
 * merging left the push, the label, the close, the issue, the dispatch and the
 * row all undone, and every rerun forever after reported "already landed;
 * nothing to do". Reconciling is not a new subsystem: it is each duty asking
 * what it can see before deciding to skip.
 */
function finishLanding(args: {
  beadId: string;
  bead: Bead;
  verdict: Verdict;
  mergeSha: string;
  message: string;
  notes: string[];
  reconciling: boolean;
}): number {
  const { beadId, bead, verdict, mergeSha, message, notes, reconciling } = args;
  // Which duties actually did something this run. Only used to keep a
  // no-op reconcile from writing a row; every skip above says so in `notes`.
  const wrote = { any: false };

  // --- push -----------------------------------------------------------------
  // A push that was authorised, attempted and REJECTED is a failure, not a
  // skip. The two are held apart because the brief permits exactly two skips —
  // no recorded grant, and no `gh` — and neither of those means anything broke.
  let pushFailed = false;
  const grant = grantsPush();
  if (!grant.granted) {
    notes.push(`not pushed (authorised skip): ${grant.why}`);
  } else {
    const dest = resolvePushDestination(verdict.pushRemote!);
    if (!dest.ok) {
      // Unreachable on the fresh path — the gate below refuses first — but the
      // reconcile path re-reads the verdict, so it is checked here too.
      pushFailed = true;
      notes.push(`NOT pushed: ${dest.why}`);
    } else {
      // runbooks/RUNNING_THE_LOOP.md, "When publishing a reviewed tip by object
      // id": a bare 40-hex token is ambiguous to Git, which will resolve a
      // same-named ref ahead of the object. `^{commit}` forces the object
      // reading, and a local branch named like the id we are about to publish
      // is "a cleanup defect, not something to publish around" — so it refuses
      // BEFORE the push rather than publishing whatever that branch points at.
      // A refusal and not a note: which commit reaches the remote is exactly
      // the question, and guessing it is the failure being prevented.
      if (git(["show-ref", "--verify", "--quiet", `refs/heads/${mergeSha}`]).status === 0) {
        refuse("sha-named-branch", `a local branch is named ${mergeSha}, the object id this would publish; Git would resolve the ref, not the commit. Delete the branch — a SHA-named branch is a cleanup defect, not something to publish around.`);
      }
      const pushed = git(["push", dest.remote, `${mergeSha}^{commit}:refs/heads/${TRUNK}`]);
      if (pushed.status === 0) notes.push(`pushed ${TRUNK} to ${dest.remote}`);
      else {
        pushFailed = true;
        notes.push(`NOT pushed: git push ${dest.remote} ${TRUNK} failed: ${(pushed.stderr || pushed.stdout).trim().slice(0, 300)}`);
      }
    }
  }

  // A merge that did not reach the remote it was authorised to reach has not
  // finished landing. Stop before the steps that TELL THE WORLD it shipped:
  // closing the bead ends the review, and commenting "Fixed by <sha>" on a
  // GitHub issue names a commit nobody outside this machine can fetch. The
  // merge is local and real, so the row says so and the next tick retries —
  // the reconcile path above is what makes a transient push failure heal.
  if (pushFailed) {
    notes.push(`bead NOT closed and no issue answered: the merge is local only until the push succeeds`);
    // The same de-dup the successful path uses at the end of this function. A
    // remote that stays unreachable is retried on every poll tick, and without
    // this each tick appends another NOT PUBLISHED row to a durable inbox
    // forever. The first tick to fail says it; the rest are the same fact.
    // (`wrote.any` is always false here — the push runs before any write — so
    // this suppresses on every reconcile and never on the first failure.)
    if (!(reconciling && !wrote.any)) {
      appendRow("landed", beadId, `landed ${beadId} as ${mergeSha.slice(0, 12)} — NOT PUBLISHED`, notes.join("; "));
    }
    process.stderr.write(`STOP: ${beadId} merged as ${mergeSha} but the push failed; nothing downstream was told it shipped. ${notes.join("; ")}\n`);
    return 1;
  }

  // --- the bead -------------------------------------------------------------
  // contracts/GRAPH.md:56 has the commander/integrator drop needs-review "in the
  // same breath as closing after review and merge", because a closed bead still
  // carrying it reads as in-flight to every seat.
  //
  // The label comes off BEFORE the close, and a failed close puts it back. The
  // two orderings leave different wreckage when half of it fails, and only one
  // is caught: seats/intent-check.sh fails a bead closed while still labelled,
  // which is exactly what closing first and then failing to drop would leave.
  //
  // `--remove-label` is documented in the beads vendor CLI reference for
  // `bd update` (with --add-label and --set-labels) and is NOT inferred from
  // --add-label's spelling. It is also not a measurement: that page carries no
  // version, contracts/GRAPH.md stamps this install against bd 1.2.2, and bd was
  // not installed where this was written. Vendor-documented, build unconfirmed —
  // which is why a non-zero exit is a note rather than a failure. The merge has
  // already happened and an unconfirmed flag must not be able to undo it.
  let dropped = { status: 0 };
  if (!bead.labels.includes("needs-review")) {
    notes.push(reconciling ? "needs-review was already off the bead" : "needs-review was not on the bead");
  } else {
    wrote.any = true;
    dropped = bd(["update", beadId, "--remove-label", "needs-review"]);
    if (dropped.status !== 0) {
      notes.push(`needs-review NOT dropped: bd update ${beadId} --remove-label needs-review exited ${dropped.status} — drop it by hand and check the flag against your bd build`);
    }
  }

  if (bead.status === "closed") {
    notes.push(`${beadId} was already closed`);
  } else {
    wrote.any = true;
    const closed = bd(["close", beadId, "--reason", `landed as ${mergeSha} on ${TRUNK} (reviewed ${verdict.pinned}, APPROVE)`]);
    if (closed.status !== 0) {
      const restored = dropped.status === 0 && bead.labels.includes("needs-review") ? bd(["update", beadId, "--add-label", "needs-review"]) : null;
      die(
        `merged as ${mergeSha} but bd close ${beadId} failed: ${(closed.stderr || closed.stdout).trim()}. ` +
          (restored === null
            ? "The needs-review label was never dropped."
            : restored.status === 0
              ? "The needs-review label was put back, so the bead is still in the review queue."
              : "The needs-review label was dropped and could NOT be put back — restore it by hand."),
      );
    }
    notes.push(dropped.status === 0 ? `closed ${beadId} with the merge SHA and dropped needs-review` : `closed ${beadId} with the merge SHA, needs-review still on it`);
  }

  // --- the GitHub issue -----------------------------------------------------
  const ghLabel = bead.labels.find((l) => /^gh-\d+$/.test(l));
  if (!ghLabel) {
    notes.push("no gh-<N> label, so no issue was answered");
  } else if (!have("gh")) {
    notes.push(`gh is not on PATH (authorised skip), so issue ${ghLabel.slice(3)} was not answered — comment and close it by hand`);
  } else {
    const issue = ghLabel.slice(3);
    const view = spawnSync("gh", ["issue", "view", issue, "--json", "state"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if ((view.status ?? 1) === 0 && /"state"\s*:\s*"CLOSED"/i.test(view.stdout ?? "")) {
      notes.push(`issue ${issue} was already closed`);
    } else {
      wrote.any = true;
      const body = `Fixed by ${mergeSha} on ${TRUNK} (${message}).`;
      const commented = spawnSync("gh", ["issue", "comment", issue, "--body", body], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const closedIssue =
        (commented.status ?? 1) === 0 ? spawnSync("gh", ["issue", "close", issue], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) : null;
      if ((commented.status ?? 1) === 0 && (closedIssue?.status ?? 1) === 0) notes.push(`commented ${mergeSha.slice(0, 12)} on issue ${issue} and closed it`);
      else notes.push(`issue ${issue} was not fully answered: gh exited ${commented.status ?? "?"}/${closedIssue?.status ?? "-"}`);
    }
  }

  // --- the next review ------------------------------------------------------
  const next = oldestOtherNeedsReview(beadId);
  const seat = soleReviewerSeat();
  if (!next) {
    notes.push("no other bead is waiting in the review queue, so nothing was dispatched");
  } else if (!seat) {
    notes.push(`${next} is waiting but the roster has no single non-shadow reviewer seat, so it was not dispatched`);
  } else if (seatLastBead(seat) === next) {
    // The adapter records what it last dispatched. Re-sending on a reconcile
    // would interrupt a review already running on that very bead.
    notes.push(`${next} was already dispatched to ${seat}`);
  } else if (!settled(lastLogEvent(seat))) {
    notes.push(`${next} is waiting but seat "${seat}" is mid-turn (last log event "${lastLogEvent(seat) || "none"}"), so it was not dispatched`);
  } else {
    const text = `Review ${next}. Its branch is fleet/${next}. Post the verdict as a bead comment in the format contracts/REVIEWER.md prescribes: a VERDICT line and a PUSH line.`;
    wrote.any = true;
    const sent = spawnSync("bun", [ADAPTER_TS, "dispatch", seat, next, text], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if ((sent.status ?? 1) === 0) notes.push(`dispatched ${next} to ${seat}`);
    else notes.push(`${next} was not dispatched: adapter.ts dispatch exited ${sent.status} (${(sent.stderr || sent.stdout).trim().slice(0, 200)})`);
  }

  // A reconcile that found every duty already done is a second run, and "a
  // second run never merges or posts twice" covers the row as much as the
  // close: an inbox row per poll tick, forever, for work that landed once.
  // Only a run that actually changed something says so.
  if (reconciling && !wrote.any) {
    process.stdout.write(`land: ${beadId} already landed as ${mergeSha.slice(0, 12)} and every duty was already done; nothing to do\n`);
    return 0;
  }

  appendRow("landed", beadId, `landed ${beadId} as ${mergeSha.slice(0, 12)}`, notes.join("; "));
  process.stdout.write(`land: ${beadId} — ${notes.join("; ")}\n`);
  return 0;
}

/** The merge commit that brought `tipSha` into the trunk, or null. */
function mergeCommitFor(tipSha: string): string | null {
  const r = git(["rev-list", "--ancestry-path", "--merges", `${tipSha}..${TRUNK}`]);
  if (r.status !== 0) return null;
  const candidates = r.stdout.split("\n").filter(Boolean);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parents = git(["rev-list", "--parents", "-n", "1", candidates[i]]).stdout.trim().split(/\s+/).slice(1);
    if (parents.includes(tipSha)) return candidates[i];
  }
  return null;
}

// --- the landing sequence ---------------------------------------------------

function landOne(beadId: string): number {
  const branch = `fleet/${beadId}`;

  const comment = latestVerdictComment(beadId);
  if (!comment) {
    process.stdout.write(`land: ${beadId} not triggered — no comment carries a VERDICT line\n`);
    return 0;
  }
  const parsed = parseVerdict(comment);
  if (!parsed.ok) {
    // A malformed verdict is not "no verdict". Someone posted something that
    // reads like a decision and this tool will not guess which one it was.
    refuse("malformed-verdict", `${parsed.why}. contracts/REVIEWER.md prescribes one verdict, exclusively.`);
  }
  const verdict = parsed.verdict;
  if (!verdict.approve || !verdict.pushApprove) {
    // Not a trigger. A missing or NOT CONSIDERED PUSH line is unanswered, and
    // an unanswered question is not a refusal to record.
    process.stdout.write(`land: ${beadId} not triggered — the latest verdict is not APPROVE with PUSH: APPROVE\n`);
    return 0;
  }
  requireReviewerAuthored(beadId, verdict);
  if (!verdict.pinned) {
    die(
      `${beadId}'s VERDICT line says APPROVE with PUSH APPROVE but names no reviewed SHA ("at pinned <sha>"), ` +
        `so the stale-tip gate cannot be run. A malformed verdict is an error, not a judgment.`,
    );
  }

  // --- refs are pinned ONCE, here, and every later step uses these ids -------
  // Resolving `fleet/<id>` by NAME again after gate 1 is a gate-1 bypass: a
  // worker appending a commit while gate 3 runs its suite would have the live
  // merge take the new tip, and contracts/REVIEWER.md:29 is explicit that the
  // integrator "refuses any tip other than the verdict's pinned SHA". The same
  // applies to the trunk: gate 3 tests main-as-it-was, so merging a main that
  // has moved since would ship an untested combination.
  const tipResolved = git(["rev-parse", `${branch}^{commit}`]);
  if (tipResolved.status !== 0) die(`${beadId}'s verdict triggers a land but ${branch} does not exist in ${ROOT}`);
  const tipSha = tipResolved.stdout.trim();
  const trunkSha = gitOrDie(["rev-parse", `${TRUNK}^{commit}`]);

  // --- already landed? reconcile rather than declare victory ----------------
  if (git(["merge-base", "--is-ancestor", tipSha, TRUNK]).status === 0) {
    const mergeSha = mergeCommitFor(tipSha);
    if (!mergeSha) {
      process.stdout.write(`land: ${beadId} already landed (${branch} is an ancestor of ${TRUNK}) but no --no-ff merge commit names it; leaving the rest alone\n`);
      return 0;
    }
    const bead = readBead(beadId);
    const summary = bead.title.trim() || beadId;
    return finishLanding({
      beadId,
      bead,
      verdict,
      mergeSha,
      message: `Merge fleet/${beadId}: ${summary} (reviewed ${verdict.pinned}, APPROVE)`,
      notes: [`already merged as ${mergeSha.slice(0, 12)}; reconciling the remaining duties`],
      reconciling: true,
    });
  }

  // --- gate 1: stale tip ----------------------------------------------------
  const reviewed = git(["rev-parse", `${verdict.pinned}^{commit}`]);
  if (reviewed.status !== 0 || reviewed.stdout.trim() !== tipSha) {
    refuse(
      "stale-tip",
      `the verdict reviewed ${verdict.pinned} and ${branch} is now at ${tipSha.slice(0, 12)}. ` +
        `contracts/REVIEWER.md: the integrator refuses any tip other than the verdict's pinned SHA.`,
    );
  }

  // --- gate 2: merge conflict ----------------------------------------------
  const probe = git(["merge-tree", "--write-tree", "--name-only", trunkSha, tipSha]);
  if (probe.status !== 0) {
    // rc 1 covers both a conflict and an unmergeable ref, and only stdout tells
    // them apart: a conflict prints the tree oid then the conflicted paths, an
    // unresolvable ref prints nothing and puts its complaint on stderr. Both
    // refs were resolved above, so an empty stdout here is our own error.
    const lines = probe.stdout.split("\n");
    if (lines.length < 2 || !lines[0].trim()) die(`git merge-tree ${TRUNK} ${branch} could not run: ${(probe.stderr || probe.stdout).trim()}`);
    refuse("merge-conflict", `${branch} conflicts with ${TRUNK} at ${trunkSha.slice(0, 12)}: ${lines.slice(1).filter((l) => l.trim()).slice(0, 10).join(", ")}`);
  }

  // --- gate 3: selftests, on the would-be merge, in a scratch checkout ------
  const mergeBase = gitOrDie(["merge-base", trunkSha, tipSha]);
  const red = runSelftestsOnMerge(tipSha, trunkSha, selftestNamesForBranch(tipSha, mergeBase));
  if (red.failed) refuse("selftest-red", `${red.failed} fails on the merge of ${branch} into ${TRUNK}: ${red.output}`);

  // --- gate 4: still in the review queue -----------------------------------
  const bead = readBead(beadId);
  if (bead.status !== "in_progress" || !bead.labels.includes("needs-review")) {
    refuse(
      "not-in-review",
      `bead status is "${bead.status}" and labels are [${bead.labels.join(", ")}]; landing requires in_progress with needs-review. ` +
        `(This bd build has no in_review status — contracts/GRAPH.md.)`,
    );
  }

  // --- gate 5: the verdict names somewhere we may actually publish ----------
  // Before any write, because refusing after the merge would leave the merge
  // done and the row arguing with itself.
  const grantForGate = grantsPush();
  if (grantForGate.granted) {
    const dest = resolvePushDestination(verdict.pushRemote!);
    if (!dest.ok) refuse("push-destination", `${dest.why}. contracts/INTEGRATOR.md limits publishing to the remote the PUSH line names; it does not make any string in a comment a destination.`);
  }

  // --- every gate passed; writes begin here --------------------------------
  const head = gitOrDie(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head !== TRUNK) die(`the checkout at ${ROOT} is on "${head}", not ${TRUNK} — nothing was merged`);
  if (gitOrDie(["status", "--porcelain"]) !== "") die(`the checkout at ${ROOT} has uncommitted changes — nothing was merged`);

  // Both refs re-checked against what the gates actually judged. Anything that
  // moved under us since means the gates tested a combination we are no longer
  // about to create.
  const tipNow = gitOrDie(["rev-parse", `${branch}^{commit}`]);
  if (tipNow !== tipSha) {
    refuse("stale-tip", `${branch} moved from ${tipSha.slice(0, 12)} to ${tipNow.slice(0, 12)} while the gates were running; the gates judged the old tip.`);
  }
  const trunkNow = gitOrDie(["rev-parse", `${TRUNK}^{commit}`]);
  if (trunkNow !== trunkSha) {
    refuse("stale-tip", `${TRUNK} moved from ${trunkSha.slice(0, 12)} to ${trunkNow.slice(0, 12)} while the gates were running; gate 3 tested the old merge.`);
  }

  const summary = bead.title.trim() || beadId;
  const message = `Merge fleet/${beadId}: ${summary} (reviewed ${verdict.pinned}, APPROVE)`;
  const headBefore = gitOrDie(["rev-parse", "HEAD"]);
  const merged = git(["merge", "--no-ff", "-m", message, tipSha]);
  const unmerged = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  if (merged.status !== 0 || unmerged !== "") {
    // Gated on BOTH, because either alone can read clean while the other does
    // not: a conflicted merge leaves paths behind, and a merge that exits zero
    // having covered less than expected prints a genuine diffstat.
    git(["merge", "--abort"]);
    die(
      `the merge of ${branch} into ${TRUNK} did not complete cleanly and was aborted` +
        `${unmerged ? ` (unmerged paths: ${unmerged.split("\n").join(", ")})` : ""}: ${(merged.stderr || merged.stdout).trim()}`,
    );
  }
  const mergeSha = gitOrDie(["rev-parse", "HEAD"]);
  if (mergeSha === headBefore) {
    // "Already up to date" exits 0 with no unmerged paths, which is this tool's
    // whole success condition. The lock should make it unreachable; it is
    // checked anyway, because the cost of being wrong is a second close, a
    // second issue comment and a second dispatch.
    process.stdout.write(`land: ${beadId} — ${TRUNK} did not move; another run landed it first, so nothing further was done\n`);
    return 0;
  }

  return finishLanding({ beadId, bead, verdict, mergeSha, message, notes: [`merged ${branch} into ${TRUNK} as ${mergeSha.slice(0, 12)}`], reconciling: false });
}

/** landOne under the lock, with a Refusal turned into its row and exit 2. */
function landOneGuarded(beadId: string): number {
  const lock = acquireLock();
  if (!lock) {
    process.stdout.write(`land: another lander holds ${path.relative(ROOT, LOCK_FILE)}; leaving ${beadId} to it\n`);
    return 0;
  }
  try {
    return landOne(beadId);
  } catch (e: any) {
    if (e instanceof Refusal) {
      appendRow("land-refused", beadId, `land refused — ${e.reason}`, `${e.reason}: ${e.detail}`);
      process.stderr.write(`land refused ${beadId}: ${e.reason}: ${e.detail}\n`);
      return 2;
    }
    throw e;
  } finally {
    lock.release();
  }
}

function scan(): number {
  const r = bd(["list", "--status", "in_progress", "--label", "needs-review", "--limit", "0", "--json"]);
  if (r.status !== 0) die(`bd list --status in_progress --label needs-review --limit 0 --json failed: ${(r.stderr || r.stdout).trim()}`);
  const parsed = parseJsonOrDie(r.stdout, "bd list --status in_progress --label needs-review --json");
  const rows: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.issues) ? parsed.issues : [];
  let worst = 0;
  for (const row of rows) {
    const id = String(row?.id ?? "");
    if (!id) continue;
    // One refusal must not stop the scan reaching the next bead, so a gate
    // refusal is caught here and carried out as the run's exit code.
    const child = spawnSync("bun", [import.meta.path, id], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] });
    const status = child.status ?? 1;
    if (status === 1) die(`landing ${id} failed unexpectedly (exit 1); the scan stops rather than running on past an error`);
    if (status > worst) worst = status;
  }
  return worst;
}

function main(): void {
  const argv = process.argv.slice(2);
  let doScan = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scan") doScan = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write("usage: land.ts <bead-id> | land.ts --scan\n");
      process.exit(0);
    } else positional.push(argv[i]);
  }
  if (doScan && positional.length > 0) die("usage: land.ts <bead-id> | land.ts --scan — not both");
  if (!doScan && positional.length !== 1) die("usage: land.ts <bead-id> | land.ts --scan");
  if (!doScan && !/^[A-Za-z0-9._-]+$/.test(positional[0])) die(`bead id "${positional[0]}" has characters a branch name and a bd id do not share`);
  process.exit(doScan ? scan() : landOneGuarded(positional[0]));
}

main();
