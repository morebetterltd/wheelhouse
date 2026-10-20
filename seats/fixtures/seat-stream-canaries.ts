import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// Each new test case must reject removal of its corresponding fix. Copies are
// beneath the enclosing selftest allocation; never mutate the source checkout.
type Mutation = [test: string, file: string, before: string, after: string];
const mutations: Mutation[] = [
  ["config", "seat-stream-health.ts", ', 20, 1000)', ', 21, 1000)'],
  ["threshold", "seat-stream-health.ts", 'stalled: phase === "model" && quietForMs >= quietMs', 'stalled: false'],
  ["realTime", "seat-stream-health.ts", 'stalled: phase === "model" && quietForMs >= quietMs', 'stalled: false'],
  ["progress", "seat-stream-health.ts", '|stream_activity|', '|discarded_activity|'],
  ["driverTimestamps", "seat-stream-health.ts", 'millis(ev.timestamp)', 'null'],
  ["filter", "seat-event-log.ts", 'if (at - lastDelta >= 1000)', 'if (true)'],
  ["framing", "seat-event-log.ts", 'obj.wheelhouse_received_at = new Date(at).toISOString();', '/* receipt stamp removed */'],
  ["polls", "seat-stream-health.ts", '(?:agent_start|agent_end|', '(?:response|agent_start|agent_end|'],
  ["settled", "seat-stream-health.ts", 'active = type === "agent_end" && ev.willRetry === true;', 'active = true;'],
  ["tool", "seat-stream-health.ts", 'tools.size ? "tool" : "model"', '"model"'],
  ["parallel", "seat-stream-health.ts", 'if (type === "tool_execution_end") tools.delete(id);', 'if (type === "tool_execution_end") tools.clear();'],
  ["legacy", "seat-stream-health.ts", 'same && prior!.progressKey === key ? Date.parse(prior!.lastEventAt)', 'false ? Date.parse(prior!.lastEventAt)'],
  ["bounded", "seat-stream-health.ts", 'same && start > 0 ? Object.entries(prior!.pendingToolIds ?? {}) : []', '[]'],
  ["bounded", "seat-stream-health.ts", 'if (type === "agent_start" || type === "turn_start") tools.clear();', '/* new-turn tool retirement removed */'],
  ["bounded", "seat-stream-health.ts", '`${rec.pid}:${rec.startedAt ?? ""}`', '`${rec.pid}:${rec.startedAt ?? ""}:${rec.lastBead ?? ""}`'],
  ["alert", "adapter.ts", 'Boolean(stream?.stalled)', 'false'],
  ["dedupe", "alerts.ts", 'next.active&&(!was?.active||was.signature!==next.signature)', 'next.active'],
  ["need", "alerts.ts", 'stream && age>=seatStallNeedMs(ROOT)', 'false && stream && age>=seatStallNeedMs(ROOT)'],
  ["recovery", "alerts.ts", 'if(!next.active&&was?.active)', 'if(false&&!next.active&&was?.active)'],
  ["exclusions", "seat-stream-health.ts", 'rec.stoppedAt || ', ''],
];
export async function mutationChecks(root: string, fixture: string) {
  let ran = 0;
  for (const [test, file, before, after] of mutations) {
    const dir = path.join(root, `mutation-${++ran}`), target = path.join(dir, "seats");
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(path.join(root, "seats"), { withFileTypes: true })) {
      const from = path.join(root, "seats", entry.name), to = path.join(target, entry.name);
      if (entry.isFile() && /\.(?:ts|sh)$/.test(entry.name)) fs.copyFileSync(from, to);
      if (entry.isDirectory() && ["drivers", "transports"].includes(entry.name)) fs.cpSync(from, to, { recursive: true });
    }
    const edited = path.join(target, file), text = fs.readFileSync(edited, "utf8");
    assert.equal(text.split(before).length, 2, `mutation must change exactly one subject: ${test}/${before}`);
    fs.writeFileSync(edited, text.replace(before, after));
    const r = spawnSync("bun", [fixture, dir, test], { cwd: dir, encoding: "utf8", env: process.env });
    // A missing dependency/import, timeout or absent case is not a successful
    // negative control. Require the chosen case's own assertion and summary.
    const assertion = (r.stderr ?? "").split("\n").find(line => line.startsWith(`  FAIL  ${test}: AssertionError`));
    assert.equal(r.status, 1, `mutation ${test} must exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert(assertion, `mutation ${test} did not reach its own assertion\n${r.stdout}\n${r.stderr}`);
    assert((r.stdout ?? "").includes("seat-stream selftest: 0/1 passed"));
    console.log(JSON.stringify({ negative: test, mutation: ran, exit: r.status, assertion }));
  }
  console.log(`seat-stream mutation controls: ${ran}/${mutations.length} rejected`);
}
