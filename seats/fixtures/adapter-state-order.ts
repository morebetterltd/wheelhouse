// Real reversed-commit controls: final stopped states alone do not prove order.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command";

const [here, root] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const fixture = fs.readFileSync(path.join(here, "fixtures/adapter-state.ts"), "utf8");
const peer = fs.readFileSync(path.join(here, "fixtures/adapter-state-peer.ts"), "utf8");
const ready = 'predicate: () => fs.existsSync(release)';
// SIGTERM is only a receipt, never permission to exit during setup. Keep the
// ordinary release for failure cleanup, and give the second peer its own gate.
const reverseReady = `predicate: () => fs.existsSync(release) ||
  (name === (path.basename(path.dirname(dir)) === "ab" ? "worker-b" : "worker-a") &&
    fs.existsSync(path.join(dir, \`\${name}.reverse-release\`)))`;
const release = '  write(`${names[0]}.release`);';
const reversed = `  assert.equal(peers[1].exitCode, null, "second peer must remain held through receipt observation and refresh");
  assert.equal(stops[1].exitCode, null, "second stop must remain pending through setup");
  assert.equal(read().seats[names[1]].pid, peers[1].pid);
  assert.equal(read().seats[names[0]].pid, peers[0].pid);
  console.log("REVERSE_RELEASE_AFTER_SETUP " + JSON.stringify({ order,
    receiptDelayMs: Number(process.env.WHEELHOUSE_ADAPTER_STATE_RECEIPT_DELAY_MS ?? 0),
    secondPeerPending: true, secondStopPending: true }));
  write(\`\${names[1]}.reverse-release\`);
  assert.equal(await bounded(peers[1].exited), 0, "planted second peer must exit on its explicit release");
  assert.equal(await bounded(stops[1].exited), 0, "planted second stop must commit successfully first");
  const broken = read();
  assert.equal(broken.seats[names[1]].pid, null);
  assert.equal(broken.seats[names[0]].pid, peers[0].pid);
  console.log("BROKEN_COMMIT_ORDER " + JSON.stringify({ order, secondNative: 0, secondCommitted: true, firstStillUncommitted: true }));
${release}`;
assert.equal(peer.split(ready).length, 2);
assert.equal(fixture.split(release).length, 2);
const slowReceiptMs = Math.max(1500, Number(process.env.WHEELHOUSE_ADAPTER_STATE_RECEIPT_DELAY_MS ?? 0));
assert(Number.isSafeInteger(slowReceiptMs) && slowReceiptMs <= 10000);
const cases = [0, slowReceiptMs].flatMap(delayMs => ["ab", "ba"].map(order => ({
  order, delayMs, label: (delayMs ? "slow-" : "") + order,
})));
const failures: string[] = [];
for (const { order, delayMs, label } of cases) {
  const base = path.join(root, "order-control-" + label);
  const runtime = path.join(base, "runtime"), project = path.join(base, order);
  fs.mkdirSync(base);
  for (const dest of [runtime, project]) {
    const copied = completedCommand("bash", ["-c", '. "$1/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1"', "copy-runtime", here, dest]);
    assert.equal(copied.status, 0, copied.stderr);
    assert(!copied.signal && !copied.error);
  }
  const fixtures = path.join(runtime, "seats/fixtures");
  fs.mkdirSync(fixtures);
  fs.writeFileSync(path.join(fixtures, "adapter-state.ts"), fixture.replace(release, reversed));
  fs.writeFileSync(path.join(fixtures, "adapter-state-peer.ts"), peer.replace(ready, reverseReady));
  // Copy every sibling helper the two fixtures import (the shared observer among
  // them) verbatim, so a new shared import cannot go missing in this copy.
  for (const source of [fixture, peer]) for (const [, name] of source.matchAll(/from ["']\.\/([^"']+)["']/g)) {
    if (!fs.existsSync(path.join(fixtures, name))) fs.copyFileSync(path.join(here, "fixtures", name), path.join(fixtures, name));
  }
  const env = { ...process.env, WHEELHOUSE_ADAPTER_STATE_FIRST_COMMIT_DELAY_MS: "0",
    WHEELHOUSE_ADAPTER_STATE_RECEIPT_DELAY_MS: String(delayMs) };
  if (env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE) env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE = path.join(env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE, "order-control-" + label);
  const result = completedCommand("bun", [path.join(fixtures, "adapter-state.ts"), project, order], { env });
  if (process.env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE) {
    const prefix = path.join(process.env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE, "reversed-" + label);
    fs.writeFileSync(prefix + ".stdout", result.stdout);
    fs.writeFileSync(prefix + ".stderr", result.stderr);
    fs.writeFileSync(prefix + ".json", JSON.stringify({ status: result.status, signal: result.signal ?? null, error: result.error?.message ?? null }));
  }
  try {
    assert(!result.signal && !result.error, "order break must complete naturally");
    assert(result.stdout.includes("REVERSE_RELEASE_AFTER_SETUP "), "second peer must be released only after observed setup");
    assert(result.stdout.includes('"secondNative":0,"secondCommitted":true,"firstStillUncommitted":true'), "real reversed commits must precede the assertion");
    assert(result.stdout.includes(`ADAPTER_STATE_FIRST_STOP {"order":"${order}","native":0,`), "first stop must also complete successfully");
    assert.equal(result.status, 1, "broken order must fail, not merely leave both final states stopped: " + result.stdout + result.stderr);
    assert(result.stderr.includes("AssertionError") && result.stderr.includes("second stop must remain uncommitted until its ordered release"), result.stderr);
    console.log(`REJECT reversed commit order ${label}: native1 after second stop0/commit, first stop0, intended actual-order assertion; receipt input ${delayMs}ms`);
  } catch (error: any) {
    failures.push(label);
    console.error(`FAIL reversed commit order ${label}: ${error.message}`);
    // Preserve the actual inner failure rather than only the grader's message.
    console.error(JSON.stringify({ label, status: result.status, signal: result.signal ?? null, error: result.error?.message ?? null }));
    console.error(result.stdout);
    console.error(result.stderr);
  }
}
assert.equal(failures.length, 0, `order controls failed: ${failures.join(", ")}`);
