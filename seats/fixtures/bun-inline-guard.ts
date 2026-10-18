import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { auditTracked, inlinePrograms, unsafeInline } from "../bun-inline";

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

// Each new shape has a real Bun subject (not just a zero-error assertion).
// Payloads are inert source data; never execute the planted CommonJS programs.
const q = JSON.stringify;
const apiCases: [string, (code: string) => string][] = [
  ["spawn preload eval", code => `spawn("bun", ["--preload", "guard.cjs", "-e", ${q(code)}]);`],
  ["spawnSync cwd print", code => `spawnSync("bun", ["--cwd", "fixture", "-p", ${q(code)}]);`],
  ["execFile long eval", code => `execFile("bun", ["--eval", ${q(code)}]);`],
  ["execFileSync long print", code => `execFileSync("bun", ["--print", ${q(code)}]);`],
  ["equals eval", code => `spawnSync("bun", [${q('--eval=' + code)}]);`],
  ["equals print", code => `spawnSync("bun", [${q('--print=' + code)}]);`],
  ["namespace call", code => `cp.spawnSync("bun", ["--preload", "guard.cjs", "-e", ${q(code)}]);`],
  ["import alias", code => `import {spawnSync as launch} from "node:child_process"; launch("bun", ["--preload", "guard.cjs", "-e", ${q(code)}]);`],
  ["execPath binding", code => `const bin = process.execPath; const code: string = ${q(code)}; execFileSync(bin, ["--preload", "guard.cjs", "-e", code]);`],
  ["named argv/options", code => `const code = ${q(code)}; const prefix = ["--preload", "guard.cjs"]; const argv = [...prefix, "-p", code]; const options = {encoding:"utf8"}; spawnSync("bun", argv, options);`],
  ["Bun.spawn argv", code => `Bun.spawn(["bun", "-e", ${q(code)}]);`],
  ["Bun.spawnSync object", code => `Bun.spawnSync({cmd:["bun", "--preload", "guard.cjs", "-p", ${q(code)}]});`],
  ["Bun.spawn named object", code => `const payload = ${q(code)}; const argv = ["bun", "--eval", payload]; const options = {cmd:argv}; Bun.spawn(options);`],
  ["stdin input dash", code => `spawnSync("bun", ["-"], {input:${q(code)}});`],
  ["stdin input implicit", code => `spawnSync("bun", [], {input:${q(code)}});`],
  ["stdin input flags only", code => `spawnSync("bun", ["--preload", "guard.cjs"], {input:${q(code)}});`],
  ["stdin named buffer", code => `const code = ${q(code)}; const options = {input:Buffer.from(code)}; execFileSync("bun", ["--preload", "guard.cjs", "-"], options);`],
  ["Bun stdin Blob", code => `const code = ${q(code)}; Bun.spawn({cmd:["bun", "-"], stdin:new Blob([code])});`],
  ["Bun stdin Buffer", code => `Bun.spawnSync(["bun"], {stdin:Buffer.from(${q(code)})});`],
  ["child stdin end", code => `const child = spawn("bun", ["-"], {stdio:["pipe","pipe","pipe"]}); child.stdin.end(${q(code)});`],
  ["Bun child stdin write", code => `const child = Bun.spawn(["bun", "-"], {stdin:"pipe"}); child.stdin.write(${q(code)}); child.stdin.end();`],
  ["local child stdin write", code => `const run = () => { const code = ${q(code)}; const child = spawn("bun", ["-"]); child.stdin.write(code); };`],
  ["spawnSync options overload", code => `spawnSync("bun", {input:${q(code)}});`],
  ["execFileSync options overload", code => `execFileSync("bun", {input:${q(code)}});`],
  ["child implicit stdin", code => `const child = spawn("bun"); child.stdin.end(${q(code)});`],
  ["preload multiline template", code => `spawnSync("bun", ["--preload", "guard.cjs", "-e", \`\n${code}\n\`]);`],
  ["named multiline template", code => `const code = \`\n${code}\n\`; spawnSync("bun", ["--preload", "guard.cjs", "-e", code]);`],
];
for (const [name, make] of apiCases) {
  for (const [kind, code] of [["require", cjs], ["module", mod]]) test(`programmatic rejects ${name} ${kind}`, () => {
    const source = make(code);
    assert.equal(inlinePrograms(source).length, 1, 'must inspect exactly one inline program');
    assert.equal(unsafeInline(source).length, 1, source);
  });
  test(`programmatic allows ESM ${name}`, () => {
    const source = make('import assert from "node:assert/strict"; assert.equal(1,1)');
    assert.equal(inlinePrograms(source).length, 1, 'ESM allowance must not be a missed call');
    assert.equal(unsafeInline(source).length, 0, source);
  });
}
for (const [name, source, bun] of [
  ["explicit Node", `spawnSync("node", ["--preload", "guard.cjs", "-e", ${q(cjs)}]);`, apiCases[0][1](cjs)],
  ["Bun spawning Node", `Bun.spawn({cmd:["node", "-e", ${q(cjs)}]});`, apiCases[10][1](cjs)],
  ["entry file arguments", `spawnSync("bun", ["checked-in.cjs", "-e", ${q(cjs)}]);`, apiCases[0][1](cjs)],
  ["source string data", `const data = ${q(apiCases[0][1](cjs))};`, apiCases[0][1](cjs)],
  ["comment data", `// ${apiCases[0][1](cjs)}\n`, apiCases[0][1](cjs)],
]) test(`programmatic exempts ${name}, detects Bun counterpart`, () => {
  assert.equal(unsafeInline(source).length, 0, source);
  assert.equal(unsafeInline(bun).length, 1, 'must recognize the corresponding Bun program');
});
const plantRoot = process.argv[3];
assert(plantRoot && fs.statSync(plantRoot).isDirectory(), 'owned shell fixture argument required');
const auditRoot = path.join(plantRoot, 'tracked-programmatic');
fs.mkdirSync(path.join(auditRoot, 'seats'), {recursive:true});
const git = (...args: string[]) => { const r = spawnSync('git', ['-C', auditRoot, ...args], {encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
git('init', '-q');
fs.writeFileSync(path.join(auditRoot,'seats/bun-inline.ts'), '// required audit root marker\n');
git('add', '.');
for (const ext of ['ts','js','mjs','cjs']) test(`tracked ${ext} plant fails with file:line and Node remains exempt`, () => {
  const file = `plant.${ext}`, full = path.join(auditRoot,file);
  fs.writeFileSync(full, `// planted source, not executed\n${apiCases[0][1](cjs)}\n`); git('add',file);
  try {
    const bad = auditTracked(auditRoot);
    assert.equal(bad.errors.length,1,bad.errors.join('\n'));
    assert.match(bad.errors[0],new RegExp(`^plant\\.${ext}:2: CommonJS in Bun programmatic -e;`));
    fs.writeFileSync(full, `// exempt Node, not Bun\nspawnSync("node", ["-e", ${q(cjs)}]);\n${apiCases[0][1]('import fs from "node:fs";')}\n`);
    const good = auditTracked(auditRoot); assert.equal(good.errors.length,0,good.errors.join('\n')); assert.equal(good.programs,1,'must scan the safe Bun counterpart');
  } finally { fs.unlinkSync(full); git('rm','-q','--cached',file); }
});

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
