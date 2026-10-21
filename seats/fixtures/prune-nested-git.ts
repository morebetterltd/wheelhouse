// Fast self-checks of prune's enclosing-Git containment check. No prune corpus.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const [seats, base, prune] = process.argv.slice(2);
assert(fs.statSync(path.join(path.dirname(base), ".wheelhouse-selftest-fixture")).isFile());
const original = fs.readFileSync(path.join(seats, "prune-safety.selftest.sh"), "utf8");
console.log("nested-git pinned selftest sha256=" + createHash("sha256").update(original).digest("hex"));
fs.mkdirSync(base);
let serial = 0;
function replace(source: string, old: string, next: string) { assert.equal(source.split(old).length, 2, "mutation must hit one site: " + old); return source.replace(old, next); }
function run(source: string) {
  const root = path.join(base, String(++serial)), runtime = path.join(root, "seats"); fs.mkdirSync(runtime, { recursive: true });
  for (const name of fs.readdirSync(seats)) {
    const file = path.join(seats, name);
    if (fs.statSync(file).isFile() && /\.(sh|ts)$/.test(name)) fs.copyFileSync(file, path.join(runtime, name));
    else if (["drivers", "transports"].includes(name)) fs.cpSync(file, path.join(runtime, name), { recursive: true });
  }
  fs.mkdirSync(path.join(runtime, "fixtures"));
  fs.copyFileSync(path.join(seats, "fixtures/prune-fixture.sh"), path.join(runtime, "fixtures/prune-fixture.sh"));
  fs.writeFileSync(path.join(runtime, "prune-safety.selftest.sh"), source); fs.copyFileSync(prune, path.join(runtime, "prune.ts"));
  const env = { ...process.env, WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK_ONLY: "1", WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK: "0" };
  const result = spawnSync("bash", [path.join(runtime, "prune-safety.selftest.sh")], { env, encoding: "utf8", timeout: 90000 });
  assert(!result.error, String(result.error)); assert.equal(result.signal, null);
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  return result;
}
const beforeHead = '  OUTER_HEAD_AFTER="$(git -C "$OUTER" rev-parse HEAD)" || exit 2';
const headLeak = '  tree="$(git -C "$OUTER" rev-parse HEAD^{tree})" || exit 2\n  leaked="$(printf "injected HEAD leak\\n" | git -C "$OUTER" commit-tree "$tree" -p "$OUTER_HEAD_BEFORE")" || exit 2\n  git -C "$OUTER" update-ref HEAD "$leaked" || exit 2\n' + beforeHead;
const indexLeak = '  printf "changed staged bytes\\n" >> "$OUTER/staged.txt"\n  git -C "$OUTER" add staged.txt || exit 2\n' + beforeHead;
const childExit = "  printf 'prune nested git leak subset: PASS\\n'\n  exit 0";
const slow = replace(replace(original, "NESTED_GIT_LEAK_TIMEOUT_S=60", "NESTED_GIT_LEAK_TIMEOUT_S=1"), childExit, "  exec perl -e 'sleep 30'");
const failedChild = replace(original, childExit, "  printf 'prune nested git leak subset: PASS\\n'\n  exit 17");
const head = replace(original, beforeHead, headLeak), index = replace(original, beforeHead, indexLeak);
const cases = [
  { name: "bounded actual Git setup", source: original, status: 0, text: "HEAD and index bytes unchanged" },
  { name: "HEAD leak refused", source: head, status: 1, text: "nested TMPDIR repo changed:" },
  { name: "index leak refused", source: index, status: 1, text: "index_unchanged=0" },
  { name: "timeout identifies itself", source: slow, status: 1, text: "nested TMPDIR Git leak check timed out after 1s (rc=142" },
  { name: "child error is not a timeout", source: failedChild, status: 1, text: "nested TMPDIR Git leak subset failed (rc=17" },
];
function check(test: typeof cases[number], source = test.source) {
  const r = run(source); assert.equal(r.status, test.status, r.stdout + r.stderr); assert(r.stdout.includes(test.text), r.stdout + r.stderr);
  if (test.name === "child error is not a timeout") assert(!r.stdout.includes("timed out"));
  if (test.name === "bounded actual Git setup") {
    const timing = /elapsed=(\d+)s limit=(\d+)s/.exec(r.stdout); assert(timing); assert(Number(timing[1]) < Number(timing[2]));
  }
}
for (const test of cases) { check(test); console.log("PASS nested-git " + test.name); }
const controls = [
  slow,
  replace(head, '[ "$OUTER_HEAD_AFTER" = "$OUTER_HEAD_BEFORE" ]', 'true'),
  replace(index, '[ "$OUTER_INDEX_UNCHANGED" = 1 ]', 'true'),
  replace(slow, 'Git leak check timed out after', 'Git leak check failed after'),
  replace(failedChild, '[ "$NESTED_RC" = 0 ] && grep', 'grep'),
];
for (let i = 0; i < cases.length; i++) {
  let caught = false; try { check(cases[i], controls[i]); } catch { caught = true; }
  assert(caught, "fix removal must fail: " + cases[i].name); console.log("NEGATIVE nested-git detected " + cases[i].name);
}
console.log("nested-git check: 5 cases, 5 failing removal controls, PASS");
