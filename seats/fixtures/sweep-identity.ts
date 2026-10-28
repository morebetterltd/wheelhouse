// Real helper transitions and an idle real runner, isolated from host admission.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync as nativeSpawnSync } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
const [root, helper, runner] = process.argv.slice(2);
// Exact current-main helper captured at 76bd232 (blob 3805817f...).
const oldHelper = path.join(import.meta.dir, "sweep-lock-v1.ts");
const compatibilityHelper = process.env.WHEELHOUSE_IDENTITY_COMPAT_HELPER || oldHelper;
assert(fs.statSync(compatibilityHelper).isFile());
assert(fs.statSync(oldHelper).isFile());
const oldBytes = fs.readFileSync(oldHelper);
assert.equal(createHash("sha1").update(`blob ${oldBytes.length}\0`).update(oldBytes).digest("hex"), "3805817fedd7e663527097697d3a54df27ea735c", "frozen current-main helper is byte-exact");
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(helper).isFile()); assert(fs.statSync(runner).isFile());
const source = fs.readFileSync(helper, "utf8"), marker = "wheelhouse-selftest-sweep", anchor = marker + "-queue";
function copyCaptureDependencies(dir: string) { for (const name of ["native-command.ts", "completed-command.ts"]) fs.copyFileSync(path.join(path.dirname(helper), name), path.join(dir, name)); }
copyCaptureDependencies(root);
const tokenA = "a".repeat(32), tokenB = "b".repeat(32), results: object[] = [];
// These three legs vary the reported network name, not hardware availability.
// Capture/drain one real native provider to close, then replay those exact
// private bytes for both names. Missing/error/malformed-provider legs below
// continue to exercise the untouched production helper and lookup policy.
const selected = process.env.WHEELHOUSE_IDENTITY_TEST_CASE;
const nameCases = ["inherited-network-change", "supervise-network-change", "network-change", "hostname-only-mutant", "lookup-failure-network-change", "lookup-failure-foreign-host"];
const renewalCases = ["payload-exit-at-renewal", "renewal-refused-still-releases", "payload-killed-releases"];
let provider: string | undefined;
if (!selected || nameCases.includes(selected) || renewalCases.includes(selected)) {
  const began = performance.now();
  let bytes: string, command: string[], status = 0;
  if (process.platform === "darwin") {
    command = ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"];
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b);
    const native = await new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(native.signal, null); assert.equal(native.code, 0, err); assert.equal(err, "");
    bytes = out;
    const match = /^\s*"IOPlatformUUID" = "([0-9A-Fa-f-]+)"\s*$/m.exec(bytes);
    assert(match && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(match[1]) && !/^0+$/.test(match[1].replaceAll("-", "")), "native identity capture must be valid before the name-change experiment");
  } else {
    assert.equal(process.platform, "linux"); command = ["read", "/etc/machine-id"];
    bytes = fs.readFileSync(command[1], "utf8");
    assert(/^[0-9a-f]{32}$/i.test(bytes.trim()) && !/^0+$/.test(bytes.trim()), "valid native machine-id capture");
  }
  const response = path.join(root, "native-identity-response");
  fs.writeFileSync(response, bytes, { mode: 0o600 });
  provider = response;
  console.log("NATIVE_IDENTITY_CAPTURE " + JSON.stringify({ command, status, bytes: Buffer.byteLength(bytes), valid: true, elapsedMs: performance.now()-began, nice: os.getPriority(0) }));
}
const helpers = new Map<string, string>();
for (const hostname of ["network-before", "network-after"]) {
  assert.equal(source.split("const HOST = os.hostname();").length, 2, "instrument only reported hostname");
  const file = path.join(root, hostname + ".ts");
  let named = source.replace("const HOST = os.hostname();", `const HOST = ${JSON.stringify(hostname)};`);
  if (provider) {
    const needle = process.platform === "darwin"
      ? 'readIdentityProvider("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 })'
      : 'fs.readFileSync("/etc/machine-id", "utf8")';
    assert.equal(named.split(needle).length, 2, "one native provider to replay");
    named = named.replace(needle, `fs.readFileSync(${JSON.stringify(provider)}, "utf8")`);
  }
  fs.writeFileSync(file, named); helpers.set(hostname, file);
}
function call(dir: string, op: string, token: string, owned = "", file = helper, pid = process.pid) {
  const args = [file, op, path.join(dir, "host.lock"), String(pid), token, owned];
  const r = spawnSync("bun", args, { encoding: "utf8" });
  assert.equal(r.signal, null); assert(!r.error, String(r.error));
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ command: ["bun", ...args], status: r.status, stdout: r.stdout, stderr: r.stderr }) + "\n");
  return r;
}
function acquired(dir: string, file = helper) { const r = call(dir, "acquire", tokenA, "", file); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function release(dir: string, owned: string, file = helper) { const r = call(dir, "release", tokenA, owned, file); assert.equal(r.status, 0, r.stderr); }
function rewrite(file: string, mutate: (value: any) => void) {
  const value = JSON.parse(fs.readFileSync(file, "utf8")); mutate(value);
  const before = fs.statSync(file, { bigint: true }); fs.writeFileSync(file, JSON.stringify(value) + "\n");
  assert.equal(fs.statSync(file, { bigint: true }).ino, before.ino, "rewrite really preserves the marker inode");
}
function diagnostic(r: ReturnType<typeof call>, file: string, operation?: string, status = 2) {
  assert.equal(r.status, status, r.stdout + r.stderr);
  const lines = r.stderr.split("\n").filter(x => x.startsWith("SELFTEST_LOCK_REFUSAL ")).filter(x => !operation || JSON.parse(x.slice("SELFTEST_LOCK_REFUSAL ".length)).operation === operation);
  assert.equal(lines.length, 1, r.stderr);
  const d = JSON.parse(lines[0].slice("SELFTEST_LOCK_REFUSAL ".length)), stat = fs.statSync(file, { bigint: true });
  assert.equal(d.host.hostname, os.hostname()); assert.match(d.host.hostId, /^[0-9a-f]{64}$/); assert.equal(d.host.platform, process.platform);
  const rows = [...d.observed, ...d.snapshots].filter(x => x.path === file && x.contentsBase64);
  assert(rows.length, "offending marker's full bytes are present, not just an error label");
  for (const row of rows) {
    assert.equal(row.inode, String(stat.ino)); assert.equal(row.device, String(stat.dev)); assert.equal(row.mtimeNs, String(stat.mtimeNs));
    assert.equal(row.contents, fs.readFileSync(file, "utf8")); assert.equal(row.contentsBase64, fs.readFileSync(file).toString("base64"));
  }
  return d;
}
function refreshOwnership(dir: string, kind: "token" | "identity" | "pid" | "missing" | "dead" | "combined") {
  const lock = path.join(dir, "host.lock");
  let sequence = 0;
  // Regular descriptors preserve both native streams; every helper has a hard
  // deadline even when this leg is invoked without the containing sweep.
  function bounded(command: string[]) {
    const prefix = path.join(dir, String(++sequence));
    const out = fs.openSync(prefix + ".stdout", "wx", 0o600), err = fs.openSync(prefix + ".stderr", "wx", 0o600);
    let native;
    try { native = nativeSpawnSync(command[0], command.slice(1), { timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", out, err] }); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    const result = { command, status: native.status, signal: native.signal, error: native.error?.message ?? null,
      stdout: fs.readFileSync(prefix + ".stdout", "utf8"), stderr: fs.readFileSync(prefix + ".stderr", "utf8") };
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(result) + "\n");
    assert.equal(result.error, null); assert.equal(result.signal, null);
    return { ...result, pid: native.pid };
  }
  const transition = (op: string, pid: number, token: string, owned: string) => bounded(["bun", helper, op, lock, String(pid), token, owned]);
  const admission = transition("acquire", process.pid, tokenA, ""); assert.equal(admission.status, 0, admission.stderr);
  const owned = admission.stdout.trim(), markerFile = path.join(lock, marker), pidFile = path.join(lock, "pid");
  const originalMarker = fs.readFileSync(markerFile), originalPid = fs.readFileSync(pidFile);
  const claim = JSON.parse(originalMarker.toString()); assert.equal(claim.pid, process.pid); assert.equal(claim.token, tokenA);
  assert.equal(owned, `${fs.statSync(lock).dev}:${fs.statSync(lock).ino}`);
  let pid = process.pid, token = tokenA, identity = owned;
  const expected: string[] = [];
  if (kind === "missing") { identity = ""; expected.push("missing caller identity"); }
  if (kind === "identity" || kind === "combined") { identity = "0:0"; expected.push("identity"); }
  if (kind === "pid" || kind === "combined") { pid = process.ppid; process.kill(pid, 0); expected.push("pid"); }
  if (kind === "token" || kind === "combined") { token = "f".repeat(32); expected.push("token"); }
  if (kind === "dead") {
    const exited = bounded(["/bin/sh", "-c", "exit 0"]); assert.equal(exited.status, 0); pid = exited.pid;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "native child really exited before measuring liveness");
    rewrite(markerFile, m => { m.pid = pid; }); fs.writeFileSync(pidFile, `${pid}\n`);
    expected.push("payload exited");
  }
  function records() {
    return [lock, lock + ".queue"].flatMap(d => fs.readdirSync(d).map(n => {
      const f = path.join(d, n), s = fs.statSync(f, { bigint: true });
      return { path: f, inode: String(s.ino), mtime: String(s.mtimeNs), bytes: fs.readFileSync(f).toString("base64") };
    }));
  }
  try {
    const before = records(), lockPid = kind === "dead" ? pid : process.pid;
    const result = transition("refresh", pid, token, identity);
    const status = kind === "dead" ? 76 : 2;
    assert.equal(result.status, status, result.stderr);
    const reason = kind === "dead" ? "payload exited" : `cannot refresh a different lock owner (${expected.join(", ")})`;
    if (kind === "dead") assert(!result.stderr.includes("different lock owner") && !result.stderr.includes("STOP:"));
    else assert(result.stderr.split("\n").some(line => line.startsWith("STOP:") && line.includes(reason)), result.stderr);
    const d = diagnostic(result, markerFile, "refresh", status);
    assert.equal(d.reason, reason);
    if (kind !== "dead") assert.deepEqual(d.ownership, { mismatches: expected, caller: { pid, token, identity: identity || null, payloadAlive: true },
      lock: { pid: lockPid, token: tokenA, identity: owned } });
    assert.deepEqual(records(), before, "refusal never renews or rewrites the lock or FIFO");
    console.log(`OWNERSHIP_REFRESH ${kind} exit=${status} mismatches=${JSON.stringify(expected)} ${kind === "dead" ? "completion=verified" : "caller+lock=verified"} records=unchanged`);
  } finally {
    if (kind === "dead") { fs.writeFileSync(markerFile, originalMarker); fs.writeFileSync(pidFile, originalPid); }
    const healthy = transition("refresh", process.pid, tokenA, owned); assert.equal(healthy.status, 0, healthy.stderr);
    const released = transition("release", process.pid, tokenA, owned); assert.equal(released.status, 0, released.stderr);
    assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue"));
  }
}
async function network(dir: string) {
  const before = helpers.get("network-before")!, after = helpers.get("network-after")!, lock = path.join(dir, "host.lock");
  // Contention needs a sibling owner. An ancestor-owned token is now correctly
  // inherited by the nested sweep instead of generating a waiter ticket.
  const holder = spawn("bash", ["-c", "IFS= read -r release"], { cwd: dir, stdio: ["pipe", "ignore", "ignore"] });
  const holderDone = new Promise<number | null>((resolve, reject) => { holder.once("error", reject); holder.once("close", resolve); });
  try {
  assert(holder.pid);
  const admission = call(dir, "acquire", tokenA, "", before, holder.pid); assert.equal(admission.status, 0, admission.stderr);
  const owned = admission.stdout.trim();
  const m = JSON.parse(fs.readFileSync(path.join(lock, marker), "utf8")); assert.equal(m.hostname, "network-before");
  const cache = JSON.parse(fs.readFileSync(path.join(lock + ".host", marker + "-host"), "utf8")); assert.match(cache.hostId, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(m, "hostId"), false, "wire marker shape stays unchanged");
  const stamp = path.join(dir, "ran"), suite = path.join(dir, "idle.selftest.sh");
  fs.writeFileSync(suite, '#!/usr/bin/env bash\nsleep 0.01\nprintf "ran\\n" > "$IDENTITY_STAMP"\n');
  const child = spawn("bash", [runner], { env: { ...process.env, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: after, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: suite, IDENTITY_STAMP: stamp }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", closed = false;
  child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", rc => { closed = true; resolve(rc); }); });
  try {
    while (!err.includes("waiting for host-wide lock")) { assert(!closed, out + err); await Bun.sleep(10); }
    assert(!fs.existsSync(stamp));
    const ticket = fs.readdirSync(lock + ".queue").find(x => /^\d{20}\.\w+$/.test(x) && JSON.parse(fs.readFileSync(path.join(lock + ".queue", x), "utf8")).pid === child.pid); assert(ticket);
    const waiter = JSON.parse(fs.readFileSync(path.join(lock + ".queue", ticket), "utf8")); assert.equal(waiter.hostname, "network-after"); assert.equal(Object.hasOwn(waiter, "hostId"), false);
    // Read a new-name ticket using the old reported hostname, then release an
    // old-name owner using the new one: all three marker kinds use the cache.
    const queued = call(dir, "acquire", tokenB, "", before); assert.equal(queued.status, 75, queued.stderr);
    const released = call(dir, "release", tokenA, owned, after, holder.pid); assert.equal(released.status, 0, released.stderr);
    assert.equal(await done, 0, out + err); assert.equal(fs.readFileSync(stamp, "utf8"), "ran\n");
    assert(!fs.existsSync(lock));
    const cancel = call(dir, "release", tokenB); assert.equal(cancel.status, 0, cancel.stderr); assert(!fs.existsSync(lock + ".queue"));
    const legacyOwned = acquired(dir); release(dir, legacyOwned);
  } finally { if (!closed) child.kill("SIGTERM"); await done; fs.writeFileSync(path.join(dir, "runner.out"), out); fs.writeFileSync(path.join(dir, "runner.err"), err); }
  } finally { holder.stdin!.end("release\n"); assert.equal(await holderDone, 0); }
}
async function rewritten(dir: string, kind: "lock" | "queue" | "waiter") {
  const owned = acquired(dir), lock = path.join(dir, "host.lock");
  let file = path.join(lock, marker);
  if (kind === "queue") file = path.join(lock + ".queue", anchor);
  if (kind === "waiter") {
    const wait = call(dir, "acquire", tokenB); assert.equal(wait.status, 75, wait.stderr);
    file = path.join(lock + ".queue", fs.readdirSync(lock + ".queue").find(x => x.endsWith(tokenB))!);
  }
  rewrite(file, v => { v.hostname = "unobserved-foreign-host"; });
  const raw = fs.readFileSync(file), r = call(dir, "release", kind === "waiter" ? tokenB : tokenA, kind === "waiter" ? "" : owned);
  diagnostic(r, file); assert(fs.readFileSync(file).equals(raw), "refusal must not erase or repair the rewritten marker");
}
async function writer(dir: string) {
  const owned = acquired(dir), lock = path.join(dir, "host.lock");
  // Legacy publication command captured from verify-readiness.ts at 76bd232.
  // Native mv targets an existing directory: it adds a fourth member instead
  // of replacing the directory. This proves that writer, not the old outage.
  const command = 'printf "pid=%s\\n" "$$" > "$1.new"; mv -f "$1.new" "$1"';
  const r = spawnSync("bash", ["-c", command, "_", lock], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "writer.json"), JSON.stringify({ command: ["bash", "-c", command, "_", lock], status: r.status, stdout: r.stdout, stderr: r.stderr })); assert.equal(r.status, 0, r.stderr);
  const extra = path.join(lock, "host.lock.new"); assert(fs.statSync(extra).isFile());
  const refused = call(dir, "release", tokenA, owned); diagnostic(refused, path.join(lock, marker)); diagnostic(refused, extra);
  assert.match(refused.stderr, /entries must be exactly marker, pid, started/);
}
async function compatibility(dir: string) {
  const lock = path.join(dir, "host.lock"), owned = acquired(dir);
  const cache = path.join(lock + ".host", marker + "-host"), bytes = fs.readFileSync(cache), ino = fs.statSync(cache).ino;
  const queued = call(dir, "acquire", tokenB, "", oldHelper); assert.equal(queued.status, 75, queued.stderr);
  release(dir, owned, oldHelper);
  const admitted = call(dir, "acquire", tokenB, "", oldHelper); assert.equal(admitted.status, 0, admitted.stderr);
  const released = call(dir, "release", tokenB, admitted.stdout.trim(), oldHelper); assert.equal(released.status, 0, released.stderr);
  assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue"));
  assert(fs.readFileSync(cache).equals(bytes)); assert.equal(fs.statSync(cache).ino, ino, "old helper ignores sibling cache");
  // Reverse direction: new helper also queues behind and releases old records.
  const oldOwned = acquired(dir, oldHelper);
  const waiting = call(dir, "acquire", tokenB); assert.equal(waiting.status, 75, waiting.stderr);
  release(dir, oldOwned);
  const admittedAgain = call(dir, "acquire", tokenB, "", oldHelper); assert.equal(admittedAgain.status, 0, admittedAgain.stderr);
  const final = call(dir, "release", tokenB, admittedAgain.stdout.trim()); assert.equal(final.status, 0, final.stderr);
  assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue"));
}
function mode(dir: string, operation: string, command: string[] = [], file = helper, env = process.env) {
  const args = [file, operation, path.join(dir, "host.lock"), ...command];
  const r = spawnSync("bun", args, { env, encoding: "utf8" });
  assert(!r.error, String(r.error)); assert.equal(r.signal, null);
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ command: ["bun", ...args], status: r.status, stdout: r.stdout, stderr: r.stderr }) + "\n");
  return r;
}
async function inheritedNetwork(dir: string) {
  const before = helpers.get("network-before")!, after = helpers.get("network-after")!, owned = acquired(dir, before);
  const r = mode(dir, "inherited", [], after); assert.equal(r.status, 0, r.stderr);
  release(dir, owned, after);
}
async function inheritedRefusal(dir: string, kind: "extra" | "queue" | "waiter") {
  acquired(dir); const lock = path.join(dir, "host.lock"); let file = path.join(lock, marker);
  if (kind === "extra") fs.writeFileSync(path.join(lock, "unexpected"), "do not delete\n");
  else {
    file = kind === "queue" ? path.join(lock + ".queue", anchor) : path.join(lock + ".queue", fs.readdirSync(lock + ".queue").find(x => x.endsWith(tokenA))!);
    rewrite(file, v => { v.hostname = "unobserved-foreign-host"; });
  }
  const raw = fs.readFileSync(file); diagnostic(mode(dir, "inherited"), file, "inherited"); assert(fs.readFileSync(file).equals(raw));
}
async function supervisedRefusal(dir: string, kind: "command" | "poll" | "acquire" | "release") {
  const lock = path.join(dir, "host.lock"), file = path.join(lock, marker), stamp = path.join(dir, "ran");
  let command: string[] = [], env = process.env;
  if (kind === "release") {
    const mutate = path.join(dir, "mutate.ts");
    fs.writeFileSync(mutate, 'import fs from "node:fs"; const [file, stamp] = process.argv.slice(2); const m=JSON.parse(fs.readFileSync(file,"utf8")); m.hostname="unobserved-foreign-host"; fs.writeFileSync(file,JSON.stringify(m)+"\\n"); fs.writeFileSync(stamp,"ran\\n");\n');
    command = ["bash", "-c", 'exec bun "$1" "$2" "$3"', "fixture", mutate, file, stamp];
  } else {
    acquired(dir);
    if (kind !== "command") command = ["bash", "-c", 'printf "ran\\n" > "$1"', "fixture", stamp];
    if (kind === "poll") env = { ...process.env, WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS: "invalid" };
    if (kind === "acquire") fs.writeFileSync(path.join(lock, "unexpected"), "do not delete\n");
  }
  const r = mode(dir, "supervise", command, helper, env);
  assert.equal(fs.existsSync(stamp), kind === "release", "only the admitted release-refusal payload ran");
  const raw = fs.readFileSync(file); diagnostic(r, file, "supervise"); assert(fs.readFileSync(file).equals(raw));
}
async function supervisedNetwork(dir: string) {
  const before = helpers.get("network-before")!, after = helpers.get("network-after")!, owned = acquired(dir, before), lock = path.join(dir, "host.lock"), stamp = path.join(dir, "ran");
  const child = spawn("bun", [after, "supervise", lock, "bash", "-c", 'sleep 0.01; printf "ran\\n" > "$1"', "fixture", stamp], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", closed = false; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", rc => { closed = true; resolve(rc); }); });
  try {
    while (!err.includes("waiting for host-wide lock")) { assert(!closed, out + err); await Bun.sleep(10); }
    assert(!fs.existsSync(stamp)); release(dir, owned, after);
    assert.equal(await done, 0, out + err); assert.equal(fs.readFileSync(stamp, "utf8"), "ran\n");
    assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue"));
  } finally { if (!closed) child.kill("SIGTERM"); await done; fs.writeFileSync(path.join(dir, "supervisor.out"), out); fs.writeFileSync(path.join(dir, "supervisor.err"), err); }
}
async function renewalLifecycle(dir: string, kind: "exit" | "refused" | "killed") {
  assert(provider, "capture the real hardware response before lifecycle instrumentation");
  const count = kind === "exit" ? 52 : 1; // 50 exit0, then exit7 at both checkpoints.
  for (let iteration = 0; iteration < count; iteration++) {
    const run = path.join(dir, String(iteration)); fs.mkdirSync(run); copyCaptureDependencies(run);
    const lock = path.join(run, "host.lock"), finish = path.join(run, "finish"), ready = path.join(run, "ready"), receipt = path.join(run, "refresh.jsonl");
    const file = path.join(run, "helper.ts"), payload = path.join(run, "payload.ts");
    const replace = (text: string, needle: string, value: string) => { assert.equal(text.split(needle).length, 2, needle); return text.replace(needle, value); };
    let code = source;
    // Replay native bytes, not a made-up UUID. This tests lease ordering, not
    // hardware availability; the matcher also accepts a named timeout bound.
    const expression = process.platform === "darwin"
      ? code.match(/readIdentityProvider\("\/usr\/sbin\/ioreg", \["-rd1", "-c", "IOPlatformExpertDevice"\], \{[^\n]+\}\)/g)
      : ['fs.readFileSync("/etc/machine-id", "utf8")'];
    assert(expression && expression.length === 1);
    code = replace(code, expression[0], `fs.readFileSync(${JSON.stringify(provider)}, "utf8")`);
    const beforeCheck = iteration % 2 === 0, expected = kind === "exit" ? iteration < 50 ? 0 : 7 : kind === "killed" ? 137 : 2;
    const endChild = `fs.writeFileSync(${JSON.stringify(finish)}, "exit\\n"); await done;`;
    if (kind === "exit") {
      // Two deterministic preemptions: after close BEFORE the guard, and after
      // the guard BEFORE native refresh. Hold teardown until that tick settles.
      code = replace(code, "      renewal = setInterval(() => {", `      let tickFinished = () => {}; const tickDone = new Promise<void>(resolve => { tickFinished = resolve; });\n      renewal = setInterval(async () => { clearInterval(renewal); try { ${beforeCheck ? endChild : ""}`);
      code = replace(code, "      }, 60_000);", "      } finally { tickFinished(); } }, 100);");
      code = replace(code, "      const result = await done;", "      const result = await done; await tickDone;");
    } else if (kind === "killed") {
      // Kill between ticks after one successful native refresh. Keep teardown
      // joined to the next tick so this case actually measures the closed-child
      // guard, rather than merely beating the next timer by luck.
      code = replace(code, "      renewal = setInterval(() => {", "      let observedTicks = 0, tickFinished = () => {}; const tickDone = new Promise<void>(resolve => { tickFinished = resolve; });\n      renewal = setInterval(async () => { if (observedTicks) { clearInterval(renewal); await done; } try {");
      code = replace(code, "      }, 60_000);", "      } finally { if (++observedTicks >= 2) tickFinished(); } }, 100);");
      code = replace(code, "      const result = await done;", "      const result = await done; await tickDone;");
    } else code = replace(code, "}, 60_000);", "}, 100);");
    code = replace(code, '        const result = transition("refresh");', `${kind === "exit" && !beforeCheck ? endChild : ""}\n        const result = transition("refresh"); fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({status:result.status, signal:result.signal, error:result.error?.message ?? null})+"\\n");`);
    fs.writeFileSync(file, code);
    fs.writeFileSync(payload, `import fs from "node:fs"; const ready=${JSON.stringify(ready)}; fs.writeFileSync(ready+".new", JSON.stringify({pid:process.pid})); fs.renameSync(ready+".new",ready); while(!fs.existsSync(${JSON.stringify(finish)})) await Bun.sleep(5); process.exit(${expected === 7 ? 7 : 0});\n`);
    const args = [file, "supervise", lock, "bash", "-c", 'exec bun "$1"', "fixture", payload];
    const child = spawn("bun", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", closed = false, expired = false;
    // Named outer containment for one supervisor, not a startup/renewal SLA.
    const containment = setTimeout(() => { expired = true; child.kill("SIGTERM"); }, 120_000);
    child.stdout!.on("data", b => stdout += b); child.stderr!.on("data", b => stderr += b);
    const done = new Promise<any>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({code, signal}); }); });
    const waitFor = async (test: () => boolean) => { while (!test()) { assert(!closed, stdout + stderr); await Bun.sleep(5); } };
    let foreign: Record<string, string> | undefined;
    const lockBytes = () => Object.fromEntries(fs.readdirSync(lock).sort().map(name => [name, fs.readFileSync(path.join(lock, name)).toString("base64")]));
    try {
      if (kind !== "exit") {
        await waitFor(() => fs.existsSync(ready));
        const actual = JSON.parse(fs.readFileSync(ready, "utf8")), markerFile = path.join(lock, marker), m = JSON.parse(fs.readFileSync(markerFile, "utf8"));
        assert.equal(actual.pid, m.pid); process.kill(actual.pid, 0);
        if (kind === "refused") {
          rewrite(markerFile, m => { m.token = (m.token[0] === "f" ? "e" : "f") + m.token.slice(1); });
          foreign = lockBytes();
          await waitFor(() => stderr.includes("STOP: suite lock renewal failed"));
          fs.writeFileSync(finish, "exit\n");
        } else {
          await waitFor(() => fs.existsSync(receipt) && fs.readFileSync(receipt, "utf8").includes("\n"));
          const first = JSON.parse(fs.readFileSync(receipt, "utf8").trim().split("\n")[0]);
          assert.equal(first.status, 0, stderr); // A native tick before the kill.
          process.kill(actual.pid, "SIGKILL");
        }
      }
      const result = await done;
      assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
      const ticks = fs.existsSync(receipt) ? fs.readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      fs.writeFileSync(path.join(run, "native.json"), JSON.stringify({ args, kind, iteration, beforeCheck, expected, ...result, stdout, stderr, ticks, expired }, null, 2) + "\n");
      assert(!expired, "renewal lifecycle supervisor exceeded outer120s containment");
      assert.equal(result.signal, null); assert.equal(result.code, expected, stderr);
      if (kind === "refused") {
        assert(stderr.split("\n").includes("STOP: suite lock renewal failed (token)"), stderr);
        assert.deepEqual(lockBytes(), foreign, "release must not erase/rewrite the foreign marker");
        assert(!fs.existsSync(lock + ".queue"), "refused renewal must retire its own FIFO ticket");
        console.log("RENEWAL_REFUSED native=2 check=token foreign-marker=unchanged own-ticket=gone");
      } else {
        assert(!stderr.includes("cannot refresh a different lock owner") && !stderr.includes("STOP: suite lock renewal failed"), stderr);
        assert(!fs.existsSync(lock) && !fs.existsSync(lock + ".queue"), "completed/killed payload must release lock and ticket");
        if (kind === "exit") {
          if (beforeCheck) assert.equal(ticks.length, 0, "closed payload must not spawn refresh");
          else { assert.equal(ticks.length, 1); assert.deepEqual(ticks[0], {status:76,signal:null,error:null}); }
          console.log(`RENEWAL_EXIT iteration=${iteration} checkpoint=${beforeCheck ? "after-close" : "after-guard"} payload=${expected} supervisor=${result.code} refresh=${ticks.length ? ticks[0].status : "skipped"} lock+ticket=gone`);
        } else {
          assert.equal(ticks.length, 1, "killed payload must not spawn another refresh");
          console.log("RENEWAL_KILLED payload=SIGKILL supervisor=137 native-live-tick=0 closed-tick=skipped lock+ticket=gone");
        }
      }
    } finally {
      clearTimeout(containment);
      if (!closed) { child.kill("SIGTERM"); await done; }
    }
  }
}
async function lookupFailure(dir: string, foreign: boolean) {
  assert(provider, "native identity captured before replay/failure injection");
  copyCaptureDependencies(dir);
  const flag = path.join(dir, "lookup-failed"), refreshed = path.join(dir, "refreshed"), failures = path.join(dir, "timeouts");
  const lock = path.join(dir, "host.lock"), file = path.join(dir, "helper.ts"), payload = path.join(dir, "payload.ts");
  const replace = (text: string, needle: string, value: string) => { assert.equal(text.split(needle).length, 2, needle); return text.replace(needle, value); };
  let code = replace(source, "const HOST = os.hostname();", `const HOST = fs.existsSync(${JSON.stringify(flag)}) ? "network-after" : "network-before";`);
  const needle = process.platform === "darwin"
    ? 'readIdentityProvider("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 })'
    : 'fs.readFileSync("/etc/machine-id", "utf8")';
  // Match the captured production failure code, not malformed hardware bytes.
  code = replace(code, needle, `(() => { if (fs.existsSync(${JSON.stringify(flag)})) { fs.appendFileSync(${JSON.stringify(failures)}, "ETIMEDOUT\\n"); throw Object.assign(new Error("injected provider timeout"), { code: "ETIMEDOUT" }); } return fs.readFileSync(${JSON.stringify(provider)}, "utf8"); })()`);
  code = replace(code, "}, 60_000);", "}, 100);"); // Accelerate only this disposable supervisor's renewal timer.
  code = replace(code, "renewQueue(queue, current); renewLock(parent, name, snapshot);", `renewQueue(queue, current); renewLock(parent, name, snapshot); fs.appendFileSync(${JSON.stringify(refreshed)}, "renewed\\n");`);
  fs.writeFileSync(file, code);
  fs.writeFileSync(payload, `import fs from "node:fs"; import assert from "node:assert/strict"; import {spawn} from "node:child_process";
const lock=${JSON.stringify(lock)}, marker=${JSON.stringify(marker)}, helper=${JSON.stringify(file)};
const pin=JSON.parse(process.env.WHEELHOUSE_SELFTEST_SWEEP_HELD_IDENTITY || "null");
assert(pin && pin.pid===process.pid && pin.hostname==="network-before", "payload received the admitted hardware proof");
const snapshot=()=>Object.fromEntries([lock,lock+".queue",lock+".host"].flatMap(d=>fs.readdirSync(d).map(n=>[d+"/"+n,fs.readFileSync(d+"/"+n).toString("base64")])));
async function call(op,args=[]) { const c=spawn("bun",[helper,op,lock,...args],{stdio:["ignore","pipe","pipe"]}); let out="",err=""; c.stdout.on("data",b=>out+=b); c.stderr.on("data",b=>err+=b); const rc=await new Promise((resolve,reject)=>{c.once("error",reject);c.once("close",resolve)}); return {rc,out,err}; }
if (${foreign}) {
  const p=lock+"/"+marker,m=JSON.parse(fs.readFileSync(p,"utf8")); m.hostname="unobserved-foreign-host"; fs.writeFileSync(p,JSON.stringify(m)+"\\n");
  const before=snapshot(); fs.writeFileSync(${JSON.stringify(flag)},"timeout\\n");
  for (const op of ["acquire","refresh","inherited"]) {
    const r=await call(op,op==="inherited"?[]:[String(process.pid),pin.token,pin.identity]);
    assert.equal(r.rc,2,r.out+r.err); assert(r.err.includes("marker host identity is not this host"),r.err);
    const diagnostic=r.err.split("\\n").find(s=>s.startsWith("SELFTEST_LOCK_REFUSAL ")); const d=JSON.parse(diagnostic.slice(22));
    assert.equal(d.host.identitySource,"hostname"); assert(d.host.identityFailures.some(f=>f.reason==="ETIMEDOUT"));
    assert.deepEqual(snapshot(),before,"foreign refusal preserves all lock/queue/cache bytes");
    console.log(op+" foreign marker exit=2 reason=marker host identity is not this host bytes=unchanged");
  }
} else {
  fs.writeFileSync(${JSON.stringify(flag)},"timeout\\n");
  const until=Date.now()+15000; while(!fs.existsSync(${JSON.stringify(refreshed)})) { assert(Date.now()<until,"supervisor renewal did not complete under failed lookup/new name"); await Bun.sleep(20); }
  const r=await call("inherited"); assert.equal(r.rc,0,r.out+r.err); assert.equal(r.err,"");
  console.log("payload inherited exit=0 after supervisor refresh under ETIMEDOUT/network-after");
}
console.log("payload exit=0");
`);
  const r = mode(dir, "supervise", ["bash", "-c", 'exec bun "$1"', "fixture", payload], file);
  assert.equal(r.status, foreign ? 2 : 0, r.stdout + r.stderr);
  assert.match(r.stdout, /payload exit=0/);
  assert(fs.readFileSync(failures, "utf8").includes("ETIMEDOUT"), "the hardware provider actually failed");
  if (!foreign) {
    assert.equal(r.stderr, "", "held-run refresh/inherited/release must emit no refusal or STOP");
    assert(fs.readFileSync(refreshed, "utf8").includes("renewed"));
    assert(!fs.existsSync(lock) && !fs.existsSync(lock + ".queue"), "original owner released after outage");
    const aliases = fs.readdirSync(lock + ".host").filter(n => n !== marker + "-host").map(n => fs.readFileSync(path.join(lock + ".host", n), "utf8"));
    assert.deepEqual(aliases, ["network-before\n"], "fallback does not publish unauthenticated aliases");
    console.log(r.stdout.trim()); console.log("supervisor exit=0 stderr=empty; failed-lookup renewal and inherited admission retained original lock; release complete");
  } else {
    assert.match(r.stderr, /marker host identity is not this host/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, marker), "utf8")).hostname, "unobserved-foreign-host");
    console.log(r.stdout.trim()); console.log("supervisor release foreign marker exit=2; foreign marker retained");
  }
}
async function hostnameOnlyMutant(dir: string) {
  copyCaptureDependencies(dir);
  const before = helpers.get("network-before")!, after = helpers.get("network-after")!;
  const named = fs.readFileSync(after, "utf8"), needle = "return hostNames.has(marker.hostname);";
  assert.equal(named.split(needle).length, 2);
  const mutant = path.join(dir, "hostname-only.ts");
  fs.writeFileSync(mutant, named.replace(needle, "return marker.hostname === HOST;"));
  const owned = acquired(dir, before), stamp = path.join(dir, "ran");
  try {
    const result = mode(dir, "supervise", ["bash", "-c", 'printf "ran\\n" > "$1"', "fixture", stamp], mutant);
    assert.equal(result.status, 2, "hostname-only matcher must break cross-name admission; native stderr=" + result.stderr);
    const diagnostics = result.stderr.split("\n").filter(x => x.startsWith("SELFTEST_LOCK_REFUSAL ")).map(x => JSON.parse(x.slice("SELFTEST_LOCK_REFUSAL ".length)));
    assert(diagnostics.some(x => x.operation === "acquire" && x.reason === "marker host identity is not this host" && x.host.identitySource !== "hostname" && x.host.identityFailures.length === 0), "reject the actual lost-alias proof with valid captured hardware identity, not an unrelated setup error");
    assert(!fs.existsSync(stamp), "broken matcher must not admit the payload");
    console.log("EXPECTED_REJECTION hostname-only-matcher native=2 reason=marker-host-identity payload=absent");
  } finally { release(dir, owned, after); }
}
async function identityAvailability(dir: string, kind: "path" | "missing" | "error" | "empty" | "truncated" | "malformed") {
  const lock = path.join(dir, "host.lock"), nativeOwned = acquired(dir);
  const cacheFile = path.join(lock + ".host", marker + "-host");
  const cache = fs.existsSync(cacheFile) ? { bytes: fs.readFileSync(cacheFile), ino: fs.statSync(cacheFile).ino } : undefined;
  let file = helper, env = process.env;
  copyCaptureDependencies(dir);
  if (kind === "path") {
    const bin = path.join(dir, "minimal-bin"); fs.mkdirSync(bin); fs.symlinkSync(fs.realpathSync(process.execPath), path.join(bin, "bun"));
    const shims = (process.env.PATH ?? "").split(path.delimiter).filter(p => p.endsWith("/seats/bin"));
    env = { ...process.env, PATH: [...shims, bin, "/usr/bin", "/bin"].join(path.delimiter) };
    assert(!env.PATH!.split(path.delimiter).includes("/usr/sbin"));
    const absent = spawnSync("bash", ["-c", "command -v ioreg"], { env, encoding: "utf8" });
    assert.equal(absent.status, 1); assert.equal(absent.stdout, "");
    fs.writeFileSync(path.join(dir, "path-probe.json"), JSON.stringify({ command: ["bash", "-c", "command -v ioreg"], status: absent.status, stdout: absent.stdout, stderr: absent.stderr, PATH: env.PATH }));
  } else {
    // Redirect only the native identity source in a disposable helper copy.
    // No OS binary, machine-id, platform ABI or installed helper is changed.
    const provider = path.join(dir, "identity-source");
    if (process.platform === "darwin") {
      const script = kind === "error" ? "#!/bin/sh\nexit 73\n"
        : kind === "empty" ? "#!/bin/sh\nexit 0\n"
        // Truncate the captured IOPlatformUUID field shape; normalized value.
        : kind === "truncated" ? "#!/bin/sh\nprintf '  \"IOPlatformUUID\" = \"12345678-1234-\\n'\n"
        : "#!/bin/sh\nprintf 'not a hardware UUID\\n'\n";
      if (kind !== "missing") fs.writeFileSync(provider, script, { mode: 0o700 });
      const pattern = /readIdentityProvider\("(?:\/usr\/sbin\/)?ioreg"/g;
      assert.equal([...source.matchAll(pattern)].length, 1);
      file = path.join(dir, "helper.ts"); fs.writeFileSync(file, source.replace(pattern, `readIdentityProvider(${JSON.stringify(provider)}`));
    } else {
      assert.equal(process.platform, "linux", "availability fixture supports native macOS/Linux");
      if (kind === "error") fs.mkdirSync(provider);
      if (kind === "malformed") fs.writeFileSync(provider, "not a machine id\n");
      if (kind === "empty") fs.writeFileSync(provider, "");
      if (kind === "truncated") fs.writeFileSync(provider, "1234567890abcdef\n");
      const needle = 'fs.readFileSync("/etc/machine-id", "utf8")'; assert.equal(source.split(needle).length, 2);
      file = path.join(dir, "helper.ts"); fs.writeFileSync(file, source.replace(needle, `fs.readFileSync(${JSON.stringify(provider)}, "utf8")`));
    }
    if (kind === "missing") assert(!fs.existsSync(provider), "missing identity source really is absent");
  }
  const op = (operation: string, command: string[] = []) => mode(dir, operation, command, file, env);
  // A fallback must also handle markers/cache made while hardware ID worked.
  const inherited = op("inherited"); assert.equal(inherited.status, 0, inherited.stderr);
  const wait = op("acquire", [String(process.pid), tokenB, ""]); assert.equal(wait.status, 75, wait.stderr);
  assert.equal(op("release", [String(process.pid), tokenA, nativeOwned]).status, 0);
  const next = op("acquire", [String(process.pid), tokenB, ""]); assert.equal(next.status, 0, next.stderr);
  const legacyWait = mode(dir, "acquire", [String(process.pid), tokenA, ""], compatibilityHelper); assert.equal(legacyWait.status, 75, legacyWait.stderr);
  assert.equal(op("release", [String(process.pid), tokenB, next.stdout.trim()]).status, 0);
  const legacyNext = mode(dir, "acquire", [String(process.pid), tokenA, ""], compatibilityHelper); assert.equal(legacyNext.status, 0, legacyNext.stderr);
  assert.equal(mode(dir, "release", [String(process.pid), tokenA, legacyNext.stdout.trim()], compatibilityHelper).status, 0);
  const stamp = path.join(dir, "ran");
  const supervised = op("supervise", ["bash", "-c", 'printf "ran\\n" > "$1"', "fixture", stamp]); assert.equal(supervised.status, 0, supervised.stderr); assert.equal(fs.readFileSync(stamp, "utf8"), "ran\n");
  const again = op("acquire", [String(process.pid), tokenA, ""]); assert.equal(again.status, 0, again.stderr);
  const extra = path.join(lock, "unexpected"); fs.writeFileSync(extra, "diagnostic source witness\n");
  const d = diagnostic(op("inherited"), path.join(lock, marker), "inherited");
  assert.equal(d.host.identitySource, kind === "path" && cache ? process.platform === "darwin" ? "darwin-ioplatformuuid" : "linux-machine-id" : "hostname");
  assert(Array.isArray(d.host.identityFailures));
  if (kind !== "path") { assert.equal(d.host.identityFailures.length, 1); assert.equal(d.host.identityFailures[0].source, process.platform === "darwin" ? "darwin-ioplatformuuid" : "linux-machine-id"); }
  fs.unlinkSync(extra); assert.equal(op("release", [String(process.pid), tokenA, again.stdout.trim()]).status, 0);
  assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue"));
  if (cache) { assert(fs.readFileSync(cacheFile).equals(cache.bytes), "fallback never overwrites the stable host cache"); assert.equal(fs.statSync(cacheFile).ino, cache.ino); }
  let freshStatuses: number[] | undefined;
  if (kind !== "path") {
    const fresh = path.join(dir, "fresh"); fs.mkdirSync(fresh);
    const first = mode(fresh, "acquire", [String(process.pid), tokenA, ""], file, env); assert.equal(first.status, 0, first.stderr);
    assert.equal(mode(fresh, "acquire", [String(process.pid), tokenB, ""], compatibilityHelper).status, 75);
    assert.equal(mode(fresh, "release", [String(process.pid), tokenA, first.stdout.trim()], file, env).status, 0);
    const legacy = mode(fresh, "acquire", [String(process.pid), tokenB, ""], compatibilityHelper); assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(mode(fresh, "release", [String(process.pid), tokenB, legacy.stdout.trim()], compatibilityHelper).status, 0);
    assert(!fs.existsSync(path.join(fresh, "host.lock"))); assert(!fs.existsSync(path.join(fresh, "host.lock.queue"))); assert(!fs.existsSync(path.join(fresh, "host.lock.host")), "hostname fallback does not persist a misleading stable cache");
    freshStatuses = fs.readFileSync(path.join(fresh, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).status);
  }
  const calls = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  fs.writeFileSync(path.join(dir, "identity-observation.json"), JSON.stringify({ kind, source: d.host.identitySource, failures: d.host.identityFailures, statuses: calls.map(c => c.status), stableCachePreserved: !!cache, freshStatuses }, null, 2) + "\n");
}
const cases = [...(["token", "identity", "pid", "missing", "dead", "combined"] as const).map(kind => [`refresh-${kind}`, (d: string) => refreshOwnership(d, kind)] as const), ["payload-exit-at-renewal", (d: string) => renewalLifecycle(d, "exit")], ["renewal-refused-still-releases", (d: string) => renewalLifecycle(d, "refused")], ["payload-killed-releases", (d: string) => renewalLifecycle(d, "killed")], ["lookup-failure-network-change", (d: string) => lookupFailure(d, false)], ["lookup-failure-foreign-host", (d: string) => lookupFailure(d, true)], ["minimal-path", (d: string) => identityAvailability(d, "path")], ["identity-source-missing", (d: string) => identityAvailability(d, "missing")], ["identity-source-error", (d: string) => identityAvailability(d, "error")], ["identity-source-malformed", (d: string) => identityAvailability(d, "malformed")], ["identity-source-empty", (d: string) => identityAvailability(d, "empty")], ["identity-source-truncated", (d: string) => identityAvailability(d, "truncated")], ["inherited-network-change", inheritedNetwork], ["inherited-extra-entry", (d: string) => inheritedRefusal(d, "extra")], ["inherited-queue-marker", (d: string) => inheritedRefusal(d, "queue")], ["inherited-waiter-marker", (d: string) => inheritedRefusal(d, "waiter")], ["supervise-missing-command", (d: string) => supervisedRefusal(d, "command")], ["supervise-invalid-poll", (d: string) => supervisedRefusal(d, "poll")], ["supervise-admission-refusal", (d: string) => supervisedRefusal(d, "acquire")], ["supervise-release-refusal", (d: string) => supervisedRefusal(d, "release")], ["supervise-network-change", supervisedNetwork], ["hostname-only-mutant", hostnameOnlyMutant], ["network-change", network], ["current-helper-compatibility", compatibility], ["rewritten-lock", (d: string) => rewritten(d, "lock")], ["rewritten-queue", (d: string) => rewritten(d, "queue")], ["rewritten-waiter", (d: string) => rewritten(d, "waiter")], ["legacy-mv-writer", writer]] as const;
assert(!selected || cases.some(([name]) => name === selected), "known selected identity leg");
for (const [name, run] of cases) {
  if (selected && selected !== name) continue;
  const dir = path.join(root, name); fs.mkdirSync(dir);
  try { await run(dir); results.push({ name, pass: true }); console.log("PASS " + name); }
  catch (e: any) { results.push({ name, pass: false, error: e.stack }); console.error("FAIL " + name + ": " + e.message); }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2) + "\n");
if (process.env.WHEELHOUSE_IDENTITY_EVIDENCE_DIR) fs.cpSync(root, process.env.WHEELHOUSE_IDENTITY_EVIDENCE_DIR, { recursive: true });
const failed = results.filter((r: any) => !r.pass).length;
console.log(`selftest-sweep-identity: ${results.length} checks, ${failed} failures`); process.exitCode = failed ? 1 : 0;
