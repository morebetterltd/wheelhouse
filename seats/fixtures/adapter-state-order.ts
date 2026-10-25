// Real reversed-commit controls: final stopped states alone do not prove order.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command";

const [here, root] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const fixture = fs.readFileSync(path.join(here, "fixtures/adapter-state.ts"), "utf8");
const peer = fs.readFileSync(path.join(here, "fixtures/adapter-state-peer.ts"), "utf8");
const adapter = fs.readFileSync(path.join(here, "adapter.ts"), "utf8");
const signal = '  process.kill(rec.pid!, "SIGTERM");';
assert.equal(adapter.split(signal).length, 2, "one real native stop signal in the copied adapter");
// Fault-planted copies only: real signal delivery precedes this event gate,
// and the unchanged product grace follows it. A control-owned live peer must
// not consume stop grace while its owner deliberately withholds observation.
const heldAdapter = adapter.replace(signal, () => `${signal}\n  await (await import("./fixtures/adapter-state-order-hold.ts")).holdStopForOrderControl(ROOT, name, rec.pid!);`);
const terms = '  await Promise.all(names.map((name, i) => barrier(`${name}.term`, stops[i])));';
const firstStop = '  const firstStop = await bounded(stops[0].exited);';
const cleanup = '  for (const name of names) write(`${name}.release`);';
for (const anchor of [terms, firstStop, cleanup]) assert.equal(fixture.split(anchor).length, 2);
function setup(lateReceipt: boolean): string {
  return `  const termObservers = ${lateReceipt ? "[]" : 'names.map((name, i) => barrier(`${name}.term`, stops[i]))'};
  await Promise.all(names.map((name, i) => barrier(\`\${name}.stop-held\`, stops[i])));
  for (let i = 0; i < names.length; i++) {
    const held = JSON.parse(fs.readFileSync(path.join(dir, \`\${names[i]}.stop-held\`), "utf8"));
    assert.equal(held.stopPid, stops[i].pid); assert.equal(held.peerPid, peers[i].pid); assert.equal(held.token, token);
    assert.equal(held.gatePresent, false);
    assert.equal(held.pendingConditions, 1, "CONTROL_NATIVE_HOLD_ORACLE: each real stop must be held before grace starts");
    assert(!fs.existsSync(path.join(dir, \`\${names[i]}.stop-returned\`)), "native stop cannot return before its owner event");
  }
  console.log("CONTROL_NATIVE_HOLD_OBSERVED " + JSON.stringify({ order, stops: 2, peers: 2, graceNotStarted: true }));
  ${lateReceipt ? `const published = waitForCondition({ site: 'adapter-state-order.terms-published', paths: [dir],
    predicate: () => names.every(name => fs.existsSync(path.join(dir, \`\${name}.term\`))) });
  try { await bounded(published.promise); } finally { published.cancel(); }
  console.log("CONTROL_LATE_RECEIPT_ATTACH " + JSON.stringify({ order, durableTerms: 2, elapsedVerdict: false }));
  termObservers.push(...names.map((name, i) => barrier(\`\${name}.term\`, stops[i])));` : ""}
  await Promise.all(termObservers);`;
}
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
  write(\`\${names[1]}.stop-release\`);
  assert.equal(await bounded(stops[1].exited), 0, "planted second stop must commit successfully first");
  const broken = read();
  assert.equal(broken.seats[names[1]].pid, null);
  assert.equal(broken.seats[names[0]].pid, peers[0].pid);
  console.log("BROKEN_COMMIT_ORDER " + JSON.stringify({ order, secondNative: 0, secondCommitted: true, firstStillUncommitted: true }));
${release}`;
assert.equal(peer.split(ready).length, 2);
assert.equal(fixture.split(release).length, 2);
// Late delivery means observer attachment AFTER durable publication, not a
// wall-clock delay competing with a separately scheduled stop deadline.
const cases = [false, true].flatMap(lateReceipt => ["ab", "ba"].map(order => ({
  order, lateReceipt, label: (lateReceipt ? "slow-" : "") + order,
})));
const failures: string[] = [];
for (const { order, lateReceipt, label } of cases) {
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
  const planted = fixture.replace(release, reversed).replace(terms, () => setup(lateReceipt))
    .replace(firstStop, () => `  write(\`\${names[0]}.stop-release\`);\n${firstStop}`)
    .replace(cleanup, () => `${cleanup}\n  for (const name of names) write(\`\${name}.stop-release\`);`);
  fs.writeFileSync(path.join(fixtures, "adapter-state.ts"), planted);
  fs.writeFileSync(path.join(project, "seats/adapter.ts"), heldAdapter);
  const projectFixtures = path.join(project, "seats/fixtures");
  fs.mkdirSync(projectFixtures, { recursive: true });
  for (const name of ["adapter-state-order-hold.ts", "wait-for-condition.cjs"])
    fs.copyFileSync(path.join(here, "fixtures", name), path.join(projectFixtures, name));
  fs.writeFileSync(path.join(fixtures, "adapter-state-peer.ts"), peer.replace(ready, reverseReady));
  // Copy every sibling helper the two fixtures import (the shared observer among
  // them) verbatim, so a new shared import cannot go missing in this copy.
  for (const source of [fixture, peer]) for (const [, name] of source.matchAll(/from ["']\.\/([^"']+)["']/g)) {
    if (!fs.existsSync(path.join(fixtures, name))) fs.copyFileSync(path.join(here, "fixtures", name), path.join(fixtures, name));
  }
  const env = { ...process.env, WHEELHOUSE_ADAPTER_STATE_FIRST_COMMIT_DELAY_MS: "0",
    WHEELHOUSE_ADAPTER_STATE_RECEIPT_DELAY_MS: "0" };
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
    assert(result.stdout.includes("CONTROL_NATIVE_HOLD_OBSERVED "), "native stop grace must not run during held control setup");
    if (lateReceipt) assert(result.stdout.includes("CONTROL_LATE_RECEIPT_ATTACH "), "late receipts must attach after real durable publication");
    assert(result.stdout.includes("REVERSE_RELEASE_AFTER_SETUP "), "second peer must be released only after observed setup");
    assert(result.stdout.includes('"secondNative":0,"secondCommitted":true,"firstStillUncommitted":true'), "real reversed commits must precede the assertion");
    assert(result.stdout.includes(`ADAPTER_STATE_FIRST_STOP {"order":"${order}","native":0,`), "first stop must also complete successfully");
    assert.equal(result.status, 1, "broken order must fail, not merely leave both final states stopped: " + result.stdout + result.stderr);
    assert(result.stderr.includes("AssertionError") && result.stderr.includes("second stop must remain uncommitted until its ordered release"), result.stderr);
    console.log(`REJECT reversed commit order ${label}: native1 after second stop0/commit, first stop0, intended actual-order assertion; receipt mode ${lateReceipt ? "after-durable-publication" : "normal"}, event-gated stop grace`);
  } catch (error: any) {
    failures.push(label);
    console.error(`FAIL reversed commit order ${label}: ${error.message}`);
    // Preserve the actual inner failure rather than only the grader's message.
    console.error(JSON.stringify({ label, status: result.status, signal: result.signal ?? null, error: result.error?.message ?? null }));
    console.error(result.stdout);
    console.error(result.stderr);
    // A barrier exit must retain the native cause, not only the owner's race.
    for (const name of ["worker-a", "worker-b"]) for (const stream of ["out", "err"]) {
      const file = path.join(project, "barriers", `stop-${name}.${stream}`);
      console.error(`CONTROL_NATIVE_STOP ${label} ${name} ${stream}: ` +
        (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "<not published>"));
    }
  }
}
assert.equal(failures.length, 0, `order controls failed: ${failures.join(", ")}`);
