import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { run, retain, changed } from "./producer-test-support";
const [repo, scratch] = process.argv.slice(2); fs.mkdirSync(scratch, { recursive: true });
const root = fs.realpathSync(scratch), file = path.join(repo, "contracts/PRODUCER.md"), doc = fs.readFileSync(file, "utf8"), records: any[] = [];
const tag = "PRODUCER_DOC_ASSERTION";
const required = ["Your assembled brief carries the intent and outcomes skills in full", "Write every intent with the intent skill", "every outcomes section with the outcomes skill", "Skills: intent@<v> outcomes@<v>", "using the two versions shown in your brief", "Dispatch and review refuse an unstamped contract", "bun seats/intake.ts show <id>", "bun seats/intake.ts dispose <id> produced --work <bead-id>", "bun seats/intake.ts dispose <id> parked --reason <reason> --revive <trigger>", "bun seats/intake.ts dispose <id> dropped --reason <reason>"];
function check(text: string) { for (const s of required) assert(text.includes(s), `${tag}: missing instruction ${s}`); assert(!text.includes("as a comment on the record") && !text.includes("For now, record that disposition as a comment"), `${tag}: obsolete comment disposition`); }
const save = () => retain(root, "producer-docs", { file, doc, records });
try {
  check(doc);
  for (const phrase of required) {
    const altered = changed(doc, phrase, "[planted instruction removal]"); fs.writeFileSync(path.join(root, "removed-" + records.length + ".md"), altered);
    let rejected = false; try { check(altered); } catch (e: any) { assert(e.message.includes(tag)); rejected = true; }
    assert(rejected, `${tag}: removed instruction escaped reader predicate`); records.push({ kind: "removed-instruction", phrase, altered, rejected }); save();
  }
  const project = path.join(root, "intake"); fs.mkdirSync(project);
  const env = { ...process.env, WHEELHOUSE_INTAKE_ROOT: project, BEADS_ACTOR: "fixture-producer" };
  async function command(args: string[]) { const r = await run("bun", [path.join(repo, "seats/intake.ts"), ...args], project, env); records.push({ kind: "command", native: r }); save(); assert(!r.error && r.signal === null && r.stdoutEOF && r.stderrEOF); assert.equal(r.code, 0, `${tag}: documented intake command: ${r.stderr}`); return r; }
  for (const disposition of ["produced", "parked", "dropped"]) {
    const post = await command(["post", "--kind", "finding", "--source", "fixture", "--title", "Fixture signal", "--text", "Fixture signal data"]), id = post.stdout.trim(); assert(/^sig-[a-z0-9]{4}$/.test(id), "CONTROL_SETUP actual post id");
    const shown = await command(["show", id]); assert.equal(JSON.parse(shown.stdout).id, id);
    const fields = disposition === "produced" ? ["--work", "fixture-work"] : disposition === "parked" ? ["--reason", "fixture reason", "--revive", "fixture trigger"] : ["--reason", "fixture reason"];
    await command(["dispose", id, disposition, ...fields]);
    const after = JSON.parse((await command(["show", id])).stdout); assert.equal(after.disposition.disposition, disposition); assert.equal(after.disposition.by, "fixture-producer");
  }
  const audit = await command(["audit"]); assert.equal(audit.stdout, "");
  console.log("PASS producer document: full instructions, 10 removed-instruction rejections; real show/three dispose forms/audit0 on private intake");
} finally { save(); }
