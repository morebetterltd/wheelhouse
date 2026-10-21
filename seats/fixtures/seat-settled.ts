import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mock } from "bun:test";

export const cases = ["config", "threshold", "review", "dispatch", "dedupe", "active", "retry", "traffic", "legacy", "metadata", "exclusions", "bounded", "rotation", "safe-files", "realtime"];
const args = process.argv.slice(2), selected = args[0] === "--case";
const [here, parent] = selected ? args.slice(2) : args;
assert(here && parent && fs.statSync(here).isDirectory() && fs.statSync(parent).isDirectory());
const t0 = Date.UTC(2026, 0, 1), minute = 60_000, iso = (t: number) => new Date(t).toISOString();
const name = selected ? args[1] : "";
const key = "seat-settled-task:worker-a";
function make(label: string) {
  const root = path.join(parent, label); fs.mkdirSync(root);
  const seats = path.join(root, "seats"), logs = path.join(seats, "logs"), bin = path.join(root, "bin");
  fs.cpSync(here, seats, { recursive: true });
  for (const d of [logs, path.join(seats, "run"), bin, path.join(root, "home"), path.join(root, "wheelhouse")]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(logs, "worker-a.jsonl"), tasks = path.join(root, "tasks.json"), stateFile = path.join(seats, "state.json"), rosterFile = path.join(seats, "seats.json");
  const state = { seats: { "worker-a": { pid: process.pid, log, lastBead: "fixture-task", lastDispatchAt: iso(t0 - minute) } as any } };
  const roster = { seats: { "worker-a": { role: "worker", account: { dir: "~/fixture-worker" } } as any } };
  // Shape captured with bd list --json --limit 5000 on 2026-10-20:
  // status=in_progress with labels=[needs-review] is still a review-ready task.
  const rows = [{ id: "fixture-task", title: "Fixture task", status: "in_progress", labels: [] as string[], assignee: "worker-a" }];
  const save = () => { fs.writeFileSync(stateFile, JSON.stringify(state)); fs.writeFileSync(rosterFile, JSON.stringify(roster)); fs.writeFileSync(tasks, JSON.stringify(rows) + "\n"); };
  const events = (...evs: any[]) => fs.writeFileSync(log, evs.map(e => JSON.stringify(e) + "\n").join(""));
  const append = (...evs: any[]) => fs.appendFileSync(log, evs.map(e => JSON.stringify(e) + "\n").join(""));
  events({ type: "agent_end", at: iso(t0) }); save();
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "namespace=settled-fixture\nalert-low-disk-gb=0\nalert-inbox-lag-minutes=999999\nalert-human-after-minutes=999999\ngithub-issue-watch=off\n");
  fs.writeFileSync(path.join(bin, "bd"), '#!/usr/bin/env bash\nif [ "$1" = list ]; then IFS= read -r row < "$SETTLED_TASKS_FILE"; printf "%s\\n" "$row"; else printf "[]\\n"; fi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(seats, "template-drift.sh"), '#!/usr/bin/env bash\nprintf \'{"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n', { mode: 0o755 });
  const clock = path.join(root, "clock.mjs");
  fs.writeFileSync(clock, 'const NativeDate=Date,at=Number(process.env.SETTLED_TEST_NOW);if(!Number.isFinite(at))throw Error("invalid fixture clock");globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};\n');
  let calls = 0;
  const inbox = () => { const file = path.join(seats, "inbox.jsonl"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.source?.name === key) : []; };
  function check(at: number | null, extra: Record<string, string> = {}) {
    calls++;
    const env = { ...process.env, HOME: path.join(root, "home"), PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_ALERTS_ROOT: root, SETTLED_TASKS_FILE: tasks, SETTLED_TEST_NOW: String(at), ...extra };
    delete env.WHEELHOUSE_SEAT_SETTLED_MS;
    Object.assign(env, extra);
    const result = spawnSync("bun", [...(at === null ? [] : ["--preload", clock]), path.join(seats, "alerts.ts"), "check", "--json"], { cwd: root, env, encoding: "utf8" });
    fs.writeFileSync(path.join(root, `call-${calls}.stdout`), result.stdout);
    fs.writeFileSync(path.join(root, `call-${calls}.stderr`), result.stderr);
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout); assert(snapshot.at && snapshot.snapshot);
    fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ code: result.status, at: snapshot.at, observation: snapshot.settledSeats?.["worker-a"], alert: snapshot.alerts[key], inbox: inbox() }) + "\n");
    return snapshot;
  }
  const worker = () => [{ name: "worker-a", entry: null, accountDir: null, busy: true, lastBead: "fixture-task", lastActivityAt: null, taskStatus: rows[0].status, taskNeedsReview: rows[0].labels.includes("needs-review") }];
  return { root, seats, log, rows, state, roster, save, events, append, inbox, check, worker };
}
async function run(which: string) {
  assert(cases.includes(which)); const f = make(which), rec = f.state.seats["worker-a"];
  const observation = (snap: any) => snap.settledSeats?.["worker-a"];
  if (which === "config") {
    const { settledSeatMs } = await import(pathToFileURL(path.join(f.seats, "seat-settled.ts")).href);
    fs.writeFileSync(path.join(f.root, "probe-imported"), "config imported\n");
    delete process.env.WHEELHOUSE_SEAT_SETTLED_MS; assert.equal(settledSeatMs(f.root), 30 * minute);
    fs.appendFileSync(path.join(f.root, "wheelhouse/.template-source"), "seat-settled-minutes=7\n"); assert.equal(settledSeatMs(f.root), 7 * minute);
    process.env.WHEELHOUSE_SEAT_SETTLED_MS = "1000"; assert.equal(settledSeatMs(f.root), 1000);
    for (const value of ["0", "-1", "NaN", "Infinity"]) { process.env.WHEELHOUSE_SEAT_SETTLED_MS = value; assert.throws(() => settledSeatMs(f.root), /at least 1000ms/); }
  } else if (which === "threshold") {
    assert.equal(f.check(t0 + 30 * minute - 1).alerts[key].active, false); assert.equal(f.inbox().length, 0);
    const snap = f.check(t0 + 30 * minute), [row] = f.inbox(); assert.equal(f.inbox().length, 1);
    assert.equal(snap.alerts[key].active, true); assert.equal(row.workerSeat, "worker-a"); assert.equal(row.bead, "fixture-task");
    assert.equal(row.lastEvent, "agent_end"); assert.equal(row.lastEventAt, iso(t0)); assert.equal(row.mode, "progress");
    assert(row.detail.includes("check the background work or redispatch")); assert(row.detail.includes("Cost:")); assert(row.detail.includes("Next:"));
    assert.equal(snap.snapshot.workers.live[0].taskStatus, "in_progress");
    console.log(JSON.stringify({ case: which, row, thresholdMs: observation(snap).quietMs }));
  } else if (which === "review") {
    f.rows[0].labels = ["needs-review"]; rec.lastDispatchAt = iso(t0 - 31 * minute); f.save();
    f.events({ type: "agent_settled" }); // Actual Pi capture: type-only, no event timestamp.
    const snap = f.check(t0), rows = f.inbox(); assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, "review"); assert(rows[0].title.includes("seat free for new work")); assert(rows[0].detail.includes("seat free for new work"));
    assert.equal(observation(snap).quietSince, rec.lastDispatchAt); assert.equal(snap.snapshot.workers.live[0].taskNeedsReview, true);
    assert.equal(observation(snap).eventTimeSource, "observed");
    console.log(JSON.stringify({ case: which, row: rows[0], eventAgeMs: 0, dispatchAgeMs: 31 * minute, legacyTypeOnly: true }));
    // Native Pi can expose both terminal records without another dispatch.
    f.append({ type: "agent_end", willRetry: false }, { type: "agent_settled" });
    f.check(t0 + minute); assert.equal(f.inbox().length, 1, "review-ready reminders dedupe by dispatch, not terminal record count");
  } else if (which === "dispatch") {
    for (const review of [false, true]) {
      const base = t0 + (review ? 120 * minute : 0);
      f.rows[0].labels = review ? ["needs-review"] : []; rec.lastDispatchAt = iso(base - 40 * minute); f.save();
      f.events({ type: "agent_end", at: iso(base) });
      assert.equal(f.check(base + 31 * minute).alerts[key].active, true); const before = f.inbox().length;
      rec.lastDispatchAt = iso(base + 32 * minute); f.save();
      const snap = f.check(base + 33 * minute); assert.equal(snap.alerts[key].active, false); assert.equal(f.inbox().length, before);
      f.check(base + 40 * minute); assert.equal(f.inbox().length, before);
    }
  } else if (which === "dedupe") {
    const first = f.check(t0 + 31 * minute); assert.equal(f.inbox().length, 1);
    for (let i = 1; i <= 3; i++) { const next = f.check(t0 + (31 + i) * minute); assert.equal(f.inbox().length, 1); assert.deepEqual(next.alerts[key], first.alerts[key]); }
    f.rows[0].labels = ["needs-review"]; f.save(); f.check(t0 + 35 * minute); assert.equal(f.inbox().length, 2); assert.equal(f.inbox()[1].mode, "review");
    f.check(t0 + 36 * minute); assert.equal(f.inbox().length, 2);
  } else if (which === "active") {
    f.check(t0 + 31 * minute); const before = f.inbox().length;
    f.append({ type: "agent_start", at: iso(t0 + 32 * minute) });
    f.append({ type: "response", command: "get_state", success: true, data: { isStreaming: false } });
    const snap = f.check(t0 + 63 * minute); assert.equal(observation(snap).phase, "active"); assert.equal(snap.alerts[key].active, false); assert.equal(f.inbox().length, before);
    f.events({ type: "tool_execution_start", at: iso(t0), toolName: "bash", toolCallId: "held-command" });
    assert.equal(f.check(t0 + 70 * minute).alerts[key].active, false);
    f.events({ type: "agent_end", at: iso(t0) }, { type: "compaction_end", at: iso(t0 + 69 * minute) });
    assert.equal(f.check(t0 + 70 * minute).alerts[key].active, false);
    const maintained = f.check(t0 + 100 * minute); assert.equal(observation(maintained).phase, "settled"); assert.equal(maintained.alerts[key].active, true);
    assert.equal(f.inbox().length, before + 1); assert.equal(f.inbox().at(-1).lastEvent, "compaction_end");
  } else if (which === "retry") {
    f.events({ type: "agent_end", willRetry: true, at: iso(t0) });
    assert.equal(observation(f.check(t0 + 31 * minute)).phase, "active"); assert.equal(f.inbox().length, 0);
    f.events({ type: "turn_end", at: iso(t0) }); assert.equal(observation(f.check(t0 + 32 * minute)).phase, "active"); assert.equal(f.inbox().length, 0);
  } else if (which === "traffic") {
    f.check(t0 + 10 * minute);
    for (const at of [20, 29, 30]) { f.append({ type: "response", command: "get_state", success: true, timestamp: iso(t0 + at * minute), data: { isStreaming: false, isCompacting: false } }); f.check(t0 + at * minute); }
    assert.equal(f.inbox().length, 1); assert.equal(f.inbox()[0].lastEventAt, iso(t0));
  } else if (which === "legacy") {
    f.events({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", timestamp: t0 - 8 * 60 * minute }] }, { type: "agent_settled" });
    let snap = f.check(t0); assert.equal(f.inbox().length, 0); assert.equal(observation(snap).lastEventAt, iso(t0)); assert.equal(observation(snap).eventTimeSource, "observed");
    const poll = JSON.stringify({ type: "response", command: "get_state", data: { isStreaming: false }, pad: "x".repeat(300) }) + "\n";
    fs.appendFileSync(f.log, poll.repeat(5000));
    snap = f.check(t0 + 30 * minute); assert.equal(f.inbox().length, 1); assert.equal(observation(snap).lastEventAt, iso(t0));
  } else if (which === "metadata") {
    f.events({ type: "agent_end", timestamp: iso(t0 - 2 * 60 * minute), wheelhouse_received_at: iso(t0), message: { timestamp: t0 - 8 * 60 * minute } });
    assert.equal(f.check(t0 + 29 * minute).alerts[key].active, false);
    assert.equal(observation(f.check(t0 + 30 * minute)).eventTimeSource, "received"); assert.equal(f.inbox().length, 1);
  } else if (which === "exclusions") {
    f.rows[0].status = "closed"; f.rows[0].labels = ["needs-review"]; f.save(); f.check(t0 + 31 * minute); assert.equal(f.inbox().length, 0);
    f.rows[0].status = "in_progress"; f.rows[0].labels = []; rec.pid = 999999999; f.save(); f.check(t0 + 32 * minute); assert.equal(f.inbox().length, 0);
    rec.pid = process.pid; rec.stoppedAt = iso(t0); f.save(); f.check(t0 + 33 * minute); assert.equal(f.inbox().length, 0);
    delete rec.stoppedAt; f.roster.seats["worker-a"].external = true; f.save(); f.check(t0 + 34 * minute); assert.equal(f.inbox().length, 0);
    f.roster.seats["worker-a"].external = false; delete rec.lastBead; f.save(); f.check(t0 + 35 * minute); assert.equal(f.inbox().length, 0);
    rec.lastBead = "fixture-task"; f.rows[0].labels = ["needs-review"]; f.save(); fs.truncateSync(f.log, 0);
    assert.equal(observation(f.check(t0 + 36 * minute)).phase, "unknown"); assert.equal(f.inbox().length, 0, "assignment/empty log is not proof of settlement");
  } else if (which === "bounded") {
    const terminal = JSON.stringify({ type: "agent_end", at: iso(t0) }) + "\n", shell = JSON.stringify({ type: "response", pad: "" }) + "\n";
    const filler = JSON.stringify({ type: "response", pad: "x".repeat(1024 * 1024 - Buffer.byteLength(terminal) - Buffer.byteLength(shell)) }) + "\n";
    assert.equal(Buffer.byteLength(terminal + filler), 1024 * 1024);
    fs.writeFileSync(f.log, "🪵 prefix\n" + terminal + filler); f.check(t0 + 31 * minute); assert.equal(f.inbox().length, 1);
  } else if (which === "rotation") {
    const first = f.check(t0 + 31 * minute); assert.equal(f.inbox().length, 1);
    fs.copyFileSync(f.log, f.log + ".1"); fs.truncateSync(f.log, 0);
    const next = f.check(t0 + 32 * minute); assert.equal(f.inbox().length, 1); assert.equal(observation(next).eventKey, observation(first).eventKey);
    f.append({ type: "response", command: "get_state", data: { isStreaming: false } }); f.check(t0 + 32.5 * minute); assert.equal(f.inbox().length, 1);
    f.events({ type: "agent_start", at: iso(t0 + 33 * minute) }); f.check(t0 + 34 * minute);
    fs.truncateSync(f.log, 0); f.check(t0 + 70 * minute); assert.equal(f.inbox().length, 1, "old archive cannot hide a newer active turn");
  } else if (which === "safe-files") {
    const native = { ...fs }; let opens = 0;
    const guarded = (p: any, ...rest: any[]) => { if (p === f.log) { opens++; throw Error("unsafe fixture log was opened"); } return (native.openSync as any)(p, ...rest); };
    mock.module("node:fs", () => ({ ...native, openSync: guarded, default: { ...native, openSync: guarded } }));
    const { observeSettledSeats } = await import(pathToFileURL(path.join(f.seats, "seat-settled.ts")).href);
    native.writeFileSync(path.join(f.root, "probe-imported"), "safe-files imported\n");
    for (const kind of ["symlink", "hardlink", "fifo"]) {
      native.unlinkSync(f.log); const other = path.join(f.root, "other-" + kind); native.writeFileSync(other, JSON.stringify({ type: "agent_end", at: iso(t0) }) + "\n");
      if (kind === "symlink") native.symlinkSync(other, f.log);
      else if (kind === "hardlink") native.linkSync(other, f.log);
      else assert.equal(spawnSync("mkfifo", [f.log]).status, 0);
      assert.equal(Object.keys(observeSettledSeats(f.root, f.worker(), {}, t0 + 31 * minute)).length, 0); assert.equal(opens, 0, "unsafe logs must be refused before open");
    }
  } else if (which === "realtime") {
    const start = Date.now(); rec.lastDispatchAt = iso(start); f.save(); f.events({ type: "agent_end", at: iso(start) });
    while (Date.now() - start < 1100) await Bun.sleep(20);
    const snap = f.check(null, { WHEELHOUSE_SEAT_SETTLED_MS: "1000" }); assert.equal(f.inbox().length, 1); process.kill(process.pid, 0);
    const age = Date.parse(snap.at) - start; assert(age >= 1000); console.log(JSON.stringify({ case: which, quietMs: 1000, detectedAfterMs: age, processAlive: true }));
  }
  console.log("PASS " + which);
}
if (selected) await run(name);
else {
  for (const which of cases) {
    const result = spawnSync("bun", [import.meta.path, "--case", which, here, parent], { encoding: "utf8" });
    fs.writeFileSync(path.join(parent, which + ".stdout"), result.stdout); fs.writeFileSync(path.join(parent, which + ".stderr"), result.stderr);
    if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.signal, null); assert.equal(result.error, undefined); assert.equal(result.status, 0, which + " fixture");
  }
  console.log(`seat-settled.selftest: PASS (${cases.length} positive cases)`);
}
