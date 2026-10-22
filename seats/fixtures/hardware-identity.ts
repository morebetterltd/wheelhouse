import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [root, seats] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const original = fs.readFileSync(path.join(seats, "selftest-sweep-lock.ts"), "utf8");
const replace = (s: string, a: string, b: string) => { assert.equal(s.split(a).length, 2, a); return s.replace(a, b); };
async function run(file: string, args: string[]) {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", b => stdout += b); child.stderr!.on("data", b => stderr += b);
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout, stderr };
}
let raw: string;
if (process.platform === "darwin") {
  const captured = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  assert.equal(captured.code, 0, captured.stderr); assert.equal(captured.signal, null); assert.equal(captured.stderr, "");
  raw = captured.stdout;
  assert.match(raw, /^\s*"IOPlatformUUID" = "[0-9A-Fa-f-]+"\s*$/m);
} else {
  assert.equal(process.platform, "linux"); raw = fs.readFileSync("/etc/machine-id", "utf8"); assert.match(raw.trim(), /^[0-9a-f]{32}$/i);
}
const data = path.join(root, "native.raw"); fs.writeFileSync(data, raw, { mode: 0o600 });
const options = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 1024 * 1024 };
const hook = replace(original,
  'import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";',
  'import { execFileSync as nativeExecFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";\nfunction execFileSync(...args: any[]): any { (nativeExecFileSync as any)(...args); return ""; }');
async function moduleCopy(name: string, source: string) {
  const file = path.join(root, name + ".ts"); fs.writeFileSync(file, source); return await import(file);
}
function exact(value: string) {
  assert.equal(Buffer.byteLength(value), Buffer.byteLength(raw), "native provider bytes must not come from the empty synchronous return");
  assert.equal(value === raw, true, "native bytes must be exact (private hardware bytes are not assertion payloads)");
}
const files = () => fs.readdirSync(os.tmpdir()).filter(x => x.startsWith("wheelhouse-native-identity-")).sort();
const before = files(), fixed = await moduleCopy("empty-return", hook);
exact(fixed.readIdentityProvider("/bin/cat", [data], options));
assert.throws(() => fixed.readIdentityProvider("/bin/cat", [data], { ...options, maxBuffer: Buffer.byteLength(raw) - 1 }), (e: any) => e.code === "ENOBUFS");
assert.deepEqual(files(), before, "capture files/descriptors retired after success and rejection");
console.log("PASS native capture: real bytes survive empty sync-return fault; bounded read and private cleanup");
// Same checker must reject the old stdout-pipe-result implementation.
const start = original.indexOf("export function readIdentityProvider("), end = original.indexOf("function stableHostId(): string {");
assert(start > 0 && end > start);
const removed = hook.slice(0, hook.indexOf("export function readIdentityProvider(")) +
  'export function readIdentityProvider(file: string, args: string[], options: any): string { return execFileSync(file, args, options); }\n' +
  hook.slice(hook.indexOf("function stableHostId(): string {"));
const old = await moduleCopy("pipe-result-removed", removed);
let rejected = false;
try { exact(old.readIdentityProvider("/bin/cat", [data], options)); }
catch (e: any) { if (e.code !== "ERR_ASSERTION" || e.actual !== 0 || e.expected !== Buffer.byteLength(raw)) throw e; rejected = true; }
assert(rejected); console.log("EXPECTED_REJECTION pipe-result native bytes lost to empty return; same byte checker rejected removed fix");

// Bad provider data must remain hostname fallback, not a forged hardware proof.
for (const kind of ["empty", "truncated", "malformed"]) {
  const bytes = kind === "empty" ? "" : kind === "truncated" ? raw.slice(0, Math.max(1, raw.indexOf("IOPlatformUUID") + 18)) : "not a hardware identity\n";
  const input = path.join(root, kind + ".raw"); fs.writeFileSync(input, bytes);
  let badSource: string;
  if (process.platform === "darwin") {
    const provider = path.join(root, kind + ".sh");
    fs.writeFileSync(provider, `#!/bin/sh\nexec /bin/cat '${input.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
    badSource = replace(original, 'readIdentityProvider("/usr/sbin/ioreg",', `readIdentityProvider(${JSON.stringify(provider)},`);
  } else badSource = replace(original, 'fs.readFileSync("/etc/machine-id", "utf8")', `fs.readFileSync(${JSON.stringify(input)}, "utf8")`);
  const bad = await moduleCopy("bad-" + kind, badSource);
  const fallback = (module: any) => assert.equal(module.stableHostIdentity().source, "hostname", kind + " must not become hardware identity");
  fallback(bad);
  // Plant the forbidden hardware label at the fallback decision itself. This
  // still executes the bad provider, but cannot lose the fault merely because
  // that command took an error path before a forged parser input was reached.
  const mutant = await moduleCopy("bad-accepted-" + kind, replace(badSource,
    '  identitySource = "hostname";\n  return digest(`hostname:${HOST}`);',
    '  identitySource = darwin ? "darwin-ioplatformuuid" : "linux-machine-id";\n  return digest(`hostname:${HOST}`);'));
  rejected = false;
  try { fallback(mutant); } catch (e: any) { if (e.code !== "ERR_ASSERTION" || e.expected !== "hostname" || e.actual === "hostname") throw e; rejected = true; }
  assert(rejected); console.log(`PASS ${kind}: hostname fallback retained; false hardware-upgrade mutant rejected`);
}

// Closing an unadmitted gate is its exit instruction. Do not forward a signal
// to a dying numeric group before joining the original child's native close.
async function refusal(source: string, name: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir); const trace = path.join(dir, "forwards");
  const instrumented = replace(source, '  const forward = (signal: NodeJS.Signals) => {',
    `  const forward = (signal: NodeJS.Signals) => {\n    if (!owned && !interrupted) fs.appendFileSync(${JSON.stringify(trace)}, "unadmitted\\n");`);
  const file = path.join(dir, "helper.ts"), lock = path.join(dir, "host.lock"), stamp = path.join(dir, "ran");
  fs.writeFileSync(file, instrumented); fs.writeFileSync(lock, "pid=not-a-pid\n");
  const result = await run("bun", [file, "supervise", lock, "bash", "-c", 'printf "ran\\n" > "$1"', "fixture", stamp]);
  assert.equal(result.code, 2); assert.equal(result.signal, null); assert(!fs.existsSync(stamp)); assert.equal(fs.readFileSync(lock, "utf8"), "pid=not-a-pid\n");
  const diagnostics = result.stderr.split("\n").filter(x => x.startsWith("SELFTEST_LOCK_REFUSAL ")).map(x => JSON.parse(x.slice(22)));
  assert(diagnostics.some(x => x.operation === "acquire"));
  return { forwards: fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").length : 0, eperm: result.stderr.includes("kill() failed: EPERM") };
}
const quiet = await refusal(original, "join-positive"); assert.equal(quiet.forwards, 0); assert.equal(quiet.eperm, false);
const joined = '      if (!owned && !interrupted) await done;\n      else { forward(interrupted ?? "SIGTERM"); await done; }';
const noJoin = replace(original, joined, '      forward(interrupted ?? "SIGTERM"); await done;');
const noisy = await refusal(noJoin, "join-removed"); rejected = false;
try { assert.equal(noisy.forwards, 0, "unadmitted exit must be joined, not forwarded"); } catch (e: any) { if (e.code !== "ERR_ASSERTION" || e.expected !== 0 || e.actual < 1) throw e; rejected = true; }
assert(rejected); console.log("PASS refusal: original gate joined, primary refusal preserved; removed join rejected by attempted-forward observation");
console.log("hardware-identity: PASS");
