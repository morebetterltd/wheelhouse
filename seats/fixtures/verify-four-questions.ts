// Actual dispatcher CLI with private scripted peers, never a model judgment.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command.ts";
const [implementation, scratch, selected = "all"] = process.argv.slice(2);
const runtime = path.dirname(implementation), root = path.resolve(scratch), bin = path.join(root, "bin"), home = path.join(root, "home");
assert(!fs.existsSync(root));
for (const dir of [root, bin, home, path.join(root, "seats"), path.join(root, "contracts")]) fs.mkdirSync(dir, { recursive: true });
for (const file of fs.readdirSync(runtime)) if (/\.(ts|sh)$/.test(file) && !file.endsWith(".selftest.sh")) fs.copyFileSync(path.join(runtime, file), path.join(root, "seats", file));
fs.copyFileSync(implementation, path.join(root, "seats/verify.ts"));
fs.writeFileSync(path.join(root, "contracts/REVIEWER.md"), "# Private scripted reviewer fixture\n");
const seats: any = {};
for (const [name, role] of [["author", "worker"], ["reviewer", "reviewer"]]) {
  const dir = path.join(home, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "auth.json"), '{"fixture":true}\n');
  seats[name] = { role, provider: "openai", model: "stub-model", account: { dir } };
}
fs.writeFileSync(path.join(root, "seats/seats.json"), JSON.stringify({ seats }));
fs.writeFileSync(path.join(root, "seats/selftest-core.list"), "fixture.selftest.sh\n");
fs.writeFileSync(path.join(root, "seats/fixture.selftest.sh"), '#!/usr/bin/env bash\nset -eu\nprintf "four-question fixture sweep PASS\\n"\n');
const commands: any[] = [], records: any[] = [];
function save() {
  const bytes = JSON.stringify({ implementation, source: fs.readFileSync(implementation, "utf8"), selected, commands, records }, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "results.json"), bytes);
  if (process.env.WHEELHOUSE_FOUR_QUESTIONS_EVIDENCE) {
    fs.mkdirSync(process.env.WHEELHOUSE_FOUR_QUESTIONS_EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(process.env.WHEELHOUSE_FOUR_QUESTIONS_EVIDENCE, `questions-${process.pid}.json`), bytes);
  }
}
function git(...args: string[]) {
  const r = completedCommand("git", args, { cwd: root }); commands.push({ args, ...r, error: r.error?.message }); save();
  assert.equal(r.status, 0, r.stderr); assert.equal(r.signal, null); assert(!r.error); return r.stdout.trim();
}
git("init", "-q", "-b", "main");
git("add", ...["selftest-core.list", "selftest-sweep.sh", "selftest-sweep-lock.ts", "native-command.ts", "completed-command.ts", "python-invocations.ts", "fixture.selftest.sh"].map(f => "seats/" + f));
git("-c", "user.name=selftest", "-c", "user.email=selftest@local", "-c", "commit.gpgsign=false", "commit", "-qm", "private question fixture"); git("branch", "fleet/questions");
const trace = fs.readFileSync(path.join(import.meta.dir, "verify-real/pi-v3-message-end.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
const seed = trace.findLast(e => e.type === "message_end" && e.message?.role === "assistant"); assert(seed);
fs.writeFileSync(path.join(root, "seed.json"), JSON.stringify(seed));
fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env bun
const fs=require('fs'),root=${JSON.stringify(root)};const event=JSON.parse(fs.readFileSync(root+'/seed.json','utf8'));
fs.writeFileSync(root+'/prompt.txt',process.argv.at(-1));event.message.content=[{type:'text',text:fs.readFileSync(root+'/reply.txt','utf8')}];
console.log(JSON.stringify(event));console.log(JSON.stringify({type:'agent_end',messages:[event.message]}));
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "bd"), '#!/usr/bin/env bash\ncase "$1" in init) mkdir -p .beads;; where) printf \'{"path":"%s/.beads"}\\n\' "$PWD";; *) exit 0;; esac\n', { mode: 0o755 });
const tags = ["SCOPE", "INTEGRITY", "SAFETY", "HEALTH"];
const fourOK = tags.map(t => `${t}: OK — read private fixture ${t.toLowerCase()} evidence`).join("\n");
const ending = (v: string) => `\nVERDICT: ${v}\nPUSH: NOT CONSIDERED\n`;
const defect = fourOK.replace("SCOPE: OK — read private fixture scope evidence", "SCOPE: DEFECT — unrelated.txt changed without a contract outcome calling for it");
const cases: Record<string, { reply: string; code: number; reason?: string }> = {
  approve: { reply: fourOK + ending("APPROVE"), code: 0 },
  "missing-health": { reply: fourOK.replace(/\nHEALTH:[^\n]*/, "") + ending("APPROVE"), code: 1, reason: "HEALTH: 0 live lines" },
  "approve-defect": { reply: defect + ending("APPROVE"), code: 1, reason: "APPROVE requires four OK" },
  "bounce-ok": { reply: fourOK + ending("BOUNCE"), code: 1, reason: "BOUNCE names no DEFECT" },
  bounce: { reply: defect + ending("BOUNCE"), code: 2 },
  duplicate: { reply: fourOK + "\nSAFETY: OK — read private fixture safety evidence" + ending("APPROVE"), code: 1, reason: "SAFETY: 2 live lines" },
  fenced: { reply: "```\n" + fourOK + "\n```" + ending("APPROVE"), code: 1, reason: "SCOPE: 0 live lines" },
  "tilde-fenced": { reply: "~~~text\n" + fourOK + "\n~~~" + ending("APPROVE"), code: 1, reason: "SCOPE: 0 live lines" },
  "bare-ok": { reply: fourOK.replace("HEALTH: OK — read private fixture health evidence", "HEALTH: OK") + ending("APPROVE"), code: 1, reason: "malformed HEALTH line" },
  "bare-defect": { reply: defect.replace(/SCOPE:[^\n]*/, "SCOPE: DEFECT") + ending("BOUNCE"), code: 1, reason: "malformed SCOPE line" },
  "bare-not-judged": { reply: fourOK.replace(/HEALTH:[^\n]*/, "HEALTH: NOT JUDGED") + ending("DISCOVER"), code: 1, reason: "malformed HEALTH line" },
  "invalid-status": { reply: fourOK.replace("HEALTH: OK", "HEALTH: MAYBE") + ending("DISCOVER"), code: 1, reason: "malformed HEALTH line" },
  "approve-not-judged": { reply: fourOK.replace("HEALTH: OK", "HEALTH: NOT JUDGED") + ending("APPROVE"), code: 1, reason: "APPROVE requires four OK" },
  "bounce-not-judged": { reply: fourOK.replace("HEALTH: OK", "HEALTH: NOT JUDGED") + ending("BOUNCE"), code: 1, reason: "BOUNCE names no DEFECT" },
  "bounce-scope-defect-health-not-judged": { reply: defect.replace("HEALTH: OK — read private fixture health evidence", "HEALTH: NOT JUDGED — health check not run after the scope defect") + ending("BOUNCE"), code: 2 },
  discover: { reply: fourOK.replace("HEALTH: OK", "HEALTH: NOT JUDGED") + ending("DISCOVER"), code: 3 },
  "long-evidence": { reply: fourOK.replace("scope evidence", "scope evidence " + "x".repeat(1300)) + ending("APPROVE"), code: 0 },
};
assert(selected === "all" || selected === "controls" || selected in cases, selected);
if (selected === "controls") {
  const source = fs.readFileSync(implementation, "utf8"), start = source.indexOf("      // four-question-parse:start"), endMark = "      // four-question-parse:end";
  const end = source.indexOf(endMark);
  assert(start >= 0 && end > start && source.indexOf(endMark, end + 1) === -1, "canary markers must bite exactly once");
  const cut = source.slice(0, start) + source.slice(end + endMark.length); assert.notEqual(cut, source, "cmp guard: canary must change bytes");
  fs.writeFileSync(path.join(root, "seats/verify.ts"), cut);
  const cmp = completedCommand("cmp", ["-s", implementation, path.join(root, "seats/verify.ts")], { cwd: root });
  commands.push({ file: "cmp", status: cmp.status, signal: cmp.signal, error: cmp.error?.message, stdout: cmp.stdout, stderr: cmp.stderr }); save();
  assert.equal(cmp.status, 1, "native cmp guard: canary must change bytes"); assert.equal(cmp.signal, null); assert(!cmp.error);
  assert(!fs.readFileSync(path.join(root, "seats/verify.ts"), "utf8").includes("// question-count"), "cmp guard: actual parse removed");
  for (const name of Object.keys(cases)) {
    const r = completedCommand("bun", [import.meta.filename, path.join(root, "seats/verify.ts"), path.join(root, "control-" + name), name], { cwd: root });
    records.push({ control: name, ...r, error: r.error?.message }); save();
    assert(!r.error && r.signal === null); assert.equal(r.status, 1, `canary ${name} must fail without the fix: ${r.stdout} ${r.stderr}`);
    assert(r.stderr.includes("FOUR_QUESTIONS_ORACLE"), `canary ${name} must reach its oracle, not fail setup: ${r.stderr}`);
    console.log(`PASS four questions canary ${name}: parse-cut copy rejected by intended oracle (native fixture 1)`);
  }
  // Commander ruling: a concrete DEFECT permits other questions NOT JUDGED.
  // Restore the retired restriction in actual copied source, not the reply.
  const restored = source.replace(endMark, '      if (verdict !== "DISCOVER" && questionLines.some(q => q.status === "NOT JUDGED")) refuse("NOT JUDGED requires DISCOVER"); // ruling-restored\n' + endMark);
  assert.notEqual(restored, source); fs.writeFileSync(path.join(root, "seats/verify.ts"), restored);
  const restoredCmp = completedCommand("cmp", ["-s", implementation, path.join(root, "seats/verify.ts")], { cwd: root });
  commands.push({ file: "cmp", control: "ruling-restored", status: restoredCmp.status, signal: restoredCmp.signal, error: restoredCmp.error?.message }); save();
  assert.equal(restoredCmp.status, 1); assert.equal(restoredCmp.signal, null); assert(!restoredCmp.error);
  const ruling = completedCommand("bun", [import.meta.filename, path.join(root, "seats/verify.ts"), path.join(root, "control-ruling-restored"), "bounce-scope-defect-health-not-judged"], { cwd: root });
  records.push({ control: "ruling-restored", ...ruling, error: ruling.error?.message }); save();
  assert.equal(ruling.status, 1); assert.equal(ruling.signal, null); assert(!ruling.error);
  assert(ruling.stderr.includes("FOUR_QUESTIONS_ORACLE bounce-scope-defect-health-not-judged") && ruling.stderr.includes("NOT JUDGED requires DISCOVER"), "restored policy must fail at its intended oracle after valid setup");
  console.log("PASS four questions ruling restored: actual retired guard rejects the valid BOUNCE (native fixture 1)");
  process.exit(0);
}
try {
  for (const [name, c] of Object.entries(cases)) {
    if (selected !== "all" && selected !== name) continue;
    fs.writeFileSync(path.join(root, "reply.txt"), c.reply);
    const bead = "questions-" + name, verdictPath = path.join(root, "seats/verdicts", bead + ".md");
    const r = completedCommand("bun", [path.join(root, "seats/verify.ts"), bead, "fleet/questions", "author", "reviewer"], { cwd: root, env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CONTRACT_FIXTURE: path.join(import.meta.dir, "contracts/valid.md") } });
    const record: any = { name, ...c, ...r, error: r.error?.message, verdict: fs.existsSync(verdictPath) ? fs.readFileSync(verdictPath, "utf8") : null }; records.push(record); save();
    assert(!r.error && r.signal === null, "FOUR_QUESTIONS_ORACLE native completion");
    assert.equal(r.status, c.code, `FOUR_QUESTIONS_ORACLE ${name}: ${r.stderr}`);
    if (c.code === 1) {
      assert.equal(record.verdict, null, "refusal must not publish a verdict"); assert(r.stderr.includes(c.reason!), `FOUR_QUESTIONS_ORACLE ${name} named refusal: ${r.stderr}`);
      const refused = fs.readdirSync(path.join(root, "seats/verdicts/refused")).filter(f => f.startsWith(bead + ".")); assert(refused.length > 0);
      assert(r.stderr.includes("refused"), "refusal must name raw output record");
    } else {
      assert(record.verdict, "actual verdict must exist");
      const inbox = fs.readFileSync(path.join(root, "seats/inbox.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s)).findLast(e => e.title === `verifier gate verdict — ${bead}`); assert(inbox);
      for (const tag of tags) {
        const line = c.reply.split("\n").find(s => s.startsWith(tag + ":"))!;
        assert(record.verdict.includes(`- ${tag.toLowerCase()}: ${line.slice(tag.length + 2)}`), `FOUR_QUESTIONS_ORACLE header ${tag}`);
        assert(inbox.detail.includes(line), `FOUR_QUESTIONS_ORACLE inbox ${tag}`);
      }
      const prompt = fs.readFileSync(path.join(root, "prompt.txt"), "utf8"); record.prompt = prompt; save();
      assert(prompt.includes("Read the whole diff") && prompt.includes("Do not walk a consumer surface or prove an outcome"), "FOUR_QUESTIONS_ORACLE role prompt");
      if (name === "bounce-scope-defect-health-not-judged") assert(prompt.includes("DISCOVER, and BOUNCE beside at least one DEFECT, may carry NOT JUDGED"), "FOUR_QUESTIONS_ORACLE ruling prompt");
    }
    console.log(`PASS four questions ${name}: native ${c.code}${c.reason ? "; " + c.reason : "; header and inbox carry four lines"}`);
  }
} finally { save(); }
