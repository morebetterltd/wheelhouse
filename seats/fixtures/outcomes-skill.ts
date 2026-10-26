// Real skill/example tree and CLI checks; work must be an owned selftest directory.
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [root, contract, work] = process.argv.slice(2);
assert(root && contract && work);
assert(fs.statSync(root).isDirectory());
assert(fs.statSync(contract).isFile());
fs.mkdirSync(work, { recursive: true });
const skillDir = path.join(root, ".agents/skills/outcomes");
const names = ["goal", "user-report", "isa-gap"];
const parser = await import(contract);
let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS outcomes ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL outcomes ${name}: ${e.message}`); }
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv, stem: string) {
  const r = spawnSync(command, args, { env, encoding: "utf8", timeout: 30000 });
  // Preserve real tool output before parsing it or normalizing fixture ids.
  fs.writeFileSync(path.join(work, stem + ".json"), JSON.stringify({ command: [command, ...args], status: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr }, null, 2) + "\n");
  assert(!r.error, String(r.error)); assert.equal(r.signal, null);
  return r;
}
const env = { ...process.env, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CONTRACT_ROOT: work, WHEELHOUSE_INTAKE_FIXTURE: path.join(work, "posted-fixture.jsonl") };
const posted: string[] = [];
function check(file: string, stem: string) { return run("bun", [contract, "check", "--file", file], env, stem); }

test("layout and frontmatter", () => {
  const text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const front = text.match(/^---\n([\s\S]+?)\n---\n/); assert(front, "YAML frontmatter missing");
  const fields = Bun.YAML.parse(front[1]) as Record<string, unknown>;
  assert.equal(fields.name, "outcomes"); assert.equal(fields.version, "1.1.0");
  assert.equal(typeof fields.description, "string");
  for (const trigger of ["write the outcomes", "definition of done", "what does done look like", "acceptance criteria"]) assert(String(fields.description).includes(trigger), "missing trigger " + trigger);
  const link = path.join(root, ".claude/skills/outcomes"); assert(fs.lstatSync(link).isSymbolicLink(), "compatibility path is not a symlink");
  assert.equal(fs.readlinkSync(link), "../../.agents/skills/outcomes");
  assert.equal(fs.realpathSync(path.join(link, "SKILL.md")), fs.realpathSync(path.join(skillDir, "SKILL.md")));
  const indexed = run("git", ["-C", root, "ls-files", "--stage", "--", ".claude/skills/outcomes"], process.env, "indexed-link");
  assert.equal(indexed.status, 0, indexed.stderr); assert.match(indexed.stdout, /^120000 [0-9a-f]+ 0\t\.claude\/skills\/outcomes\n$/);
});
test("neutral skill directory", () => {
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else { assert(entry.isFile(), "non-regular skill entry"); assert(!/lifeos|pai\b|\.cursor|cursor|claude|codex|\bpi\b|chatgpt|openai|anthropic|gemini/i.test(fs.readFileSync(file, "utf8")), "non-neutral text in " + file); }
    }
  }
  walk(skillDir);
});
for (const name of names) test("example " + name, () => {
  const file = path.join(skillDir, "examples", name + ".md");
  const text = fs.readFileSync(file, "utf8"), parsed = parser.parseContract(text);
  const source = fs.readFileSync(path.join(root, ".agents/skills/intent/examples", name + ".md"), "utf8");
  assert(source.includes("## Intent\nIntent:\n"), "source intent absent");
  const intent = source.split("## Intent\nIntent:\n")[1].trim();
  assert.equal(parsed.intent, intent, "intent differs from shipped source example");
  // Historical examples keep the versions that wrote them; map-* examples
  // exercise the new rule/version separately, not by rewriting old provenance.
  assert.equal(parsed.skills, "intent@1.0.0 outcomes@1.0.0"); assert.match(parsed.signal, /^sig-[a-z0-9]+$/);
  const outcomeCount = (text.match(/^- O[0-9]+ /gm) ?? []).length;
  const consumerCount = (text.match(/^  consumer: (person-on-surface|person-reading|machine) — /gm) ?? []).length;
  assert(outcomeCount > 0); assert.equal(consumerCount, outcomeCount, "consumer/outcome count mismatch");
  if (name === "goal") assert(parsed.outcomes.some((o: any) => o.group === "person-reading"));
  if (name === "user-report") for (const group of ["person-on-surface", "machine"]) assert(parsed.outcomes.some((o: any) => o.group === group), "user report lacks " + group);
  console.log("OUTCOMES_CONSUMER_COUNTS " + JSON.stringify({ name, outcomes: outcomeCount, consumers: consumerCount }));
  const nativeRoot = path.join(work, name + "-native");
  const nativeEnv = { ...process.env, WHEELHOUSE_INTAKE_ROOT: nativeRoot };
  const post = run("bun", [path.join(path.dirname(contract), "intake.ts"), "post", "--kind", name === "goal" ? "goal" : name === "isa-gap" ? "isa-change" : "report", "--source", "outcomes-example", "--title", "Invented " + name, "--text", "Invented Basket Ledger example"], nativeEnv, name + "-post");
  assert.equal(post.status, 0, post.stderr); assert.equal(post.stderr, "");
  assert.match(post.stdout, /^sig-[a-z0-9]{4}\n$/);
  // Derive the fixture from the captured owner CLI's posted JSONL row.
  // Normalize only the random id into a fixture file; never rewrite intake.jsonl.
  const raw = fs.readFileSync(path.join(nativeRoot, "seats/intake.jsonl"), "utf8");
  fs.writeFileSync(path.join(work, name + "-native.jsonl"), raw);
  const row = JSON.parse(raw); assert.equal(row.type, "posted"); assert.equal(row.id, post.stdout.trim());
  posted.push(raw.replaceAll(row.id, parsed.signal).trimEnd());
  fs.writeFileSync(env.WHEELHOUSE_INTAKE_FIXTURE, posted.join("\n") + "\n");
  const result = check(file, name + "-check");
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  console.log("OUTCOMES_EXAMPLE_CHECK " + JSON.stringify({ name, code: result.status, stdout: result.stdout, stderr: result.stderr }));
});
test("user-report group/check mismatch refused", () => {
  const text = fs.readFileSync(path.join(skillDir, "examples/user-report.md"), "utf8");
  assert.equal((text.match(/^  check: walk — /gm) ?? []).length, 1, "must mutate exactly the person-on-surface check");
  const file = path.join(work, "user-report-mismatch.md");
  fs.writeFileSync(file, text.replace("  check: walk — ", "  check: run — "));
  const result = check(file, "mismatch-check");
  assert.equal(result.status, 2, result.stderr); assert.equal(result.stdout, "");
  assert(result.stderr.includes("O1: check: person-on-surface requires walk, got run"), result.stderr);
  console.log("OUTCOMES_MISMATCH_CHECK " + JSON.stringify({ code: result.status, stdout: result.stdout, stderr: result.stderr }));
});
console.log(`outcomes-skill checks: ${passed} PASS / ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
