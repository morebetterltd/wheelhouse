// Consumer-level lock checks: real alerts CLIs, not acquirePidLock alone.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { completedCommand } from "../completed-command";
import { pidAlive } from "../seat-activity";
import conditionWait from "./wait-for-condition.cjs";
const { waitForCondition } = conditionWait;

const [here, base, kind, mutation = "none"] = process.argv.slice(2);
assert(fs.statSync(path.join(here, "alerts.ts")).isFile());
let marked = false;
for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, ".wheelhouse-selftest-fixture"))) { marked = true; break; }
  if (path.dirname(dir) === dir) break;
}
assert(marked, "alerts lock cases require an owned fixture ancestor");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const assertion = (name: string) => `ALERTS_LOCK_ASSERTION ${name}`;
const resultFile = path.join(base, "result.json");
function save(file: string, data: any) { fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); }

if (!kind) {
  fs.mkdirSync(base);
  const records = [];
  for (const [name, change] of [
    ["empty", "none"], ["garbage", "none"], ["dead", "none"], ["live", "none"],
    ["empty", "no-recovery"], ["garbage", "no-recovery"], ["dead", "no-recovery"], ["live", "no-live-guard"],
  ]) {
    const dir = path.join(base, `${name}-${change}`);
    const child = completedCommand("bun", [import.meta.path, here, dir, name, change]);
    fs.writeFileSync(dir + ".stdout", child.stdout); fs.writeFileSync(dir + ".stderr", child.stderr);
    save(dir + ".native.json", { status: child.status, signal: child.signal ?? null, error: child.error?.message ?? null });
    assert(!child.signal && !child.error, "case must complete naturally");
    // Setup and the native measurement must exist before a rejection can grade.
    const record = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    records.push(record);
    if (change === "none") {
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(`PASS alerts lock ${name}: ${name === "live" ? "same real alerts owner and snapshot preserved through competing refusal" : "native check0 writes a fresh snapshot after stale lock"}`);
    } else {
      assert.equal(child.status, 1, "removal must fail its consumer assertion");
      assert(child.stderr.includes("AssertionError") && child.stderr.includes(assertion(name)), child.stderr);
      assert.equal(record.check.status, 0); assert.equal(record.check.signal, null); assert.equal(record.check.error, null);
      if (change === "no-recovery") {
        assert.equal(record.check.stdout, "alerts: check already running\n");
        assert.equal(record.check.stderr, ""); assert.equal(record.snapshotUnchanged, true);
      } else {
        assert.equal(record.ownerStillLive, true);
        assert.equal(record.snapshotUnchanged, false);
        assert.equal(record.freshSnapshot, true);
        assert.equal(record.refused, false);
      }
      console.log(`REJECT alerts lock ${name}/${change}: native case1 at ${assertion(name)}; actual check0 ${change === "no-recovery" ? "reports check already running; snapshot unchanged" : "wrongly writes snapshot while real first owner remains held"}`);
    }
  }
  save(resultFile, records);
  if (process.env.WHEELHOUSE_ALERTS_LOCK_EVIDENCE) {
    fs.mkdirSync(process.env.WHEELHOUSE_ALERTS_LOCK_EVIDENCE, { recursive: true });
    // Regular measurements only; never copy the runtime or a live pipe/FIFO.
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(base, entry.name), path.join(process.env.WHEELHOUSE_ALERTS_LOCK_EVIDENCE, entry.name));
      else if (entry.isDirectory()) for (const name of ["result.json", "owner.json", "owner-closed.json", "dead-child.json"]) {
        const file = path.join(base, entry.name, name);
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(process.env.WHEELHOUSE_ALERTS_LOCK_EVIDENCE, entry.name + "." + name));
      }
    }
  }
  console.log("alerts-lock: PASS (O1 empty/garbage/naturally-exited PID, O2 actual live alerts owner, 4 meaningful removals)");
} else {
  assert(["empty", "garbage", "dead", "live"].includes(kind));
  assert(["none", "no-recovery", "no-live-guard"].includes(mutation));
  fs.mkdirSync(base);
  const project = path.join(base, "project"), bin = path.join(base, "bin"), home = path.join(base, "home");
  for (const dir of [project, bin, home]) fs.mkdirSync(dir);
  const copied = completedCommand("bash", ["-c", '. "$1/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1"', "copy", here, project]);
  assert.equal(copied.status, 0, copied.stderr); assert(!copied.signal && !copied.error);
  for (const dir of ["seats/run", "seats/logs", "wheelhouse"]) fs.mkdirSync(path.join(project, dir), { recursive: true });
  fs.writeFileSync(path.join(project, "seats/seats.json"), JSON.stringify({ seats: { commander: { role: "commander", external: true } } }));
  fs.writeFileSync(path.join(project, "seats/state.json"), '{"seats":{}}\n');
  fs.writeFileSync(path.join(project, "wheelhouse/.template-source"), "github-issue-watch=off\ngithub-issue-repos=fixture/repo\nalert-low-disk-gb=0\n");
  fs.writeFileSync(path.join(project, "seats/template-drift.sh"), '#!/usr/bin/env bash\nprintf \'{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n', { mode: 0o700 });
  const gate = path.join(base, "bd-held.json"), release = path.join(base, "release");
  const bd = path.join(base, "bd.ts");
  fs.writeFileSync(bd, `import fs from 'node:fs';import condition from ${JSON.stringify(path.join(here, "fixtures/wait-for-condition.cjs"))};
if(process.env.WHEELHOUSE_ALERT_LOCK_HOLD==='1') {
  fs.writeFileSync(${JSON.stringify(gate)},JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(2)}));
  const observation=condition.waitForCondition({site:'alerts-lock.bd-release',paths:[${JSON.stringify(base)}],predicate:()=>fs.existsSync(${JSON.stringify(release)})});
  try { await observation.promise; } finally { observation.cancel(); }
}
console.log('[]');
`);
  fs.writeFileSync(path.join(bin, "bd"), '#!/usr/bin/env bash\nexec bun "$WHEELHOUSE_ALERT_LOCK_BD_SCRIPT" "$@"\n', { mode: 0o700 });
  const moduleFile = path.join(project, "seats/lock.ts"), original = fs.readFileSync(moduleFile, "utf8");
  if (mutation !== "none") {
    const needle = mutation === "no-recovery" ? "    if (!removeStaleLock(file)) return null;" : "      if (pidAlive(owner)) return false;";
    assert.equal(original.split(needle).length, 2, "unique actual lock mutation");
    fs.writeFileSync(moduleFile, original.replace(needle, mutation === "no-recovery" ? "    return null; // removed stale recovery" : "      // removed live-owner refusal"));
  }
  const lock = path.join(project, "seats/run/alerts.lock"), snapshot = path.join(project, "seats/run/fleet-snapshot.json");
  const token = randomUUID(), oldAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(snapshot, JSON.stringify({ at: oldAt, alerts: {}, seatStreams: {}, settledSeats: {}, fixtureToken: token }) + "\n");
  function identity(file: string) {
    try {
      const st = fs.lstatSync(file, { bigint: true }); assert(st.isFile());
      const bytes = fs.readFileSync(file);
      return { exists: true, dev: String(st.dev), ino: String(st.ino), mtimeNs: String(st.mtimeNs), bytes: bytes.toString("base64"), sha256: hash(bytes) };
    } catch (error: any) { if (error.code === "ENOENT") return { exists: false }; throw error; }
  }
  const before = identity(snapshot);
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH,
    WHEELHOUSE_ALERTS_ROOT: project, WHEELHOUSE_ALERT_LOCK_BD_SCRIPT: bd };
  delete env.WHEELHOUSE_ALERT_LOCK_HOLD;
  let owner: ReturnType<typeof spawn> | undefined, joined: Promise<any> | undefined;
  let lockBefore: ReturnType<typeof identity>;
  let dead: any;
  try {
    if (kind === "live") {
      owner = spawn("bun", ["seats/alerts.ts", "check"], { cwd: project, env: { ...env, WHEELHOUSE_ALERT_LOCK_HOLD: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false;
      owner.stdout!.on("data", b => { stdout += b; }); owner.stderr!.on("data", b => { stderr += b; });
      owner.stdout!.on("end", () => { stdoutEOF = true; }); owner.stderr!.on("end", () => { stderrEOF = true; });
      joined = new Promise((yes, no) => { owner!.once("error", no); owner!.once("close", (code, signal) => yes({ code, signal, stdout, stderr, stdoutEOF, stderrEOF })); });
      save(path.join(base, "owner.json"), { pid: owner.pid, argv: ["bun", "seats/alerts.ts", "check"], cwd: project });
      const observed = waitForCondition({ site: "alerts-lock.owner-held", paths: [base], predicate: () => fs.existsSync(gate) });
      try {
        await Promise.race([observed.promise, joined.then(x => { throw new Error("owner exited before holding gate: " + JSON.stringify(x)); })]);
      } finally { observed.cancel(); }
      const held = JSON.parse(fs.readFileSync(gate, "utf8"));
      assert.equal(held.ppid, owner.pid, "held bd must be the actual alerts owner's child");
      assert.deepEqual(held.argv, ["ready", "--json"], "actual owner must hold inside its readiness query");
      assert.equal(fs.readFileSync(lock, "utf8"), `${owner.pid}\n`);
      assert(pidAlive(owner.pid)); assert.equal(owner.exitCode, null);
    } else {
      let content = kind === "garbage" ? "not a pid\n" : "";
      if (kind === "dead") {
        const child = completedCommand("bun", ["-e", "console.log(process.pid)"]);
        dead = { pid: child.pid, status: child.status, signal: child.signal ?? null, error: child.error?.message ?? null, stdout: child.stdout, stderr: child.stderr };
        save(path.join(base, "dead-child.json"), dead);
        assert.equal(child.status, 0); assert(!child.signal && !child.error);
        assert.equal(Number(child.stdout.trim()), child.pid); assert(!pidAlive(child.pid), "natural exit must precede lock seeding; reused PID is invalid setup");
        content = `${child.pid}\n`;
      }
      fs.writeFileSync(lock, content);
      // Existing malformed-lock grace remains: model an abandoned old file,
      // not a legitimate live publisher. No wall-clock sleep/assertion.
      const old = new Date(Date.now() - 60_000); fs.utimesSync(lock, old, old);
    }
    lockBefore = identity(lock);
    const check = completedCommand("bun", ["seats/alerts.ts", "check"], { cwd: project, env });
    const after = identity(snapshot), lockAfter = identity(lock), parsed = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    const ownerStillLive = owner ? owner.exitCode === null && pidAlive(owner.pid) : null;
    const record = { kind, mutation, token, dead, ownerPid: owner?.pid ?? null, ownerStillLive,
      check: { status: check.status, signal: check.signal ?? null, error: check.error?.message ?? null, stdout: check.stdout, stderr: check.stderr },
      before, after, lockBefore, lockAfter, snapshotUnchanged: JSON.stringify(before) === JSON.stringify(after),
      lockUnchanged: JSON.stringify(lockBefore) === JSON.stringify(lockAfter),
      refused: check.stdout === "alerts: check already running\n",
      freshSnapshot: parsed.at !== oldAt && Number.isFinite(Date.parse(parsed.at)) && !!parsed.snapshot && parsed.fixtureToken === undefined,
      moduleSha256: hash(fs.readFileSync(moduleFile)) };
    save(resultFile, record);
    console.log("MEASUREMENT alerts-lock " + JSON.stringify({ kind, mutation, check: record.check, ownerStillLive, snapshotUnchanged: record.snapshotUnchanged, freshSnapshot: record.freshSnapshot, lockUnchanged: record.lockUnchanged }));
    assert.equal(check.status, 0, check.stderr); assert(!check.signal && !check.error);
    if (kind === "live") {
      assert(record.ownerStillLive, "actual first alerts owner must remain held across second completion");
      assert(record.refused && record.snapshotUnchanged && record.lockUnchanged, assertion(kind) + ": live alerts owner must retain its lock and previous snapshot");
      assert.equal(check.stderr, "");
    } else {
      assert(record.freshSnapshot && !record.snapshotUnchanged && !record.lockAfter.exists && !record.refused,
        assertion(kind) + ": stale lock must permit real snapshot publication, not check already running");
      assert.equal(check.stderr, "");
    }
  } finally {
    if (owner) {
      fs.writeFileSync(release, token + "\n");
      const result = await joined!;
      save(path.join(base, "owner-closed.json"), result);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
      assert(result.stdoutEOF && result.stderrEOF, "actual owner's native pipes must close");
      const published = JSON.parse(fs.readFileSync(snapshot, "utf8"));
      assert(published.at !== oldAt && !!published.snapshot, "released real owner must publish its own snapshot");
      assert.equal(fs.existsSync(lock), false, "completed real owner must release its lock");
    }
  }
}
