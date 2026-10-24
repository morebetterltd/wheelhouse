// Real reversed-commit controls: final stopped states alone do not prove order.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command";

const [here, root] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const fixture = fs.readFileSync(path.join(here, "fixtures/adapter-state.ts"), "utf8");
const peer = fs.readFileSync(path.join(here, "fixtures/adapter-state-peer.ts"), "utf8");
const term = 'process.once("SIGTERM", () => fs.writeFileSync(path.join(dir, `${name}.term`), String(process.pid)));';
const earlyTerm = `process.once("SIGTERM", () => {
  fs.writeFileSync(path.join(dir, \`\${name}.term\`), String(process.pid));
  const second = path.basename(path.dirname(dir)) === "ab" ? "worker-b" : "worker-a";
  if (name === second) { fs.closeSync(fd); process.exit(0); }
});`;
const release = '  write(`${names[0]}.release`);';
const reversed = `  assert.equal(await bounded(stops[1].exited), 0, "planted second stop must commit successfully first");
  const broken = read();
  assert.equal(broken.seats[names[1]].pid, null);
  assert.equal(broken.seats[names[0]].pid, peers[0].pid);
  console.log("BROKEN_COMMIT_ORDER " + JSON.stringify({ order, secondNative: 0, secondCommitted: true, firstStillUncommitted: true }));
${release}`;
assert.equal(peer.split(term).length, 2);
assert.equal(fixture.split(release).length, 2);
const failures: string[] = [];
for (const order of ["ab", "ba"]) {
  const base = path.join(root, "order-control-" + order);
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
  fs.writeFileSync(path.join(fixtures, "adapter-state-peer.ts"), peer.replace(term, earlyTerm));
  // Preserve the shared observer verbatim; never bring back local watch loops.
  fs.copyFileSync(path.join(here, "fixtures/wait-for-condition.cjs"), path.join(fixtures, "wait-for-condition.cjs"));
  const env = { ...process.env, WHEELHOUSE_ADAPTER_STATE_FIRST_COMMIT_DELAY_MS: "0" };
  if (env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE) env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE = path.join(env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE, "order-control-" + order);
  const result = completedCommand("bun", [path.join(fixtures, "adapter-state.ts"), project, order], { env });
  if (process.env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE) {
    const prefix = path.join(process.env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE, "reversed-" + order);
    fs.writeFileSync(prefix + ".stdout", result.stdout);
    fs.writeFileSync(prefix + ".stderr", result.stderr);
    fs.writeFileSync(prefix + ".json", JSON.stringify({ status: result.status, signal: result.signal ?? null, error: result.error?.message ?? null }));
  }
  try {
    assert(!result.signal && !result.error, "order break must complete naturally");
    assert(result.stdout.includes('"secondNative":0,"secondCommitted":true,"firstStillUncommitted":true'), "real reversed commits must precede the assertion");
    assert(result.stdout.includes(`ADAPTER_STATE_FIRST_STOP {"order":"${order}","native":0,`), "first stop must also complete successfully");
    assert.equal(result.status, 1, "broken order must fail, not merely leave both final states stopped: " + result.stdout + result.stderr);
    assert(result.stderr.includes("AssertionError") && result.stderr.includes("second stop must remain uncommitted until its ordered release"), result.stderr);
    console.log(`REJECT reversed commit order ${order}: native1 after second stop0/commit, first stop0, intended actual-order assertion`);
  } catch (error: any) {
    failures.push(order);
    console.error(`FAIL reversed commit order ${order}: ${error.message}`);
  }
}
assert.equal(failures.length, 0, `order controls failed: ${failures.join(", ")}`);
