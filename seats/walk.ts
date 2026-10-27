#!/usr/bin/env bun
/**
 * walk.ts — consumer-surface walk dispatcher for ISA claims.
 *
 * One invocation = one verifier walk of one claim against one named surface.
 * It uses only the roster's verifier role (never verify.ts's reviewer role), and does NOT
 * compare that account to an author: a walker judges a consumer surface, not a
 * diff. The zero-context boundary is the prompt: claim text, surface spec, and
 * the VERIFIER.md walker brief only. No bead, ISA, contract bundle, logs, or
 * author reasoning enter the turn.
 *
 * Usage: bun seats/walk.ts <claim-ref> --surface <kind>:<spec> [--baseline <sha>]
 *          [--repo <product-repo>] [--out <dir>] [--verifier <seat>]
 *
 * Exit: 0 WALKED-DONE | 2 WALKED-NOT-DONE | 3 COULD-NOT-WALK |
 *       4 malformed/missing verdict | 5 credential/preflight refusal | 1 other.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { completedExecFileSync as execFileSync, completedSpawnSync as spawnSync } from "./native-command";
import { resolveRoleBrief } from "./briefs";
import { appendVerifierGateInbox, die, expandTilde, makeScratchCwd, readonlyBdPath, readReviewRecord, requireDifferentAccountDirs, requireDistinctAccount, resolveRepoRoot, setVerifierGateBead, sweepStaleScratchWorktrees, validateSegment } from "./verify";
import { hostBudgetPath } from "./host-budget";
import { harnessNameForSeat, oneShotCommandForHarness, oneShotEnvForHarness, type HarnessName } from "./harness";
import { effectiveRoster } from "./roster";
import { hasPool } from "./pool";
import { liveLineCandidates } from "./final-assistant-message";
import { readManual, type VerificationManual } from "./manual";
import { checkBeadContract, contractRemedy, parseContract, type Contract } from "./contract";
import { initialTestLock, testLockPath, waitForInitialTestLock, spawnWorkWalker } from "./walk-test-lock";

const ROOT = path.resolve(import.meta.dir, "..");
const SEATS_DIR = path.join(ROOT, "seats");
const ROSTER_FILE = path.join(SEATS_DIR, "seats.json");
const SCRUB = path.join(SEATS_DIR, "evidence-scrub.sh");
const DEFAULT_WALKS_DIR = path.join(SEATS_DIR, "verdicts", "walks");
const TIMEOUT_MS = Number(process.env.WHEELHOUSE_WALK_TIMEOUT_MS || 1800000);
const WINDOW_LIST_POLICY_MS = Number(process.env.WHEELHOUSE_WALK_WINDOW_LIST_TIMEOUT_MS || 120000);
const IMAGE_MAX_WIDTH = Number(process.env.WHEELHOUSE_WALK_IMAGE_MAX_WIDTH || 1000);
const IMAGE_MAX_CONTEXT = Number(process.env.WHEELHOUSE_WALK_IMAGE_MAX_CONTEXT || 3);
const IMAGE_QUALITY = Number(process.env.WHEELHOUSE_WALK_IMAGE_JPEG_QUALITY || 75);

interface SeatEntry {
  role: string;
  harness?: string;
  provider?: string;
  model?: string;
  external?: boolean;
  account?: { dir: string; label?: string; authRoute?: string };
  allowedTools?: string;
  disallowedTools?: string;
}

type WalkVerdict = "WALKED-DONE" | "WALKED-NOT-DONE" | "COULD-NOT-WALK";

let workRefusalBead: string | undefined;
function refuse(msg: string): never {
  if (workRefusalBead) appendVerifierGateInbox(workRefusalBead, "distress", `verifier work refused — ${workRefusalBead}`, `REFUSED: ${msg}`, "verifier-work-preflight", "seats/walk.ts");
  process.stderr.write(`REFUSED: ${msg}\n`);
  process.exit(5);
}

function readRoster(): Record<string, SeatEntry> {
  if (hasPool(ROOT)) return effectiveRoster(ROOT) as Record<string, SeatEntry>;
  if (!fs.existsSync(ROSTER_FILE)) refuse(`no ${ROSTER_FILE} — copy seats/seats.json.example to seats/seats.json and edit it`);
  return (JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8")).seats ?? {}) as Record<string, SeatEntry>;
}

function walkMarkerLive(seat: string): boolean {
  try { const m = JSON.parse(fs.readFileSync(path.join(ROOT, "seats", "run", `walk.${seat}.json`), "utf8")); process.kill(Number(m.pid), 0); return true; } catch { return false; }
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
  const free = verifiers.find(([n]) => !walkMarkerLive(n));
  if (!free) refuse(`all verifier seats busy (${verifiers.map(([n]) => n).join(", ")}) — retry later`);
  return { name: free[0], entry: free[1] };
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

function requireCredential(entry: SeatEntry, seatName: string, harness: HarnessName): string {
  if (!entry.account?.dir) refuse(`verifier seat "${seatName}" has no account.dir in seats/seats.json`);
  const dir = path.resolve(expandTilde(entry.account.dir));
  if (!fs.existsSync(dir)) refuse(`verifier seat directory does not exist: ${dir}`);
  const authFile = path.join(dir, "auth.json");
  const envName = providerEnvName(entry.provider);
  const envReady = entry.account.authRoute === "env" && !!(envName && process.env[envName]);
  const oauthReady = entry.account.authRoute !== "env" && harness === "claude-code" && claudeOauthIsIdentity(dir);
  const fileReady = entry.account.authRoute !== "env" && harness !== "claude-code" && authIsIdentity(authFile);
  if (!fileReady && !oauthReady && !envReady) {
    const credentialHint = harness === "claude-code" && entry.account.authRoute !== "env"
      ? `${path.join(dir, ".claude.json")} has no oauthAccount`
      : `${authFile} is missing/empty`;
    refuse(
      `verifier seat "${seatName}" has no resolved credential — ${credentialHint}` +
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
  if (!["install", "upgrade", "product", "manual"].includes(kind)) die(`unsupported surface kind "${kind}" — expected install, upgrade, product, or manual`);
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

interface GuiGuardResult {
  mode: "not-gui" | "window-list";
  target?: string;
  ok: boolean;
  reason?: string;
}

function guiTarget(surface: { kind: string; spec: string }): string | null {
  if (surface.kind !== "product") return null;
  const m = surface.spec.match(/^gui:([^:]+)(?::.*)?$/);
  return m ? m[1].trim() : null;
}

function normalizeWindowList(source: string, parsed: any): any[] | string {
  const windows = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.windows) ? parsed.windows : null;
  if (!windows) return `${source} returned wrong shape: expected JSON array or object with windows array`;
  const bad = windows.find((w: any) => !w || typeof w !== "object" || (w.title == null && w.name == null));
  if (bad) return `${source} returned wrong shape: each window needs title or name`;
  return windows;
}

function readWindowList(): any[] | string {
  const raw = process.env.WHEELHOUSE_WALK_WINDOW_LIST_JSON;
  if (raw) {
    try {
      return normalizeWindowList("window-list JSON", JSON.parse(raw));
    } catch (e: any) {
      return `window-list JSON malformed: ${e?.message ?? e}`;
    }
  }
  const cmd = process.env.WHEELHOUSE_WALK_WINDOW_LIST_COMMAND;
  if (cmd) {
    const res = spawnSync("bash", ["-lc", cmd], { encoding: "utf8", policyTimeoutMs: WINDOW_LIST_POLICY_MS });
    if (res.error) return `window-list command failed (${cmd}): ${res.error.message}; last stdout tail=${String(res.stdout ?? "").slice(-1000)}; last stderr tail=${String(res.stderr ?? "").slice(-1000)}`;
    if (res.status !== 0) return `window-list command failed (${cmd}): exit ${res.status}${res.stderr ? `: ${String(res.stderr).trim()}` : ""}`;
    const out = String(res.stdout ?? "").trim();
    if (!out) return `window-list command failed (${cmd}): empty output`;
    try {
      return normalizeWindowList(`window-list command (${cmd})`, JSON.parse(out));
    } catch (e: any) {
      return `window-list command malformed JSON (${cmd}): ${e?.message ?? e}`;
    }
  }
  return [];
}

function checkGuiGuard(surface: { kind: string; spec: string }): GuiGuardResult {
  const target = guiTarget(surface);
  if (!target) return { mode: "not-gui", ok: true };
  const windows = readWindowList();
  if (typeof windows === "string") return { mode: "window-list", target, ok: false, reason: windows };
  const hit = windows.find((w) => String(w.title ?? w.name ?? "").includes(target));
  if (!hit) return { mode: "window-list", target, ok: false, reason: `target window ${target} not found in window list` };
  const frontmost = hit.frontmost === true || hit.isFrontmost === true;
  const obscuredBy = hit.obscuredBy ?? hit.obscured_by ?? (hit.obscured ? "unknown window" : "");
  if (!frontmost) return { mode: "window-list", target, ok: false, reason: `target window ${target} is not frontmost` };
  if (obscuredBy) return { mode: "window-list", target, ok: false, reason: `target window ${target} is obscured by ${obscuredBy}` };
  return { mode: "window-list", target, ok: true };
}

function optionalManual(repo: string): VerificationManual | undefined {
  const skills = path.join(repo, ".agents", "skills");
  try {
    if (!fs.readdirSync(skills).some(name => name.startsWith("verify-") && fs.existsSync(path.join(skills, name, "SKILL.md")))) return undefined;
  } catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
  return readManual(repo);
}

function buildSurfaceInstructions(kind: string, spec: string, baseline: string | undefined, workspaceRel: string, manual: VerificationManual | undefined, outDir: string): string[] {
  if (kind === "manual") {
    const feature = manual!.features.find(feature => feature.slug === spec);
    if (!feature) refuse(`unknown manual feature slug "${spec}" in ${manual!.file}`);
    return [
      `Surface kind: manual`,
      `Verification manual: ${manual!.file}`,
      `Feature entry: ${feature.file}`,
      `Launch, doctor, drive and clean up exactly as the manual says; drive this feature from its entry; the end state the entry names is what proves it. If the entry does not lead where it says, the verdict is WALKED-NOT-DONE quoting the step.`,
      `First perform the entry's How to get to it step, then its How to drive it steps; a failed reach step is not permission to try later or alternate routes.`,
      `When How to get to it names an explicit URL or command, execute that named reach step; do not replace it with navigation or another route. A working alternative does not excuse an incorrect entry.`,
      `Follow the manual's Evidence section too. Do not repair the entry, consult implementation source, or discover a substitute route when the entry disagrees with the product.`,
      `Caller-provided RUN_DIR: ${path.join(outDir, "runtime")}`,
      `Caller-provided EVIDENCE_DIR: ${path.join(outDir, "evidence")}`,
      `Use only an isolated test instance with scratch state and a non-production port/socket; leave installed applications and production services untouched. Retain evidence after cleanup.`,
      `Full feature entry follows:`,
      fs.readFileSync(feature.file, "utf8"),
    ];
  }
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
    ...(manual ? [`Verification manual (may be used): ${manual.file}`] : []),
    `Consumer setup: open the URL or run the command exactly as a consumer/operator would, without reading implementation internals unless the surface itself instructs you to. For product:gui:<target> surfaces, the dispatcher preflights the target window with a window-list guard before the walk begins; if it is not frontmost and unobscured the walk records COULD-NOT-WALK instead of sending host GUI input into the wrong window.`,
  ];
}

function parseWalkVerdict(stdout: string, harness: HarnessName): { verdict: WalkVerdict; detail: string; line: string } {
  const lines = liveLineCandidates(stdout, harness, "VERDICT");
  if (lines.length !== 1) {
    process.stderr.write(`--- walk output tail ---\n${stdout.slice(-2000)}\n`);
    die(`walker emitted ${lines.length} distinct VERDICT lines in the final assistant message — expected exactly one`, 4);
  }
  const line = lines[0].normalized;
  const m = line.match(/^VERDICT:\s*(WALKED-DONE|WALKED-NOT-DONE|COULD-NOT-WALK)(?:\s*[—-]{1,2}\s*(\S.*))?$/);
  if (!m) {
    die(`malformed walk verdict line: ${JSON.stringify(line)}`, 4);
  }
  const verdict = m[1] as WalkVerdict;
  const detail = (m[2] ?? "").trim();
  if ((verdict === "WALKED-NOT-DONE" || verdict === "COULD-NOT-WALK") && detail.length === 0) {
    die(`${verdict} must carry the failing step or reason on the VERDICT line`, 4);
  }
  if (verdict === "WALKED-DONE" && detail.length > 0) {
    die("WALKED-DONE takes no detail on the VERDICT line", 4);
  }
  return { verdict, detail, line };
}

function appendWalkVerdictInbox(claimRef: string, line: string, detail: string, outDir: string, transcriptRel: string, metaRel: string): void {
  appendVerifierGateInbox(
    claimRef,
    "settle",
    `verifier walk verdict — ${claimRef}`,
    `${line}${detail ? `\n${detail}` : ""}\nout: ${rootRelative(outDir)}\ntranscript: ${transcriptRel}\nmetadata: ${metaRel}`,
    "verifier-walk",
    "seats/walk.ts"
  );
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

function imageBudget(outDir: string): { fullDir: string; contextDir: string; manifest: string } {
  return {
    fullDir: path.join(outDir, "screen-captures", "full-size"),
    contextDir: path.join(outDir, "screen-captures", "context"),
    manifest: path.join(outDir, "image-budget.json"),
  };
}

function isImage(file: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file);
}

function jpegName(file: string, index: number): string {
  const base = path.basename(file).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || `capture-${index + 1}`;
  return `${String(index + 1).padStart(2, "0")}-${base}.jpg`;
}

function convertToContextJpeg(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const sips = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(IMAGE_QUALITY), "-Z", String(IMAGE_MAX_WIDTH), src, "--out", dest], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (sips.status !== 0 || sips.error) die(`could not make budgeted JPEG for ${rootRelative(src)}: ${sips.error?.message ?? sips.stderr}`);
}

function reduceImageSetForContext(sourceDir: string | undefined, outDir: string): string[] {
  const budget = imageBudget(outDir);
  fs.mkdirSync(budget.fullDir, { recursive: true });
  fs.mkdirSync(budget.contextDir, { recursive: true });
  const images = sourceDir && fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir).filter(isImage).sort().map((f) => path.join(sourceDir, f))
    : [];
  const kept: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const src = images[i];
    const full = path.join(budget.fullDir, path.basename(src));
    fs.copyFileSync(src, full);
    if (kept.length < IMAGE_MAX_CONTEXT) {
      const context = path.join(budget.contextDir, jpegName(src, i));
      convertToContextJpeg(src, context);
      kept.push(context);
    }
  }
  fs.writeFileSync(budget.manifest, JSON.stringify({ maxWidth: IMAGE_MAX_WIDTH, maxContextImages: IMAGE_MAX_CONTEXT, sourceImages: images.length, contextImages: kept.map(rootRelative), fullSizeDir: rootRelative(budget.fullDir) }, null, 2));
  return kept;
}

function writeCaptureHelper(binDir: string, outDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const helper = path.join(binDir, "wheelhouse-walk-capture");
  const budget = imageBudget(outDir);
  const script = `#!/usr/bin/env bash
set -euo pipefail
label=\${1:-capture}
if [ "\${1:-}" = "" ]; then echo "usage: wheelhouse-walk-capture <label> -- <capture-command...>" >&2; exit 64; fi
shift
[ "\${1:-}" = "--" ] || { echo "usage: wheelhouse-walk-capture <label> -- <capture-command...>" >&2; exit 64; }
shift
safe=$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')
full_dir=${JSON.stringify(budget.fullDir)}
context_dir=${JSON.stringify(budget.contextDir)}
manifest=${JSON.stringify(budget.manifest)}
mkdir -p "$full_dir" "$context_dir"
full="$full_dir/$safe.png"
context="$context_dir/$safe.jpg"
"$@" "$full"
count=$(find "$context_dir" -maxdepth 1 -type f -name '*.jpg' | wc -l | tr -d ' ')
if [ "$count" -lt ${IMAGE_MAX_CONTEXT} ]; then
  sips -s format jpeg -s formatOptions ${IMAGE_QUALITY} -Z ${IMAGE_MAX_WIDTH} "$full" --out "$context" >/dev/null
  printf 'context image: %s\\n' "$context"
else
  printf 'image budget full; retained full-size only: %s\\n' "$full"
fi
printf '{"maxWidth":${IMAGE_MAX_WIDTH},"maxContextImages":${IMAGE_MAX_CONTEXT},"fullSizeDir":"%s","contextDir":"%s"}\\n' "$full_dir" "$context_dir" > "$manifest"
`;
  fs.writeFileSync(helper, script, { mode: 0o755 });
  return helper;
}

function spawnWalker(oneShot: ReturnType<typeof oneShotCommandForHarness>, scratchCwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(oneShot.bin, oneShot.args, {
    cwd: scratchCwd,
    env,
    encoding: "utf8",
    policyTimeoutMs: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--work")) { await workMain(process.argv.slice(2)); return; }
  let phase = "parse arguments";
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let surfaceRaw: string | undefined;
  let baseline: string | undefined;
  let outArg: string | undefined;
  let verifierArg: string | undefined;
  let repoArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--surface") surfaceRaw = argv[++i];
    else if (a === "--baseline") baseline = argv[++i];
    else if (a === "--out") outArg = argv[++i];
    else if (a === "--verifier") verifierArg = validateSegment("seat name", argv[++i] ?? "");
    else if (a === "--repo") {
      repoArg = argv[++i];
      if (!repoArg || repoArg.startsWith("--")) die("--repo requires a product repository path");
    }
    else positional.push(a);
  }
  const claimRef = positional[0];
  if (!claimRef || positional.length !== 1) {
    die("usage: walk.ts <claim-ref> --surface <kind>:<spec> [--baseline <sha>] [--repo <product-repo>] [--out <dir>] [--verifier <seat>]");
  }
  setVerifierGateBead(claimRef, "seats/walk.ts");
  phase = "read claim and surface";
  const claim = readClaim(claimRef);
  if (!claim) die("claim text is empty");
  const surface = parseSurface(surfaceRaw, baseline);
  const outDir = resolveOutDir(outArg);
  const transcriptFile = path.join(outDir, "transcript.txt");
  const metaFile = path.join(outDir, "walk.json");
  const seededContextImages = reduceImageSetForContext(process.env.WHEELHOUSE_WALK_IMAGE_SOURCE_DIR, outDir);
  const imageBudgetInfo = imageBudget(outDir);
  const transcriptRel = rootRelative(transcriptFile);
  const metaRel = rootRelative(metaFile);
  const guiGuard = checkGuiGuard(surface);
  if (!guiGuard.ok) {
    fs.writeFileSync(metaFile, JSON.stringify({ verdict: "COULD-NOT-WALK", reason: guiGuard.reason, surface: surfaceRaw, baseline, transcript: transcriptRel, guiGuard }, null, 2));
    fs.writeFileSync(transcriptFile, `COULD-NOT-WALK before GUI input: ${guiGuard.reason}\n`);
    const line = `VERDICT: COULD-NOT-WALK — ${guiGuard.reason}`;
    appendWalkVerdictInbox(claimRef, line, String(guiGuard.reason ?? ""), outDir, transcriptRel, metaRel);
    console.log(line);
    console.log(`transcript: ${transcriptRel}`);
    console.log(`metadata: ${metaRel}`);
    process.exit(3);
  }

  phase = "prepare pinned product workspace";
  let repo: string, gitRoot: string, tip: string;
  try {
    repo = fs.realpathSync(path.resolve(repoArg ?? ROOT));
    gitRoot = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim());
    tip = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: gitRoot, encoding: "utf8" }).trim();
  } catch (e: any) { refuse(`cannot pin product repository: ${e.message}`); }
  const productSubdirectory = path.relative(gitRoot, repo);
  if (productSubdirectory === ".." || productSubdirectory.startsWith(`..${path.sep}`) || path.isAbsolute(productSubdirectory)) refuse("product repository is outside its Git root");
  sweepStaleScratchWorktrees(gitRoot);
  const scratchRoot = makeScratchCwd(gitRoot, "review", tip);
  const scratchCwd = path.join(scratchRoot, productSubdirectory);
  if (!fs.existsSync(scratchCwd) || !fs.statSync(scratchCwd).isDirectory()) refuse(`product directory is absent at pinned tip ${tip}`);
  let manual: VerificationManual | undefined;
  try {
    manual = surface.kind === "manual" ? readManual(scratchCwd) : surface.kind === "product" ? optionalManual(scratchCwd) : undefined;
  } catch (e: any) { refuse(e.message); }
  const surfaceInstructions = buildSurfaceInstructions(surface.kind, surface.spec, baseline,
    surface.kind === "install" ? "consumer-product" : surface.kind === "upgrade" ? "consumer-upgrade" : ".", manual, outDir);

  phase = "prepare verifier seat";
  const { name: verifierSeat, entry } = requireVerifierSeat(verifierArg);
  let verifierHarness: ReturnType<typeof harnessNameForSeat>;
  try {
    verifierHarness = harnessNameForSeat(verifierSeat, entry);
  } catch (e: any) {
    refuse(e.message);
  }
  const verifierDir = requireCredential(entry, verifierSeat, verifierHarness);
  let brief: string;
  try {
    brief = resolveRoleBrief(ROOT, "verifier");
  } catch (e: any) {
    die(e.message);
  }

  phase = "prepare scratch workspace";
  const helperBin = path.join(scratchCwd, ".wheelhouse-walk-bin");
  const captureHelper = writeCaptureHelper(helperBin, outDir);
  let workspaceRel = ".";
  if (surface.kind === "install") {
    workspaceRel = "consumer-product";
    const consumer = path.join(scratchCwd, workspaceRel);
    fs.mkdirSync(consumer, { recursive: true });
    try { execFileSync("git", ["init", "-q", "-b", "main"], { cwd: consumer, stdio: "ignore" }); } catch {}
  } else if (surface.kind === "upgrade") {
    workspaceRel = "consumer-upgrade";
    fs.mkdirSync(path.join(scratchCwd, workspaceRel), { recursive: true });
  }

  const prompt = [
    `Claim under verifier walk:`,
    claim,
    ``,
    ...surfaceInstructions,
    `Product repository pinned tip: ${tip}`,
    `Your cwd is the pinned scratch product directory. Manual/entry paths above refer to that snapshot, not the fleet checkout.`,
    ``,
    `Walk only the surface named above. Do not read fleet internals, bead history, ISA files, seat logs, author transcripts, or implementation notes unless the named surface itself sends you there.`,
    `Install root for machine-local wheelhouse/ paths: ${ROOT} (also exported as WHEELHOUSE_ROOT). If the named surface sends you to a wheelhouse/ path that is not present in your scratch cwd, resolve it under WHEELHOUSE_ROOT.`,
    `Image budget for screen captures: full-size captures are evidence on disk under ${rootRelative(imageBudgetInfo.fullDir)}; in-context images must be JPEG, downscaled to <=${IMAGE_MAX_WIDTH}px wide, and limited to the first ${IMAGE_MAX_CONTEXT}. Use the PATH helper \`wheelhouse-walk-capture <label> -- <capture-command...>\` for simulator/app screenshots; it keeps full-size output under --out and only emits budgeted context JPEGs under ${rootRelative(imageBudgetInfo.contextDir)}. Do not paste full-size PNG/screenshots into the transcript or prompt context.`,
    seededContextImages.length > 0 ? `Already-budgeted context image(s), max ${IMAGE_MAX_CONTEXT}: ${seededContextImages.map(rootRelative).join(", ")}` : `Already-budgeted context image(s): none.`,
    `Retain a full transcript. End with exactly one line: VERDICT: WALKED-DONE | WALKED-NOT-DONE — <failing step quoted from the transcript> | COULD-NOT-WALK — <why>.`,
  ].join("\n");

  const oneShot = oneShotCommandForHarness(verifierHarness, brief, entry.provider, entry.model, prompt, entry.allowedTools, entry.disallowedTools);

  phase = "run verifier walk";
  const markerFile = path.join(ROOT, "seats", "run", `walk.${verifierSeat}.json`);
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ pid: process.pid, bead: claimRef, startedAt: new Date().toISOString() }, null, 2) + "\n");
  const oneShotPath = readonlyBdPath(ROOT, `${helperBin}${path.delimiter}${hostBudgetPath(ROOT)}`, scratchCwd);
  const env = oneShotEnvForHarness(verifierHarness, verifierDir, { ...process.env, PATH: oneShotPath, WHEELHOUSE_ROOT: ROOT, WHEELHOUSE_WALK_CAPTURE_HELPER: captureHelper,
    ...(surface.kind === "manual" ? { RUN_DIR: path.join(outDir, "runtime"), EVIDENCE_DIR: path.join(outDir, "evidence") } : {}) });
  const res = spawnWalker(oneShot, scratchCwd, env);

  try { fs.unlinkSync(markerFile); } catch {}
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const rawTranscript = [
    `$ ${oneShot.display}`,
    `$ cwd ${scratchCwd}`,
    `--- stdout ---`,
    stdout,
    `--- stderr ---`,
    stderr,
  ].join("\n");
  scrubToFile(rawTranscript, transcriptFile);

  if (res.error) {
    if ((res.error as any).code === "ETIMEDOUT") {
      const line = `VERDICT: COULD-NOT-WALK — timed out after ${TIMEOUT_MS}ms during ${phase}`;
      fs.writeFileSync(metaFile, JSON.stringify({ verdict: "COULD-NOT-WALK", reason: `timed out after ${TIMEOUT_MS}ms during ${phase}`, phase, transcript: transcriptRel }, null, 2));
      appendWalkVerdictInbox(claimRef, line, `timed out after ${TIMEOUT_MS}ms during ${phase}`, outDir, transcriptRel, metaRel);
      console.log(line);
      console.log(`transcript: ${transcriptRel}`);
      process.exit(3);
    }
    die(`could not run ${oneShot.bin}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    refuse(`${oneShot.bin} exited ${res.status ?? `signal ${res.signal}`} for verifier seat "${verifierSeat}" — transcript: ${transcriptRel}`);
  }

  const parsed = parseWalkVerdict(stdout, verifierHarness);
  fs.writeFileSync(metaFile, JSON.stringify({ verdict: parsed.verdict, detail: parsed.detail, line: parsed.line, surface: surfaceRaw, baseline, repo: rootRelative(repo), tip, productSubdirectory,
    ...(manual ? { manual: path.relative(scratchCwd, manual.file), feature: surface.kind === "manual" ? surface.spec : undefined } : {}),
    transcript: transcriptRel, guiGuard, imageBudget: { maxWidth: IMAGE_MAX_WIDTH, maxContextImages: IMAGE_MAX_CONTEXT, fullSizeDir: rootRelative(imageBudgetInfo.fullDir), contextDir: rootRelative(imageBudgetInfo.contextDir) } }, null, 2));

  appendWalkVerdictInbox(claimRef, parsed.line, parsed.detail, outDir, transcriptRel, metaRel);
  console.log(parsed.line);
  console.log(`transcript: ${transcriptRel}`);
  console.log(`metadata: ${metaRel}`);
  process.exit(parsed.verdict === "WALKED-DONE" ? 0 : parsed.verdict === "WALKED-NOT-DONE" ? 2 : 3);
}

type OutcomeResult = "PASS" | "FAIL" | "UNREACHED";
interface OutcomeRow { id: string; result: OutcomeResult; detail: string }

function parseWorkRows(stdout: string, harness: HarnessName, contract: Contract): OutcomeRow[] {
  // Unlike claim verdicts, identical repeated outcome rows are duplicates.
  const candidates = liveLineCandidates(stdout, harness, "OUTCOME", false);
  const found = new Map<string, OutcomeRow>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const m = candidate.normalized.match(/^OUTCOME:\s*(O\d+)\s+(PASS|FAIL|UNREACHED)(?:\s*[—-]{1,2}\s*(\S.*))?$/);
    if (!m) die(`malformed OUTCOME row: ${candidate.normalized}`, 4);
    const [, id, result, evidence] = m;
    if (!contract.outcomes.some(outcome => outcome.id === id)) die(`extra OUTCOME row ${id}`, 4);
    if (found.has(id)) die(`duplicate OUTCOME row ${id}`, 4);
    if (!evidence?.trim()) die(`OUTCOME ${id} requires evidence detail`, 4);
    found.set(id, { id, result: result as OutcomeResult, detail: evidence.trim() });
    order.push(id);
  }
  for (const outcome of contract.outcomes) if (!found.has(outcome.id)) die(`missing OUTCOME row ${outcome.id}`, 4);
  const rows = contract.outcomes.map(outcome => found.get(outcome.id)!);
  if (order.some((id, i) => id !== rows[i].id)) die("OUTCOME rows must be in contract id order", 4);
  return rows;
}

function consistentWorkVerdict(rows: OutcomeRow[], verdict: ReturnType<typeof parseWalkVerdict>): void {
  const failed = rows.find(row => row.result === "FAIL");
  const unreached = rows.find(row => row.result === "UNREACHED");
  const first = failed ?? unreached;
  const expected = failed ? "WALKED-NOT-DONE" : unreached ? "COULD-NOT-WALK" : "WALKED-DONE";
  if (verdict.verdict !== expected || (first && !new RegExp(`^${first.id}:\\s*\\S`).test(verdict.detail))) {
    die(`inconsistent VERDICT: expected ${expected}${first ? ` — ${first.id}: <step or blocker>` : ""}`, 4);
  }
}

function workPrompt(contract: Contract, tip: string, manual: VerificationManual | undefined, outDir: string): string {
  const budget = imageBudget(outDir);
  const entries = manual ? contract.outcomes.flatMap(outcome => {
    // A feature slug must be named as its own token, not a substring of another feature.
    return manual.features.filter(feature => new RegExp(`(?:^|[^a-z0-9-])${feature.slug}(?:$|[^a-z0-9-])`).test(outcome.surface))
      .map(feature => `Feature entry for ${outcome.id}: ${feature.file}\n${fs.readFileSync(feature.file, "utf8")}`);
  }) : [];
  return [
    `Work under verification. Tip: ${tip}. Your cwd is a checkout of that tip.`,
    `Intent:`, contract.intent, ``, `Outcomes:`,
    ...contract.outcomes.flatMap(outcome => [
      `- ${outcome.id} ${outcome.claim}`,
      `  consumer: ${outcome.group} — ${outcome.who}`,
      `  surface: ${outcome.surface}`,
      `  check: ${outcome.checkKind} — ${outcome.checkHow}`,
    ]),
    ``,
    `You receive only person-on-surface and person-reading outcomes. For each outcome given, go where that person meets it (its surface) and make their check: walk means drive the real page, app or CLI session as that person; read means read the artifact top to bottom and run its commands. Machine outcomes belong to the worker's evidence and the review's test run; they are not given to you and must not be re-run or answered here. Prove every outcome given true or false with your own evidence. You have not been given, and must not go looking for, the author's report, the task's history, or any fleet file; the surfaces and your cwd are the whole world.`,
    ...(manual ? [`Verification manual (may be used): ${manual.file}`, ...entries,
      `Follow the manual's launch, doctor, drive, evidence and cleanup. Drive named features from their entries; execute an explicit reach URL/command before driving. A failed reach step is WALKED-NOT-DONE, not permission to find another route or consult implementation source.`] : []),
    `Caller-provided RUN_DIR: ${path.join(outDir, "runtime")}`,
    `Caller-provided EVIDENCE_DIR: ${path.join(outDir, "evidence")}`,
    `Use only isolated test instances, scratch state and non-production ports/sockets. Never stop, replace or modify installed applications or production service definitions. Retain evidence after cleanup.`,
    `Install root for machine-local wheelhouse/ paths: ${ROOT} (also exported as WHEELHOUSE_ROOT). Only resolve a path there when a named outcome surface sends you there.`,
    `Image budget for screen captures: full-size evidence under ${rootRelative(budget.fullDir)}; in-context JPEGs <=${IMAGE_MAX_WIDTH}px wide, first ${IMAGE_MAX_CONTEXT} only. Use wheelhouse-walk-capture <label> -- <capture-command...>.`,
    `Retain a full transcript. End with exactly one unfenced OUTCOME row per outcome given, in original contract id order (do not renumber gaps), each with evidence detail. Never add a row for an omitted machine outcome:`,
    `OUTCOME: O<n> PASS — <what you drove, read or ran and observed>`,
    `OUTCOME: O<n> FAIL — <quoted failing step>`,
    `OUTCOME: O<n> UNREACHED — <blocker>`,
    `Then exactly one unfenced VERDICT line: WALKED-DONE if all PASS; WALKED-NOT-DONE — O<n>: <step> for the first FAIL; otherwise COULD-NOT-WALK — O<n>: <why> for the first UNREACHED. Prefix the closing line with VERDICT:.`,
  ].join("\n");
}

async function workMain(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  const usage = "usage: walk.ts --work <bead> --branch <ref> --author <seat> [--repo <path>] [--out <dir>] [--verifier <seat>] (no claim-ref, --surface or --baseline)";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--work", "--branch", "--author", "--repo", "--out", "--verifier"].includes(flag) || values.has(flag)) die(usage);
    const value = args[++i];
    if (!value || value.startsWith("--")) die(usage);
    values.set(flag, value);
  }
  if (!["--work", "--branch", "--author"].every(flag => values.has(flag))) die(usage);
  const bead = validateSegment("bead id", values.get("--work")!);
  const branch = values.get("--branch")!;
  const author = validateSegment("seat name", values.get("--author")!);
  const verifierArg = values.has("--verifier") ? validateSegment("seat name", values.get("--verifier")!) : undefined;
  workRefusalBead = bead;
  const testLock = testLockPath();
  const alreadyHeld = initialTestLock(testLock);
  setVerifierGateBead(bead, "seats/walk.ts");
  const checked = checkBeadContract(ROOT, bead);
  if (checked.errors.length) refuse(contractRemedy(bead, checked.errors));
  const fullContract = parseContract(checked.text!);
  // One projection governs prompt/manual entries, required rows AND timeout rows.
  const contract: Contract = { ...fullContract, outcomes: fullContract.outcomes.filter(outcome =>
    outcome.group === "person-on-surface" || outcome.group === "person-reading") };
  if (!contract.outcomes.length) refuse(`${bead}: no outcome needs a walk (all outcomes are machine); use bun seats/merge-gate.ts ${bead} ${branch}`);
  const review = readReviewRecord(ROOT, bead);
  const reviewNext = `review first: bun seats/verify.ts ${bead} ${branch} ${author}`;
  if (!review) refuse(`${bead}: ${reviewNext}`);
  if (review.verdict !== "APPROVE") refuse(`${bead}: review verdict is ${review.verdict}; ${reviewNext}`);
  const repoArg = values.get("--repo");
  const repoRoot = resolveRepoRoot(repoArg);
  const product = repoArg ? fs.realpathSync(path.resolve(ROOT, expandTilde(repoArg))) : repoRoot;
  const productSubdirectory = path.relative(repoRoot, product);
  if (productSubdirectory === ".." || productSubdirectory.startsWith(`..${path.sep}`) || path.isAbsolute(productSubdirectory)) die("product directory is outside repository");
  let tip: string;
  try { tip = execFileSync("git", ["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).trim(); }
  catch { die(`cannot resolve branch ${JSON.stringify(branch)} to a commit`); }
  if (review.tip !== tip!) refuse(`${bead}: reviewed tip ${review.tip} is not the branch tip ${tip!}; re-review at ${tip!}; ${reviewNext}`);
  const { name: verifierSeat, entry } = requireVerifierSeat(verifierArg);
  if (!entry.account?.dir) refuse(`verifier seat "${verifierSeat}" has no account.dir`);
  requireDistinctAccount(author, verifierSeat, entry.account.dir, refuse, "verifier");
  requireDifferentAccountDirs(review.reviewerSeat, review.reviewerDir, verifierSeat, entry.account.dir, refuse, "verifier", "gating reviewer");
  let harness: HarnessName;
  try { harness = harnessNameForSeat(verifierSeat, entry); } catch (e: any) { refuse(e.message); }
  const verifierDir = requireCredential(entry, verifierSeat, harness);
  const brief = resolveRoleBrief(ROOT, "verifier");
  sweepStaleScratchWorktrees(repoRoot);
  const scratchRoot = makeScratchCwd(repoRoot, "verify", tip);
  const cwd = path.join(scratchRoot, productSubdirectory);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) refuse(`product directory absent at ${tip}`);
  let manual: VerificationManual | undefined;
  try { manual = optionalManual(cwd); } catch (e: any) { refuse(e.message); }
  const outDir = resolveOutDir(values.get("--out") ?? path.join(DEFAULT_WALKS_DIR, bead, path.basename(defaultOutDir())));
  const transcriptFile = path.join(outDir, "transcript.txt"), metaFile = path.join(outDir, "walk.json");
  if (fs.existsSync(metaFile)) refuse("work output already contains walk.json; use a fresh --out directory");
  const transcriptRel = rootRelative(transcriptFile), metaRel = rootRelative(metaFile);
  const helperBin = path.join(cwd, ".wheelhouse-walk-bin");
  const captureHelper = writeCaptureHelper(helperBin, outDir);
  const prompt = workPrompt(contract, tip!, manual, outDir);
  const oneShot = oneShotCommandForHarness(harness, brief, entry.provider, entry.model, prompt, entry.allowedTools, entry.disallowedTools);
  const oneShotPath = readonlyBdPath(ROOT, `${helperBin}${path.delimiter}${hostBudgetPath(ROOT)}`, cwd);
  const env = oneShotEnvForHarness(harness, verifierDir, { ...process.env, PATH: oneShotPath, WHEELHOUSE_ROOT: ROOT,
    WHEELHOUSE_WALK_CAPTURE_HELPER: captureHelper, WHEELHOUSE_SELFTEST_SWEEP_LOCK: testLock,
    RUN_DIR: path.join(outDir, "runtime"), EVIDENCE_DIR: path.join(outDir, "evidence") });
  const markerFile = path.join(ROOT, "seats", "run", `walk.${verifierSeat}.json`);
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ pid: process.pid, bead, startedAt: new Date().toISOString() }) + "\n");
  await waitForInitialTestLock(alreadyHeld);
  const res = await spawnWorkWalker(oneShot.bin, oneShot.args, cwd, env, TIMEOUT_MS, testLock);
  try { fs.unlinkSync(markerFile); } catch {}
  const stdout = res.stdout ?? "", stderr = res.stderr ?? "";
  scrubToFile([`$ ${oneShot.display}`, `$ cwd ${cwd}`, `--- stdout ---`, stdout, `--- stderr ---`, stderr].join("\n"), transcriptFile);
  let rows: OutcomeRow[], parsed: ReturnType<typeof parseWalkVerdict>;
  if (res.error && (res.error as any).code === "ETIMEDOUT") {
    const reason = `dispatcher timed out after ${TIMEOUT_MS}ms during run verifier walk${res.queued ? `; ${res.queued}` : ""}`;
    rows = contract.outcomes.map(outcome => ({ id: outcome.id, result: "UNREACHED", detail: reason }));
    parsed = { verdict: "COULD-NOT-WALK", detail: `${rows[0].id}: ${reason}`, line: `VERDICT: COULD-NOT-WALK — ${rows[0].id}: ${reason}` };
  } else {
    if (res.error || res.status !== 0) refuse(`verifier process failed: ${res.error?.message ?? `exit ${res.status} signal ${res.signal}`}; transcript: ${transcriptRel}`);
    rows = parseWorkRows(stdout, harness, contract);
    parsed = parseWalkVerdict(stdout, harness);
    consistentWorkVerdict(rows, parsed);
  }
  const rowLines = rows.map(row => `OUTCOME: ${row.id} ${row.result} — ${row.detail}`);
  fs.writeFileSync(metaFile, JSON.stringify({ mode: "work", bead, branch, tip: tip!, repo: rootRelative(repoRoot), productSubdirectory,
    outcomes: rows, verdict: parsed.verdict, detail: parsed.detail, line: parsed.line, transcript: transcriptRel,
    ...(res.error && (res.error as any).code === "ETIMEDOUT" ? { reason: rows[0].detail } : {}) }, null, 2));
  appendVerifierGateInbox(bead, "settle", `verifier work verdict — ${bead}`,
    [parsed.line, ...rowLines, `out: ${rootRelative(outDir)}`, `transcript: ${transcriptRel}`, `metadata: ${metaRel}`].join("\n"), "verifier-walk", "seats/walk.ts", Infinity);
  console.log([...rowLines, parsed.line, `transcript: ${transcriptRel}`, `metadata: ${metaRel}`].join("\n"));
  process.exit(parsed.verdict === "WALKED-DONE" ? 0 : parsed.verdict === "WALKED-NOT-DONE" ? 2 : 3);
}

if (import.meta.main) main().catch(error => die(error.message));
