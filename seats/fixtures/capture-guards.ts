import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [seats, fix] = process.argv.slice(2);
assert(fs.statSync(seats).isDirectory());
assert(fs.existsSync(path.join(fix, ".wheelhouse-selftest-fixture")));
// Inventory is explicit: removing a call/site must not silently shrink coverage.
const inventory = new Map([
  ["adapter.selftest.sh", 5], ["walk.selftest.sh", 3],
  ["verify.selftest.sh", 3], ["reset.selftest.sh", 2],
  ["herald.selftest.sh", 1], ["desk.selftest.sh", 6],
  ["isolation.selftest.sh", 5], ["prune.selftest.sh", 5],
  ["concurrency.selftest.sh", 2], ["drivers/codex/selftest.sh", 1],
  ["channel-credentials.selftest.sh", 1], ["selftest-sweep.selftest.sh", 3],
]);
const prelude = `
set -eu
. "$1/selftest-lib.sh"
FIX="$2"; TMP="$FIX"; PROJ="$FIX/project"; proj="$PROJ"; HOME_FIX="$FIX/home"
CODEX_TMP="$FIX/codex"; ARGV="$FIX/argv.json"; VARGV="$FIX/verifier/argv.json"
VDIR="$FIX/verdicts"; SEND_LOG="$FIX/send.log"; BD_LOG="$FIX/bd.log"
PROJA="$FIX/A"; PROJB="$FIX/B"; SEAT_A="$FIX/seat-a"; SEAT_B="$FIX/seat-b"
STATE_A="$FIX/state-A.json"; STATE="$FIX/state.json"; SENTINEL=forbidden; ELOG="$FIX/cleanup.log"; la="$FIX/a.log"; lb="$FIX/b.log"
PROD="$FIX/product"; WTS="$FIX/worktrees"; EWTS="$WTS"; LINK_ID=linked
CLOSED_ID=closed; GOAL_CHILD_ID=goal-child; PIN_SESS_BEFORE=old; OLD_SESS=old
CWD_FILE="$FIX/cwd"; SEAT_WT="$FIX/worktree"; ns=fixture; name=fixture; P=1
prompt="$FIX/prompt.txt"; label=fixture; RC=0; OUT=fixture; FAKE=forbidden; ROOT="$FIX/root"
host="$FIX/host"; events="$FIX/events"; EVENTS="$events"; WAIT_SIGNAL=ticket; PID_A=123456
RC_NO_PID=2; NO_PID="$FIX/no-pid"
has(){ return 0; }; no_value(){ return 0; }
mkdir -p "$FIX" "$HOME_FIX" "$PROJ" "$WTS" "$NO_PID" "$PROJ/seats/logs"
printf 'safe\\n' > "$PROJ/seats/logs/fixture.jsonl"
printf 'keep\\n' > "$NO_PID/KEEP"
printf 'waiting for host-wide lock %s/wheelhouse-selftest-sweep.lock\\n' "$host" > "$FIX/TB.err"
printf 'waiting for host-wide lock fixture queue_position=1 holder=pid=%s started=fixture\\n' "$PID_A" > "$FIX/B.err"
printf 'STOP: fixture is not a selftest-sweep lock\\n' > "$FIX/no-pid.err"
printf '%s' "$SEAT_WT" > "$CWD_FILE"
printf 'MARKER-ALPHA\\n' > "$la"; printf 'MARKER-BRAVO\\n' > "$lb"
# Only non-grep predicates are stubbed in these extracted assertion controls.
# No network, Git mutation, real service or source-program execution occurs.
curl(){ printf 404; }; git(){ printf fixture; }; state_get(){ printf fresh; }; says(){ return 1; }
failed=0
pass(){ printf 'PASS %s\\n' "$*"; }
fail(){ failed=$((failed+1)); printf 'FAIL %s\\n' "$*" >&2; }
`;
let passed = 0, failed = 0;
for (const [file, expected] of inventory) {
  const lines = fs.readFileSync(path.join(seats, file), "utf8").split("\n");
  const sites = lines.flatMap((line, i) => line.includes("selftest_capture_lacks ") ? [i] : []);
  assert.equal(sites.length, expected, `${file}: guard inventory changed`);
  for (const i of sites) {
    const exprs = [...lines[i].matchAll(/selftest_capture_lacks ("(?:[^"\\]|\\.)*")/g)].map(m => m[1]);
    assert(exprs.length > 0, `${file}:${i + 1}: no capture expression`);
    const captures = [...new Set(exprs)];
    // Preserve the entire actual if/pass/fail assertion, not a reimplementation.
    let end = i;
    if (lines[i].trimStart().startsWith("if ")) {
      while (!/(?:^|;)\s*fi\s*$/.test(lines[end])) {
        end++;
        assert(end < lines.length, `${file}:${i + 1}: unterminated assertion`);
      }
    }
    const assertion = lines.slice(i, end + 1).join("\n");
    for (const expression of captures) {
      try {
        const errors: string[] = [];
        for (const mode of ["baseline", "missing", "empty"]) {
          try {
            const dir = path.join(fix, String(i) + "-" + file.replaceAll("/", "-"), mode);
            fs.mkdirSync(dir, { recursive: true });
            const script = prelude + `
${file === "channel-credentials.selftest.sh" ? "RC=1" : ""}
# Seed ALL inputs to a multi-capture assertion, then corrupt exactly one.
${captures.map(e => `capture=${e}\nmkdir -p "$(dirname "$capture")"\nprintf '{"captured":true}\\n' > "$capture"`).join("\n")}
capture=${expression}
# Assert the subject exists and the corruption actually happened.
[ -s "$capture" ]
case "$3" in
  missing) rm -f "$capture"; [ ! -e "$capture" ];;
  empty) : > "$capture"; [ -f "$capture" ] && [ ! -s "$capture" ];;
esac
printf 'CAPTURE_PATH=%s\\n' "$capture"
` + assertion + '\n[ "$failed" -eq 0 ]\n';
            const result = spawnSync("bash", ["-c", script, "capture-control", seats, dir, mode], { encoding: "utf8" });
            assert.equal(result.error, undefined);
            assert.equal(result.signal, null);
            assert.equal(result.status, mode === "baseline" ? 0 : 1,
              `${file}:${i + 1} ${mode}: exit=${result.status}\n${result.stdout}\n${result.stderr}`);
            const capture = /^CAPTURE_PATH=(.+)$/m.exec(result.stdout)?.[1];
            assert(capture?.startsWith(dir + "/"), result.stdout);
            if (mode !== "baseline") {
              assert(result.stderr.includes(`selftest: missing, empty, or unreadable capture: ${capture}`), result.stderr);
              assert(!result.stdout.includes("PASS "), `${mode} assertion also printed PASS: ${result.stdout}`);
            }
          } catch (error) { errors.push(String(error)); }
        }
        assert.equal(errors.length, 0, errors.join("\n"));
        console.log(`ok - ${file}:${i + 1} ${expression}: baseline0; deleted1; empty1 (capture named)`);
        passed++;
      } catch (error) {
        console.error(`not ok - ${file}:${i + 1} ${expression}: ${error}`);
        failed++;
      }
    }
  }
}
// A valid forbidden match must fail too; an always-success helper is unsafe.
const forbidden = spawnSync("bash", ["-c", '. "$1/selftest-lib.sh"; printf "leak\\n" > "$2/forbidden.txt"; selftest_capture_lacks "$2/forbidden.txt" -q -- leak', "forbidden", seats, fix], { encoding: "utf8" });
assert.equal(forbidden.status, 1, forbidden.stderr);
// grep errors must not turn into absence either (e.g. malformed regexp).
const invalid = spawnSync("bash", ["-c", '. "$1/selftest-lib.sh"; printf "safe\\n" > "$2/invalid.txt"; selftest_capture_lacks "$2/invalid.txt" -q -- "["', "grep-error", seats, fix], { encoding: "utf8" });
assert.equal(invalid.status, 1, invalid.stderr);
assert(invalid.stderr.includes(`checking capture: ${fix}/invalid.txt`));
console.log(`capture-guards.selftest: ${failed ? "FAIL" : "PASS"} (${passed} assertion groups, ${failed} failures; grep error refused)`);
process.exit(failed ? 1 : 0);
