// Real helper transitions and an idle real runner, isolated from host admission.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
const [root, helper, runner] = process.argv.slice(2);
// Exact current-main helper captured at 76bd232 (blob 3805817f...).
const oldHelper = path.join(import.meta.dir, "sweep-lock-v1.ts");
assert(fs.statSync(oldHelper).isFile());
const oldBytes = fs.readFileSync(oldHelper);
assert.equal(createHash("sha1").update(`blob ${oldBytes.length}\0`).update(oldBytes).digest("hex"), "3805817fedd7e663527097697d3a54df27ea735c", "frozen current-main helper is byte-exact");
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(helper).isFile()); assert(fs.statSync(runner).isFile());
const source = fs.readFileSync(helper, "utf8"), marker = "wheelhouse-selftest-sweep", anchor = marker + "-queue";
const tokenA = "a".repeat(32), tokenB = "b".repeat(32), results: object[] = [];
const helpers = new Map<string, string>();
for (const hostname of ["network-before", "network-after"]) {
  assert.equal(source.split("const HOST = os.hostname();").length, 2, "instrument only reported hostname");
  const file = path.join(root, hostname + ".ts");
  fs.writeFileSync(file, source.replace("const HOST = os.hostname();", `const HOST = ${JSON.stringify(hostname)};`)); helpers.set(hostname, file);
}
function call(dir: string, op: string, token: string, owned = "", file = helper) {
  const args = [file, op, path.join(dir, "host.lock"), String(process.pid), token, owned];
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
function diagnostic(r: ReturnType<typeof call>, file: string) {
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const lines = r.stderr.split("\n").filter(x => x.startsWith("SELFTEST_LOCK_REFUSAL ")); assert.equal(lines.length, 1, r.stderr);
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
async function network(dir: string) {
  const before = helpers.get("network-before")!, after = helpers.get("network-after")!, owned = acquired(dir, before), lock = path.join(dir, "host.lock");
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
    release(dir, owned, after);
    assert.equal(await done, 0, out + err); assert.equal(fs.readFileSync(stamp, "utf8"), "ran\n");
    assert(!fs.existsSync(lock));
    const cancel = call(dir, "release", tokenB); assert.equal(cancel.status, 0, cancel.stderr); assert(!fs.existsSync(lock + ".queue"));
    const legacyOwned = acquired(dir); release(dir, legacyOwned);
  } finally { if (!closed) child.kill("SIGTERM"); await done; fs.writeFileSync(path.join(dir, "runner.out"), out); fs.writeFileSync(path.join(dir, "runner.err"), err); }
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
  // Exact publication command from verify-readiness.ts's hold-H4 branch.
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
const cases = [["network-change", network], ["current-helper-compatibility", compatibility], ["rewritten-lock", (d: string) => rewritten(d, "lock")], ["rewritten-queue", (d: string) => rewritten(d, "queue")], ["rewritten-waiter", (d: string) => rewritten(d, "waiter")], ["legacy-mv-writer", writer]] as const;
const selected = process.env.WHEELHOUSE_IDENTITY_TEST_CASE;
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
