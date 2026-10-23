import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [runtime, parent] = process.argv.slice(2);
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
const engine = path.join(runtime, "seats/native-command.ts"), source = fs.readFileSync(engine, "utf8");
const { nativeJsonArray } = await import(pathToFileURL(engine).href);
function capture(label: string, command: string, args: string[], cwd: string, env = process.env) {
  const out = path.join(parent, label + ".out"), err = path.join(parent, label + ".err");
  const a = fs.openSync(out, "wx", 0o600), b = fs.openSync(err, "wx", 0o600); let r;
  try { r = spawnSync(command, args, { cwd, env, stdio: ["ignore", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  assert(!r.error && !r.signal, "actual native fixture input required");
  const stdout = fs.readFileSync(out, "utf8"), stderr = fs.readFileSync(err, "utf8");
  console.log("CAPTURE native-json " + JSON.stringify({ label, command: [command, ...args], status: r.status, signal: r.signal, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: createHash("sha256").update(stdout).digest("hex") }));
  return { ...r, stdout, stderr };
}
const specs = [
  { name: "empty", body: "", code: 0, old: 'JSON.parse(String(result.stdout ?? ""))', replacement: 'JSON.parse(String(result.stdout || "[]"))' },
  { name: "shape", body: "{}\n", code: 0, old: 'if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || required.some(key => !(key in row)))) refuse("expected a complete record array");', replacement: 'if (!Array.isArray(rows)) return [];' },
  { name: "native-failure", body: "[]\n", code: 23, old: 'if (result.error || result.signal || result.status !== 0) refuse(result.error?.message ?? "native command did not complete successfully");', replacement: 'if (result.error || result.signal) refuse("native command failed");' },
];
for (const s of specs) {
  const data = path.join(parent, s.name + ".input"), script = path.join(parent, s.name + ".sh");
  fs.writeFileSync(data, s.body); fs.writeFileSync(script, `cat "$1"\nexit ${s.code}\n`);
  // Real native stdout and nonzero exit are captured before constructing the
  // parser expectation. No guessed SpawnSync result stands in for the record.
  const result = capture(s.name, "sh", [script, data], parent); assert.equal(result.status, s.code);
  assert.throws(() => nativeJsonArray(result, s.name), Error, "unknown native input must be refused");
  console.log("PASS native-json " + s.name);
  const dir = path.join(parent, "json-mutant-" + s.name); fs.mkdirSync(dir);
  fs.copyFileSync(path.join(runtime, "seats/completed-command.ts"), path.join(dir, "completed-command.ts"));
  assert.equal(source.split(s.old).length - 1, 1, "specific parser guard required");
  fs.writeFileSync(path.join(dir, "native-command.ts"), source.replace(s.old, () => s.replacement));
  const mutant = (await import(pathToFileURL(path.join(dir, "native-command.ts")).href)).nativeJsonArray;
  assert.throws(() => assert.throws(() => mutant(result, s.name), Error), assert.AssertionError, "removed guard must produce false empty success on this actual native record");
  console.log("REJECT native-json " + s.name + " native=" + result.status);
}

const floorSource = fs.readFileSync(path.join(runtime, "seats/floor.ts"), "utf8");
const old = 'const out = execFileSync("bd", ["ready", "--json", "--limit", "0"], { encoding: "utf8" });\n    const rows = JSON.parse(out);\n    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("bd ready did not return an issue array");\n    count = rows.length;';
assert.equal(floorSource.split(old).length - 1, 1);
const legacy = 'const out = execFileSync("bd", ["ready"], {encoding:"utf8"});\n    count = out.split("\\n").filter(line=>/\\S/.test(line)&&!/no issues|nothing/i.test(line)).length;';
function floor(removed: boolean) {
  const root = path.join(parent, "floor-count-" + (removed ? "removed" : "positive")); fs.cpSync(runtime, root, { recursive: true });
  if (removed) fs.writeFileSync(path.join(root, "seats/floor.ts"), floorSource.replace(old, () => legacy));
  for (const dir of ["bin", "wheelhouse"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "seats/seats.json"), JSON.stringify({ seats: { worker: { role: "worker", cwd: root } } }) + "\n"); fs.writeFileSync(path.join(root, "seats/state.json"), '{"seats":{}}\n');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root, "seats/seats.json"), "utf8")).seats).length, 1, "a real roster subject must exist before measuring the status view");
  // bd 1.2.2's real ready renderer was captured before fixture construction:
  // issue rows plus separator/Ready/Status footer. Replace private content;
  // only the JSON records, never these display lines, define the cardinality.
  const rows = [{ id: "fixture-a111", title: "First", status: "open" }, { id: "fixture-b222", title: "Second", status: "open" }];
  const pretty = "○ fixture-a111 ● P2 First\n○ fixture-b222 ● P2 Second\n\n----------------\nReady: 2 issues with no active blockers\n\nStatus: ○ open  ◐ in_progress  ● blocked  ✓ closed  ❄ deferred\n";
  fs.writeFileSync(path.join(root, "bin/bd"), `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes('--json')?${JSON.stringify(JSON.stringify(rows) + "\n")}:${JSON.stringify(pretty)});\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(root, "bin") + ":" + process.env.PATH, NO_COLOR: "1" };
  const reference = capture("floor-reference-" + removed, "bd", ["ready", "--json", "--limit", "0"], root, env); assert.equal(reference.status, 0); assert.equal(JSON.parse(reference.stdout).length, 2);
  const actual = capture("floor-" + removed, "bun", [path.join(root, "seats/floor.ts"), "--once", "--pin", "0"], root, env); assert.equal(actual.status, 0);
  return actual.stdout;
}
assert.match(floor(false), /bd ready: 2 bead\(s\) waiting/); console.log("PASS native-json floor-machine-count");
assert.throws(() => assert.match(floor(true), /bd ready: 2 bead\(s\) waiting/), assert.AssertionError); console.log("REJECT native-json floor-machine-count native=0");
console.log("PASS native-json: 4 observations, 4 meaningful removals; native failure/schema uncertainty and real machine cardinality");
