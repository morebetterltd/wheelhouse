// Fixture-only real endpoint and real courier. Wait for observed polls, not
// throughput inside a one-second sleep. No production timer/deadline override.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const [projectArg, outputArg, mode = "serial", delayArg = "350"] = process.argv.slice(2);
const project = fs.realpathSync(projectArg), fixture = path.dirname(project), output = path.resolve(outputArg);
assert(fs.statSync(path.join(fixture, ".wheelhouse-selftest-fixture")).isFile());
assert.equal(path.dirname(output), fixture);
assert(["serial", "parallel", "policy-timeout"].includes(mode));
const firstDelay = Number(delayArg);
assert(Number.isInteger(firstDelay) && firstDelay > 0 && firstDelay < 1000);
fs.mkdirSync(output, { recursive: true });
const courier = path.join(project, "seats/courier.ts");
assert(fs.statSync(courier).isFile());
if (mode === "parallel") {
  const source = fs.readFileSync(courier, "utf8"), needle = "line=await processOnce();";
  assert.equal(source.split(needle).length, 2, "one initial processOnce call to mutate");
  fs.writeFileSync(courier, source.replace(needle, "line=(await Promise.all([processOnce(), processOnce()]))[0];"));
}
const log = path.join(project, "seats/logs/courier.out.log");
const logOffset = fs.existsSync(log) ? fs.statSync(log).size : 0;
let active = 0, maximum = 0, polls = 0;
let releasePair!: () => void;
const pair = new Promise<void>(resolve => { releasePair = resolve; });
const events: any[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith("/getUpdates")) return Response.json({ ok: false }, { status: 404 });
  const index = ++polls;
  active++; maximum = Math.max(maximum, active);
  events.push({ phase: "begin", index, active, at: Date.now(), mono: performance.now() });
  try {
    // The planted concurrent startup calls must actually reach this endpoint
    // together: keep the first pending until the second has been observed.
    if (mode === "parallel" && index === 1) await pair;
    if (mode === "parallel" && index === 2) releasePair();
    if (mode === "policy-timeout") await new Promise(() => {});
    await Bun.sleep(index === 1 ? firstDelay : 350);
    return Response.json({ ok: true, result: [] });
  } finally {
    active--;
    events.push({ phase: "end", index, active, at: Date.now(), mono: performance.now() });
  }
} });
let child: ReturnType<typeof Bun.spawn> | undefined;
let stdout = "", stderr = "", joined = false, failure: string | undefined;
let observation: any;
async function joinWithin(promise: Promise<number>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(code => ({ code })), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const began = Date.now();
try {
  child = Bun.spawn(["bun", courier], { cwd: project, env: { ...process.env,
    WHEELHOUSE_TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}`,
    WHEELHOUSE_TELEGRAM_POLL_TIMEOUT: "0", WHEELHOUSE_TELEGRAM_FETCH_ABORT_MS: "1000",
    WHEELHOUSE_COURIER_INTERVAL_MS: "100", WHEELHOUSE_TRANSPORT: "telegram",
    WHEELHOUSE_COURIER_ROOT: project, WHEELHOUSE_NEEDS_ROOT: project,
  }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const exited = child.exited;
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  try {
    while (polls < 3) {
      if (child.exitCode != null || child.signalCode != null) throw new Error("courier exited before three real polls");
      await Bun.sleep(20);
    }
    observation = { mode, firstDelay, intervalMs: 100, abortMs: 1000, nice: os.getPriority(0),
      began, observedAt: Date.now(), pid: child.pid, polls, maxActive: maximum,
      result: maximum === 1 ? "serial" : "overlap", events: [...events] };
  } catch (e: any) { failure = e.message; }
  finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    let result = await joinWithin(exited, 1500);
    if (!result) { child.kill("SIGKILL"); result = await joinWithin(exited, 1500); }
    joined = result !== null;
    if (joined) [stdout, stderr] = await Promise.all([out, err]);
    else failure = "original child handle did not join after TERM/KILL";
    const produced = fs.existsSync(log) ? fs.readFileSync(log).subarray(logOffset).toString("utf8") : "";
    // A request cancelled by the unchanged API policy is not evidence that
    // the courier overlapped live requests or failed to start on this host.
    if (produced.includes("STOP: poll failed: telegram getUpdates timed out after 1000ms")) failure = "network policy expired: telegram getUpdates timed out after 1000ms";
  }
} catch (e: any) { failure = e.message; }
finally {
  server.stop(true);
  fs.writeFileSync(path.join(output, "courier.out"), stdout);
  fs.writeFileSync(path.join(output, "courier.err"), stderr);
  fs.writeFileSync(path.join(output, "observation.json"), JSON.stringify({ ...observation, mode, firstDelay, joined, failure, finalEvents: events }, null, 2) + "\n");
}
console.log("POLL_MEASUREMENT " + JSON.stringify({ ...observation, mode, firstDelay, joined, failure }));
if (failure || !joined || !observation) {
  console.error(`POLL_OBSERVATION_INCOMPLETE ${failure ?? "original child handle did not join"}`);
  process.exitCode = 2;
} else if (observation.maxActive !== 1) {
  console.error(`OVERLAP_REJECTED polls=${observation.polls} max_active=${observation.maxActive} first_delay_ms=${firstDelay} joined=${joined}`);
  process.exitCode = 1;
} else {
  console.log(`POLL_OBSERVED polls=${observation.polls} max_active=1 first_delay_ms=${firstDelay} joined=${joined}`);
}
