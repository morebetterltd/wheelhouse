import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const [runtime, parent] = process.argv.slice(2);
assert(fs.statSync(path.join(runtime, "seats/digest.ts")).isFile());
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
assert(!fs.existsSync(path.join(runtime, "seats/state.json")), "copy code, never a live fleet state");
const root = path.join(parent, "digest-data"), bin = path.join(root, "bin");
fs.mkdirSync(bin, { recursive: true });
for (const dir of ["seats", "wheelhouse"]) fs.mkdirSync(path.join(root, dir));
fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "namespace=fixture\nproduct-repo=.\n");
fs.writeFileSync(path.join(root, "seats/needs.jsonl"), "");
fs.writeFileSync(path.join(root, "seats/inbox.jsonl"), "");
fs.writeFileSync(path.join(root, "seats/seats.json"), '{"seats":{}}\n');
fs.writeFileSync(path.join(root, "bd-calls.jsonl"), "");
// Array/object field schema captured from bd 1.2.2 before fixture construction;
// identifiers/content below are synthetic. This is a volume/fault control,
// not a claim that an actual install has this many closed tasks.
const count = 2200;
const rows = Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, title: `Completed capture ${i}`, status: "closed", priority: 2, issue_type: "task", description: "Fixture payload. " + "payload ".repeat(140), created_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z", close_reason: `completed fixture-${i}`, labels: [] }));
fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify(rows) + "\n");
assert(fs.statSync(path.join(root, "graph.json")).size > 1024 * 1024);
fs.writeFileSync(path.join(bin, "bd"), String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=process.env.CAPTURE_ROOT,mode=fs.readFileSync(path.join(root,'mode'),'utf8').trim(),args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'bd-calls.jsonl'),JSON.stringify({mode,args})+'\n');
if(mode==='exit7'){process.stderr.write('native provider fault exit7\n');process.exit(7)}
if(mode==='empty')process.exit(0);
if(mode==='malformed'){process.stdout.write('not JSON\n');process.exit(0)}
if(args.includes('closed'))process.stdout.write(fs.readFileSync(path.join(root,'graph.json')));else process.stdout.write('[]\n');
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_ROOT: root, WHEELHOUSE_DIGEST_ROOT: root, WHEELHOUSE_NEEDS_ROOT: root };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function native(label: string, file: string, args: string[], cwd = root) {
  const out = path.join(parent, label + ".out"), err = path.join(parent, label + ".err");
  const a = fs.openSync(out, "wx", 0o600), b = fs.openSync(err, "wx", 0o600);
  let r;
  try { r = spawnSync(file, args, { cwd, env, stdio: ["ignore", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  const stdout = fs.readFileSync(out), stderr = fs.readFileSync(err);
  assert(!r.error && !r.signal, "native fixture command must start and complete");
  return { ...r, stdout, stderr };
}
assert.equal(native("init", "git", ["-c", "init.defaultBranch=main", "init", "-q"]).status, 0);
const digestSource = fs.readFileSync(path.join(runtime, "seats/digest.ts"), "utf8");
const engineSource = fs.readFileSync(path.join(runtime, "seats/native-command.ts"), "utf8");
const specs = [
  { mode: "large", file: "native-command.ts", old: "return completedCommand(file, args, { ...nativeOptions, ...policy, encoding });", replacement: "return pipeCapture(file, args, { ...options, encoding: options.encoding === 'buffer' ? undefined : options.encoding });", nativeEngine: true },
  { mode: "empty", file: "digest.ts", old: "JSON.parse(r.stdout)", replacement: 'JSON.parse(r.stdout || "[]")' },
  { mode: "malformed", file: "digest.ts", old: "}catch(e:any){ return unknown(`bd list JSON unavailable: ${e.message}`); }", replacement: "}catch(e:any){ return {rows:[],unavailable:false}; }" },
  { mode: "exit7", file: "digest.ts", old: 'if(r.error||r.signal||r.status!==0) return unknown("native bd list did not complete successfully");', replacement: "if(r.error||r.signal||r.status!==0) return {rows:[],unavailable:false};" },
];
for (const spec of specs) {
  fs.writeFileSync(path.join(root, "mode"), spec.mode + "\n");
  // Capture real native provider bytes/status BEFORE exercising the consumer.
  const reference = native(spec.mode + "-reference", "bd", ["list", "--json", "--limit", "0", "--status", "closed"]);
  assert.equal(reference.status, spec.mode === "exit7" ? 7 : 0);
  if (spec.mode === "large") assert(reference.stdout.equals(fs.readFileSync(path.join(root, "graph.json"))));
  console.log("CAPTURE native-digest " + JSON.stringify({ mode: spec.mode, command: ["bd", "list", "--json", "--limit", "0", "--status", "closed"], status: reference.status, stdoutBytes: reference.stdout.length, stderrBytes: reference.stderr.length, stdoutSha256: sha(reference.stdout), stderrSha256: sha(reference.stderr) }));
  function observe(codeRoot: string, label: string) {
    const r = native(label, "bun", [path.join(import.meta.dir, "native-digest-child.ts"), codeRoot, root, spec.mode]);
    assert.equal(r.status, 0, "consumer setup/driver must complete: " + r.stderr.toString());
    const result = JSON.parse(r.stdout.toString());
    assert.equal(result.providerCalls, 2, "both actual consumer commands reached the intended provider");
    return result;
  }
  function check(result: any) {
    if (spec.mode === "large") { assert.equal(result.unavailable, false); assert.equal(result.shipped, count, "all actual native graph rows retained"); }
    else assert.equal(result.unavailable, true, "invalid/failed graph is unknown, never empty success");
  }
  check(observe(runtime, spec.mode + "-positive"));
  console.log("PASS native-digest " + spec.mode);
  const mutant = path.join(parent, "digest-mutant-" + spec.mode);
  fs.cpSync(runtime, mutant, { recursive: true });
  const source = spec.nativeEngine ? engineSource : digestSource;
  assert.equal(source.split(spec.old).length - 1, 1, "specific source removal must match once");
  let changed = source.replace(spec.old, () => spec.replacement);
  if (spec.nativeEngine) changed = 'import { spawnSync as pipeCapture } from "node:child_process";\n' + changed;
  fs.writeFileSync(path.join(mutant, "seats", spec.file), changed);
  const rejected = observe(mutant, spec.mode + "-removed");
  assert.throws(() => check(rejected), assert.AssertionError, "meaningful removal must reject with a valid provider/consumer setup");
  console.log("REJECT native-digest " + spec.mode + " driverNative=0 providerCalls=2");
}
console.log("PASS native-digest: 4 observations, 4 meaningful removals; no missing-provider/setup success");
