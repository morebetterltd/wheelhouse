// Real adapter CLI writes, but only against newly copied fixture runtimes.
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const [source, root] = process.argv.slice(2);
assert.ok(source && fs.statSync(source).isFile(), "adapter source must exist");
assert.ok(root && fs.statSync(root).isDirectory(), "owned case root must exist");
const seats = path.join(root, "project", "seats");
fs.mkdirSync(seats, { recursive: true });
// Never execute the input adapter at its original location: ROOT controls state.
for (const entry of fs.readdirSync(path.dirname(source), { withFileTypes: true })) {
  const src = path.join(path.dirname(source), entry.name), dest = path.join(seats, entry.name);
  if (entry.isFile() && entry.name.endsWith(".ts")) fs.copyFileSync(src, dest);
  if (entry.isDirectory() && ["drivers", "transports"].includes(entry.name)) fs.cpSync(src, dest, { recursive: true });
}
const adapter = path.join(seats, "adapter.ts");
fs.copyFileSync(source, adapter);
const state = path.join(seats, "state.json"), lock = path.join(seats, "state.lock");
const home = path.join(root, "home"), tmp = path.join(root, "tmp");
fs.mkdirSync(home); fs.mkdirSync(tmp);
const env = { ...process.env, HOME: home, TMPDIR: tmp, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_STATE_LOCK_TIMEOUT_MS: "150" };
const aged = () => { const at = new Date(Date.now() - 60_000); fs.utimesSync(lock, at, at); };
function reset() {
  fs.rmSync(lock, { force: true });
  fs.writeFileSync(state, JSON.stringify({ seats: { "worker-1": { pid: null, cwd: root, sessionId: "fixture-only" } } }, null, 2) + "\n");
}
function run(extra = {}) {
  return spawnSync(process.execPath, [adapter, "stop", "worker-1"], { encoding: "utf8", env: { ...env, ...extra }, timeout: 10_000 });
}
function wrote(r: ReturnType<typeof run>) {
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal("cwd" in JSON.parse(fs.readFileSync(state, "utf8")).seats["worker-1"], false, "real CLI state mutation must commit");
  assert.equal(fs.existsSync(lock), false, "owner must release state.lock");
}
function refused(beforeState: string, beforeLock: string, ino: number) {
  const r = run();
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /timed out waiting for .*state\.lock/);
  assert.equal(fs.readFileSync(state, "utf8"), beforeState);
  assert.equal(fs.readFileSync(lock, "utf8"), beforeLock);
  assert.equal(fs.statSync(lock).ino, ino);
}
let failures = 0;
async function test(name: string, check: () => void | Promise<void>) {
  try { await check(); console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}

for (const [name, text] of [["empty", ""], ["malformed", "not a pid\n"]]) {
  await test(`old closed ${name} state.lock is reclaimed and real state write commits`, () => {
    reset(); fs.writeFileSync(lock, text); aged();
    assert.ok(fs.existsSync(lock)); assert.ok("cwd" in JSON.parse(fs.readFileSync(state, "utf8")).seats["worker-1"]);
    wrote(run());
  });
}

await test("fresh incomplete lock gets grace, then the same aged lock is reclaimed", () => {
  reset(); fs.writeFileSync(lock, "");
  // A future mtime keeps this safely inside grace even on a loaded test host.
  const fresh = new Date(Date.now() + 5000); fs.utimesSync(lock, fresh, fresh);
  refused(fs.readFileSync(state, "utf8"), "", fs.statSync(lock).ino);
  aged(); wrote(run());
});

await test("old open empty lock is protected, then reclaimed only after close", () => {
  reset(); const fd = fs.openSync(lock, "wx");
  try {
    aged(); refused(fs.readFileSync(state, "utf8"), "", fs.statSync(lock).ino);
  } finally { fs.closeSync(fd); }
  wrote(run());
});

await test("live PID is never stolen by acquisition or an old owner's release", async () => {
  reset(); fs.writeFileSync(lock, `${process.pid}\n`); aged();
  refused(fs.readFileSync(state, "utf8"), `${process.pid}\n`, fs.statSync(lock).ino);
  fs.unlinkSync(lock);
  // Now an adapter owns a real handle; replace its path with our live owner.
  const child = spawn(process.execPath, [adapter, "stop", "worker-1"], { env: { ...env, WHEELHOUSE_STATE_WRITE_DELAY_MS: "2000" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
  const done = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === `${child.pid}\n`) break;
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`writer exited before acquiring: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.readFileSync(lock, "utf8"), `${child.pid}\n`, "real writer must hold its lock before replacement");
    fs.unlinkSync(lock); fs.writeFileSync(lock, `${process.pid}\n`); aged();
    const replacement = fs.statSync(lock);
    assert.equal(await done, 0, output);
    assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`, "old release deleted live replacement");
    assert.equal(fs.statSync(lock).ino, replacement.ino);
    assert.equal("cwd" in JSON.parse(fs.readFileSync(state, "utf8")).seats["worker-1"], false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await done; }
  }
});

await test("failed PID write never publishes an empty state.lock or leaks a candidate", () => {
  reset(); const before = fs.readFileSync(state, "utf8");
  const code = `
    const fs = require('node:fs'), original = fs.writeFileSync;
    fs.writeFileSync = function(fd, ...args) {
      if (typeof fd === 'number') throw Error('fixture PID write refusal');
      return original.call(this, fd, ...args);
    };
    process.argv = [process.execPath, ${JSON.stringify(adapter)}, 'stop', 'worker-1'];
    await import(${JSON.stringify(adapter)});
  `;
  const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /fixture PID write refusal/);
  assert.equal(fs.existsSync(lock), false, "PID write failure left an empty public state.lock");
  assert.equal(fs.readdirSync(seats).some(n => n.startsWith("state.lock.tmp.")), false);
  assert.equal(fs.readFileSync(state, "utf8"), before);
});
console.log(`adapter state lock: ${failures ? "FAIL" : "PASS"} (${failures} failure(s))`);
process.exitCode = failures ? 1 : 0;
