// Test-only native child identities. Shared by Bun fixture entrypoints and the
// Node model stub; never imported by the production verifier.
"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { spawnSync } = require("./fixture-command.cjs");
const columns = "pid=,ppid=,pgid=,stat=,lstart=,comm=";

function readProcess(pid, run = spawnSync) {
  assert(Number.isSafeInteger(pid) && pid > 1, "child PID must be a real subject");
  const r = run("ps", ["-ww", "-p", String(pid), "-o", columns], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const native = { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (r.error || native.signal || native.stderr) throw new Error(`incomplete child identity observation: ${JSON.stringify({ pid, ...native, error: r.error?.message })}`);
  if (native.status === 1 && !native.stdout.trim()) return { kind: "absent", native };
  // Captured native ps layout: PID PPID PGID STAT weekday month day time year
  // comm. Fix locale/timezone and normalize padding, not identity values.
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d\d:\d\d:\d\d)\s+(\d{4})\s*(.*?)\s*$/.exec(native.stdout);
  if (native.status !== 0 || !m || Number(m[1]) !== pid) throw new Error(`incomplete child identity record: ${JSON.stringify({ pid, ...native })}`);
  const identity = { pid, ppid: Number(m[2]), pgid: Number(m[3]), state: m[4], started: m.slice(5, 10).join(" "), command: m[10] };
  validate(identity);
  return { kind: "present", identity, native };
}
function validate(identity) {
  assert(identity && Number.isSafeInteger(identity.pid) && identity.pid > 1 && Number.isSafeInteger(identity.pgid) && identity.pgid > 0 && Number.isSafeInteger(identity.ppid) && identity.ppid >= 0 && typeof identity.started === "string" && identity.started.length > 10 && typeof identity.state === "string" && identity.state.length, "missing or malformed recorded child identity");
}
function recordChild(event) {
  const file = process.env.WHEELHOUSE_TEST_CHILD_LEDGER;
  assert(file, "identity publication requires a child ledger");
  const observed = readProcess(process.pid);
  assert.equal(observed.kind, "present", "child must capture itself before payload/exit");
  assert(!observed.identity.state.startsWith("Z"), "spawn identity must describe a live child");
  const row = { ...event, pid: process.pid, identity: observed.identity };
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  return row;
}
function judge(recorded, observed) {
  validate(recorded);
  if (observed.kind === "absent") return "gone";
  assert.equal(observed.kind, "present", "unknown native child observation");
  validate(observed.identity);
  assert.equal(observed.identity.pid, recorded.pid, "observer examined another PID");
  if (recorded.started !== observed.identity.started) return "reused";
  if (observed.identity.state.startsWith("Z")) return "zombie";
  // PGID/PPID/comm are diagnostics, not immutable birth identity: a live child
  // may regroup, be reparented or exec. Do not silently excuse that survivor.
  // ps birth resolution is seconds; same-PID same-second ambiguity fails
  // conservatively as a possible survivor rather than claiming absence.
  return "surviving";
}
function inspect(recorded, read = readProcess) {
  validate(recorded);
  const observed = read(recorded.pid);
  return { recorded, observed, verdict: judge(recorded, observed) };
}
function assertNoSurvivors(checks) {
  for (const check of checks) {
    assert.notEqual(check.verdict, "surviving", `surviving fixture child identity ${JSON.stringify(check)}`);
  }
}
module.exports = { readProcess, recordChild, judge, inspect, assertNoSurvivors };

// Bun runs this before a fixture/holder's main module, even when that module's
// first statement kills itself. Clear the launch tag before descendants inherit
// the environment; the model stub publishes its own separate model identity.
if (process.env.WHEELHOUSE_TEST_CHILD_CAPTURE) {
  const role = JSON.parse(process.env.WHEELHOUSE_TEST_CHILD_CAPTURE);
  delete process.env.WHEELHOUSE_TEST_CHILD_CAPTURE;
  assert(typeof role.name === "string" && typeof role.fixture === "string");
  recordChild({ event: "spawn", ...role });
}
