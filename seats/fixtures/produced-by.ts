// Real intake owner CLI -> shared contract gate. Actor fields are provenance,
// not authentication; this is not a proof of who used BEADS_ACTOR.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command.ts";
const [implementation, scratch, template] = process.argv.slice(2);
assert(fs.statSync(implementation).isFile() && fs.statSync(scratch).isDirectory());
const runtime = path.dirname(implementation), commands: any[] = [], results: any[] = [];
const evidence = process.env.WHEELHOUSE_PRODUCED_EVIDENCE;
function save() {
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "produced-by.json"), JSON.stringify({ implementation, source: fs.readFileSync(implementation, "utf8"), commands, results }, null, 2) + "\n"); }
}
function command(args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  assert(fs.statSync(cwd).isDirectory());
  const env = { ...process.env, ...extra };
  const r = completedCommand("bun", args, { cwd, env });
  commands.push({ args, cwd, extra, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }); save();
  assert(!r.error && r.signal === null); return r;
}
const work = "demo-work", producer = "fixture-producer";
const valid = fs.readFileSync(path.join(template, "seats/fixtures/contracts/valid.md"), "utf8");
const posted = path.join(scratch, "posted"); fs.mkdirSync(posted);
const post = command([path.join(runtime, "intake.ts"), "post", "--kind", "finding", "--source", "fixture", "--title", "Produced-by gate", "--text", "A signal needs the producer's disposition"], posted, { WHEELHOUSE_INTAKE_ROOT: posted });
assert.equal(post.status, 0, post.stderr); const signal = post.stdout.trim(); assert(/^sig-[a-z0-9]+$/.test(signal));
const snapshot = fs.readFileSync(path.join(posted, "seats/intake.jsonl"));
function history(name: string, disposition: string | null, actor = producer, target = work) {
  const root = path.join(scratch, name); fs.mkdirSync(path.join(root, "seats"), { recursive: true });
  // Fork the captured posted history; never re-dispose a completed row.
  fs.writeFileSync(path.join(root, "seats/intake.jsonl"), snapshot);
  const roster = { seats: { [producer]: { role: "producer", external: true, runtime: "commander-subagent" } } };
  fs.writeFileSync(path.join(root, "seats/seats.json"), JSON.stringify(roster));
  const file = path.join(root, "arbitrary-contract-filename.md"); fs.writeFileSync(file, valid.replace(/^Signal:.*$/m, "Signal: " + signal));
  if (disposition) {
    const args = [path.join(runtime, "intake.ts"), "dispose", signal, disposition, ...(disposition === "produced" ? ["--work", target] : ["--reason", "fixture", ...(disposition === "parked" ? ["--revive", "fixture resolution"] : [])])];
    const r = command(args, root, { WHEELHOUSE_INTAKE_ROOT: root, BEADS_ACTOR: actor }); assert.equal(r.status, 0, r.stderr);
  }
  return { root, file };
}
const good = history("good", "produced"), parked = history("parked", "parked"), wrong = history("wrong-work", "produced", producer, "other-work"), commander = history("commander", "produced", "commander"), open = history("open", null), dropped = history("dropped", "dropped");
function check(h: typeof good, mode = "bead", extra: NodeJS.ProcessEnv = {}, id = work) {
  const args = [implementation, "check", ...(mode === "bead" ? [id] : ["--file", h.file, ...(mode === "file-no-id" ? [] : ["--bead", id])])];
  return command(args, h.root, { WHEELHOUSE_CONTRACT_ROOT: h.root, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CONTRACT_FIXTURE: h.file, WHEELHOUSE_INTAKE_ROOT: h.root, WHEELHOUSE_INTAKE_FIXTURE: path.join(h.root, "seats/intake.jsonl"), ...extra });
}
function accepted(r: ReturnType<typeof check>) { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ""); assert.equal(r.stderr, ""); }
function refused(r: ReturnType<typeof check>, message: string) { assert.equal(r.status, 2, `expected refusal, got ${r.status}: ${r.stderr}`); assert.equal(r.stdout, ""); assert(r.stderr.includes(message), r.stderr); }
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, pass: true }); console.log("PASS produced-by " + name); }
  catch (e) { results.push({ name, pass: false, error: String(e) }); console.log("FAIL produced-by " + name + ": " + e); }
  save();
}
const ledgers = [good, parked, wrong, commander, open, dropped].map(h => [h.root, fs.readFileSync(path.join(h.root, "seats/intake.jsonl"), "utf8")] as const);
test("producer passes", () => { for (const mode of ["bead", "file"]) accepted(check(good, mode)); });
test("parked refused", () => { for (const mode of ["bead", "file"]) refused(check(parked, mode), `refused: signal ${signal} is not disposed produced`); });
test("work mismatch refused", () => { for (const mode of ["bead", "file"]) refused(check(wrong, mode), `refused: signal ${signal} produced work other-work, not ${work}`); });
test("commander refused", () => { for (const mode of ["bead", "file"]) refused(check(commander, mode), `refused: signal ${signal} was produced by commander, not the producer ${producer}`); });
for (const [name, h] of [["open", open], ["dropped", dropped]] as const) test(name + " refused", () => refused(check(h), `refused: signal ${signal} is not disposed produced`));
test("file requires explicit bead id", () => {
  const r = check(good, "file-no-id"); refused(r, `refused: signal ${signal} requires --bead <id>`);
  assert(r.stderr.includes("pass --bead <id>") && r.stderr.includes("record the produced disposition first"), "missing-id refusal must teach the recovery sequence");
});
test("file uses the supplied id, not filename or disposition work", () => {
  refused(check(good, "bead", {}, "other-work"), `produced work ${work}, not other-work`);
  refused(check(good, "file", {}, "other-work"), `produced work ${work}, not other-work`);
});
test("caller identity cannot replace disposition actor", () => refused(check(commander, "bead", { BEADS_ACTOR: producer }), `was produced by commander, not the producer ${producer}`));
test("root override without legacy fixture", () => accepted(check(good, "file", { WHEELHOUSE_INTAKE_FIXTURE: "" })));
test("normal file mode reads the same root", () => accepted(check(good, "file", { WHEELHOUSE_SKIP_BD: "", WHEELHOUSE_INTAKE_FIXTURE: "" })));
test("missing ledger refuses", () => {
  const file = path.join(good.root, "seats/intake.jsonl"); fs.renameSync(file, file + ".saved");
  try { refused(check(good, "bead", { WHEELHOUSE_INTAKE_FIXTURE: "" }), "ledger link unreadable"); } finally { fs.renameSync(file + ".saved", file); }
});
test("missing fixture identity never skips provenance", () => refused(check(good, "bead", { WHEELHOUSE_INTAKE_ROOT: "", WHEELHOUSE_INTAKE_FIXTURE: "" }), "intake ledger link missing"));
for (const kind of ["missing", "malformed", "no-producer", "wrong-role"] as const) test("roster " + kind + " refuses", () => {
  const file = path.join(good.root, "seats/seats.json"), before = fs.readFileSync(file);
  if (kind === "missing") fs.unlinkSync(file);
  else fs.writeFileSync(file, kind === "malformed" ? "not JSON" : JSON.stringify({ seats: kind === "no-producer" ? {} : { [producer]: { role: "worker" } } }));
  try { const r = check(good); assert.equal(r.status, 2, r.stderr); assert.equal(r.stdout, ""); assert(r.stderr.includes(signal)); }
  finally { fs.writeFileSync(file, before); }
});
test("standing and multiple producer names work", () => {
  const file = path.join(good.root, "seats/seats.json"), before = fs.readFileSync(file);
  try { fs.writeFileSync(file, JSON.stringify({ seats: { [producer]: { role: "producer" }, "second-producer": { role: "producer", external: true, runtime: "commander-subagent" } } })); accepted(check(good, "file")); }
  finally { fs.writeFileSync(file, before); }
});
for (const [root, before] of ledgers) assert.equal(fs.readFileSync(path.join(root, "seats/intake.jsonl"), "utf8"), before, "gate rewrote a ledger history");
save(); console.log(`produced-by: ${results.filter(r => r.pass).length}/${results.length} PASS`); process.exitCode = results.some(r => !r.pass) ? 1 : 0;
