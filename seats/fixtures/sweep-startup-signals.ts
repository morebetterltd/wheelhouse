// Pause the real runner at startup publication boundaries; no scheduling sleep
// decides a verdict. Deadlines only fail containment. All runners/locks are private.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const [here, root] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const source = fs.readFileSync(path.join(here, "selftest-sweep.sh"), "utf8");
console.log(`startup signal runner sha256=${createHash("sha256").update(source).digest("hex")}`);
const work = path.join(root, "startup");
fs.mkdirSync(work);
const project = path.join(work, "project");
const setup = spawnSync("bash", ["-c", String.raw`. "$1"
selftest_copy_seat_runtime "$2" "$3" || exit 2
git -C "$2" init -q -b main || exit 2
[ "$(git -C "$2" rev-parse --show-toplevel)" = "$2" ] || exit 2
git -C "$2" add seats || exit 2
`, "startup-setup", path.join(here, "selftest-lib.sh"), project, here], { encoding: "utf8" });
assert.ifError(setup.error);
assert.equal(setup.status, 0, setup.stderr);

const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const lines = (file: string) => read(file).trim().split("\n").filter(Boolean);
type Identity = { pid: number; group: number; born: string };
function parseIdentity(row: string): Identity {
  const [pid, group, ...born] = row.trim().split(/\s+/);
  assert(/^\d+$/.test(pid) && /^\d+$/.test(group) && born.length === 5, `bad native identity: ${row}`);
  return { pid: Number(pid), group: Number(group), born: born.join(" ") };
}
function identity(pid: number): Identity | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "pid=,pgid=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  assert.ifError(r.error);
  if (r.status === 1 && !r.stdout.trim() && !r.stderr.trim()) return null;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  return parseIdentity(r.stdout);
}
function same(a: Identity | null, b: Identity): boolean {
  return !!a && a.pid === b.pid && a.group === b.group && a.born === b.born;
}
async function until(test: () => boolean, label: string): Promise<void> {
  const limit = Date.now() + 30_000;
  while (!test()) {
    if (Date.now() >= limit) throw new Error(`startup fixture containment deadline: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const guard = `  if [ "$STARTING_SUITE" = 1 ]; then
    [ -n "$PENDING_INTERRUPT" ] || PENDING_INTERRUPT="$rc"
    return
  fi
`;
function instrument(removed: boolean): string {
  let s = source;
  const replace = (old: string, next: string) => {
    assert.equal(s.split(old).length, 2, `startup fixture anchor changed: ${old}`);
    s = s.replace(old, next);
  };
  if (removed) replace(guard, "");
  // Helper exists only in this private copy. A suite-fork checkpoint first
  // obtains the real leader's native identity/readiness, never a guessed PID.
  const point = `startup_fixture_point(){
  if [ "$1" = suite-forked ]; then
    while [ ! -f "$START_READY" ]; do sleep 0.01; done
    cat "$START_SUITE_OWNER" >> "$START_IDENTITIES"
  fi
  [ "$1" = "$START_POINT" ] || return 0
  printf 'paused\\n' > "$START_PAUSED"
  while [ ! -f "$START_RELEASE" ]; do sleep 0.01; done
}
`;
  replace("start_suite(){\n", point + "start_suite(){\n");
  replace("  STARTING_SUITE=1\n", "  STARTING_SUITE=1\n  startup_fixture_point entered\n");
  const allocation = s.split("\n").find(line => line.startsWith('  SUITE_STATE="$(umask 077;'))!;
  assert(allocation);
  replace(allocation, allocation + '\n  printf "%s\\n" "$SUITE_STATE" > "$START_STATE"\n  startup_fixture_point allocated');
  replace('  exec 9<> "$SUITE_STATE/control"\n', '  exec 9<> "$SUITE_STATE/control"\n  startup_fixture_point control-open\n');
  replace("  CURRENT_SUITE_PID=$!\n", `  START_SUITE_PID=$!
  printf '%s\\n' "$START_SUITE_PID" > "$START_SUITE_PID_FILE"
  startup_fixture_point suite-forked
  CURRENT_SUITE_PID=$START_SUITE_PID
  startup_fixture_point suite-published
`);
  replace('  suite_watchdog "$CURRENT_SUITE_PID" "$SUITE_STATE" & WATCHDOG_PID=$!', `  suite_watchdog "$CURRENT_SUITE_PID" "$SUITE_STATE" &
  START_WATCH_PID=$!
  printf '%s\\n' "$START_WATCH_PID" >> "$START_FORKS"
  ps -p "$START_WATCH_PID" -o pid=,pgid=,lstart= >> "$START_IDENTITIES"
  startup_fixture_point watchdog-forked
  WATCHDOG_PID=$START_WATCH_PID`);
  replace('  local root="$1" dir="$2" message=""\n', '  local root="$1" dir="$2" message=""\n  printf "read\\n" >> "$START_READS"\n');
  replace('  if [ "$mode" = stop ]; then printf \'stop\\n\' >&9; fi', '  if [ "$mode" = stop ]; then printf "stop\\n" >> "$START_STOPS"; printf \'stop\\n\' >&9; fi');
  replace('interrupt_sweep(){\n  local rc="$1"\n', 'interrupt_sweep(){\n  local rc="$1"\n  printf "%s\\n" "$rc" >> "$START_SIGNALS"\n');
  return s;
}

const cases = [
  ...["entered", "allocated", "control-open", "suite-forked", "suite-published", "watchdog-forked"].map(point => ({ point, signal: "SIGTERM" as NodeJS.Signals, code: 143 })),
  { point: "watchdog-forked", signal: "SIGINT" as NodeJS.Signals, code: 130 },
  { point: "watchdog-forked", signal: "SIGHUP" as NodeJS.Signals, code: 129 },
];
async function probe(test: typeof cases[number], removed: boolean) {
  const name = `${test.point}-${test.signal}-${removed ? "removed" : "fixed"}`;
  const dir = path.join(work, name); fs.mkdirSync(dir);
  const tmp = path.join(dir, "tmp"); fs.mkdirSync(tmp);
  const file = (name: string) => path.join(dir, name);
  const target = path.join(project, "seats/selftest-sweep.sh");
  fs.writeFileSync(target, instrument(removed));
  const suite = file("00-wait.selftest.sh");
  fs.writeFileSync(suite, `#!/bin/bash
set -u
ps -p "$$" -o pid=,pgid=,lstart= > "$START_SUITE_OWNER"
sleep 1000 & keeper=$!
ps -p "$keeper" -o pid=,pgid=,lstart= >> "$START_IDENTITIES"
trap 'kill "$keeper" 2>/dev/null || true; wait "$keeper" 2>/dev/null || true; exit 143' TERM INT HUP
printf 'ready\\n' > "$START_READY"
wait "$keeper"
`);
  fs.writeFileSync(file("01-after.selftest.sh"), 'printf later > "$START_LATER"\n');
  const lock = file("host.lock");
  const env = { ...process.env, LC_ALL: "C", TMPDIR: tmp,
    START_POINT: test.point, START_READY: file("ready"), START_PAUSED: file("paused"), START_RELEASE: file("release"),
    START_SUITE_OWNER: file("suite-owner"), START_SUITE_PID_FILE: file("suite-pid"), START_IDENTITIES: file("identities"),
    START_FORKS: file("forks"), START_READS: file("reads"), START_STOPS: file("stops"), START_SIGNALS: file("signals"),
    START_STATE: file("state"), START_LATER: file("later"),
    WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock,
    WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: path.join(project, "seats/selftest-sweep-lock.ts"),
    WHEELHOUSE_SELFTEST_SWEEP_PATTERN: file("*.selftest.sh"),
    WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S: "60", WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: "1",
  };
  const child = spawn("bash", [target], { env, cwd: project, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exited = false, closed = false;
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.once("exit", () => { exited = true; });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  const owner = identity(child.pid!); assert(owner && owner.group === child.pid);
  const recorded = () => [owner, ...lines(file("identities")).map(parseIdentity)];
  let rescued = false;
  try {
    await until(() => !!read(file("paused")) || exited, name + " startup pause");
    assert(!exited, "runner exited before startup checkpoint");
    assert(child.kill(test.signal), "signal delivery");
    await until(() => lines(file("signals")).length > 0 || exited, name + " trap acknowledgement");
    assert.equal(lines(file("signals"))[0], String(test.code));
    fs.writeFileSync(file("release"), "release\n");
    await until(() => closed || (removed && (lines(file("reads")).length > 1 || (exited && !lines(file("forks")).length))), name + " exit/duplicate-reader evidence");
    const observed = {
      name, removed, closed, forks: lines(file("forks")).length, readers: lines(file("reads")).length,
      stops: lines(file("stops")).length, later: fs.existsSync(file("later")),
      result: closed ? await close : null, lockGone: !fs.existsSync(lock), queueGone: !fs.existsSync(lock + ".queue"),
      stateGone: !!read(file("state")).trim() && !fs.existsSync(read(file("state")).trim()),
      survivors: recorded().filter(row => same(identity(row.pid), row)).map(row => row.pid),
    };
    console.log(JSON.stringify(observed));
    if (removed) {
      // No timeout or unrelated assertion can count as a sensitive control.
      if (test.point === "watchdog-forked") assert.equal(observed.readers, 2, "removed guard must reproduce the second reader");
      else assert.equal(observed.forks, 0, "removed guard must interrupt before asynchronous publication");
      assert(observed.forks !== 1 || observed.readers !== 1 || !observed.closed);
      console.log(`NEGATIVE startup ${test.point} ${test.signal}: guard removal detected`);
    } else {
      assert.deepEqual(observed.result, { code: test.code, signal: null });
      assert.equal(observed.forks, 1); assert.equal(observed.readers, 1); assert.equal(observed.stops, 1);
      assert(observed.closed && observed.lockGone && observed.queueGone && observed.stateGone);
      assert(!observed.later); assert.deepEqual(observed.survivors, []);
      console.log(`PASS startup ${test.point} ${test.signal}: one watchdog, one stop, exit ${test.code}, both EOF, no survivors, lock/state gone`);
    }
  } finally {
    fs.writeFileSync(file("release"), "release\n");
    // Deliberately broken controls can strand output. Kill only fresh identities
    // in this runner's newly detached group or its recorded suite's group.
    const suitePid = Number(read(file("suite-pid")).trim());
    const groups = new Set<number>();
    for (const row of recorded()) {
      if ((row.group === owner.group || row.group === suitePid) && same(identity(row.pid), row) && !groups.has(row.group)) {
        if (!removed) rescued = true;
        groups.add(row.group);
        try { process.kill(-row.group, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
      }
    }
    await close;
    fs.writeFileSync(file("stdout"), stdout); fs.writeFileSync(file("stderr"), stderr);
    assert(!rescued, "fixed startup required emergency cleanup");
  }
}
for (const test of cases) {
  await probe(test, false);
  await probe(test, true);
}
console.log(`sweep startup signals: PASS (${cases.length} cases, ${cases.length} detected guard removals)`);
