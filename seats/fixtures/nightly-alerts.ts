import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
const [root, home, bin] = process.argv.slice(2);
assert(fs.statSync(path.join(root, "seats/alerts.ts")).isFile());
const run = path.join(root, "seats/run"), source = fs.readFileSync(path.join(root, "seats/alerts.ts"), "utf8");
const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_ALERTS_ROOT: root,
  BD_READY: "0", GH_UNTRIAGED: "0", DRIFT_ON: "0", DRIFT_AHEAD: "0", DRIFT_JSON: "", DRIFT_CASE: "", WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS: "600000" };
const write = (f: string, v: any) => fs.writeFileSync(path.join(run, f), JSON.stringify(v) + "\n");
const tip = "d".repeat(40), dates = [1, 2, 3, 4, 5, 6].map(n => `2026-01-0${n}T03:00:00.000Z`);
function result(rc: number, date = dates[0]) { write("nightly-sweep.json", { date, tip, rc, logPath: "fixture/nightly.log", elapsedMs: 4, failedSuites: rc ? ["tiny-red.selftest.sh"] : [] }); }
function missed(date = dates[2]) { write("nightly-sweep-missed.json", { date, reason: "host sweep lock busy (fixture holder)" }); }
function reset() { for (const f of ["fleet-snapshot.json", "nightly-sweep.json", "nightly-sweep-missed.json"]) fs.rmSync(path.join(run, f), { force: true }); for (const f of ["inbox.jsonl", "inbox.cursor", "needs.jsonl"]) fs.rmSync(path.join(root, "seats", f), { force: true }); fs.writeFileSync(path.join(root, "seats/state.json"), '{"seats":{}}\n'); }
function check(script = "alerts.ts") { const r = spawnSync("bun", [path.join(root, "seats", script), "check", "--json"], { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr + r.stdout); const j = JSON.parse(r.stdout); assert(!j.locked); return j; }
function rows(name: string) { let text = ""; try { text = fs.readFileSync(path.join(root, "seats/inbox.jsonl"), "utf8"); } catch (e: any) { if (e.code !== "ENOENT") throw e; } return text.split("\n").filter(Boolean).map(s => JSON.parse(s)).filter(r => r.source?.name === name); }
reset(); result(1); let snap = check(); assert(snap.alerts["nightly-sweep-red"].active); assert.equal(rows("nightly-sweep-red").length, 1);
for (const value of [dates[0], tip, "tiny-red.selftest.sh"]) assert(rows("nightly-sweep-red")[0].detail.includes(value)); check(); check(); assert.equal(rows("nightly-sweep-red").length, 1);
result(1, dates[1]); snap = check(); assert.equal(rows("nightly-sweep-red").length, 1); assert(snap.alerts["nightly-sweep-red"].detail.includes(dates[1]));
missed(); snap = check(); assert(snap.alerts["nightly-sweep-red"].active); assert(snap.alerts["nightly-sweep-missed"].active); assert.equal(rows("nightly-sweep-missed").length, 1); assert(rows("nightly-sweep-missed")[0].detail.includes("host sweep lock busy")); check(); check(); assert.equal(rows("nightly-sweep-missed").length, 1);
for (const row of [...rows("nightly-sweep-red"), ...rows("nightly-sweep-missed")]) { assert(row.detail.startsWith("Alert " + row.source.name + ": ")); assert(row.detail.includes("Cost:")); assert(row.detail.includes("Next:")); }
const gate = path.join(root, "seats/fleet-gate.sh"), normal = spawnSync("bash", [gate], { cwd: root, env, encoding: "utf8" }); assert.equal(normal.status, 0); assert(normal.stdout.includes("nightly-sweep-red") && normal.stdout.includes("nightly-sweep-missed"));
const minimal = path.join(root, "nightly-bun-only"); fs.mkdirSync(minimal);
for (const tool of ["bash", "dirname", "bun"]) fs.symlinkSync(execFileSync("bash", ["-c", 'command -v "$1"', "_", tool], { encoding: "utf8" }).trim(), path.join(minimal, tool));
const lean = { ...env, PATH: minimal }; for (const key of Object.keys(lean)) if (key.startsWith("BASH_FUNC_")) delete lean[key]; delete lean.BASH_ENV; delete lean.ENV;
const noNode = spawnSync(path.join(minimal, "bash"), ["--noprofile", "--norc", "-c", "command -v node"], { env: lean, encoding: "utf8" }); assert.equal(noNode.status, 1); assert.equal(noNode.stderr, "");
const fallback = spawnSync(path.join(minimal, "bash"), [gate], { cwd: root, env: lean, encoding: "utf8" }); assert.equal(fallback.status, 0); assert(fallback.stdout.includes("nightly-sweep-red") && fallback.stdout.includes("nightly-sweep-missed"));
const fullBeforeFilter = JSON.parse(fs.readFileSync(path.join(run, "nightly-sweep.json"), "utf8"));
write("nightly-sweep.json", { ...fullBeforeFilter, date: dates[2], rc: 0, failedSuites: [], filtered: true, lastCompleted: fullBeforeFilter }); snap = check(); assert(snap.alerts["nightly-sweep-red"].active); assert(snap.alerts["nightly-sweep-red"].detail.includes(dates[1])); assert.equal(rows("nightly-sweep-red").length, 1);
console.log("PASS nightly alert transitions: red date/tip/failed names and missed reason, one inbox row each; filtered rc0 preserves prior red; actual fleet-gate Node and Bun paths show both names");
result(0, dates[3]); snap = check(); assert.equal(snap.alerts["nightly-sweep-red"].active, false); assert.equal(snap.alerts["nightly-sweep-missed"].active, false); assert.equal(rows("nightly-sweep-red").length, 1); assert.equal(rows("nightly-sweep-missed").length, 1);
result(1, dates[4]); check(); assert.equal(rows("nightly-sweep-red").length, 2); missed(dates[5]); check(); assert.equal(rows("nightly-sweep-missed").length, 2);
console.log("PASS later completed green clears red/missed; new incidents after clear emit one fresh inbox row");
const once = (s: string, old: string, next: string) => { assert.equal(s.split(old).length, 2, old); return s.replace(old, next); };
function mutant(name: string, old: string, next: string) { const file = `alerts-nightly-${name}.ts`; fs.writeFileSync(path.join(root, "seats", file), once(source, old, next)); return file; }
const redOff = mutant("no-red", '"nightly-sweep-red":nightly.red,', '"nightly-sweep-red":{...nightly.red,on:false},'); reset(); result(1); assert.equal(check(redOff).alerts["nightly-sweep-red"].active, false); assert.equal(rows("nightly-sweep-red").length, 0);
const missedOff = mutant("no-missed", '"nightly-sweep-missed":nightly.unavailable,', '"nightly-sweep-missed":{...nightly.unavailable,on:false},'); reset(); missed(); assert.equal(check(missedOff).alerts["nightly-sweep-missed"].active, false); assert.equal(rows("nightly-sweep-missed").length, 0);
const repeat = mutant("repeat", 'const shouldFire = next.active&&(!was?.active||was.signature!==next.signature);', 'const shouldFire = next.active; // removed transition dedupe'); reset(); result(1); check(repeat); check(repeat); assert.equal(rows("nightly-sweep-red").length, 2);
const sticky = mutant("sticky", '"nightly-sweep-red":nightly.red,', '"nightly-sweep-red":{...nightly.red,on:!!nightly.result},'); reset(); result(0); assert.equal(check(sticky).alerts["nightly-sweep-red"].active, true);
const stateFile = path.join(root, "seats/nightly-state.ts"), stateCode = fs.readFileSync(stateFile, "utf8"); reset(); result(1); const priorFull = JSON.parse(fs.readFileSync(path.join(run, "nightly-sweep.json"), "utf8")); write("nightly-sweep.json", { ...priorFull, rc: 0, failedSuites: [], filtered: true, lastCompleted: priorFull });
fs.writeFileSync(stateFile, once(stateCode, '  const full = v?.filtered ? v.lastCompleted : v;', '  const full = v; // removed prior-full lookup'));
try { assert.equal(check().alerts["nightly-sweep-red"].active, false); assert.equal(rows("nightly-sweep-red").length, 0); } finally { fs.writeFileSync(stateFile, stateCode); }
console.log("PASS nightly alert removals: disabling either condition/prior-full lookup loses its row; disabled transition guard duplicates rows; sticky red fails green clear");
