// A live holder outlasts the real CLI. Observe a native lock-wait attempt,
// never elapsed startup/identity-check time. Only the enclosing suite contains us.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [rawRoot, base, mode = "fixed"] = process.argv.slice(2);
assert(["fixed", "removed"].includes(mode), "unknown refusal control mode");
const root = fs.realpathSync(rawRoot);
let marked = false;
for (let dir = root; ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, ".wheelhouse-selftest-fixture"))) { marked = true; break; }
  if (path.dirname(dir) === dir) break;
}
assert(marked, "refusal fixture requires an owned scratch root");
const dir = path.join(base, mode); fs.mkdirSync(dir, { recursive: true });
const lock = path.join(root, "seats/run/cleanup.lock"), pidFile = path.join(lock, "pid");
assert(!fs.existsSync(lock), "refusal fixture must create its own lock");
fs.mkdirSync(path.dirname(lock), { recursive: true });
fs.mkdirSync(lock); fs.writeFileSync(pidFile, process.pid + "\n");
function identity() {
  const st = fs.lstatSync(lock, { bigint: true });
  return { inode: `${st.dev}:${st.ino}`, entries: fs.readdirSync(lock).sort(), pid: fs.readFileSync(pidFile, "utf8") };
}
const held = identity(); process.kill(process.pid, 0);
const implementation = path.join(root, "seats/cleanup-identity.ts"), original = fs.readFileSync(implementation, "utf8");
const anchor = "      if (Date.now() >= until) return null;";
const armed = path.join(dir, "armed"), attempt = path.join(dir, "wait-attempt.json"), returned = path.join(dir, "wait-return.json");
const observer = path.join(dir, "observer.ts");
fs.writeFileSync(observer, `import fs from "node:fs";
const nativeWait = Atomics.wait;
fs.writeFileSync(${JSON.stringify(armed)}, "observer installed\\n");
Atomics.wait = function(...args) {
  const stack = new Error().stack ?? "";
  if (!stack.includes("acquireCleanupLock")) return nativeWait.apply(Atomics, args);
  fs.writeFileSync(${JSON.stringify(attempt)}, JSON.stringify({stack, timeout: args[3]}) + "\\n");
  const result = nativeWait.apply(Atomics, args);
  fs.writeFileSync(${JSON.stringify(returned)}, JSON.stringify({result}) + "\\n");
  // The real native wait has happened. Stop the broken CLI before it can loop
  // forever or enter a scan; the holder never releases to make this a success.
  throw new Error("fixture observed actual cleanup lock wait");
};
`);
function run(args: string[]) {
  const child = spawn("bun", args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false;
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.stdout.on("end", () => { stdoutEOF = true; }); child.stderr.on("end", () => { stderrEOF = true; });
  return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; stdoutEOF: boolean; stderrEOF: boolean }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, stdoutEOF, stderrEOF }));
  });
}
try {
  if (mode === "removed") {
    assert.equal(original.split(anchor).length, 2, "unique actual refusal-return removal");
    fs.writeFileSync(implementation, original.replace(anchor, "      // removed immediate refusal; enter the real native wait"));
  }
  const result = await run(["--preload", observer, "seats/prune.ts", "cleanup"]);
  assert(fs.existsSync(armed), "wait observer must be installed in the actual CLI");
  const after = identity(); assert.deepEqual(after, held, "same live holder still owns the lock after CLI exit");
  const waited = fs.existsSync(attempt), nativeWait = fs.existsSync(returned) ? JSON.parse(fs.readFileSync(returned, "utf8")) : null;
  const waitAttempt = waited ? JSON.parse(fs.readFileSync(attempt, "utf8")) : null;
  const record = { mode, holder: process.pid, lockHeldAfterChildExit: true, observerArmed: true, waited, waitAttempt, nativeWait, ambient: { load: os.loadavg(), cores: os.cpus().length, nice: os.getPriority(0) }, ...result };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record, null, 2) + "\n");
  console.log("MEASUREMENT prune-refusal " + JSON.stringify(record));
  assert(!waited, "lock refusal waited on the held lock (native wait observed)");
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
  assert(result.stdoutEOF && result.stderrEOF, "actual CLI pipes must finish");
  assert.equal(result.stdout, "already running\n"); assert.equal(result.stderr, "");
  console.log("PASS cleanup refuses while the same live holder still holds the lock, without a native wait");
} finally {
  fs.writeFileSync(implementation, original);
  assert.deepEqual(identity(), held, "teardown must not remove a changed/foreign lock");
  fs.unlinkSync(pidFile); fs.rmdirSync(lock);
}
if (mode === "fixed") {
  const control = await run([import.meta.path, root, base, "removed"]);
  assert.equal(control.code, 1, "removal control must reject actual waiting"); assert.equal(control.signal, null);
  assert(control.stdoutEOF && control.stderrEOF);
  assert(control.stderr.includes("lock refusal waited on the held lock (native wait observed)"), "removal must fail at the wait verdict, not an unrelated setup/exit check");
  const observation = JSON.parse(fs.readFileSync(path.join(base, "removed/result.json"), "utf8"));
  assert(observation.lockHeldAfterChildExit && observation.observerArmed && observation.waited);
  assert.equal(observation.waitAttempt?.timeout, 200, "control uses the existing native wait, not a larger timeout");
  assert(observation.waitAttempt?.stack.includes("acquireCleanupLock"));
  assert.equal(observation.nativeWait?.result, "timed-out", "control must execute the original native wait, not just report an intention");
  console.log("PASS refusal removal control: native1 at named wait assertion after actual native wait; holder never released");
}
