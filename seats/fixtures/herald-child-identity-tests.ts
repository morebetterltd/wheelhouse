// Real held children exercise the allocation/signal protocol, including a
// controlled PID-slot collision. No OS PID recycling or live services needed.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [root, selected, implementation] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const cases = ["exit-join", "live-refusal", "uncertain-signal", "completed-slot"];
const helper = implementation || path.join(import.meta.dir, "herald-child-identity.ts");
const { captureAllocation, signalObservedChild } = await import(helper);
const suite = path.join(root, "identity-regressions"); fs.mkdirSync(suite, { recursive: true });

async function probe(name: string) {
  const dir = fs.mkdtempSync(path.join(suite, name + "-"));
  const ready = path.join(dir, "ready"), release = path.join(dir, "release"), signals = path.join(dir, "signals");
  const keeper = path.join(dir, "keeper.ts");
  fs.writeFileSync(keeper, `import fs from 'node:fs';
process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(signals)},'TERM\\n');process.exit(0)});
fs.writeFileSync(${JSON.stringify(ready)},'ready');
setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},10);
`);
  const child = Bun.spawn(["bun", keeper], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  const rec = { pid: child.pid, cwd: dir, script: keeper, direct: true, generation: null, child };
  const uncertain = new Error("captured lsof status1/empty cwd while PS still reports a process");
  const noSignals = () => !fs.existsSync(signals) && child.exitCode === null && child.signalCode === null;
  try {
    const end = performance.now() + 3000;
    while (!fs.existsSync(ready) && performance.now() < end) await Bun.sleep(5);
    assert(fs.existsSync(ready), "held-child setup failed");
    if (name === "exit-join") {
      let settled = false;
      const pending = captureAllocation(child, () => { throw uncertain; }).finally(() => { settled = true; });
      await Bun.sleep(0);
      assert(!settled && noSignals(), "CASE_ASSERTION exit-join: uncertainty settled before real child exit");
      fs.writeFileSync(release, "go");
      assert.equal(await pending, null, "CASE_ASSERTION exit-join: completed allocation must remain unowned");
      assert.equal(child.exitCode, 0, "CASE_ASSERTION exit-join: original handle must be joined");
    } else if (name === "live-refusal") {
      let error: unknown;
      try { await captureAllocation(child, () => { throw uncertain; }, 20); } catch (e) { error = e; }
      assert(error === uncertain && noSignals(), "CASE_ASSERTION live-refusal: uncertainty admitted a live child");
    } else if (name === "uncertain-signal") {
      assert.throws(() => signalObservedChild(rec, "SIGTERM", () => true, () => null), /identity captured while allocated/,
        "CASE_ASSERTION uncertain-signal: missing generation authorized a signal");
      assert(noSignals(), "CASE_ASSERTION uncertain-signal: unrelated held child was signaled");
    } else if (name === "completed-slot") {
      const old = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      await old.exited;
      // Model an old completed handle's numeric slot now naming this real,
      // unrelated held process; do not pretend to have forced OS PID reuse.
      const collision = { ...rec, child: old };
      assert.doesNotThrow(() => signalObservedChild(collision, "SIGTERM", () => true, () => { throw uncertain; }),
        "CASE_ASSERTION completed-slot: finished handle adopted a live PID slot");
      assert(noSignals(), "CASE_ASSERTION completed-slot: unrelated slot occupant was signaled");
    } else throw new Error("unknown case " + name);
    console.log("PASS herald identity " + name);
  } finally {
    fs.writeFileSync(release, "cleanup");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
  }
}
if (selected) {
  assert(cases.includes(selected)); await probe(selected);
} else {
  for (const name of cases) await probe(name);
  const source = fs.readFileSync(helper, "utf8");
  const variants = [
    { name: "no-join", cases: ["exit-join", "live-refusal"], old: "      await Promise.race([", next: "      return null; // removed completion join\n      await Promise.race([" },
    { name: "no-generation", cases: ["uncertain-signal"], old: '  assert.ok(rec.generation, "identity captured while allocated");', next: "  // removed capture guard" },
    { name: "no-completed-guard", cases: ["completed-slot"], old: "  if (rec.child && (rec.child.exitCode !== null || rec.child.signalCode !== null)) return;", next: "  // removed completed-handle guard" },
  ];
  for (const variant of variants) {
    assert.equal(source.split(variant.old).length, 2, "unique removal anchor");
    const file = path.join(suite, variant.name + ".ts");
    fs.writeFileSync(file, source.replace(variant.old, () => variant.next));
    for (const name of variant.cases) {
      const result = spawnSync("bun", [import.meta.path, root, name, file], { encoding: "utf8", timeout: 5000 });
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 1, result.stdout + result.stderr);
      assert(result.stderr.includes("CASE_ASSERTION " + name), "removal failed outside its own assertion: " + result.stderr);
      console.log(`PASS herald identity removal ${variant.name}/${name}: native1, own assertion`);
    }
  }
  console.log("herald identity regressions: PASS (4 cases, 4 rejecting removals)");
}
