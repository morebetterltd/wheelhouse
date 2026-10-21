// Real CLI/manifest admission tests. Invalid manifests must never reach H4.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const [here, root, runner] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const dir = path.join(root, "core-cli"), project = path.join(dir, "project"), seats = path.join(project, "seats");
fs.mkdirSync(seats, { recursive: true });
for (const name of ["selftest-sweep-lock.ts", "python-invocations.ts"]) fs.copyFileSync(path.join(here, name), path.join(seats, name));
const source = fs.readFileSync(runner, "utf8"), target = path.join(seats, "selftest-sweep.sh"), manifest = path.join(seats, "selftest-core.list");
for (const name of ["a", "b", "full"]) fs.writeFileSync(path.join(seats, `${name}.selftest.sh`), `#!/bin/bash\nprintf '${name}\\n' >> "$CORE_EVENTS"\n`);
fs.writeFileSync(target, source);
for (const args of [["init", "-q", "-b", "main"], ["add", "seats"]]) {
  const r = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
}
const raw = "# unsorted, inline comments and blank lines are allowed\nb.selftest.sh # second\n\na.selftest.sh\n";
const sha = createHash("sha256").update(raw).digest("hex");
let count = 0;
function run(name: string, text: string | null, args: string[], tier: string | undefined, broken: string | undefined, expected: number, events: string[], pattern?: string) {
  const key = `${++count}-${name}-${broken ? "removed" : "fixed"}`, lock = path.join(dir, key + ".lock"), capture = path.join(dir, key);
  fs.mkdirSync(capture);
  if (fs.existsSync(manifest)) fs.chmodSync(manifest, 0o600);
  fs.rmSync(manifest, { force: true });
  if (text !== null) fs.writeFileSync(manifest, text);
  if (name === "unreadable") fs.chmodSync(manifest, 0);
  fs.writeFileSync(target, broken ?? source);
  const env = { ...process.env, CORE_EVENTS: path.join(capture, "events"), WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: path.join(here, "selftest-sweep-lock.ts") };
  delete env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN; delete env.WHEELHOUSE_SELFTEST_SWEEP_TIER;
  if (tier !== undefined) env.WHEELHOUSE_SELFTEST_SWEEP_TIER = tier;
  if (pattern) env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN = pattern;
  const r = spawnSync("bash", [target, ...args], { env, cwd: project, encoding: "utf8" });
  assert.ifError(r.error); assert.equal(r.signal, null);
  fs.writeFileSync(path.join(capture, "stdout"), r.stdout); fs.writeFileSync(path.join(capture, "stderr"), r.stderr);
  const observed = fs.existsSync(env.CORE_EVENTS) ? fs.readFileSync(env.CORE_EVENTS, "utf8").trim().split("\n") : [];
  const admitted = /^selftest-sweep: tier=/m.test(r.stdout);
  const hashed = r.stdout.includes(`selftest-sweep: tier=core suites=2 manifest=${sha}`);
  const hostCreated = fs.existsSync(lock + ".host");
  const ok = r.status === expected && JSON.stringify(observed) === JSON.stringify(events) && (expected === 0 ? hashed : !admitted && !hostCreated && r.stderr.includes("STOP:")) && !fs.existsSync(lock) && !fs.existsSync(lock + ".queue");
  console.log(JSON.stringify({ name, removed: !!broken, code: r.status, events: observed, admitted, hashed, hostCreated, positiveCriterion: ok }));
  return ok;
}
const legacy = source.replace('TIER="$2"; tier_flag=1;', 'tier_flag=1;');
assert.notEqual(legacy, source);
const withoutEnv = source.replace('TIER="${WHEELHOUSE_SELFTEST_SWEEP_TIER:-full}"', 'TIER="full"');
const validationStart = source.indexOf('if [ "$TIER" = core ]; then\n  # Validate before admission.');
const validationEnd = source.indexOf('\nacquire_lock\n', validationStart);
assert(validationStart > 0 && validationEnd > validationStart);
const withoutValidation = source.slice(0, validationStart) + source.slice(validationEnd);
const cases = [
  { name: "flag-wins", text: raw, args: ["--tier", "core"], env: "full", broken: legacy, expected: 0, events: ["a", "b"] },
  { name: "env-core", text: raw, args: [], env: "core", broken: withoutEnv, expected: 0, events: ["a", "b"] },
  { name: "core-ignores-filter", text: raw, args: ["--tier", "core"], env: undefined, broken: legacy, expected: 0, events: ["a", "b"], pattern: path.join(seats, "a.selftest.sh") },
  ...[["missing-suite", "absent.selftest.sh\n"], ["duplicate", "a.selftest.sh\na.selftest.sh\n"], ["unreadable", raw], ["missing-manifest", null], ["empty", "# empty\n"], ["unsafe-path", "../a.selftest.sh\n"]].map(([name, text]) => ({ name: name!, text, args: ["--tier", "core"], env: undefined, broken: withoutValidation, expected: 2, events: [] as string[] })),
];
for (const c of cases) {
  assert(run(c.name, c.text, c.args, c.env, undefined, c.expected, c.events, c.pattern), c.name);
  assert(!run(c.name, c.text, c.args, c.env, c.broken, c.expected, c.events, c.pattern), `insensitive ${c.name} removal`);
  console.log(`PASS core CLI ${c.name}; matching removal detected`);
}
fs.chmodSync(manifest, 0o600); fs.writeFileSync(manifest, raw); fs.writeFileSync(target, source);
for (const [name, args, env] of [["default-full", [], undefined], ["flag-full-wins", ["--tier", "full"], "core"]] as const) {
  const events = path.join(dir, name + ".events"), lock = path.join(dir, name + ".lock");
  const e = { ...process.env, CORE_EVENTS: events, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: path.join(here, "selftest-sweep-lock.ts") };
  delete e.WHEELHOUSE_SELFTEST_SWEEP_PATTERN; delete e.WHEELHOUSE_SELFTEST_SWEEP_TIER;
  if (env) e.WHEELHOUSE_SELFTEST_SWEEP_TIER = env;
  const r = spawnSync("bash", [target, ...args], { env: e, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert(r.stdout.includes("selftest-sweep: tier=full suites=3"));
  assert.equal(fs.readFileSync(events, "utf8"), "a\nb\nfull\n");
  console.log(`PASS compatibility ${name}: full inventory unchanged`);
}
console.log(`core CLI: PASS (${cases.length} regressions/removal pairs, 2 full compatibility controls)`);
