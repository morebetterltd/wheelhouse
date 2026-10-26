#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { completedCommand } from "./completed-command";
import { fold, INTAKE_KINDS, type IntakeEvent, type IntakeRow } from "./intake";
import { readContractSkill } from "./briefs";

const ROOT = path.resolve(process.env.WHEELHOUSE_CONTRACT_ROOT || path.join(import.meta.dir, ".."));
const REQUIRE_SKILLS = true;
const CHECKS = { "person-on-surface": "walk", "person-reading": "read", machine: "run" } as const;
export interface Outcome {
  id: string;
  claim: string;
  group: string;
  who: string;
  surface: string;
  checkKind: string;
  checkHow: string;
}
export interface Contract {
  trace: string;
  integration: string;
  signal: string;
  skills: string;
  intent: string;
  outcomes: Outcome[];
  errors: string[];
}

/** Plain column-zero headers; quoted/fenced examples are not the contract. */
export function parseContract(text: string): Contract {
  const parsed: Contract = { trace: "", integration: "", signal: "", skills: "", intent: "", outcomes: [], errors: [] };
  const intent: string[] = [];
  let section = "", fenced = false;
  let sawIntent = false, sawOutcomes = false;
  let outcome: Outcome | undefined;
  let fields = new Set<string>();
  let sawSignal = false, sawSkills = false;
  const pair = (value: string): [string, string] => {
    const m = value.match(/^(\S+)[ \t]+(?:—|-)[ \t]*(.*)$/);
    return m ? [m[1], m[2].trim()] : [value.trim().split(/\s/)[0] ?? "", ""];
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      if (section === "intent" || section === "outcomes") parsed.errors.push("contract: format: use plain text, not fences");
      continue;
    }
    if (fenced || /^\s*>/.test(line)) continue;
    const meta = line.match(/^(Trace|Integration|Signal|Skills):[ \t]*(.*)$/);
    if (meta && !section) {
      const key = meta[1].toLowerCase() as "trace" | "integration" | "signal" | "skills";
      if (key === "signal") {
        if (sawSignal) parsed.errors.push("contract: Signal: duplicate line");
        sawSignal = true;
      }
      if (key === "skills") {
        if (sawSkills) parsed.errors.push("contract: Skills: duplicate line");
        sawSkills = true;
      }
      parsed[key] = meta[2].trim();
      continue;
    }
    if (/^Intent:[ \t]*$/.test(line)) {
      if (sawIntent) parsed.errors.push("contract: Intent: duplicate section");
      if (sawOutcomes) parsed.errors.push("contract: Intent: must precede Outcomes:");
      sawIntent = true; section = "intent"; continue;
    }
    if (/^Outcomes:[ \t]*$/.test(line)) {
      if (sawOutcomes) parsed.errors.push("contract: Outcomes: duplicate section");
      sawOutcomes = true; section = "outcomes"; continue;
    }
    if (section === "intent") { intent.push(line); continue; }
    if (section !== "outcomes") {
      if (sawOutcomes && /^- O\S+/.test(line)) parsed.errors.push(`${line.split(/\s+/)[1]}: claim: outside Outcomes continuation`);
      continue;
    }
    const start = line.match(/^- (O\S+)(?:[ \t]+(.*))?$/);
    if (start) {
      outcome = { id: start[1], claim: (start[2] ?? "").trim(), group: "", who: "", surface: "", checkKind: "", checkHow: "" };
      parsed.outcomes.push(outcome); fields = new Set(); continue;
    }
    const field = line.match(/^[ \t]+(consumer|surface|check):[ \t]*(.*)$/);
    if (field) {
      if (!outcome) { parsed.errors.push(`O1: ${field[1]}: no outcome claim before field`); continue; }
      const [, name, value] = field;
      if (fields.has(name)) parsed.errors.push(`${outcome.id}: ${name}: duplicate field`);
      fields.add(name);
      if (name === "surface") outcome.surface = value.trim();
      else if (name === "consumer") [outcome.group, outcome.who] = pair(value);
      else [outcome.checkKind, outcome.checkHow] = pair(value);
      continue;
    }
    // Other bead material (notes, source paths, evidence, etc.) can follow the
    // contract. It must not supply missing continuation fields to an outcome.
    if (/^\S/.test(line)) section = "other";
  }
  parsed.intent = intent.join("\n").trim();
  if (!sawIntent) parsed.errors.push("contract: Intent: missing");
  if (!sawOutcomes) parsed.errors.push("contract: Outcomes: missing");
  return parsed;
}

function stampedSkills(value: string): Map<string, string> | null {
  const tokens = value.trim().split(/\s+/), versions = new Map<string, string>();
  if (tokens.length !== 2) return null;
  for (const token of tokens) {
    const m = token.match(/^(intent|outcomes)@([^\s@]+)$/);
    if (!m || versions.has(m[1])) return null;
    versions.set(m[1], m[2]);
  }
  return versions.has("intent") && versions.has("outcomes") ? versions : null;
}

/** Shape/Signal syntax here; gate-level validation resolves posted intake ids. */
export function validateContract(parsed: Contract, options: { requireSkills?: boolean; requireSignal?: boolean; labels?: readonly string[] } = {}): string[] {
  const errors = [...parsed.errors];
  if (!parsed.intent) errors.push("contract: Intent: must contain at least one non-blank line before Outcomes:");
  if (!parsed.outcomes.length) errors.push("contract: Outcomes: must contain at least one outcome");
  const seen = new Set<string>();
  parsed.outcomes.forEach((o, i) => {
    if (seen.has(o.id)) errors.push(`${o.id}: id: duplicate`);
    seen.add(o.id);
    if (o.id !== `O${i + 1}`) errors.push(`${o.id}: id: expected O${i + 1} (sequential from O1)`);
    if (!o.claim) errors.push(`${o.id}: claim: missing`);
    const expected = Object.hasOwn(CHECKS, o.group) ? CHECKS[o.group as keyof typeof CHECKS] : undefined;
    if (!o.group) errors.push(`${o.id}: consumer: missing`);
    else if (!expected) errors.push(`${o.id}: consumer: unknown group "${o.group}"`);
    if (!o.who) errors.push(`${o.id}: consumer: who missing after dash`);
    if (!o.surface) errors.push(`${o.id}: surface: missing`);
    if (!o.checkKind) errors.push(`${o.id}: check: missing`);
    else if (!["walk", "read", "run"].includes(o.checkKind)) errors.push(`${o.id}: check: unknown kind "${o.checkKind}"`);
    else if (expected && o.checkKind !== expected) errors.push(`${o.id}: check: ${o.group} requires ${expected}, got ${o.checkKind}`);
    if (!o.checkHow) errors.push(`${o.id}: check: how missing after dash`);
  });
  if (options.requireSkills) {
    if (!parsed.skills) errors.push("contract: Skills: missing");
    else if (parsed.skills === "install-procedure carve-out") {
      if (!options.labels?.some(label => label === "wheelhouse-bootstrap" || label === "wheelhouse-smoke")) errors.push("contract: Skills: install-procedure carve-out requires wheelhouse-bootstrap or wheelhouse-smoke label");
    } else if (!stampedSkills(parsed.skills)) errors.push("contract: Skills: expected intent@<version> outcomes@<version> (both non-empty, once each)");
  }
  if (options.requireSignal) {
    if (!parsed.signal) errors.push("contract: Signal: missing");
    else if (!/^(?:sig-[a-z0-9]+|isa-gap: [A-Z]+[0-9-]+|install-procedure)$/.test(parsed.signal)) errors.push(`contract: Signal: invalid ${JSON.stringify(parsed.signal)}; expected sig-<id>, isa-gap: <claim>, or install-procedure`);
  }
  return [...new Set(errors)];
}

/** Intent-only shape check; meaning and plain wording require a fresh reader. */
export function lintIntent(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "Intent:") return `line 1: expected the literal Intent: header, got ${JSON.stringify(lines[0])}`;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\d+[.)]\s/.test(line)) return `line ${i + 1}: numbered build step: ${line}`;
    if (/^\s*- O\d/.test(line)) return `line ${i + 1}: outcome row: ${line}`;
    if (/^\s*(consumer|surface|check):/.test(line)) return `line ${i + 1}: outcome field: ${line}`;
    if (/^\s*Outcomes:\s*$/.test(line)) return `line ${i + 1}: Outcomes: header is not part of an intent: ${line}`;
  }
  if (!lines.slice(1).some(line => line.trim())) return "line 2: Intent: needs at least one non-blank paragraph";
  return null;
}

export type BeadText = { text: string; error: null; labels: string[] } | { text: null; error: string };
function fixtureText(file: string): BeadText {
  try {
    const text = fs.readFileSync(file, "utf8");
    const header = process.env.WHEELHOUSE_SKIP_BD === "1" ? text.split(/\r?\n/, 1)[0].match(/^labels:[ \t]*(.*)$/)?.[1] : undefined;
    const labels = header?.split(/[,\s]+/).filter(Boolean) ?? [];
    return text.trim() ? { text, error: null, labels } : { text: null, error: `empty contract fixture: ${file}` };
  } catch (e: any) { return { text: null, error: `cannot read contract fixture ${file}: ${e.message}` }; }
}
function bd(root: string, args: string[]) {
  return completedCommand("bd", args, { cwd: root });
}
export function readBeadText(root: string, beadId: string): BeadText {
  const fixture = process.env.WHEELHOUSE_CONTRACT_FIXTURE;
  if (process.env.WHEELHOUSE_SKIP_BD === "1") return fixture ? fixtureText(fixture) : { text: null, error: "WHEELHOUSE_SKIP_BD=1 requires WHEELHOUSE_CONTRACT_FIXTURE" };
  const r = bd(root, ["show", beadId, "--json"]);
  if (r.status !== 0 || r.error) return fixture ? fixtureText(fixture) : { text: null, error: `bd show ${beadId} failed: ${(r.stderr || r.error?.message || r.stdout || `exit ${r.status}`).trim()}` };
  let text: string, labels: string[] = [];
  try {
    const j = JSON.parse(r.stdout);
    const b = Array.isArray(j) ? j[0] : j;
    if (Array.isArray(b?.labels) && b.labels.every((label: unknown) => typeof label === "string")) labels = b.labels;
    text = [b?.title, b?.description, b?.notes, b?.design, b?.body].filter(s => typeof s === "string").join("\n");
  } catch { text = r.stdout; }
  return text.trim() ? { text, error: null, labels } : { text: null, error: `bd show ${beadId} returned empty bead text` };
}

function intakeRows(root: string, strict: boolean): Map<string, IntakeRow> | null {
  const fixture = process.env.WHEELHOUSE_INTAKE_FIXTURE;
  const intakeRoot = process.env.WHEELHOUSE_INTAKE_ROOT;
  if (process.env.WHEELHOUSE_SKIP_BD === "1" && !fixture && !intakeRoot) {
    if (strict) throw new Error("intake ledger link missing: WHEELHOUSE_INTAKE_FIXTURE is unset");
    console.error("Signal: intake id check skipped: WHEELHOUSE_SKIP_BD=1 and WHEELHOUSE_INTAKE_FIXTURE is unset");
    return null;
  }
  const file = process.env.WHEELHOUSE_SKIP_BD === "1" && fixture ? fixture : path.join(intakeRoot || root, "seats", "intake.jsonl");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e: any) {
    let absent = false;
    if (e.code === "ENOENT") {
      try { fs.lstatSync(file); } catch (statError: any) { absent = statError.code === "ENOENT"; }
    }
    if (absent && process.env.WHEELHOUSE_SKIP_BD !== "1" && !strict) {
      console.error(`Signal: intake id check skipped: ledger missing at ${file}`);
      return null;
    }
    throw new Error(`intake ledger link unreadable at ${file}: ${e.message}`);
  }
  try {
    const events = text.split("\n").filter(line => line.trim()).map((line, i) => {
      const ev = JSON.parse(line);
      if (!ev || !["posted", "disposed"].includes(ev.type) || typeof ev.id !== "string" || typeof ev.at !== "string") throw new Error(`invalid event at line ${i + 1}`);
      if (ev.type === "posted" && (!(INTAKE_KINDS as readonly string[]).includes(ev.kind) || [ev.source, ev.title, ev.text].some(v => typeof v !== "string"))) throw new Error(`invalid posted event at line ${i + 1}`);
      if (ev.type === "disposed" && !["produced", "parked", "dropped"].includes(ev.disposition)) throw new Error(`invalid disposition at line ${i + 1}`);
      return ev as IntakeEvent;
    });
    return fold(events);
  } catch (e: any) { throw new Error(`intake ledger link invalid at ${file}: ${e.message}`); }
}
function producedByError(root: string, signal: string, row: IntakeRow, beadId: string): string | null {
  const disposition = row.disposition;
  if (disposition?.disposition !== "produced") return `refused: signal ${signal} is not disposed produced`;
  if (disposition.work !== beadId) return `refused: signal ${signal} produced work ${disposition.work ?? "<missing>"}, not ${beadId}`;
  const file = path.join(root, "seats", "seats.json");
  if (!fs.statSync(file).isFile()) throw new Error(`producer roster is not a regular file: ${file}`);
  const roster = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!roster?.seats || typeof roster.seats !== "object" || Array.isArray(roster.seats)) throw new Error(`producer roster seats must be an object: ${file}`);
  const producers = Object.entries(roster.seats).filter(([, seat]: [string, any]) => seat?.role === "producer").map(([name]) => name).sort();
  if (!producers.length) return `refused: signal ${signal} has no producer seat in ${file}`;
  if (!producers.includes(disposition.by)) return `refused: signal ${signal} was produced by ${disposition.by ?? "<missing>"}, not the producer ${producers.join(", ")}`;
  return null;
}
function contractErrors(root: string, text: string, requireSignal: boolean, labels: readonly string[] = [], requireSkills = REQUIRE_SKILLS, beadId?: string): string[] {
  const parsed = parseContract(text);
  const errors = validateContract(parsed, { requireSignal, requireSkills, labels });
  const versions = stampedSkills(parsed.skills);
  if (requireSkills && versions) for (const name of ["intent", "outcomes"] as const) {
    const file = path.join(root, ".agents", "skills", name, "SKILL.md");
    // Older contracts remain usable; absent installed skills are not a new
    // worker gate. Producer assembly independently requires both readable files.
    if (!fs.existsSync(file)) continue;
    try {
      const installed = readContractSkill(root, name).version, written = versions.get(name)!;
      if (written !== installed) console.error(`WARN: contract written with ${name}@${written}, installed ${name}@${installed}`);
    } catch { console.error(`WARN: installed skill version unavailable at ${file}`); }
  }
  if (requireSignal && /^sig-[a-z0-9]+$/.test(parsed.signal)) {
    try {
      if (!beadId) {
        errors.push(`refused: signal ${parsed.signal} requires --bead <id> for --file checks`);
      } else {
        const rows = intakeRows(root, true)!;
        const row = rows.get(parsed.signal);
        if (!row) errors.push(`contract: Signal: ${parsed.signal} is not a posted intake event`);
        else {
          const error = producedByError(root, parsed.signal, row, beadId);
          if (error) errors.push(error);
        }
      }
    } catch (e: any) { errors.push(`contract: Signal: ${parsed.signal}: ${e.message}`); }
  }
  return errors;
}
/** Keep the gate strict; an upgrade refusal must name the producer repair, not
 * invite a blind stamp append. Both dispatch/review and CLI checks use this. */
function withSkillsRepair(errors: string[], target: readonly string[]): string[] {
  if (!errors.some(error => error.startsWith("contract: Skills:"))) return errors;
  const quote = (arg: string) => /^[A-Za-z0-9_./-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'";
  const command = "bun seats/contract.ts check " + target.map(quote).join(" ");
  const repair = "two-skill upgrade fix: ask the producer to revalidate Intent: and Outcomes: with both installed skills; set one top-level Skills: intent@<version> outcomes@<version> using the versions shown in its fresh assembled brief; do not merely append outcomes@. Upgrade path: wheelhouse/runbooks/UPGRADE.md#two-skill-contract-gate (template: runbooks/UPGRADE.md#two-skill-contract-gate). Recheck: " + command;
  return errors.map(error => error.startsWith("contract: Skills:") ? `${error}; ${repair}` : error);
}
export function checkBeadContract(root: string, beadId: string, options: { requireSignal?: boolean; requireSkills?: boolean } = {}): { text: string | null; errors: string[]; unreadable: boolean } {
  const read = readBeadText(root, beadId);
  return read.error !== null ? { text: null, errors: [`${beadId}: contract: unreadable: ${read.error}`], unreadable: true }
    : { text: read.text, errors: withSkillsRepair(contractErrors(root, read.text, options.requireSignal ?? true, read.labels, options.requireSkills ?? REQUIRE_SKILLS, beadId), [beadId]).map(e => `${beadId}: ${e}`), unreadable: false };
}

/** Shared read-only Repo: grammar: paths/lists, NAME (path/), TEMPLATE., UMBRELLA. */
export function repoDeclarations(text: string): string[] | null {
  let fenced = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    const match = line.match(/^[ \t]*Repo:[ \t]*(.*)$/i);
    if (!match) continue;
    return match[1].split(/[,;]/).map(entry => {
      const named = entry.trim().match(/^([A-Za-z][\w-]*)\.?\s+\(([^)]+)\)/);
      let value = named && !/^(?:\w+:\/\/|git@)/.test(named[2]) ? named[2].trim() : entry.trim().split(/\s/)[0];
      if (value !== "." && value !== ".." && !/[\\/]\.\.?$/.test(value)) value = value.replace(/\.$/, "");
      if (/^UMBRELLA$/i.test(value)) return ".";
      if (/^TEMPLATE$/i.test(value)) return "template/";
      return value;
    }).filter(Boolean);
  }
  return null;
}
function defaultRepos(root: string): string[] {
  let source = "";
  try { source = fs.readFileSync(path.join(root, "wheelhouse", ".template-source"), "utf8"); }
  catch (e: any) { if (e.code !== "ENOENT") throw new Error(`repository link unreadable: ${e.message}`); }
  const value = source.split("\n").map(line => line.match(/^product-repos?=(.*)$/)?.[1]).find(v => v?.trim());
  return value ? value.split(/[,;]/).map(v => v.trim()).filter(Boolean) : ["."];
}
function gitRead(repo: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(repo) };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  const r = completedCommand("git", ["-C", repo, ...args], { env });
  if (r.status !== 0 || r.error) throw new Error(`repository link at ${repo}: ${(r.stderr || r.error?.message || `git exit ${r.status}`).trim()}`);
  return r.stdout.trimEnd();
}
function ownRepo(root: string, value: string): string {
  let candidate = path.resolve(root, value);
  if (value === "template/" && !fs.existsSync(candidate) && fs.existsSync(path.join(root, "contracts"))) candidate = root;
  const real = fs.realpathSync(candidate);
  if (!fs.existsSync(path.join(real, ".git"))) throw new Error(`repository link at ${candidate}: not its own git root`);
  if (fs.realpathSync(gitRead(real, ["rev-parse", "--show-toplevel"])) !== real) throw new Error(`repository link at ${candidate}: not its own git root`);
  return real;
}
type Merge = { sha: string; subject: string; repo: string; parents: string[] };
function mergeRecords(repo: string, sha?: string): Merge[] {
  const args = sha ? ["show", "--no-patch", "--format=%H%x00%P%x00%s", `${sha}^{commit}`] : ["log", "--all", "--merges", "--format=%H%x00%P%x00%s"];
  return gitRead(repo, args).split("\n").filter(Boolean).map(line => {
    const [sha, parentText, subject] = line.split("\0");
    if (!/^[0-9a-f]{40}$/.test(sha) || parentText === undefined || subject === undefined) throw new Error("merge link: invalid Git record");
    return { sha, parents: parentText.split(" ").filter(Boolean), subject, repo };
  }).filter(row => row.parents.length > 1);
}
function subjectBeads(subject: string): string[] {
  return [...new Set([...subject.matchAll(/(?:^|[^A-Za-z0-9_/-])fleet\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)].map(m => m[1]))];
}
export function traceContract(root: string, target: string): string {
  let beadId = target, input: Merge | undefined;
  if (/^[0-9a-f]{7,40}$/i.test(target)) {
    const candidates = [...defaultRepos(root), ".", ...fs.readdirSync(root, { withFileTypes: true }).filter(e => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(root, e.name, ".git"))).map(e => e.name)];
    for (const value of [...new Set(candidates)]) {
      try { input = mergeRecords(ownRepo(root, value), target)[0]; } catch { continue; }
      if (input) break;
    }
    if (!input) throw new Error(`merge link missing: ${target} is not a readable merge in the product repositories`);
    const ids = subjectBeads(input.subject);
    if (!ids.length) throw new Error(`merge subject names no bead: ${input.sha}`);
    if (ids.length !== 1) throw new Error(`merge subject names multiple beads: ${input.sha}`);
    beadId = ids[0];
  }
  const read = readBeadText(root, beadId);
  if (read.error !== null) throw new Error(`bead link missing: ${beadId}: ${read.error}`);
  const parsed = parseContract(read.text);
  if (!parsed.signal) throw new Error(`bead ${beadId} has no Signal:`);
  const signalErrors = validateContract(parsed, { requireSignal: true }).filter(e => e.includes("Signal:"));
  if (signalErrors.length) throw new Error(`bead ${beadId}: ${signalErrors.join("; ")}`);
  let row: IntakeRow | undefined;
  if (parsed.signal.startsWith("sig-")) {
    row = intakeRows(root, true)!.get(parsed.signal);
    if (!row) throw new Error(`signal link missing: ${parsed.signal} is not a posted intake event`);
  }
  const declared = repoDeclarations(read.text) ?? defaultRepos(root);
  if (!declared.length) throw new Error(`repository link missing: bead ${beadId} has an empty Repo:`);
  const repos = [...new Set(declared.map(value => ownRepo(root, value)))];
  const merges = repos.flatMap(repo => mergeRecords(repo)).filter(m => subjectBeads(m.subject).length === 1 && subjectBeads(m.subject)[0] === beadId);
  if (!merges.length) throw new Error(`merge link missing: no merge names fleet/${beadId}`);
  if (input && !merges.some(m => m.sha === input!.sha)) throw new Error(`merge link missing: ${input.sha} is not in the bead's declared repositories`);
  const lines = input ? [`Merge: ${input.sha} — ${input.subject}`] : [];
  lines.push(`Contract: fleet/${beadId}`, `Bead: ${beadId}`, `Signal: ${parsed.signal}`);
  if (row) lines.push("Intake:", `  id: ${row.id}`, `  kind: ${row.posted.kind}`, `  source: ${JSON.stringify(row.posted.source)}`, `  title: ${JSON.stringify(row.posted.title)}`, `  posted at: ${row.posted.at}`, `  disposition: ${row.disposition?.disposition ?? "open"}`);
  lines.push("Merges:", ...merges.map(m => `  ${m.sha} (${m.repo}) — ${m.subject}`));
  return lines.join("\n");
}
export function contractRemedy(beadId: string, errors: string[]): string {
  const suffix = errors.some(error => error.includes("two-skill upgrade fix:")) ? "" : " — fix: write Signal:, Skills:, Intent: and Outcomes: per wheelhouse/GRAPH.md (Every bead is a contract) and dispatch again";
  return `${beadId} is not a contract: ${errors.join("; ")}${suffix}`;
}

function cli(): number {
  const [command, ...args] = process.argv.slice(2);
  if (command === "lint-intent" && args[0] === "--file" && args.length === 2) {
    let text: string;
    try { text = fs.readFileSync(args[1], "utf8"); }
    catch (e: any) { console.error(`${args[1]}: lint-intent: cannot read file: ${e.message}`); return 2; }
    const error = lintIntent(text);
    if (error) console.error(`${args[1]}: lint-intent: ${error}`);
    return error ? 2 : 0;
  } else if (command === "check") {
    if (args[0] === "--file" && (args.length === 2 || (args.length === 4 && args[2] === "--bead"))) {
      const beadId = args.length === 4 ? args[3] : undefined;
      if (beadId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(beadId) || beadId === "." || beadId === "..")) {
        console.error("contract: --bead requires a valid bead id"); return 2;
      }
      const read = fixtureText(args[1]);
      if (read.error !== null) { console.error(`${args[1]}: contract: unreadable: ${read.error}`); return 3; }
      const errors = withSkillsRepair(contractErrors(ROOT, read.text, true, read.labels, REQUIRE_SKILLS, beadId), args);
      for (const e of errors) console.error(`${args[1]}: ${e}`);
      return errors.length ? 2 : 0;
    }
    if (args.length === 1 && !args[0].startsWith("-")) {
      const result = checkBeadContract(ROOT, args[0]);
      for (const e of result.errors) console.error(e);
      return result.unreadable ? 3 : result.errors.length ? 2 : 0;
    }
  } else if (command === "audit" && args.length === 0) {
    const ids = new Set<string>();
    for (const status of ["open", "in_progress"]) {
      const r = bd(ROOT, ["list", `--status=${status}`, "--json", "--limit", "5000"]);
      if (r.status !== 0 || r.error) { console.error(`audit: bd list ${status} unreadable: ${(r.stderr || r.error?.message || r.stdout).trim()}`); return 3; }
      try {
        const rows = JSON.parse(r.stdout);
        if (!Array.isArray(rows) || rows.some(b => typeof b?.id !== "string" || !b.id)) throw new Error("expected an array of beads with ids");
        for (const b of rows) ids.add(b.id);
      } catch (e: any) { console.error(`audit: bd list ${status} unreadable: ${e.message}`); return 3; }
    }
    let invalid = false;
    for (const id of [...ids].sort()) {
      const result = checkBeadContract(ROOT, id);
      if (result.errors.length) console.error(result.errors[0]);
      if (result.unreadable) return 3;
      if (result.errors.length) invalid = true;
    }
    return invalid ? 1 : 0;
  }
  if (command === "trace" && args.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[0])) {
    try { console.log(traceContract(ROOT, args[0])); return 0; }
    catch (e: any) { console.error(`trace: ${e.message}`); return 2; }
  }
  console.error("usage: contract.ts check <bead-id> | check --file <path> [--bead <id>] | audit | trace <bead-id|merge-sha> | lint-intent --file <path>");
  return 3;
}
if (import.meta.main) process.exitCode = cli();
