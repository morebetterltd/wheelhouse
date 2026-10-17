// Run the REAL suite through its H4/readiness leg, killing only the selected
// fixture before its main body. Process exits and cleanup events decide this
// test; the 10ms poll below is scheduling, never a pass/fail deadline.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const [here, root] = process.argv.slice(2);
const dir = path.join(root, "killed-before-readiness");
fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, "tmp"));
const ledger = path.join(dir, "children.jsonl");
fs.writeFileSync(ledger, "");
const child = spawn("bash", [path.join(here, "verify.selftest.sh")], {
  env: { ...process.env, TMPDIR: path.join(dir, "tmp"), WHEELHOUSE_SKIP_REAL_PI: "1",
    WHEELHOUSE_VERIFY_EXIT_BEFORE_READY_ONLY: "1", WHEELHOUSE_TEST_KILL_FIXTURE: "bead-sweep",
    WHEELHOUSE_TEST_CHILD_LEDGER: ledger },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "", err = "", closed = false, stdoutEOF = false, stderrEOF = false;
child.stdout!.on("data", b => { out += b; }); child.stderr!.on("data", b => { err += b; });
child.stdout!.on("end", () => { stdoutEOF = true; }); child.stderr!.on("end", () => { stderrEOF = true; });
const result = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
  child.once("error", error => { closed = true; reject(error); });
  child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
});
const events = () => fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const rescued = new Set<number>();
// A cleanup witness is emitted AFTER the release action, BEFORE joining the
// holder. This makes a missing-release mutation fail without hanging this test:
// record the failure, then rescue only that recorded holder's private file.
while (!closed) {
  for (const event of events()) {
    if (event.event !== "holder-cleanup" || event.released || rescued.has(event.pid)) continue;
    const relative = path.relative(dir, event.release);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "rescue must remain in this fixture");
    assert(fs.statSync(path.dirname(event.release)).isDirectory());
    assert(!fs.existsSync(event.release), "missing-release witness must describe the actual file");
    rescued.add(event.pid);
    fs.writeFileSync(event.release, "regression rescue after missing release\n");
  }
  await Bun.sleep(10);
}
const res = await result;
fs.writeFileSync(path.join(dir, "suite.stdout"), out); fs.writeFileSync(path.join(dir, "suite.stderr"), err);
fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ...res, stdoutEOF, stderrEOF, rescued: [...rescued] }));
assert.equal(res.code, 1, "killed fixture must fail the real verify suite");
assert.equal(res.signal, null); assert(stdoutEOF && stderrEOF, "suite must close both output streams");
assert(out.includes("verify.selftest: FAIL") && out.includes("FAIL fixture bead-sweep: fixture exited before"), "suite must name the failed fixture");
assert(out.includes("exit=137 signal=SIGKILL"), "suite must name the fixture's actual exit status/signal");
const records = events();
const killed = records.find(e => e.event === "exit" && e.name === "fixture" && e.fixture === "bead-sweep");
assert(killed && killed.code === null && killed.signal === "SIGKILL", "actual process exit must decide the leg");
assert(records.some(e => e.event === "fixture-failure" && e.fixture === "bead-sweep" && !e.ready && !e.armed), "killed process must precede readiness and watchdog arming");
assert(records.some(e => e.event === "spawn" && e.name === "holder"), "regression must actually start the file waiter");
const pids = [...new Set(records.filter(e => ["spawn", "model"].includes(e.event)).map(e => e.pid))];
assert(pids.length >= 4, "fixture/model/holder subjects must exist before checking their absence");
for (const pid of pids) {
  assert(Number.isInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `surviving fixture child ${pid}`);
}
console.log(JSON.stringify({ event: "pre-readiness-exit-proof", suite: { ...res, stdoutEOF, stderrEOF }, killed, childPids: pids,
  nativeChecks: pids.map(pid => ({ pid, result: "ESRCH" })), rescued: [...rescued],
  namedFailure: out.split("\n").find(line => line.includes("FAIL fixture bead-sweep:")),
  holderCleanup: records.filter(e => e.event === "holder-cleanup").map(({ release, ...e }) => e) }));
assert.equal(rescued.size, 0, "FAIL pre-readiness cleanup left a file waiter unreleased (rescued to avoid hanging the regression)");
console.log(`PASS killed-before-readiness: real verify suite exit=1; FAIL fixture bead-sweep exit=137 signal=SIGKILL; ${pids.length} recorded children gone; both EOF; no rescue`);
