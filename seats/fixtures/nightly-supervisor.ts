import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
const [here, owned] = process.argv.slice(2);
assert(fs.statSync(path.join(owned, ".wheelhouse-selftest-fixture")).isFile());
const source = fs.readFileSync(path.join(here, "supervisor.sh"), "utf8");
const base = path.join(owned, "nightly-clocks"); fs.mkdirSync(base);
const once = (s: string, old: string, next: string) => { assert.equal(s.split(old).length, 2, old); return s.replace(old, next); };
let serial = 0;
function world(label: string, code = source, config = "sweep=on\nsweep-hour=07\n") {
  const root = path.join(base, `${++serial}-${label}`);
  fs.mkdirSync(path.join(root, "seats/run"), { recursive: true }); fs.mkdirSync(path.join(root, "seats/logs")); fs.mkdirSync(path.join(root, "wheelhouse"));
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "cleanup=off\ndigest=off\n" + config);
  fs.writeFileSync(path.join(root, "seats/supervisor.sh"), code);
  fs.copyFileSync(path.join(here, "nightly-state.ts"), path.join(root, "seats/nightly-state.ts"));
  fs.writeFileSync(path.join(root, "seats/daemons.sh"), 'daemon_alive(){ return 0; }\nprincipal_channel_declared(){ return 1; }\nrecover_dead_seats(){ :; }\n');
  fs.writeFileSync(path.join(root, "seats/nightly-sweep.ts"), 'import fs from "node:fs";fs.appendFileSync(import.meta.dir+"/run/nightly-calls.jsonl",JSON.stringify({pattern:process.env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN??null,tier:process.env.WHEELHOUSE_SELFTEST_SWEEP_TIER??null})+"\\n");\n');
  return root;
}
function calls(root: string): any[] { try { return fs.readFileSync(path.join(root, "seats/run/nightly-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; } }
function tick(root: string, at: string, extra: Record<string, string> = {}) {
  const env = { ...process.env, WHEELHOUSE_SUPERVISOR_ROOT: root, WHEELHOUSE_SUPERVISOR_NOW: at,
    WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(root, "host.lock"), WHEELHOUSE_SELFTEST_SWEEP_PATTERN: "must-not-reach-job", WHEELHOUSE_SELFTEST_SWEEP_TIER: "core", ...extra };
  delete env.BASH_ENV; delete env.ENV;
  if (!("WHEELHOUSE_SUPERVISOR_SWEEP_HOUR" in extra)) delete env.WHEELHOUSE_SUPERVISOR_SWEEP_HOUR;
  if (!("WHEELHOUSE_SUPERVISOR_PAUSE_FILE" in extra)) delete env.WHEELHOUSE_SUPERVISOR_PAUSE_FILE;
  const r = spawnSync("bash", [path.join(root, "seats/supervisor.sh"), "--once"], { cwd: root, env, encoding: "utf8" });
  assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr + r.stdout);
}
async function waitCalls(root: string, n: number) { const until = performance.now() + 10000; while (calls(root).length < n && performance.now() < until) await Bun.sleep(20); assert.equal(calls(root).length, n, root); }
const cadence = world("cadence"); tick(cadence, "2026-01-01T06:59:00"); assert.equal(calls(cadence).length, 0);
tick(cadence, "2026-01-01T07:00:00"); await waitCalls(cadence, 1); tick(cadence, "2026-01-01T07:30:00"); assert.equal(calls(cadence).length, 1);
tick(cadence, "2026-01-02T07:00:00"); await waitCalls(cadence, 2);
assert.equal(JSON.parse(fs.readFileSync(path.join(cadence, "seats/run/supervisor.state.json"), "utf8")).lastSweepDay, "2026-01-02");
assert(fs.readFileSync(path.join(cadence, "seats/logs/supervisor.out.log"), "utf8").includes("nightly sweep started for 2026-01-01 (pid "));
assert(calls(cadence).every(c => c.pattern === null && c.tier === null));
const defaults = world("default", source, "sweep=on\n"); tick(defaults, "2026-01-01T03:00:00"); await waitCalls(defaults, 1);
const override = world("override"); tick(override, "2026-01-01T05:00:00", { WHEELHOUSE_SUPERVISOR_SWEEP_HOUR: "05" }); await waitCalls(override, 1);
console.log("PASS nightly clock: configured/default/override hour, next local day, one same-day launch and cleared fixture pattern/tier");
const off = world("off", source, "sweep=off\nsweep-hour=07\n"); tick(off, "2026-01-01T07:00:00"); assert.equal(calls(off).length, 0);
const paused = world("paused"); fs.writeFileSync(path.join(paused, "seats/run/paused"), "fixture\n"); tick(paused, "2026-01-01T07:00:00"); assert.equal(calls(paused).length, 0);
assert(JSON.parse(fs.readFileSync(path.join(paused, "seats/run/nightly-sweep-missed.json"), "utf8")).reason.includes("pause marker"));
const custom = world("custom-pause"); fs.writeFileSync(path.join(custom, "custom.pause"), "fixture\n"); tick(custom, "2026-01-01T07:00:00", { WHEELHOUSE_SUPERVISOR_PAUSE_FILE: "custom.pause" }); assert.equal(calls(custom).length, 0); assert(JSON.parse(fs.readFileSync(path.join(custom, "seats/run/nightly-sweep-missed.json"), "utf8")).reason.includes("pause marker"));
const invalid = world("invalid-hour", source, "sweep=on\nsweep-hour=99\n"); tick(invalid, "2026-01-01T07:00:00"); assert.equal(calls(invalid).length, 0); assert(JSON.parse(fs.readFileSync(path.join(invalid, "seats/run/nightly-sweep-missed.json"), "utf8")).reason.includes("invalid sweep-hour"));
console.log("PASS nightly off and default/custom pause marker: no child launch; pause/invalid hour recorded as missed");
const busy = world("busy"), token = randomUUID().replaceAll("-", ""), lock = path.join(busy, "host.lock"), helper = path.join(here, "selftest-sweep-lock.ts");
const identity = execFileSync("bun", [helper, "acquire", lock, String(process.pid), token, ""], { encoding: "utf8" }).trim();
try {
  const before = fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep"));
  tick(busy, "2026-01-01T07:00:00"); assert.equal(calls(busy).length, 0);
  assert(fs.readFileSync(path.join(busy, "seats/logs/supervisor.out.log"), "utf8").includes("nightly sweep skipped: host sweep lock busy"));
  assert(JSON.parse(fs.readFileSync(path.join(busy, "seats/run/nightly-sweep-missed.json"), "utf8")).reason.includes("host sweep lock busy"));
  assert.deepEqual(fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep")), before);
} finally { execFileSync("bun", [helper, "release", lock, String(process.pid), token, identity]); }
console.log("PASS nightly busy tick: genuine token-owned holder unchanged; skipped/logged/missed without a child");
// Each new negative condition has its own sensitive removal control, not a
// legacy no-op implementation which would also appear to honour sweep=off.
const repeatCode = once(source, '  supervisor_state_set lastSweepDay "$day"\n  check=', '  true # removed nightly daily guard\n  check=');
const repeat = world("removed-day", repeatCode); tick(repeat, "2026-01-01T07:00:00"); await waitCalls(repeat, 1); tick(repeat, "2026-01-01T07:30:00"); await waitCalls(repeat, 2);
const offCode = once(source, "  sweep_enabled || return 0", "  true # removed nightly opt-out");
const brokenOff = world("removed-off", offCode, "sweep=off\nsweep-hour=07\n"); tick(brokenOff, "2026-01-01T07:00:00"); await waitCalls(brokenOff, 1);
const skipCode = once(source, '  if [ "$rc" != 0 ]; then', '  if false; then # removed nightly preflight gate');
const brokenPause = world("removed-pause", skipCode); fs.writeFileSync(path.join(brokenPause, "seats/run/paused"), "fixture\n"); tick(brokenPause, "2026-01-01T07:00:00"); await waitCalls(brokenPause, 1);
const clockStart = source.indexOf("# Nightly full tier only."); assert(clockStart >= 0);
const clockCode = source.slice(0, clockStart) + once(source.slice(clockStart), '  [ "$hour" = "$want" ] || return 0', "  true # removed nightly hour guard");
const brokenClock = world("removed-hour", clockCode); tick(brokenClock, "2026-01-01T06:59:00"); await waitCalls(brokenClock, 1);
const patternCode = once(source, "    unset WHEELHOUSE_SELFTEST_SWEEP_PATTERN WHEELHOUSE_SELFTEST_SWEEP_TIER", "    true # removed nightly environment isolation");
const brokenPattern = world("removed-pattern", patternCode); tick(brokenPattern, "2026-01-01T07:00:00"); await waitCalls(brokenPattern, 1); assert.equal(calls(brokenPattern)[0].pattern, "must-not-reach-job");
const brokenBusy = world("removed-busy", skipCode), busyLock = path.join(brokenBusy, "host.lock"), busyToken = randomUUID().replaceAll("-", ""), busyIdentity = execFileSync("bun", [helper, "acquire", busyLock, String(process.pid), busyToken, ""], { encoding: "utf8" }).trim();
try { tick(brokenBusy, "2026-01-01T07:00:00"); await waitCalls(brokenBusy, 1); } finally { execFileSync("bun", [helper, "release", busyLock, String(process.pid), busyToken, busyIdentity]); }
const validationCode = once(source, 'if(!/^[0-9]{1,2}$/.test(s)||!Number.isInteger(n)||n<0||n>23) process.exit(2);', '');
const badHour = world("removed-validation", validationCode, "sweep=on\nsweep-hour=99\n"); tick(badHour, "2026-01-01T07:00:00"); assert(!fs.existsSync(path.join(badHour, "seats/run/nightly-sweep-missed.json")));
const noTick = once(source, '; tick_sweep; }', '; }');
for (const test of [{label:"configured",config:"sweep=on\nsweep-hour=07\n",at:"2026-01-01T07:00:00",extra:{}},{label:"default",config:"sweep=on\n",at:"2026-01-01T03:00:00",extra:{}},{label:"override",config:"sweep=on\nsweep-hour=07\n",at:"2026-01-01T05:00:00",extra:{WHEELHOUSE_SUPERVISOR_SWEEP_HOUR:"05"}}]) { const w=world("removed-tick-"+test.label,noTick,test.config); tick(w,test.at,test.extra); assert.equal(calls(w).length,0); }
console.log("PASS nightly scheduler removal controls: tick/default/config/override, day/hour/validation/opt-out/preflight/environment guards each fail the corresponding property when removed");
