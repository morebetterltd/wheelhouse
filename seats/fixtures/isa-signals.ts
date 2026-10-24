import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const [root, bridge] = process.argv.slice(2);
assert(root && bridge);
const isa = path.join(root, "wheelhouse/ISA.md"), snapshot = path.join(root, "seats/run/isa-claims.json");
fs.mkdirSync(path.dirname(isa), { recursive: true });
fs.writeFileSync(path.join(root, "seats/intake.jsonl"), "");
let text = "# Fixture ISA\n## Goal\n- [ ] OUT1 outside claim\n## Claims\n- [ ] A1 initial direction\n- [x] B1 closed stub\n## Decisions\n- [ ] OUT2 not a claim\n";
fs.writeFileSync(isa, text);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const env = { ...process.env, WHEELHOUSE_ISA_SIGNALS_ROOT: root, WHEELHOUSE_INTAKE_ROOT: root };
function cli(source: string, args: string[]) {
  const r = spawnSync("bun", [source, ...args], { env, cwd: root, input: "", encoding: "utf8" });
  assert.ifError(r.error); assert.equal(r.signal, null);
  return r;
}
function sync(n: number, args: string[] = []) {
  const before = fs.readFileSync(isa, "utf8");
  const r = cli(bridge, ["sync", ...args]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, `posted ${n}\n`); assert.equal(r.stderr, "");
  assert.equal(fs.readFileSync(isa, "utf8"), before, "sync must never write ISA");
}
function rows() {
  const r = cli(path.join(root, "seats/intake.ts"), ["list", "--open", "--json"]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ""); return JSON.parse(r.stdout);
}
function snap() { return JSON.parse(fs.readFileSync(snapshot, "utf8")); }
function edit(from: string, to: string) {
  assert(text.includes(from)); text = text.replace(from, to); fs.writeFileSync(isa, text);
}
let pass = 0, fail = 0;
function test(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`); pass++; }
  catch (e) { console.error(`FAIL ${name}: ${e}`); fail++; }
}
test("first sync posts 0 and writes the snapshot", () => {
  sync(0); assert.equal(rows().length, 0); assert.deepEqual(snap(), {
    A1: { open: true, sha256: hash("- [ ] A1 initial direction") },
    B1: { open: false, sha256: hash("- [x] B1 closed stub") },
  });
});
test("one open claim edit posts 1 with its kind, ref, title, source, full text and new sha256", () => {
  edit("A1 initial direction", "A1 changed direction"); sync(1);
  const open = rows(); assert.equal(open.length, 1);
  assert.deepEqual(Object.fromEntries(["kind", "source", "title", "ref", "text"].map(k => [k, open[0].posted[k]])), {
    kind: "isa-change", source: "isa:A1", title: "ISA claim A1 changed", ref: "A1", text: "- [ ] A1 changed direction",
  });
  assert.equal(snap().A1.sha256, hash(open[0].posted.text));
  console.log(`one-row probe: ${open[0].posted.title}; kind=${open[0].posted.kind}; ref=${open[0].posted.ref}`);
});
test("sync again posts 0", () => { sync(0); assert.equal(rows().length, 1); });
test("flip a claim to [x] posts 0", () => {
  edit("- [ ] A1", "- [x] A1"); sync(0); assert.equal(rows().length, 1); assert.equal(snap().A1.open, false);
});
test("add a new open claim posts 1", () => {
  edit("## Decisions", "- [ ] C1 new direction\n## Decisions"); sync(1);
  assert.equal(rows().length, 2); assert.equal(rows()[0].posted.ref, "C1");
});
test("edit only Decisions posts 0", () => {
  edit("OUT2 not a claim", "OUT2 changed decision"); sync(0); assert.equal(rows().length, 2);
});
test("status prints the snapshot count", () => {
  const before = fs.readFileSync(snapshot, "utf8"), r = cli(bridge, ["status"]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "snapshot 3 claims\n"); assert.equal(r.stderr, "");
  assert.equal(fs.readFileSync(snapshot, "utf8"), before);
});
test("changed closed stub and Goal are silent; snapshot still tracks the closed line", () => {
  edit("B1 closed stub", "B1 revised closed stub"); edit("OUT1 outside claim", "OUT1 revised goal");
  sync(0); assert.equal(rows().length, 2); assert.equal(snap().B1.sha256, hash("- [x] B1 revised closed stub"));
});
test("new and edited anti-claims are open claims", () => {
  edit("## Decisions", "- Anti: N1 never do this\n## Decisions"); sync(1);
  assert.equal(rows()[0].posted.ref, "N1"); assert.equal(snap().N1.open, true);
  edit("N1 never do this", "N1 never do that"); sync(1);
  assert.equal(rows()[0].posted.text, "- Anti: N1 never do that");
});
test("stale snapshot retry dedupes same source/hash only while the row is undisposed", () => {
  const before = fs.readFileSync(snapshot, "utf8"); edit("C1 new direction", "C1 revised direction"); sync(1);
  const n = rows().length, id = rows()[0].id;
  fs.writeFileSync(snapshot, before); sync(0); assert.equal(rows().length, n);
  const disposed = cli(path.join(root, "seats/intake.ts"), ["dispose", id, "dropped", "--reason", "fixture complete"]);
  assert.equal(disposed.status, 0, disposed.stderr);
  fs.writeFileSync(snapshot, before); sync(1); assert.equal(rows().length, n);
});
test("--isa reads an alternate root-relative file without writing the real ISA", () => {
  fs.writeFileSync(path.join(root, "alternate.md"), text.replace("## Decisions", "- [ ] ALT1 alternate direction\n## Decisions"));
  sync(1, ["--isa", "alternate.md"]); assert.equal(rows()[0].posted.ref, "ALT1"); assert(snap().ALT1.open);
});
test("bad CLI, missing ISA and duplicate ids refuse without moving snapshot or ledger", () => {
  const before = fs.readFileSync(snapshot, "utf8"), ledger = fs.readFileSync(path.join(root, "seats/intake.jsonl"), "utf8");
  fs.writeFileSync(path.join(root, "duplicate.md"), "## Claims\n- [ ] Z1 first\n- [ ] Z1 second\n");
  for (const args of [["bogus"], ["status", "--isa", "alternate.md"], ["sync", "--isa", "missing.md"], ["sync", "--isa", "duplicate.md"]]) {
    const r = cli(bridge, args); assert.equal(r.status, 2); assert.match(r.stderr, /^STOP:/);
    assert.equal(fs.readFileSync(snapshot, "utf8"), before); assert.equal(fs.readFileSync(path.join(root, "seats/intake.jsonl"), "utf8"), ledger);
  }
});
test("partial posting failure retains snapshot; retry adds only the missing signal", () => {
  const before = fs.readFileSync(snapshot, "utf8"), n = rows().length;
  const planted = "ghp_" + "A".repeat(28);
  edit("## Decisions", `- [ ] RETRY1 accepted\n- [ ] RETRY2 ${planted}\n## Decisions`);
  const r = cli(bridge, ["sync"]); assert.equal(r.status, 2); assert.match(r.stderr, /intake post failed/);
  assert(!r.stderr.includes(planted)); assert.equal(fs.readFileSync(snapshot, "utf8"), before);
  assert.equal(rows().length, n + 1); edit(planted, "now accepted"); sync(1); assert.equal(rows().length, n + 2);
});
test("concurrent caller refuses on a live shared lock, decided by its exit", () => {
  // The parent is the acknowledged live lock holder; no overlap sleep is used.
  const lock = path.join(root, "seats/run/isa-signals.lock");
  const fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, `${process.pid}\n`);
  try { const r = cli(bridge, ["sync"]); assert.equal(r.status, 2); assert.match(r.stderr, /sync busy/); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
});
console.log(`isa-signals.selftest: ${fail ? "FAIL" : "PASS"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail ? 1 : 0;
