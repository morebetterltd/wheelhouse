// Exercise the real census caller and canonical CLEAN, not a mock teardown.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const root = process.argv[2], seats = path.dirname(import.meta.dir);
assert(root && fs.statSync(root).isDirectory());
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const original = fs.readFileSync(path.join(seats, "adapter.ts"), "utf8");
const target = "  return seen;\n}\n\nfunction orphanMatchesFor";
assert.equal(original.split(target).length, 2, "fault must change exactly the duplicate-reporting consumer");
const fault = path.join(root, "drop-real-duplicate.ts");
fs.writeFileSync(fault, original.replace(target, "  return new Map();\n}\n\nfunction orphanMatchesFor"));

for (const [label, adapter, expectedNative] of [
  ["failure", fault, 1], ["success", path.join(seats, "adapter.ts"), 0],
] as const) {
  const dir = path.join(root, label), tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const suite = path.join(dir, "census.selftest.sh");
  fs.writeFileSync(suite, `#!/usr/bin/env bash\nexec bash ${quote(path.join(seats, "fixtures/adapter-census-run.sh"))} "$TMPDIR/census-case" ${quote(adapter)}\n`);
  const env = { ...process.env, TMPDIR: tmp, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: suite };
  // Test the canonical runner's default original-TMPDIR boundary, independently
  // of whatever artifact/evidence overrides an outer test driver may supply.
  delete env.WHEELHOUSE_SELFTEST_ARTIFACT_ROOT;
  delete env.WHEELHOUSE_CENSUS_EVIDENCE;
  const stdoutFile = path.join(dir, "sweep.stdout"), stderrFile = path.join(dir, "sweep.stderr");
  const child = Bun.spawn(["bash", path.join(seats, "selftest-sweep.sh"), "--tier", "full"], {
    cwd: seats, env, stdin: "ignore", stdout: Bun.file(stdoutFile), stderr: Bun.file(stderrFile),
  });
  const code = await child.exited;
  const stdout = fs.readFileSync(stdoutFile, "utf8"), stderr = fs.readFileSync(stderrFile, "utf8");
  assert.equal(code, expectedNative, `actual census invocation: ${stdout}\n${stderr}`);
  assert(stderr.includes("selftest-sweep: CLEAN "), "real canonical cleanup must finish before retention assertions");
  const artifacts = fs.readdirSync(tmp).filter(name => name.startsWith("wheelhouse-adapter-census."));
  if (label === "success") {
    assert(stdout.includes("adapter-census: 5/5 passed"), "healthy actual subject/control must run first");
    assert.equal(artifacts.length, 0, "successful census removes its own default evidence allocation");
    console.log("PASS census success removes its owned default evidence after native success");
    continue;
  }
  // These setup/consumer observations execute OUTSIDE any expected-failure
  // catch. A missing import, observer, actor, wrong fault or cleanup error
  // cannot be credited as the planted large-census assertion.
  assert(stdout.includes("large census must report the real captured duplicate"));
  assert(stdout.includes("adapter-census: 4/5 passed"));
  assert.equal(artifacts.length, 1, "failed census evidence must survive canonical CLEAN");
  const evidence = path.join(tmp, artifacts[0]);
  assert.equal(fs.statSync(evidence).mode & 0o777, 0o700, "raw process/path evidence stays private");
  assert(fs.readFileSync(path.join(evidence, ".wheelhouse-selftest-fixture"), "utf8").includes(`root=${evidence}\n`));
  const source = JSON.parse(fs.readFileSync(path.join(evidence, "source.json"), "utf8"));
  assert(!fs.existsSync(source.root), "the actual original project was deleted, not merely left around");
  assert.equal(source.fixtureSha256, hash(fs.readFileSync(path.join(seats, "fixtures/adapter-census.ts"))));
  assert.equal(source.adapterSha256, hash(fs.readFileSync(fault)));
  const progress = fs.readFileSync(path.join(evidence, "progress.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert(progress.some(row => row.stage === "original subjects joined"));
  const results = JSON.parse(fs.readFileSync(path.join(evidence, "results.json"), "utf8"));
  assert.equal(results.length, 5);
  assert.equal(results.filter((r: any) => r.failure !== null).length, 1);
  for (const result of results) {
    const mode = path.join(evidence, result.mode);
    const capture = JSON.parse(fs.readFileSync(path.join(mode, "capture.json"), "utf8"));
    const replay = JSON.parse(fs.readFileSync(path.join(mode, "replay.json"), "utf8"));
    const saved = JSON.parse(fs.readFileSync(path.join(mode, "result.json"), "utf8"));
    const bytes = fs.readFileSync(path.join(mode, "ps.stdout"));
    assert.equal(capture.status, 0); assert.equal(capture.signal, null); assert.equal(capture.error, null);
    assert.equal(bytes.length, capture.bytes); assert.equal(hash(bytes), capture.sha256);
    assert.equal(fs.statSync(path.join(mode, "ps.stderr")).size, 0);
    assert.deepEqual(saved, result);
    assert.equal(result.code, 0);
    assert.deepEqual(result.subject, { recordedAlive: true, candidateAlive: true, contextUnchanged: true });
    if (result.mode === "large") {
      assert(!result.stderr.includes("UNVERIFIED orphan census"), "only the planted reporting fault may cause this rejection; native census must be verified");
      assert(replay.bytes > 2 * 1024 * 1024 && replay.candidateOffset > 2 * 1024 * 1024);
      assert(bytes.toString("utf8").split("\n").some(line => new RegExp(`^\\s*${result.candidatePid}\\s+`).test(line)));
      assert(result.failure.includes("large census must report the real captured duplicate"));
    } else assert.equal(result.failure, null);
  }
  console.log("PASS failed census keeps exact native capture/replay/result and partial-setup context after canonical CLEAN");
}
