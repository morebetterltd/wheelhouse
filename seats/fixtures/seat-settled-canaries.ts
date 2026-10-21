import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const [here, root] = process.argv.slice(2);
assert(fs.statSync(here).isDirectory() && fs.statSync(root).isDirectory());
const helper = "seat-settled.ts", alerts = "alerts.ts";
const due = 'due: phase === "settled" && mode !== null && quietForMs >= quietMs';
const mutations = [
  { id: "wiring", test: "review", file: alerts, old: "observeSettledSeats(root,snap.workers.live,prior?.settledSeats)", next: "({})" },
  { id: "graph-status", test: "threshold", file: "fleet-snapshot.ts", old: "taskStatus: st?.status ?? null", next: "taskStatus: null" },
  { id: "graph-review", test: "review", file: "fleet-snapshot.ts", old: 'taskNeedsReview: st?.labels.includes("needs-review") ?? false', next: "taskNeedsReview: false" },
  { id: "config", test: "config", file: helper, old: "return 30 * 60_000;", next: "return 31 * 60_000;" },
  { id: "threshold", test: "threshold", file: helper, old: due, next: "due: false" },
  { id: "review", test: "review", file: helper, old: 'worker.taskNeedsReview ? "review"', next: 'false ? "review"' },
  { id: "review-dedupe", test: "review", file: alerts, old: 'observation.mode==="review"?null:observation.eventKey', next: "observation.eventKey" },
  { id: "review-clock", test: "review", file: helper, old: 'mode === "review" ? Date.parse(contextSince) :', next: 'mode === "review" ? at :' },
  { id: "dispatch", test: "dispatch", file: helper, old: "Math.max(at, Date.parse(contextSince))", next: "at" },
  { id: "dispatch-review", test: "dispatch", file: helper, old: 'mode === "review" ? Date.parse(contextSince) :', next: 'mode === "review" ? at :' },
  { id: "dedupe", test: "dedupe", file: alerts, old: "const raiseSettled=next.active&&(!was?.active||was.signature!==next.signature);", next: "const raiseSettled=next.active;" },
  { id: "active", test: "active", file: helper, old: 'else if (!/compaction_/.test(type)) phase = "active";', next: 'else if (!/compaction_/.test(type)) phase = "settled";' },
  { id: "maintenance", test: "active", file: helper, old: 'else if (!/compaction_/.test(type)) phase = "active";', next: 'else phase = "active";' },
  { id: "retry", test: "retry", file: helper, old: "ev.willRetry !== true", next: "true" },
  { id: "traffic", test: "traffic", file: helper, old: "^(?:agent_start|", next: "^(?:response|agent_start|" },
  { id: "legacy", test: "legacy", file: helper, old: "if (!event && continuous)", next: "if (false && !event && continuous)" },
  { id: "metadata", test: "metadata", file: helper, old: "const received = millis(ev.wheelhouse_received_at);", next: "const received = null;" },
  { id: "exclusions", test: "exclusions", file: helper, old: 'worker.taskStatus === "closed" ? null :', next: "false ? null :" },
  { id: "unknown", test: "exclusions", file: helper, old: 'phase = event?.phase ?? "unknown"', next: 'phase = event?.phase ?? "settled"' },
  { id: "bounded", test: "bounded", file: helper, old: "boundary = b[0] === 10;", next: "boundary = false;" },
  { id: "rotation", test: "rotation", file: helper, old: "if (event && archived && validPrior?.eventHash === event.eventHash)", next: "if (false && event && archived && validPrior?.eventHash === event.eventHash)" },
  { id: "safe-files", test: "safe-files", file: helper, old: "return st.isFile() && st.nlink === 1 ? st : null;", next: "return st;" },
  { id: "realtime", test: "realtime", file: helper, old: due, next: "due: false" },
];
for (const mutation of mutations) {
  const dir = path.join(root, "removed-" + mutation.id), runtime = path.join(dir, "runtime"), output = path.join(dir, "output");
  fs.mkdirSync(dir); fs.cpSync(here, runtime, { recursive: true }); fs.mkdirSync(output);
  const file = path.join(runtime, mutation.file), source = fs.readFileSync(file, "utf8");
  assert.equal(source.split(mutation.old).length, 2, mutation.id + " removal anchor");
  const changed = source.replace(mutation.old, mutation.next); assert.notEqual(changed, source); fs.writeFileSync(file, changed);
  const result = spawnSync("bun", [path.join(import.meta.dir, "seat-settled.ts"), "--case", mutation.test, runtime, output], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "stdout"), result.stdout); fs.writeFileSync(path.join(dir, "stderr"), result.stderr);
  fs.writeFileSync(path.join(dir, "exit.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }));
  assert.equal(result.signal, null); assert.equal(result.error, undefined); assert.equal(result.status, 1, mutation.id + " must reject removal");
  assert.match(result.stderr, /AssertionError:/);
  assert.doesNotMatch(result.stderr, /SyntaxError:|Cannot find module|ModuleNotFound|ENOENT: no such file/);
  const subject = path.join(output, mutation.test);
  if (["config", "safe-files"].includes(mutation.test)) assert(fs.statSync(path.join(subject, "probe-imported")).isFile());
  else { const snapshot = JSON.parse(fs.readFileSync(path.join(subject, "call-1.stdout"), "utf8")); assert(snapshot.at && snapshot.snapshot && snapshot.settledSeats); }
  console.log(`PASS removed ${mutation.id}: ${mutation.test} own AssertionError, native exit=1; subject imported/executed`);
}
console.log(`seat-settled removals: PASS (${mutations.length}/${mutations.length})`);
