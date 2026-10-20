import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// Runtime under test is a selftest-owned copy, never the installed seats.
const [root, selected = "all"] = process.argv.slice(2), seats = path.join(root, "seats");
const { eventLogFilter } = await import(path.join(seats, "seat-event-log.ts"));
const { seatStreamHealth, seatQuietMs, seatStallNeedMs } = await import(path.join(seats, "seat-stream-health.ts"));
const { barePidAlive, processStartMs } = await import(path.join(seats, "seat-activity.ts"));
const bin = path.join(root, "bin"), fifo = path.join(seats, "run/worker-a.stdin"), log = path.join(seats, "logs/worker-a.jsonl");
fs.mkdirSync(path.dirname(fifo), { recursive: true }); fs.mkdirSync(path.dirname(log), { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(root, "wheelhouse"));
assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
const holder = fs.openSync(fifo, fs.constants.O_RDWR);
const stamp = Date.now(), quiet = 20 * 60_000, born = processStartMs(process.pid);
assert(born !== null, "native fixture process birth must exist before measuring health");
let record: any = { pid: process.pid, fifo, startedAt: new Date(born).toISOString(), log, role: "worker", accountDir: path.join(root, "account"), cwd: root, lastBead: "fixture-abcd", lastDispatchAt: new Date(stamp).toISOString() };
const config = path.join(root, "wheelhouse/.template-source");
const baseConfig = "namespace=fixture\nseat-quiet-minutes=20\nseat-stall-need-after-minutes=15\nalert-low-disk-gb=0\nalert-inbox-lag-minutes=1000000\ngithub-issue-watch=off\n";
fs.writeFileSync(config, baseConfig);
fs.writeFileSync(path.join(seats, "seats.json"), JSON.stringify({ seats: { "worker-a": { role: "worker", worktree: false, runtime: "pi", account: { dir: record.accountDir } } } }));
fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });
fs.writeFileSync(path.join(seats, "template-drift.sh"), '#!/bin/sh\nprintf \'{"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n');
const snapshotFile = path.join(seats, "run/fleet-snapshot.json"), inboxFile = path.join(seats, "inbox.jsonl"), needsFile = path.join(seats, "needs.jsonl");
const source = "seat-stalled:worker-a";
function rows(file: string): any[] { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []; }
function inbox() { return rows(inboxFile).filter(r => r.source?.name === source); }
function state() { fs.writeFileSync(path.join(seats, "state.json"), JSON.stringify({ seats: { "worker-a": record } })); }
function reset() {
  for (const file of [snapshotFile, inboxFile, needsFile]) fs.rmSync(file, { force: true });
  fs.writeFileSync(config, baseConfig); fs.writeFileSync(log, "");
  delete process.env.WHEELHOUSE_SEAT_QUIET_MS; delete process.env.WHEELHOUSE_SEAT_STALL_NEED_MS;
  delete record.stoppedAt; delete record.lastCapacityEvent; record.pid = process.pid; record.lastBead = "fixture-abcd"; state();
}
function event(type: string, at: number, extra: any = {}) { fs.appendFileSync(log, JSON.stringify({ type, wheelhouse_received_at: new Date(at).toISOString(), ...extra }) + "\n"); }
function health(now = stamp, prior?: any) { const h = seatStreamHealth(root, "worker-a", record, prior, now); assert(h, "native FIFO-owning fixture process must be observed"); return h; }
function silent() { event("agent_start", stamp - 2 * quiet); event("message_start", stamp - 2 * quiet, { message: { role: "assistant", timestamp: stamp - 8 * quiet } }); }
function cli(file: string, args: string[]) {
  const r = spawnSync("bun", [path.join(seats, file), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BEADS_ACTOR: "wheelhouse-selftest", WHEELHOUSE_ALERTS_ROOT: root, WHEELHOUSE_NEEDS_ROOT: root } });
  assert.equal(r.status, 0, `${file} exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`); return r;
}
function check() { const r = cli("alerts.ts", ["check", "--json"]); const stored = JSON.parse(fs.readFileSync(snapshotFile, "utf8")); assert.equal(JSON.parse(r.stdout).at, stored.at); return stored; }
function ageNeed() { const j = JSON.parse(fs.readFileSync(snapshotFile, "utf8")); j.alerts[source].since = new Date(Date.now() - seatStallNeedMs(root) - 1000).toISOString(); fs.writeFileSync(snapshotFile, JSON.stringify(j)); }
function assertRow() { const r = inbox().at(-1); assert(r); assert.equal(r.source.seat, "worker-a"); assert.equal(r.source.bead, record.lastBead); assert.equal(r.source.lastEventAt, new Date(stamp - 2 * quiet).toISOString()); assert(r.detail.includes("seat=worker-a")); assert(r.detail.includes(`task=${record.lastBead}`)); assert(r.detail.includes(r.source.lastEventAt)); }
const cases: Record<string, () => void | Promise<void>> = {
  config() {
    fs.writeFileSync(config, ""); assert.equal(seatQuietMs(root), quiet); assert.equal(seatStallNeedMs(root), 15 * 60_000);
    fs.writeFileSync(config, "seat-quiet-minutes=3\nseat-stall-need-after-minutes=2\n"); assert.equal(seatQuietMs(root), 180_000); assert.equal(seatStallNeedMs(root), 120_000);
    process.env.WHEELHOUSE_SEAT_QUIET_MS = "2000"; process.env.WHEELHOUSE_SEAT_STALL_NEED_MS = "0"; assert.equal(seatQuietMs(root), 2000); assert.equal(seatStallNeedMs(root), 0);
    delete process.env.WHEELHOUSE_SEAT_QUIET_MS; delete process.env.WHEELHOUSE_SEAT_STALL_NEED_MS;
    fs.writeFileSync(config, "seat-quiet-minutes=garbage\n"); assert.throws(() => seatQuietMs(root), /must be at least/);
  },
  threshold() {
    silent(); const t = stamp - 2 * quiet;
    assert.equal(health(t + quiet - 1).stalled, false);
    const h = health(t + quiet); assert.equal(h.stalled, true); assert.equal(h.lastEventAt, new Date(t).toISOString()); assert.equal(h.lastEvent, "message_start");
  },
  async realTime() {
    process.env.WHEELHOUSE_SEAT_QUIET_MS = "1000";
    const began = Date.now(); event("agent_start", began); assert.equal(health(began).stalled, false);
    const remaining = 1020 - (Date.now() - began); if (remaining > 0) await Bun.sleep(remaining);
    const observed = Date.now(); assert.equal(health(observed).stalled, true); assert.equal(check().alerts[source].active, true);
    const resumed = Date.now(); event("stream_activity", resumed); assert.equal(health(resumed).stalled, false);
    console.log(JSON.stringify({ realQuietMs: 1000, detectedAfterMs: observed - began, processAlive: barePidAlive(process.pid) }));
  },
  progress() {
    silent(); let current = stamp;
    const filter = eventLogFilter((line: string) => fs.appendFileSync(log, line), () => current);
    for (const type of ["thinking_delta", "text_delta", "toolcall_delta"]) { current += quiet - 1; filter(JSON.stringify({ type: "message_update", assistantMessageEvent: { type, delta: "PRIVATE TEXT" } })); assert.equal(health(current + quiet - 1).stalled, false); }
    const text = fs.readFileSync(log, "utf8"); assert(!text.includes("PRIVATE TEXT")); assert.equal(rows(log).filter(r => r.type === "stream_activity").length, 3);
    assert.equal(health(current + quiet).stalled, true);
  },
  driverTimestamps() {
    fs.appendFileSync(log, JSON.stringify({ type: "agent_start", timestamp: stamp - 2 * quiet }) + "\n"); assert.equal(health(stamp).stalled, true);
    fs.appendFileSync(log, JSON.stringify({ type: "message_end", timestamp: stamp, message: { role: "assistant", timestamp: stamp - 8 * quiet } }) + "\n"); assert.equal(health(stamp + quiet - 1).stalled, false);
  },
  filter() {
    let current = stamp; const out: string[] = [], filter = eventLogFilter((s: string) => out.push(s), () => current, 16);
    const delta = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } });
    filter(delta); filter(delta); current += 1000; filter(delta);
    filter(JSON.stringify({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", output: "X".repeat(300) }));
    const parsed = out.map(l => JSON.parse(l)); assert.equal(parsed.filter(o => o.type === "stream_activity").length, 2); assert(!out.join("").includes("secret")); assert(parsed.every(o => o.wheelhouse_received_at)); assert(parsed.at(-1).wheelhouse_truncated_bytes > 0);
  },
  async framing() {
    const child = Bun.spawn(["bun", path.join(seats, "seat-event-log.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", text: "é🛠" } }) + "\n";
    for (const byte of Buffer.from(line)) { child.stdin.write(Uint8Array.of(byte)); child.stdin.flush(); }
    child.stdin.end(); const [out, err, rc] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(rc, 0, err); assert.equal(JSON.parse(out).message.text, "é🛠"); assert(JSON.parse(out).wheelhouse_received_at); assert.equal(out.split("\n").length, 2);
  },
  polls() {
    silent(); const before = health(stamp);
    event("response", stamp, { command: "get_state", success: true, data: { isStreaming: false } });
    event("response", stamp + quiet, { command: "prompt", success: true });
    const after = health(stamp + quiet, before); assert.equal(after.stalled, true); assert.equal(after.lastEventAt, before.lastEventAt); assert.equal(after.progressKey, before.progressKey);
  },
  settled() {
    for (const type of ["agent_end", "agent_settled"]) {
      fs.writeFileSync(log, ""); silent(); event(type, stamp - quiet, { messages: [{ role: "assistant", stopReason: "stop" }] }); event("response", stamp, { data: { isStreaming: false } });
      assert.equal(health(stamp + quiet).phase, "idle"); assert.equal(health(stamp + quiet).stalled, false);
    }
    event("agent_end", stamp - quiet, { willRetry: true }); assert.equal(health(stamp).stalled, true, "retrying agent_end is not settlement");
  },
  async tool() {
    // A real isolated long command is alive while its enclosing seat has no
    // new events. No fabricated timer heartbeat or host admission is required.
    const release = path.join(seats, "run/tool-release"); assert.equal(spawnSync("mkfifo", [release]).status, 0); const fd = fs.openSync(release, fs.constants.O_RDWR);
    const child = Bun.spawn(["bash", "-c", 'printf "ready\\n"; IFS= read -r line < "$1"', "fixture", release], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader(); const ready = await reader.read(); assert(Buffer.from(ready.value!).toString().includes("ready")); assert(barePidAlive(child.pid));
      silent(); event("tool_execution_start", stamp - quiet * 2, { toolCallId: "long", toolName: "bash" });
      const h = health(stamp + quiet * 8); assert.equal(h.phase, "tool"); assert.equal(h.stalled, false); assert.deepEqual(h.pendingTools, ["bash"]);
      const snap = check(); assert.equal(snap.alerts[source].active, false); assert.equal(inbox().length, 0);
      const status = cli("adapter.ts", ["status"]).stdout; assert.match(status, /RUNNING/); assert.match(status, /TOOL WAIT: bash/); assert(!/STALLED/.test(status));
      fs.writeSync(fd, "release\n"); assert.equal(await child.exited, 0); reader.releaseLock();
      event("tool_execution_end", stamp, { toolCallId: "long", toolName: "bash" }); assert.equal(health(stamp + quiet).stalled, true, "model clock resumes after tool return");
    } finally { try { child.kill(); } catch {} fs.closeSync(fd); fs.rmSync(release); }
  },
  parallel() {
    silent(); event("tool_execution_start", stamp - 3 * quiet, { toolCallId: "a", toolName: "bash" }); event("tool_execution_start", stamp - 3 * quiet, { toolCallId: "b", toolName: "read" }); event("tool_execution_end", stamp - 2 * quiet, { toolCallId: "a" });
    assert.equal(health(stamp).phase, "tool"); assert.equal(health(stamp).stalled, false); event("tool_execution_end", stamp, { toolCallId: "b" }); assert.equal(health(stamp + quiet).stalled, true);
  },
  legacy() {
    fs.writeFileSync(log, JSON.stringify({ type: "agent_start" }) + "\n"); const old = stamp - quiet * 2; fs.utimesSync(log, old / 1000, old / 1000);
    const prior = health(stamp); assert(prior.stalled);
    event("response", stamp, { data: { isStreaming: false } }); const next = health(stamp, prior); assert(next.stalled); assert.equal(next.lastEventAt, prior.lastEventAt);
  },
  bounded() {
    silent(); event("tool_execution_start", stamp - quiet * 2, { toolCallId: "long", toolName: "bash" }); const prior = health(stamp);
    const poll = JSON.stringify({ type: "response", padding: "x".repeat(65536) }) + "\n"; fs.appendFileSync(log, poll.repeat(18));
    const next = health(stamp + 8 * quiet, prior); assert.equal(next.phase, "tool"); assert.equal(next.stalled, false); assert.equal(next.lastEventAt, prior.lastEventAt);
    record.lastBead = "fixture-efgh"; assert.equal(health(stamp + 8 * quiet, next).phase, "tool", "queued next assignment must not erase this process's open tool");
    event("tool_execution_end", stamp, { toolCallId: "long" }); assert.equal(health(stamp + quiet, next).stalled, true);
    // Real Pi emits a fresh turn_start after its tool results. Its small event
    // must retire remembered tools even when the preceding result was huge.
    fs.appendFileSync(log, JSON.stringify({ type: "tool_execution_end", toolCallId: "long", result: "x".repeat(1200000) }) + "\n");
    event("turn_start", stamp); const model = health(stamp + quiet, next); assert.equal(model.phase, "model"); assert.equal(model.stalled, true);
  },
  alert() {
    silent(); const j = check(); assert.equal(j.alerts[source].active, true); assert.equal(j.seatStreams["worker-a"].phase, "model"); assertRow();
    const status = cli("adapter.ts", ["status"]).stdout; assert.match(status, /worker-a\s+STALLED/); assert(status.includes(new Date(stamp - 2 * quiet).toISOString()));
  },
  dedupe() {
    silent(); check(); const first = inbox()[0]; assert(first); check(); check(); assert.equal(inbox().length, 1); assert.equal(inbox()[0].id, first.id);
  },
  need() {
    silent(); check(); assert.equal(rows(needsFile).filter(r => r.type === "opened").length, 0); ageNeed(); check(); check();
    const opened = rows(needsFile).filter(r => r.type === "opened"); assert.equal(opened.length, 1); assert.equal(opened[0].machine.seat, "worker-a"); assert.equal(opened[0].machine.bead, "fixture-abcd"); assert(!opened[0].body.includes("fixture-abcd")); assert(opened[0].body.includes("Next:")); assert(opened[0].body.includes("Cost:"));
  },
  recovery() {
    silent(); check(); ageNeed(); check(); const oldNeed = rows(needsFile).find(r => r.type === "opened"); assert(oldNeed);
    event("stream_activity", Date.now()); const cleared = check(); assert.equal(cleared.alerts[source].active, false); assert.equal(rows(needsFile).filter(r => r.type === "closed" && r.id === oldNeed.id).length, 1);
    record.lastBead = "fixture-efgh"; state(); fs.writeFileSync(log, ""); silent(); check(); assert.equal(inbox().length, 2); assertRow(); assert.equal(rows(needsFile).filter(r => r.type === "opened").length, 1, "new assignment gets a new persistence grace");
  },
  exclusions() {
    silent(); record.stoppedAt = new Date(stamp).toISOString(); assert.equal(seatStreamHealth(root, "worker-a", record), null); delete record.stoppedAt;
    record.lastCapacityEvent = { detail: "quota" }; assert.equal(seatStreamHealth(root, "worker-a", record), null); delete record.lastCapacityEvent;
    record.pid = 2147483647; assert.equal(seatStreamHealth(root, "worker-a", record), null); record.pid = process.pid;
    const outside = path.join(root, "KEEP"); fs.copyFileSync(log, outside); const original = fs.readFileSync(outside); record.log = outside; assert.equal(seatStreamHealth(root, "worker-a", record), null); record.log = log;
    fs.rmSync(log); fs.symlinkSync(outside, log); assert.equal(seatStreamHealth(root, "worker-a", record), null); fs.rmSync(log); fs.linkSync(outside, log); assert.equal(seatStreamHealth(root, "worker-a", record), null); fs.rmSync(log); fs.writeFileSync(log, original); assert.deepEqual(fs.readFileSync(outside), original);
  },
};
let failed = 0, ran = 0;
try {
  assert(selected === "all" || cases[selected], `unknown test case ${selected}`);
  for (const [name, run] of Object.entries(cases)) if (selected === "all" || selected === name) {
    reset(); ran++;
    try { await run(); console.log(`  ok    ${name}`); } catch (e: any) { failed++; console.error(`  FAIL  ${name}: ${e.stack}`); }
  }
} finally { fs.closeSync(holder); }
console.log(`seat-stream selftest: ${ran - failed}/${ran} passed`);
if (!failed && selected === "all") {
  const { mutationChecks } = await import("./seat-stream-canaries");
  await mutationChecks(root, import.meta.path);
}
process.exitCode = failed ? 1 : 0;
