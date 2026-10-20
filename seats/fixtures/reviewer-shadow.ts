// Real verify CLI + real dispatcher fixture sweep; model and bd peers are stubs.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const [template, home] = process.argv.slice(2), base = path.join(path.dirname(template), "shadow-cases");
assert(fs.statSync(path.join(path.dirname(template), ".wheelhouse-selftest-fixture")).isFile());
const original = fs.readFileSync(path.join(template, "seats/verify.ts"), "utf8");
console.log("shadow pinned verify sha256=" + createHash("sha256").update(original).digest("hex"));
const authorDir = path.join(home, ".pi-seats-shadow/worker-1"), gateDir = path.join(home, ".pi-seats-shadow/reviewer"), mirrorDir = path.join(home, ".pi-seats-shadow/mirror");
fs.mkdirSync(mirrorDir, { recursive: true }); fs.copyFileSync(path.join(gateDir, "auth.json"), path.join(mirrorDir, "auth.json"));
const bead = "bead-shadow", commentId = "10000000-0000-0000-0000-000000000001", outage = "fixture-quota-outage", basis = "mirror subscription differs from every author (worker-1)";
const badge = `FALLBACK GATE: promotion comment ${commentId}; outage: ${outage}; distinct-account basis: ${basis}`;
let serial = 0;
function world(source = original) {
  const root = path.join(base, String(++serial)); fs.cpSync(template, root, { recursive: true });
  fs.writeFileSync(path.join(root, "seats/verify.ts"), source);
  const raw = JSON.parse(fs.readFileSync(path.join(root, "seats/seats.json"), "utf8")), gate = { ...raw.seats.reviewer }, mirror = { ...gate, shadow: true, account: { dir: mirrorDir } };
  const seats: any = { "worker-1": raw.seats["worker-1"], mirror, gate };
  const tip = execFileSync("git", ["-C", root, "rev-parse", "fleet/bead-1"], { encoding: "utf8" }).trim();
  // Schema captured with bd comments wheelhouse-project-rer0 --json on
  // 2026-10-20. IDs, issue, actor and text are fixture substitutions, not assent.
  const promotion: any = { id: commentId, issue_id: bead, author: "commander", text: "FALLBACK GATE: " + JSON.stringify({ seat: "mirror", tip, outage, distinctAccountBasis: basis }), created_at: "2026-10-20T02:46:19Z" };
  const w = { root, seats, raw, gate, mirror, tip, comments: [promotion], reply: "VERDICT: APPROVE\nPUSH: NOT CONSIDERED\n", args: [] as string[], env: {} as Record<string, string>, explicit: false };
  return w;
}
type World = ReturnType<typeof world>;
function payload(w: World, change: any) { const p = JSON.parse(w.comments[0].text.slice("FALLBACK GATE: ".length)); Object.assign(p, change); w.comments[0].text = "FALLBACK GATE: " + JSON.stringify(p); }
function promote(w: World) { w.explicit = true; w.args.push("--fallback-promotion", commentId); w.reply = badge + "\n" + w.reply; }
function invoked() { return [authorDir, gateDir, mirrorDir].filter(d => fs.existsSync(path.join(d, "invoked"))); }
function run(w: World, expected: number, selected?: string, error?: string) {
  for (const d of [authorDir, gateDir, mirrorDir]) for (const f of ["invoked", "argv.json"]) fs.rmSync(path.join(d, f), { force: true });
  fs.writeFileSync(path.join(w.root, "seats/seats.json"), JSON.stringify({ ...w.raw, seats: w.seats }));
  const comments = path.join(w.root, "comments.json"), reply = path.join(w.root, "reply.txt"); fs.writeFileSync(comments, JSON.stringify(w.comments)); fs.writeFileSync(reply, w.reply);
  const env = { ...process.env, HOME: home, STUB_REPLY_FILE: reply, STUB_BD_COMMENTS_FILE: comments };
  delete env.BEADS_ACTOR; delete env.WHEELHOUSE_BEADS_ACTOR_COMMANDER;
  Object.assign(env, w.env);
  const args = [path.join(w.root, "seats/verify.ts"), bead, "fleet/bead-1", "worker-1", ...(w.explicit ? ["mirror"] : []), ...w.args];
  const r = spawnSync("bun", args, { cwd: w.root, env, encoding: "utf8", timeout: 120000 });
  fs.writeFileSync(path.join(w.root, "invocation.json"), JSON.stringify({ args, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr }, null, 2));
  assert(!r.error, String(r.error)); assert.equal(r.signal, null); assert.equal(r.status, expected, r.stdout + r.stderr);
  if (error) assert((r.stdout + r.stderr).includes(error), r.stdout + r.stderr);
  const verdict = path.join(w.root, "seats/verdicts", bead + ".md");
  if ([0, 2, 3].includes(expected)) {
    assert(fs.statSync(verdict).isFile(), "review verdict actually exists"); assert(invoked().length, "model actually ran");
    const text = fs.readFileSync(verdict, "utf8"); assert(text.includes(`- verifier-seat: ${selected} (`), text);
    assert(text.includes(`- verdict: ${{ 0: "APPROVE", 2: "BOUNCE", 3: "DISCOVER" }[expected]}`), "fresh verdict must match the native exit");
    if (w.args.includes("--fallback-promotion")) { assert(text.includes(badge)); assert(text.includes(`- fallback-promotion-comment: ${commentId}`)); const argv = JSON.parse(fs.readFileSync(path.join(mirrorDir, "argv.json"), "utf8")); assert(argv.at(-1).includes("full REVIEWER.md contract")); assert(argv.at(-1).includes(badge)); }
  } else { assert(!fs.existsSync(verdict), "refusal must not publish a verdict"); }
  return r;
}
function refused(w: World, text: string) { run(w, 1, undefined, text); assert.equal(invoked().length, 0, "precondition refusal before model spawn"); }
const tests: Record<string, (w: World) => void> = {
  "auto-orderings": w => { run(w, 0, "gate"); assert(!fs.existsSync(path.join(mirrorDir, "invoked"))); w.seats = { "worker-1": w.seats["worker-1"], gate: w.gate, mirror: w.mirror }; run(w, 0, "gate"); assert(!fs.existsSync(path.join(mirrorDir, "invoked"))); },
  "auto-explicit-false": w => { w.gate.shadow = false; run(w, 0, "gate"); },
  "auto-busy-gate": w => { fs.mkdirSync(path.join(w.root, "seats/run"), { recursive: true }); fs.writeFileSync(path.join(w.root, "seats/run/verify.gate.json"), JSON.stringify({ pid: process.pid })); run(w, 4); assert.equal(invoked().length, 0); },
  "auto-shared-gate": w => { w.gate.account = { dir: authorDir }; refused(w, "SAME account directory"); },
  "auto-all-shadow": w => { w.gate.shadow = true; refused(w, "no non-shadow reviewer"); },
  "pool-shadow": w => {
    // Pools replace fixed seats for the roles they own. A workers-only pool
    // can coexist with this fixed gating/shadow review pair; a reviewer pool
    // cannot. Keep the retired author's identity in the supported state fallback.
    delete w.seats["worker-1"];
    fs.mkdirSync(path.join(w.root, "wheelhouse"), { recursive: true });
    fs.writeFileSync(path.join(w.root, "wheelhouse/.template-source"), "namespace=shadow\n");
    fs.writeFileSync(path.join(w.root, "seats/pool.json"), JSON.stringify({ version: 1, entries: { spare: { harness: "pi", provider: "openai", models: ["stub-model-v"], account: { dir: authorDir, authRoute: "oauth" } } }, roles: { workers: { min: 0, max: 1, entries: ["spare"], model: "stub-model-v" } } }));
    fs.writeFileSync(path.join(w.root, "seats/staffing.json"), JSON.stringify({ version: 1, seats: { "worker-spare": { role: "worker", entry: "spare" } }, rateLimited: {} }));
    fs.writeFileSync(path.join(w.root, "seats/state.json"), JSON.stringify({ seats: { "worker-1": { accountDir: authorDir } } }));
    run(w, 0, "gate");
  },
  "explicit-shadow": w => { w.explicit = true; refused(w, "shadow: true and never gates by default"); },
  "invalid-shadow": w => { (w.mirror as any).shadow = "true"; refused(w, "invalid shadow"); },
  "promoted": w => { promote(w); run(w, 0, "mirror"); },
  "promoted-actor-override": w => { promote(w); w.env.WHEELHOUSE_BEADS_ACTOR_COMMANDER = "fixture-commander"; w.comments[0].author = "fixture-commander"; run(w, 0, "mirror"); },
  "wrong-bead": w => { promote(w); w.comments[0].issue_id = "another-bead"; refused(w, "different bead"); },
  "wrong-seat": w => { promote(w); payload(w, { seat: "gate" }); refused(w, "different reviewer seat"); },
  "wrong-tip": w => { promote(w); payload(w, { tip: "0".repeat(40) }); refused(w, "different tip"); },
  "wrong-actor": w => { promote(w); w.comments[0].author = "worker-1"; refused(w, "must be recorded by commander actor"); },
  "missing-comment": w => { promote(w); w.comments = []; refused(w, "not uniquely found"); },
  "missing-basis": w => { promote(w); payload(w, { distinctAccountBasis: "" }); refused(w, "nonempty single-line"); },
  "comments-unavailable": w => { promote(w); w.env.STUB_BD_COMMENTS_FAIL = "1"; refused(w, "cannot read fallback promotion"); },
  "no-explicit-seat": w => { promote(w); w.explicit = false; payload(w, { seat: "gate" }); refused(w, "requires an explicit reviewer-seat"); },
  "duplicate-promotion": w => { promote(w); w.args.push("--fallback-promotion", commentId); refused(w, "may be supplied only once"); },
  "missing-lead-in": w => { promote(w); w.reply = "VERDICT: APPROVE\nPUSH: NOT CONSIDERED\n"; run(w, 1, undefined, "exact live lead-in"); assert(invoked().length); },
  "fenced-lead-in": w => { promote(w); w.reply = "```\n" + badge + "\n```\nVERDICT: APPROVE\nPUSH: NOT CONSIDERED\n"; run(w, 1, undefined, "exact live lead-in"); },
  "shadow-verdict": w => { promote(w); w.reply = badge + "\nVERDICT: APPROVE — SHADOW\nPUSH: NOT CONSIDERED\n"; run(w, 1, undefined, "not a SHADOW verdict"); },
  "reason-mentions-shadow": w => { promote(w); for (const [code, label] of [[0, "APPROVE"], [2, "BOUNCE"], [3, "DISCOVER"]] as const) { w.reply = badge + `\nVERDICT: ${label} — shadow selection inspected\nPUSH: NOT CONSIDERED\n`; run(w, code, "mirror"); } },
  "promoted-same-account": w => { promote(w); w.mirror.account = { dir: authorDir }; refused(w, "SAME account directory"); },
};
const earlyPromotion = 'function readFallbackPromotion(beadId: string, seat: string, tip: string, commentId: string): FallbackPromotion {';
const controls: { old: string; replacement: string; cases: string[] }[] = [
  { old: 'reviewers.filter(([, entry]) => entry.shadow !== true)', replacement: 'reviewers.filter(() => true)', cases: ["auto-orderings", "auto-explicit-false", "auto-busy-gate", "auto-shared-gate", "auto-all-shadow", "pool-shadow"] },
  { old: 'if (entry.shadow === true && !promotionId)', replacement: 'if (false)', cases: ["explicit-shadow"] },
  { old: 'typeof entry.shadow !== "boolean"', replacement: 'false', cases: ["invalid-shadow"] },
  { old: earlyPromotion, replacement: earlyPromotion + ' throw new Error("control: promotion disabled");', cases: ["promoted"] },
  { old: 'comment.issue_id !== beadId', replacement: 'false', cases: ["wrong-bead"] },
  { old: 'value.seat !== seat', replacement: 'false', cases: ["wrong-seat"] },
  { old: 'value.tip !== tip', replacement: 'false', cases: ["wrong-tip"] },
  { old: 'comment.author !== beadsActorFor("commander")', replacement: 'false', cases: ["wrong-actor"] },
  { old: 'comment.author !== beadsActorFor("commander")', replacement: 'comment.author !== "commander"', cases: ["promoted-actor-override"] },
  { old: earlyPromotion, replacement: earlyPromotion + ` return {commentId, author:"commander", seat, tip, outage:${JSON.stringify(outage)}, distinctAccountBasis:${JSON.stringify(basis)}};`, cases: ["missing-comment", "comments-unavailable"] },
  { old: '!value[k].trim()', replacement: 'false', cases: ["missing-basis"] },
  { old: 'if (promotionArg && !reviewerArg)', replacement: 'if (false)', cases: ["no-explicit-seat"] },
  { old: 'if (promotionArg !== undefined)', replacement: 'if (false)', cases: ["duplicate-promotion"] },
  { old: 'if (badges.length !== 1 || badges[0].normalized !== fallbackLeadIn(promotion))', replacement: 'if (false)', cases: ["missing-lead-in"] },
  { old: 'const badges = liveLineCandidates(stdout, reviewerHarness, "FALLBACK GATE");', replacement: 'const badges = finalAssistantText(stdout, reviewerHarness).split("\\n").filter(line => line === fallbackLeadIn(promotion)).map(normalized => ({normalized}));', cases: ["fenced-lead-in"] },
  { old: 'if (/^VERDICT:\\s*(?:APPROVE|BOUNCE|DISCOVER)\\s+[—-]\\s+SHADOW(?:\\s*$|\\s*[-:—(]|\\s+ONLY\\b)/i.test(verdictLines[0].normalized))', replacement: 'if (false)', cases: ["shadow-verdict"] },
  { old: 'if (/^VERDICT:\\s*(?:APPROVE|BOUNCE|DISCOVER)\\s+[—-]\\s+SHADOW(?:\\s*$|\\s*[-:—(]|\\s+ONLY\\b)/i.test(verdictLines[0].normalized))', replacement: 'if (/\\bSHADOW\\b/i.test(verdictLines[0].normalized))', cases: ["reason-mentions-shadow"] },
  { old: 'if (authorDir === reviewerDir) { // distinctness-gate', replacement: 'if (false) { // distinctness-gate', cases: ["promoted-same-account"] },
];
let failures = 0;
for (const [name, test] of Object.entries(tests)) {
  try { test(world()); console.log("PASS shadow " + name); }
  catch (e: any) { failures++; console.error("FAIL shadow " + name + ": " + e.message); }
}
const covered = new Set<string>();
for (const control of controls) {
  assert.equal(original.split(control.old).length, 2, "canary must hit exactly one source site: " + control.old);
  const source = original.replace(control.old, control.replacement);
  for (const name of control.cases) {
    let failed = false; try { tests[name](world(source)); } catch { failed = true; }
    if (!failed) { failures++; console.error("FAIL shadow removal control " + name); }
    else { covered.add(name); console.log("NEGATIVE shadow detected " + name); }
  }
}
assert.deepEqual([...covered].sort(), Object.keys(tests).sort());
console.log(`shadow reviewers: ${Object.keys(tests).length} cases, ${covered.size} failing removal controls, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
