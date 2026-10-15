import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { auditTracked, unsafeInline } from "../bun-inline";

let failures = 0, checks = 0;
function test(name: string, run: () => void) {
  checks++;
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
// Construct the intentionally unsafe probe/fixture source as data, not another
// executable inline CJS call for the source guard to exempt wholesale.
const cjs = 'requ' + 'ire("node:assert/strict").equal(1,2)';
const mod = 'mod' + 'ule.exports=1; throw Error("inline CJS probe")';
const call = (mode: string, code: string) => `bun ${mode} '${code}'`;
const stdin = ["bun", "-"].join(" ");
const unsafe = [
  ["eval require", call("-e", cjs)],
  ["print require", call("-p", cjs)],
  ["eval module", call("-e", mod)],
  ["print module", call("-p", mod)],
  ["multiline eval", call("-e", `\n${cjs}\n`)],
  ["double-quoted eval", `bun -e "${cjs.replaceAll('"', '\\"')}"`],
  ["stdin quoted heredoc", `${stdin} <<'JS'\n${cjs}\nJS\n`],
  ["stdin arguments", `${stdin} "$ROOT" <<'JS'\n${mod}\nJS\n`],
  ["stdin tab-stripped heredoc", `${stdin} <<-JS\n\t${cjs}\n\tJS\n`],
  ["stdin printf pipeline", `printf %s '${cjs}' | ${stdin}\n`],
  ["stdin echo pipeline", `echo '${mod}' | ${stdin}\n`],
  ["runtime selector", `$json_runtime -e '${cjs}'`],
  ["runtime selector with Node flags", `"$json_runtime" \${json_runtime_flag:+"$json_runtime_flag"} -e '${cjs}'`],
  ["shell substitution inside JS word", `bun -e "const value='$(${ 'helper "$ARG"' })'; ${cjs.replaceAll('"', '\\"')}"`],
  ["programmatic Bun template", 'const code = `' + cjs + '`; spawnSync(process.execPath, ["-e", code]);'],
  ["programmatic literal eval", `spawnSync("bun", ["-e", '${cjs}']);`],
  ["programmatic literal print", `spawn(process.execPath, ["-p", '${mod}']);`],
  ["generated shell eval", 'const script = `' + cjs + '`; return `\'${process.execPath.replace(x,y)}\' -e \'${script.replace(x,y)}\'`;'],
];
for (const [name, source] of unsafe) test(`guard rejects ${name}`, () => assert.equal(unsafeInline(source).length, 1));
for (const [name, source] of [
  ["Node CJS", `node -e '${cjs}'`],
  ["Bun file CJS", `bun checked-in.cjs\n${cjs}`],
  ["Bun ESM eval", call("-e", 'import fs from "node:fs"; JSON.parse(fs.readFileSync("file.json","utf8"))')],
  ["Bun ESM stdin", `${stdin} <<'JS'\nimport assert from "node:assert/strict"; assert.equal(1,1);\nJS\n`],
]) test(`guard allows ${name}`, () => assert.equal(unsafeInline(source).length, 0));
test("guard refuses unterminated stdin heredoc", () => assert.throws(() => unsafeInline(`${stdin} <<'JS'\n${cjs}`), /unterminated/));

for (const mode of ["-e", "-p", "-"]) {
  const esm = 'import assert from "node:assert/strict"; assert.equal(1,2)';
  test(`live ESM false assertion fails in ${mode}`, () => {
    const result = spawnSync(process.execPath, mode === "-" ? [mode] : [mode, esm], { input: mode === "-" ? esm : undefined, encoding: "utf8" });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 1); assert.match(result.stderr, /AssertionError/);
  });
  for (const [kind, code] of [["require", cjs], ["module", mod]]) test(`live CJS ${kind} probe ${mode}`, () => {
    const result = spawnSync(process.execPath, mode === "-" ? [mode] : [mode, code], { input: mode === "-" ? code : undefined, encoding: "utf8" });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert([0, 1].includes(result.status!), `unexpected probe status ${result.status}`);
    if (result.status === 1) assert.match(result.stderr, kind === "require" ? /AssertionError/ : /inline CJS probe/);
    console.log(`Bun ${Bun.version} CJS ${kind} ${mode}: ${result.status === 0 ? "BUG PRESENT (uncaught error exited 0)" : "bug not observed (exit 1)"}; stdout=${result.stdout.length} stderr=${result.stderr.length}`);
  });
}
test("live file-based CJS throw fails", () => {
  const file = `${process.argv[2]}/seats/fixtures/pid-write-fault.cjs`;
  assert(fs.statSync(file).isFile(), "checked-in CJS helper must exist");
  const result = spawnSync(process.execPath, [file, "invalid-mode"], { encoding: "utf8" });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 1); assert.match(result.stderr, /usage: pid-write-fault/);
});
test("tracked-file audit", () => {
  const result = auditTracked(process.argv[2]);
  assert.equal(result.errors.length, 0, result.errors.join("\n"));
  assert(result.files > 0 && result.programs > 0, "guard examined no subjects");
  console.log(`Bun inline guard: PASS (${result.files} tracked files, ${result.programs} programs)`);
});
console.log(`bun-inline.selftest: ${failures ? "FAIL" : "PASS"} (${checks} checks, ${failures} failures)`);
process.exitCode = failures ? 1 : 0;
