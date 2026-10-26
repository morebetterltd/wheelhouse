#!/usr/bin/env bun
/** Read the contract and completed review/walk records; write only a decision receipt. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { completedCommand } from "./completed-command";
import { checkBeadContract, contractRemedy, parseContract, type Outcome } from "./contract";
import { expandTilde, readReviewRecord, resolveRepoRoot } from "./verify";

const ROOT = path.resolve(import.meta.dir, "..");
type Row = { id: string; result: "PASS" | "FAIL" | "UNREACHED"; detail: string };
type Decision = { id: string; group: string; required: boolean; result: Row["result"] | "SKIPPED"; detail: string };
const usage = "usage: bun seats/merge-gate.ts BEAD-ID BRANCH [--repo PATH] [--walk WALK-JSON]";

function walkRows(value: any, outcomes: Outcome[]): Row[] {
  if (!Array.isArray(value.outcomes)) throw new Error("outcomes is not an array");
  const seen = new Set<string>();
  let previous = -1;
  for (const row of value.outcomes) {
    const index = outcomes.findIndex(o => o.id === row?.id);
    if (index < 0 || seen.has(row.id)) throw new Error(`extra or duplicate outcome ${row?.id}`);
    if (index <= previous) throw new Error("outcome rows are not in contract id order");
    if (!["PASS", "FAIL", "UNREACHED"].includes(row.result) || typeof row.detail !== "string" || !row.detail.trim()) throw new Error(`${row.id}: invalid result or missing detail`);
    seen.add(row.id); previous = index;
  }
  const rows: Row[] = value.outcomes;
  const first = rows.find(row => row.result === "FAIL") ?? rows.find(row => row.result === "UNREACHED");
  const expected = first?.result === "FAIL" ? "WALKED-NOT-DONE" : first ? "COULD-NOT-WALK" : "WALKED-DONE";
  const line = typeof value.line === "string" ? value.line.match(/^VERDICT:\s*(WALKED-DONE|WALKED-NOT-DONE|COULD-NOT-WALK)(?:\s*[—-]{1,2}\s*(\S.*))?$/) : null;
  if (value.verdict !== expected || line?.[1] !== expected || (first && !new RegExp(`^${first.id}:\\s*\\S`).test(line?.[2] ?? ""))) throw new Error(`rows disagree with verdict line (expected ${expected}${first ? ` — ${first.id}: <detail>` : ""})`);
  return rows;
}

function locateWalk(bead: string, tip: string, explicit?: string): { file: string | null; value: any; issue: string | null } {
  const folder = path.join(ROOT, "seats/verdicts/walks", bead);
  let candidates: string[] = [];
  if (explicit) candidates = [path.resolve(ROOT, expandTilde(explicit))];
  else if (fs.existsSync(folder)) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const file = path.join(folder, entry.name, "walk.json");
        if (fs.existsSync(file) && fs.lstatSync(file).isFile()) candidates.push(file);
      }
    }
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a));
  }
  let issue: string | null = null;
  for (const file of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      const mismatch = value?.mode !== "work" ? `walk mode ${JSON.stringify(value?.mode)} is not work`
        : value.bead !== bead ? `walk bead ${JSON.stringify(value.bead)} is not ${bead}`
        : value.tip !== tip ? `walk at ${value.tip} is not the reviewed tip ${tip}` : null;
      if (!mismatch) return { file, value, issue: null };
      issue ??= mismatch;
    } catch (e: any) { issue ??= `malformed walk ${path.relative(ROOT, file)}: ${e.message}`; }
  }
  return { file: null, value: null, issue };
}

function writeReceipt(receipt: unknown, bead: string): void {
  const dir = path.join(ROOT, "seats/verdicts"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${bead}.merge-gate.json`), temp = path.join(dir, `.${bead}.merge-gate.${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function main(args: string[]): number {
  const [bead, branch, ...rest] = args;
  if (!bead || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bead)) { console.error(usage); return 1; }
  const receipt: { bead: string; tip: string | null; result: "PASS" | "REFUSED"; outcomes: Decision[]; review: { tip: string | null; verdict: string | null }; walk: string | null; at: string } = {
    bead, tip: null, result: "REFUSED", outcomes: [], review: { tip: null, verdict: null }, walk: null, at: new Date().toISOString(),
  };
  // Invalidate an older PASS before a shared resolver can exit on bad input.
  writeReceipt(receipt, bead);
  let closed = false;
  const closing = (message: string) => { closed = true; console.log(`MERGE-GATE: ${message}`); };
  process.once("exit", () => { if (!closed) closing("REFUSED — preflight stopped before a decision"); });
  let outcomes: Outcome[] = [];
  const reject = (message: string, code: number) => {
    console.error(message);
    for (const outcome of outcomes) {
      const required = outcome.group !== "machine";
      receipt.outcomes.push({ id: outcome.id, group: outcome.group, required, result: required ? "UNREACHED" : "SKIPPED", detail: message });
      console.log(`${outcome.id} ${outcome.group}: ${required ? "unverified — " + message : "skipped (no consumer surface)"}`);
    }
    closing(`REFUSED — ${message}`); return code;
  };
  try {
    if (!branch || branch.startsWith("--")) return reject(usage, 1);
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i], value = rest[++i];
      if (!["--repo", "--walk"].includes(flag) || flags.has(flag) || !value || value.startsWith("--")) return reject(usage, 1);
      flags.set(flag, value);
    }
    const checked = checkBeadContract(ROOT, bead);
    if (checked.errors.length) return reject(contractRemedy(bead, checked.errors), 5);
    const contract = parseContract(checked.text!); outcomes = contract.outcomes;
    const repo = resolveRepoRoot(flags.get("--repo"));
    const resolved = completedCommand("git", ["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repo });
    if (resolved.status !== 0 || resolved.error) return reject(`cannot resolve branch ${JSON.stringify(branch)}: ${resolved.stderr.trim()}`, 1);
    const tip = resolved.stdout.trim(); receipt.tip = tip;
    const review = readReviewRecord(ROOT, bead);
    receipt.review = { tip: review?.tip ?? null, verdict: review?.verdict ?? null };
    if (!review || review.verdict !== "APPROVE" || review.tip !== tip) {
      return reject(`${bead}: ${!review ? "no completed review" : `review ${review.verdict} at ${review.tip}, branch tip ${tip}`}; review first: bun seats/verify.ts ${bead} ${branch} <author-seat>`, 5);
    }
    const required = contract.outcomes.some(outcome => outcome.group !== "machine");
    const located = locateWalk(bead, tip, flags.get("--walk"));
    receipt.walk = located.file ? path.relative(ROOT, located.file) : null;
    let rows: Row[] = [], malformed: string | null = null;
    if (located.value) {
      try { rows = walkRows(located.value, contract.outcomes); }
      catch (e: any) { malformed = `malformed walk: ${e.message}`; }
    } else if (flags.has("--walk") && located.issue) malformed = located.issue;
    const problems: string[] = [];
    if (malformed) problems.push(malformed);
    for (const outcome of contract.outcomes) {
      const needed = outcome.group !== "machine", row = rows.find(row => row.id === outcome.id);
      let result: Decision["result"], detail: string, shown: string;
      if (row?.result === "FAIL") {
        result = "FAIL"; detail = row.detail; shown = `failed: ${detail}`; problems.push(`${outcome.id} failed: ${detail}`);
      } else if (row?.result === "UNREACHED") {
        result = "UNREACHED"; detail = row.detail; shown = `unverified — ${detail}`; problems.push(`${outcome.id} unverified: ${detail}`);
      } else if (!needed) {
        result = row?.result ?? "SKIPPED"; detail = row?.detail ?? "no consumer surface"; shown = "skipped (no consumer surface)";
      } else if (row?.result === "PASS") {
        result = "PASS"; detail = row.detail; shown = `walked PASS — ${detail}`;
      } else {
        result = "UNREACHED"; detail = malformed ?? `no row at tip ${tip}`; shown = `unverified — ${detail}`; problems.push(`${outcome.id} unverified`);
      }
      receipt.outcomes.push({ id: outcome.id, group: outcome.group, required: needed, result, detail });
      console.log(`${outcome.id} ${outcome.group}: ${shown}`);
    }
    if (!located.file && required) {
      if (located.issue) console.log(located.issue);
      console.log(`run: bun seats/walk.ts --work ${bead} --branch ${branch} --author <author-seat>`);
    }
    if (!required && !located.file && !malformed) console.log("walk skipped: no outcome names a consumer surface");
    receipt.result = problems.length ? "REFUSED" : "PASS";
    closing(`${receipt.result}${problems.length ? ` — ${problems.join("; ")}` : ""}`);
    return problems.length ? 2 : 0;
  } catch (e: any) { return reject(e.message, 2); }
  finally { writeReceipt(receipt, bead); }
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
