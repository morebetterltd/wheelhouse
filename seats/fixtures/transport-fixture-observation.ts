// Fixture-only readiness/ledger observations. Poll cadence is not a verdict
// deadline; the admitted outer sweep supplies containment for a stuck fixture.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

type State = { ready: boolean; [key: string]: unknown };
export async function observe(probe: () => State, alive: () => boolean, event: (kind: string, state: State) => void): Promise<State> {
  let announced = false;
  for (;;) {
    const state = probe();
    if (!alive()) throw new Error("owned fixture actor exited before observation completed");
    if (state.ready) { event("complete", state); return state; }
    if (!announced) { announced = true; event("waiting", state); }
    await Bun.sleep(20);
  }
}
// An append can be observed mid-write. Only newline-committed records may
// satisfy a behavioural predicate; malformed COMPLETE records remain errors.
export function records(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8"), end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
}
function completeLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8"), end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n");
}
async function main() {
  const [mode, rootArg, pidArg, inputArg, requestsArg] = process.argv.slice(2);
  const root = fs.realpathSync(rootArg), pid = Number(pidArg), input = path.resolve(inputArg);
  assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
  assert(Number.isInteger(pid) && pid > 1);
  assert(input.startsWith(root + path.sep), "observation must stay in its owned fixture");
  assert(["ready", "send-failed", "retry-complete", "poll-recovered", "hung-retried"].includes(mode));
  if (mode !== "ready") assert(fs.statSync(path.join(input, "seats/needs.jsonl")).isFile(), "seeded ledger must exist before observation");
  const requests = requestsArg ? path.resolve(requestsArg) : "";
  if (requests) assert(requests.startsWith(root + path.sep));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (error: any) { if (error.code === "ESRCH") return false; throw error; } };
  const probe = (): State => {
    if (mode === "ready") {
      if (!fs.existsSync(input)) return { ready: false, port: null };
      const message = JSON.parse(fs.readFileSync(input, "utf8"));
      assert.equal(message.pid, pid, "ready publication belongs to a different actor");
      assert.equal(message.root, root, "ready publication belongs to a different fixture");
      assert(Number.isInteger(message.port) && message.port > 0 && message.port < 65536);
      return { ready: true, port: message.port };
    }
    const log = completeLines(path.join(input, "seats/logs/courier.out.log"));
    const sent = records(path.join(input, "seats/needs.jsonl")).filter(row => row.type === "sent" && row.id === "need-retry").length;
    const polls = requests ? records(requests).filter(row => row.method === "getUpdates").length : 0;
    const scans = log.filter(line => line.includes("courier scanned")).length;
    const sendFailed = log.some(line => line.includes("send failed need=need-retry: Bad Request: chat not found"));
    const pollFailed = log.some(line => line.includes("poll failed: Bad Request: poll failed"));
    const timedOut = log.some(line => line.includes("STOP: poll failed: telegram getUpdates timed out after 200ms"));
    const ready = mode === "send-failed" ? sendFailed : mode === "retry-complete" ? sent >= 1 && polls >= 3 && scans >= 2 : mode === "poll-recovered" ? pollFailed && polls >= 2 && scans >= 1 : timedOut && polls >= 2;
    return { ready, sent, polls, scans, sendFailed, pollFailed, timedOut };
  };
  const state = await observe(probe, alive, (event, state) => {
    const row = { event, mode, pid, nice: os.getPriority(0), state };
    fs.appendFileSync(path.join(root, "fixture-observations.jsonl"), JSON.stringify(row) + "\n");
    console.error("FIXTURE_OBSERVER " + JSON.stringify(row));
  });
  if (mode === "ready") console.log(state.port ?? 0);
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
