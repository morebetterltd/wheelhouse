import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { completedCommand } from "../completed-command";

/** Remove only the field-continuation branch, retaining real parser/gate code. */
export function withoutContinuation(source: string): string {
  const start = "    // outcome-field-continuation:start\n", end = "    // outcome-field-continuation:end\n";
  assert.equal(source.split(start).length, 2, "unique continuation start anchor");
  assert.equal(source.split(end).length, 2, "unique continuation end anchor");
  const removed = source.slice(0, source.indexOf(start)) + source.slice(source.indexOf(end) + end.length);
  assert.notEqual(removed, source); return removed;
}
const check = ["inspect these literal cases:", "- first case keeps its punctuation: [one].", "- second case follows the first.", "Disproved by: any missing or reordered continuation."].join("\n");
const surface = "the parsed outcome\nand its continuation surface";
const who = "a contract reader\nusing the complete parsed fields";
const kinds = ["check", "surface", "consumer", "boundaries"] as const;
function oracle(api: any, text: string, kind: typeof kinds[number]) {
  const p = api.parseContract(text), o = p.outcomes[0], tag = "CONTINUATION_" + kind;
  if (kind === "check") {
    assert.equal(o.checkHow, check, tag);
    const padded = text.replace("    - first case keeps its punctuation: [one].", "\t  - first case keeps its punctuation: [one].  ");
    assert.equal(api.parseContract(padded).outcomes[0].checkHow, check.replace("[one].", "[one].  "), tag + " trailing whitespace/leading tabs");
    const paragraph = text.replace("    Disproved by:", "    \n    Disproved by:");
    assert.equal(api.parseContract(paragraph).outcomes[0].checkHow, check.replace("\nDisproved by:", "\n\nDisproved by:"), tag + " indented blank paragraph");
    assert.equal(api.parseContract(text.replaceAll("\n", "\r\n")).outcomes[0].checkHow, check, tag + " CRLF");
  } else if (kind === "surface") {
    assert.equal(o.surface, surface, tag);
    const empty = text.replace("  surface: the parsed outcome\n    and its continuation surface", "  surface:\n    ");
    const missing = api.parseContract(empty); assert.equal(missing.outcomes[0].surface, "", tag + " whitespace is not a required field");
    assert(api.validateContract(missing).some((e: string) => e === "O1: surface: missing"), tag + " missing surface still refused");
  } else if (kind === "consumer") {
    assert.equal(o.who, who, tag); assert.equal(o.group, "machine", tag + " group unchanged");
  } else {
    assert.equal(o.checkHow, check, tag);
    assert.deepEqual(p.errors, [], tag + " valid fixture");
    assert.deepEqual(p.outcomes.map((x: any) => x.id), ["O1", "O2"], tag + " next outcome");
    assert.equal(p.outcomes[1].checkHow, "require only the second check", tag + " column-zero note excluded");
    assert(!JSON.stringify(p.outcomes).includes("MUST-NOT-ENTER"), tag + " quoted/fenced/note text excluded");
    const orphan = text.replace("- O2 The following outcome remains separate.", "- O2 The following outcome remains separate.\n    ORPHAN-DETAIL-MUST-NOT-ENTER");
    assert(!JSON.stringify(api.parseContract(orphan).outcomes).includes("ORPHAN-DETAIL"), tag + " field reset at O2");
    const fenced = text.replace("    Disproved by:", "    ```text\n    check: run — FENCED-DETAIL-MUST-NOT-ENTER\n    ```\n    Disproved by:");
    const f = api.parseContract(fenced); assert.equal(f.outcomes[0].checkHow, check, tag + " fenced detail ignored");
    assert(f.errors.some((e: string) => e.includes("format: use plain text, not fences")), tag + " existing fence refusal preserved");
  }
}

async function main() {
  const [contractArg, fixture, work, selected] = process.argv.slice(2), contract = path.resolve(contractArg);
  const api = await import(pathToFileURL(contract).href), text = fs.readFileSync(fixture, "utf8");
  if (selected) { assert(kinds.includes(selected as any)); oracle(api, text, selected as any); return; }
  for (const kind of kinds) { oracle(api, text, kind); console.log("PASS contract continuation " + kind); }
  fs.mkdirSync(work, { recursive: true }); const runtime = path.join(work, "removed-runtime"); fs.mkdirSync(runtime);
  for (const item of fs.readdirSync(path.dirname(contract), { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith(".ts")) fs.copyFileSync(path.join(path.dirname(contract), item.name), path.join(runtime, item.name));
  }
  const mutant = path.join(runtime, "contract.ts"); fs.writeFileSync(mutant, withoutContinuation(fs.readFileSync(contract, "utf8")));
  for (const kind of kinds) {
    const result = completedCommand("bun", [import.meta.path, mutant, fixture, work, kind]);
    fs.writeFileSync(path.join(work, kind + ".stdout"), result.stdout); fs.writeFileSync(path.join(work, kind + ".stderr"), result.stderr);
    fs.writeFileSync(path.join(work, kind + ".rc"), String(result.status) + "\n");
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1, result.stderr);
    assert(result.stderr.includes("CONTINUATION_" + kind), "intended continuation oracle, not import/setup: " + result.stderr);
    assert(!/SyntaxError|Cannot find module|ModuleNotFound/.test(result.stderr), result.stderr);
    console.log("CONTROL continuation removed " + kind + ": native1 at intended CONTINUATION_" + kind + " oracle");
  }
  console.log("contract continuations: PASS (four original-source oracles and four native source removals)");
}
if (import.meta.main) await main();
