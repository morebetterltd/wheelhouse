// Exercise the real alerts CLI and its published snapshot, not exported readers.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { completedCommand } from "../completed-command";

const [here, base, source, caseName, mutation = "none"] = process.argv.slice(2);
assert(fs.statSync(source).isFile());
let owned = false;
for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, ".wheelhouse-selftest-fixture"))) { owned = true; break; }
  if (path.dirname(dir) === dir) break;
}
assert(owned, "alert value cases require an owned fixture ancestor");
const cases = {
  missing: { raw: null, gb: 10, lag: false, old: false },
  blank: { raw: "", gb: 10, lag: false, old: false },
  whitespace: { raw: " \t ", gb: 10, lag: false, old: false },
  zero: { raw: "0", gb: 0, lag: true, old: false },
  number: { raw: "1000000000", gb: 1000000000, lag: false, old: true },
  fraction: { raw: " 1.25 ", gb: 1.25, lag: true, old: true },
  invalid: { raw: "not-a-number", gb: 10, lag: true, old: true },
  infinity: { raw: "Infinity", gb: 10, lag: true, old: true },
} as const;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const save = (file: string, data: any) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
const oracle = (reader: string, name: string) => `ALERT_VALUE_ORACLE ${reader}/${name}`;

if (!caseName) {
  fs.mkdirSync(base);
  const records: any[] = [];
  const run = (name: string, change: string) => {
    const dir = path.join(base, `${name}-${change}`);
    const child = completedCommand("bun", [import.meta.path, here, dir, source, name, change]);
    fs.writeFileSync(dir + ".stdout", child.stdout); fs.writeFileSync(dir + ".stderr", child.stderr);
    const native = { status: child.status, signal: child.signal ?? null, error: child.error?.message ?? null };
    save(dir + ".native.json", native);
    assert(!child.signal && !child.error, "value case must complete naturally");
    // Missing modules, copy/parser failures and absent measurements are not reds.
    const record = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    assert.deepEqual(record.check, { status: 0, signal: null, error: null });
    assert(record.inputObserved);
    records.push({ ...record, native });
    console.log("CAPTURE alert value " + JSON.stringify({ ...record, native }));
    return { child, record };
  };
  const failures: string[] = [];
  for (const name of Object.keys(cases)) {
    const { child } = run(name, "none");
    if (child.status !== 0) failures.push(name);
  }
  publish();
  assert.equal(failures.length, 0, "ALERT_VALUE_DEFAULTS: " + failures.join(", "));
  for (const reader of ["gb", "minutes"]) {
    for (const [name, change] of [
      ...["missing", "blank", "whitespace"].map(name => [name, "empty-to-zero"]),
      ["zero", "always-default"], ["number", "always-default"],
      ["invalid", "accept-nonfinite"], ["infinity", "accept-nonfinite"],
      ...(reader === "gb" ? [["fraction", "always-default"]] : []),
    ]) {
      const { child, record } = run(name, `${reader}-${change}`);
      assert.equal(child.status, 1, "removal must fail its actual value assertion");
      assert(child.stderr.includes("AssertionError") && child.stderr.includes(oracle(reader, name)), child.stderr);
      assert.notEqual(record.beforeHash, record.afterHash);
      console.log(`REJECT ${reader}/${name}/${change}: actual check0; case1 at ${oracle(reader, name)}`);
    }
  }
  publish();
  function publish() {
    save(path.join(base, "result.json"), records);
    if (!process.env.WHEELHOUSE_ALERT_VALUES_EVIDENCE) return;
    const out = process.env.WHEELHOUSE_ALERT_VALUES_EVIDENCE;
    fs.mkdirSync(out, { recursive: true });
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(base, entry.name), path.join(out, entry.name));
      else for (const name of ["result.json", "check.stdout", "check.stderr", "template-source.txt"]) {
        fs.copyFileSync(path.join(base, entry.name, name), path.join(out, entry.name + "." + name));
      }
    }
  }
  console.log("alert values: PASS (8 consumer cases, 15 real-source controls)");
} else {
  assert(Object.hasOwn(cases, caseName));
  const c = cases[caseName as keyof typeof cases];
  fs.mkdirSync(base);
  const root = path.join(base, "project"), bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const copy = completedCommand("bash", ["-c", '. "$1/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1"', "copy", here, root]);
  assert.equal(copy.status, 0, copy.stderr); assert(!copy.signal && !copy.error);
  const file = path.join(root, "seats/alerts.ts"), original = fs.readFileSync(source, "utf8");
  let changed = original;
  if (mutation !== "none") {
    const [reader, ...words] = mutation.split("-"), change = words.join("-");
    assert(["gb", "minutes"].includes(reader));
    const pattern = new RegExp(`function ${reader}Value\\(key:string, def:number\\):number\\{[^\\n]+\\}`);
    assert.equal([...original.matchAll(new RegExp(pattern, "g"))].length, 1, "unique actual reader");
    const body = original.match(pattern)![0];
    let replacement: string;
    if (change === "empty-to-zero") {
      const guard = 'if(raw==="") return def; ';
      assert.equal(body.split(guard).length, 2, "actual empty-value guard exists");
      replacement = body.replace(guard, "");
    } else if (change === "always-default") replacement = `function ${reader}Value(key:string, def:number):number{ return def; }`;
    else {
      assert.equal(change, "accept-nonfinite");
      assert(body.includes("return Number.isFinite(n) ? n : def;"));
      replacement = body.replace("return Number.isFinite(n) ? n : def;", "return n;");
    }
    changed = original.replace(pattern, replacement);
  }
  fs.writeFileSync(file, changed);
  for (const dir of ["seats/run", "seats/logs", "wheelhouse", "home"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "seats/seats.json"), '{"seats":{"commander":{"role":"commander","external":true}}}\n');
  fs.writeFileSync(path.join(root, "seats/state.json"), '{"seats":{}}\n');
  const settings = "github-issue-watch=off\ngithub-issue-repos=fixture/repo\nalert-human-after-minutes=15\n" +
    (c.raw === null ? "" : `alert-low-disk-gb=${c.raw}\nalert-inbox-lag-minutes=${c.raw}\n`);
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), settings);
  fs.writeFileSync(path.join(base, "template-source.txt"), settings);
  fs.writeFileSync(path.join(bin, "bd"), '#!/usr/bin/env bash\nprintf \'[]\\n\'\n', { mode: 0o700 });
  fs.writeFileSync(path.join(root, "seats/template-drift.sh"), '#!/usr/bin/env bash\nprintf \'{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n', { mode: 0o700 });
  // Synthetic timestamps make zero vs positive and huge vs default thresholds
  // distinguishable without sleeps or a near-deadline scheduling window.
  fs.writeFileSync(path.join(root, "seats/inbox.jsonl"), JSON.stringify({ id: "numeric-setting-input", at: c.old ? "2000-01-01T00:00:00.000Z" : "2100-01-01T00:00:00.000Z" }) + "\n");
  const child = completedCommand("bun", ["seats/alerts.ts", "check", "--json"], { cwd: root,
    env: { ...process.env, HOME: path.join(root, "home"), PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_ALERTS_ROOT: root } });
  fs.writeFileSync(path.join(base, "check.stdout"), child.stdout); fs.writeFileSync(path.join(base, "check.stderr"), child.stderr);
  const native = { status: child.status, signal: child.signal ?? null, error: child.error?.message ?? null };
  assert.deepEqual(native, { status: 0, signal: null, error: null }, child.stderr);
  const snap = JSON.parse(child.stdout), published = JSON.parse(fs.readFileSync(path.join(root, "seats/run/fleet-snapshot.json"), "utf8"));
  assert.deepEqual(snap, published, "actual CLI output equals published snapshot");
  assert.equal(snap.inbox.undrainedRows, 1);
  if (c.old) assert(snap.inbox.lagMs > 10 * 60_000 && snap.inbox.lagMs < 1000000000 * 60_000, "old input distinguishes default from numeric override");
  else assert.equal(snap.inbox.lagMs, 0, "future input distinguishes zero from positive threshold");
  const record = { case: caseName, mutation, beforeHash: hash(original), afterHash: hash(changed), check: native, inputObserved: true,
    thresholdBytes: snap.disk.thresholdBytes, expectedThresholdBytes: Math.floor(c.gb * 1024 ** 3), freeBytes: snap.disk.freeBytes,
    lowDisk: snap.alerts["low-disk"].active, expectedLowDisk: snap.disk.freeBytes !== null && snap.disk.freeBytes < Math.floor(c.gb * 1024 ** 3),
    lagMs: snap.inbox.lagMs, inboxLag: snap.alerts["inbox-lag"].active, expectedInboxLag: c.lag };
  save(path.join(base, "result.json"), record);
  assert.equal(record.thresholdBytes, record.expectedThresholdBytes, oracle("gb", caseName));
  assert.equal(record.lowDisk, record.expectedLowDisk, oracle("gb", caseName));
  assert.equal(record.inboxLag, record.expectedInboxLag, oracle("minutes", caseName));
}
