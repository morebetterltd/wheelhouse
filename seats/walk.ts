#!/usr/bin/env bun
/**
 * walk.ts — consumer-surface walk dispatcher for ISA claims.
 *
 * One invocation = one verifier walk of one claim against one named surface.
 * It uses the roster's verifier identity, but unlike verify.ts it does NOT
 * compare that account to an author: a walker judges a consumer surface, not a
 * diff. The zero-context boundary is the prompt: claim text, surface spec, and
 * the VERIFIER.md walker brief only. No bead, ISA, contract bundle, logs, or
 * author reasoning enter the turn.
 *
 * Usage: bun seats/walk.ts <claim-ref> --surface <kind>:<spec> [--baseline <sha>]
 *          [--out <dir>] [--verifier <seat>]
 *
 * Exit: 0 WALKED-DONE | 2 WALKED-NOT-DONE | 3 COULD-NOT-WALK |
 *       4 malformed/missing verdict | 5 credential/preflight refusal | 1 other.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveRoleBrief } from "./briefs";
import { die, expandTilde, makeScratchCwd, sweepStaleScratchWorktrees, validateSegment } from "./verify";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const SCRUB = path.join(SEATS_DIR, "evidence-scrub.sh");
const DEFAULT_WALKS_DIR = path.join(SEATS_DIR, "verdicts", "walks");
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_WALK_TIMEOUT_MS || 1800000);

interface SeatEntry {
  role: string;
  provider?: string;
  model?: string;
  external?: boolean;
  account?: { dir: string; label?: string; authRoute?: string };
}

type WalkVerdict = "WALKED-DONE" | "WALKED-NOT-DONE" | "COULD-NOT-WALK";

function refuse(msg: string): never {
  process.stderr.write(`REFUSED: ${msg}\n`);
  process.exit(5);
}

function readRoster(): Record<string, SeatEntry> {
  if (!fs.existsSync(ROSTER_FILE)) refuse(`no ${ROSTER_FILE} — copy seats/seats.json.example to seats/seats.json and edit it`);
  return (JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8")).seats ?? {}) as Record<string, SeatEntry>;
}

function requireVerifierSeat(explicit: string | undefined): { name: string; entry: SeatEntry } {
  const roster = readRoster();
  if (explicit) {
    const entry = roster[explicit];
    if (!entry) refuse(`no seat named "${explicit}" in seats/seats.json`);
    if (entry.role !== "verifier") refuse(`seat "${explicit}" has role "${entry.role}", not "verifier"`);
    if (entry.external) refuse(`seat "${explicit}" is external and has no Pi identity`);
    return { name: explicit, entry };
  }
  const verifiers = Object.entries(roster).filter(([, e]) => e.role === "verifier" && !e.external);
  if (verifiers.length === 0) refuse(`no non-external verifier seat in seats/seats.json`);
  if (verifiers.length > 1) refuse(`multiple verifier seats (${verifiers.map(([n]) => n).join(", ")}) — pass --verifier <seat>`);
  return { name: verifiers[0][0], entry: verifiers[0][1] };
}

function providerEnvName(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  const names: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    google: "GEMINI_API_KEY",
  };
  return names[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function authIsIdentity(authFile: string): boolean {
  if (!fs.existsSync(authFile)) return false;
  const body = fs.readFileSync(authFile, "utf8").replace(/[{}\s]/g, "");
  return body.length > 0;
}

function requireCredential(entry: SeatEntry, seatName: string): string {
  if (!entry.account?.dir) refuse(`verifier seat "${seatName}" has no account.dir in seats/seats.json`);
  const dir = path.resolve(expandTilde(entry.account.dir));
  if (!fs.existsSync(dir)) refuse(`verifier seat directory does not exist: ${dir}`);
  const authFile = path.join(dir, "auth.json");
  const envName = providerEnvName(entry.provider);
  const envReady = entry.account.authRoute === "env" && !!(envName && process.env[envName]);
  if (!authIsIdentity(authFile) && !envReady) {
    refuse(
      `verifier seat "${seatName}" has no resolved credential — ${authFile} is missing/empty` +
        (envName ? ` and ${envName} is not exported for env-route use` : "")
    );
  }
  return dir;
}

function readClaim(ref: string): string {
  const expanded = path.resolve(ROOT, expandTilde(ref));
  if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
    return fs.readFileSync(expanded, "utf8").trim();
  }
  return ref.trim();
}

function parseSurface(raw: string | undefined, baseline: string | undefined): { kind: string; spec: string } {
  if (!raw) die("--surface requires <kind>:<spec>");
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) die(`--surface must be <kind>:<spec>, got ${JSON.stringify(raw)}`);
  const kind = raw.slice(0, idx);
  const spec = raw.slice(idx + 1);
  if (!["install", "upgrade", "product"].includes(kind)) die(`unsupported surface kind "${kind}" — expected install, upgrade, or product`);
  if (kind === "upgrade" && !baseline) die("upgrade:<runbook> requires --baseline <sha>");
  if (kind !== "upgrade" && baseline) die("--baseline is only valid with upgrade:<runbook>");
  return { kind, spec };
}

function defaultOutDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_WALKS_DIR, `${stamp}-${Math.random().toString(36).slice(2, 8)}`);
}

function resolveOutDir(outArg: string | undefined): string {
  const out = outArg ? path.resolve(ROOT, expandTilde(outArg)) : defaultOutDir();
  fs.mkdirSync(out, { recursive: true });
  return out;
}

function rootRelative(file: string): string {
  return path.relative(ROOT, file) || ".";
}

function buildSurfaceInstructions(kind: string, spec: string, baseline: string | undefined, workspaceRel: string): string[] {
  if (kind === "install") {
    return [
      `Surface kind: install`,
      `Front door: ${spec}`,
      `Scratch product repository: ${workspaceRel}`,
      `Consumer setup: use the scratch product repository above, then start from the front door above and follow its install instructions as a new consumer.`,
    ];
  }
  if (kind === "upgrade") {
    return [
      `Surface kind: upgrade`,
      `Runbook/front door: ${spec}`,
      `Baseline: ${baseline}`,
      `Scratch consumer install workspace: ${workspaceRel}`,
      `Consumer setup: create or use a scratch consumer-shaped install at the baseline above in that workspace, then follow the runbook/front door to upgrade it to the current template.`,
    ];
  }
  return [
    `Surface kind: product`,
    `Product surface: ${spec}`,
    `Consumer setup: open the URL or run the command exactly as a consumer/operator would, without reading implementation internals unless the surface itself instructs you to.`,
  ];
}

function parseWalkVerdict(stdout: string): { verdict: WalkVerdict; detail: string; line: string } {
  const lines = stdout.split("\n").filter((l) => /^VERDICT:/.test(l.trim()));
  if (lines.length !== 1) {
    process.stderr.write(`--- walk output tail ---\n${stdout.slice(-2000)}\n`);
    process.stderr.write(`STOP: walker emitted ${lines.length} VERDICT lines — expected exactly one\n`);
    process.exit(4);
  }
  const line = lines[0].trim();
  const m = line.match(/^VERDICT:\s*(WALKED-DONE|WALKED-NOT-DONE|COULD-NOT-WALK)(?:\s*[—-]{1,2}\s*(\S.*))?$/);
  if (!m) {
    process.stderr.write(`STOP: malformed walk verdict line: ${JSON.stringify(line)}\n`);
    process.exit(4);
  }
  const verdict = m[1] as WalkVerdict;
  const detail = (m[2] ?? "").trim();
  if ((verdict === "WALKED-NOT-DONE" || verdict === "COULD-NOT-WALK") && detail.length === 0) {
    process.stderr.write(`STOP: ${verdict} must carry the failing step or reason on the VERDICT line\n`);
    process.exit(4);
  }
  if (verdict === "WALKED-DONE" && detail.length > 0) {
    process.stderr.write(`STOP: WALKED-DONE takes no detail on the VERDICT line\n`);
    process.exit(4);
  }
  return { verdict, detail, line };
}

function scrubToFile(raw: string, outFile: string): void {
  const tmp = path.join(os.tmpdir(), `wheelhouse-walk-raw-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmp, raw);
  try {
    const scrubbed = spawnSync("bash", [SCRUB], { input: fs.readFileSync(tmp), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (scrubbed.status !== 0 || scrubbed.error) {
      die(`could not scrub transcript: ${scrubbed.error?.message ?? scrubbed.stderr}`);
    }
    fs.writeFileSync(outFile, scrubbed.stdout ?? "");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let surfaceRaw: string | undefined;
  let baseline: string | undefined;
  let outArg: string | undefined;
  let verifierArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--surface") surfaceRaw = argv[++i];
    else if (a === "--baseline") baseline = argv[++i];
    else if (a === "--out") outArg = argv[++i];
    else if (a === "--verifier") verifierArg = validateSegment("seat name", argv[++i] ?? "");
    else positional.push(a);
  }
  const claimRef = positional[0];
  if (!claimRef || positional.length !== 1) {
    die("usage: walk.ts <claim-ref> --surface <kind>:<spec> [--baseline <sha>] [--out <dir>] [--verifier <seat>]");
  }
  const claim = readClaim(claimRef);
  if (!claim) die("claim text is empty");
  const surface = parseSurface(surfaceRaw, baseline);
  const outDir = resolveOutDir(outArg);
  const transcriptFile = path.join(outDir, "transcript.txt");
  const metaFile = path.join(outDir, "walk.json");
  const transcriptRel = rootRelative(transcriptFile);
  const metaRel = rootRelative(metaFile);

  sweepStaleScratchWorktrees(ROOT);
  const { name: verifierSeat, entry } = requireVerifierSeat(verifierArg);
  const verifierDir = requireCredential(entry, verifierSeat);
  let brief: string;
  try {
    brief = resolveRoleBrief(ROOT, "verifier");
  } catch (e: any) {
    die(e.message);
  }

  const scratchCwd = makeScratchCwd(ROOT);
  let workspaceRel = ".";
  if (surface.kind === "install") {
    workspaceRel = "consumer-product";
    const consumer = path.join(scratchCwd, workspaceRel);
    fs.mkdirSync(consumer, { recursive: true });
    try { execFileSync("git", ["init", "-q"], { cwd: consumer, stdio: "ignore" }); } catch {}
  } else if (surface.kind === "upgrade") {
    workspaceRel = "consumer-upgrade";
    fs.mkdirSync(path.join(scratchCwd, workspaceRel), { recursive: true });
  }

  const prompt = [
    `Claim under verifier walk:`,
    claim,
    ``,
    ...buildSurfaceInstructions(surface.kind, surface.spec, baseline, workspaceRel),
    ``,
    `Walk only the surface named above. Do not read fleet internals, bead history, ISA files, seat logs, author transcripts, or implementation notes unless the named surface itself sends you there.`,
    `Retain a full transcript. End with exactly one line: VERDICT: WALKED-DONE | WALKED-NOT-DONE — <failing step quoted from the transcript> | COULD-NOT-WALK — <why>.`,
  ].join("\n");

  const args = ["-p", "--no-session", "--append-system-prompt", brief];
  if (entry.provider) args.push("--provider", entry.provider);
  if (entry.model) args.push("--model", entry.model);
  args.push(prompt);

  const res = spawnSync("pi", args, {
    cwd: scratchCwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: verifierDir },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const rawTranscript = [
    `$ pi ${args.map((a) => (a === prompt ? "<prompt>" : a)).join(" ")}`,
    `$ cwd ${scratchCwd}`,
    `--- stdout ---`,
    stdout,
    `--- stderr ---`,
    stderr,
  ].join("\n");
  scrubToFile(rawTranscript, transcriptFile);

  if (res.error) {
    if ((res.error as any).code === "ETIMEDOUT") {
      fs.writeFileSync(metaFile, JSON.stringify({ verdict: "COULD-NOT-WALK", reason: `timed out after ${TIMEOUT_MS}ms`, transcript: transcriptRel }, null, 2));
      console.log(`VERDICT: COULD-NOT-WALK — timed out after ${TIMEOUT_MS}ms`);
      console.log(`transcript: ${transcriptRel}`);
      process.exit(3);
    }
    die(`could not run pi: ${res.error.message}`);
  }
  if (res.status !== 0) {
    refuse(`pi exited ${res.status ?? `signal ${res.signal}`} for verifier seat "${verifierSeat}" — transcript: ${transcriptRel}`);
  }

  const parsed = parseWalkVerdict(stdout);
  fs.writeFileSync(metaFile, JSON.stringify({ verdict: parsed.verdict, detail: parsed.detail, line: parsed.line, surface: surfaceRaw, baseline, transcript: transcriptRel }, null, 2));

  console.log(parsed.line);
  console.log(`transcript: ${transcriptRel}`);
  console.log(`metadata: ${metaRel}`);
  process.exit(parsed.verdict === "WALKED-DONE" ? 0 : parsed.verdict === "WALKED-NOT-DONE" ? 2 : 3);
}

if (import.meta.main) main();
