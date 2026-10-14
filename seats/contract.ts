#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(process.env.WHEELHOUSE_CONTRACT_ROOT || path.join(import.meta.dir, ".."));
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

/** Shape only here: sibling beads add Skills/Signal enforcement at the gates. */
export function validateContract(parsed: Contract, options: { requireSkills?: boolean; requireSignal?: boolean } = {}): string[] {
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
  if (options.requireSkills && !parsed.skills) errors.push("contract: Skills: missing");
  if (options.requireSignal && !parsed.signal) errors.push("contract: Signal: missing");
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

export type BeadText = { text: string; error: null } | { text: null; error: string };
function fixtureText(file: string): BeadText {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.trim() ? { text, error: null } : { text: null, error: `empty contract fixture: ${file}` };
  } catch (e: any) { return { text: null, error: `cannot read contract fixture ${file}: ${e.message}` }; }
}
function bd(root: string, args: string[]) {
  return spawnSync("bd", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
}
export function readBeadText(root: string, beadId: string): BeadText {
  const fixture = process.env.WHEELHOUSE_CONTRACT_FIXTURE;
  if (process.env.WHEELHOUSE_SKIP_BD === "1") return fixture ? fixtureText(fixture) : { text: null, error: "WHEELHOUSE_SKIP_BD=1 requires WHEELHOUSE_CONTRACT_FIXTURE" };
  const r = bd(root, ["show", beadId, "--json"]);
  if (r.status !== 0 || r.error) return fixture ? fixtureText(fixture) : { text: null, error: `bd show ${beadId} failed: ${(r.stderr || r.error?.message || r.stdout || `exit ${r.status}`).trim()}` };
  let text: string;
  try {
    const j = JSON.parse(r.stdout);
    const b = Array.isArray(j) ? j[0] : j;
    text = [b?.title, b?.description, b?.notes, b?.design, b?.body].filter(s => typeof s === "string").join("\n");
  } catch { text = r.stdout; }
  return text.trim() ? { text, error: null } : { text: null, error: `bd show ${beadId} returned empty bead text` };
}

export function checkBeadContract(root: string, beadId: string): { text: string | null; errors: string[]; unreadable: boolean } {
  const read = readBeadText(root, beadId);
  return read.error !== null ? { text: null, errors: [`${beadId}: contract: unreadable: ${read.error}`], unreadable: true }
    : { text: read.text, errors: validateContract(parseContract(read.text)).map(e => `${beadId}: ${e}`), unreadable: false };
}
export function contractRemedy(beadId: string, errors: string[]): string {
  return `${beadId} is not a contract: ${errors.join("; ")} — fix: write the Intent: and Outcomes: sections per wheelhouse/GRAPH.md (Every bead is a contract) and dispatch again`;
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
    if (args[0] === "--file" && args.length === 2) {
      const read = fixtureText(args[1]);
      if (read.error !== null) { console.error(`${args[1]}: contract: unreadable: ${read.error}`); return 3; }
      const errors = validateContract(parseContract(read.text));
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
  console.error("usage: contract.ts check <bead-id> | check --file <path> | audit | lint-intent --file <path>");
  return 3;
}
if (import.meta.main) process.exitCode = cli();
