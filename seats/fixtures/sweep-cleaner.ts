// Native age selection against PRIVATE lock paths, never the installed cleaner.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
const [input, helper, runner, mode] = process.argv.slice(2);
function validateFixture() {
  // Refuse production-shaped inputs before even stat'ing a live lock/cache.
  if (!input || !path.isAbsolute(input) || !path.basename(input).startsWith("wheelhouse-sweep-cleaner.")) throw new Error("TEST_SUBJECT_OUTSIDE_MARKED_FIXTURE");
  const marker = path.join(input, ".wheelhouse-selftest-fixture");
  if (fs.realpathSync(input) !== input || fs.lstatSync(input).isSymbolicLink() || !fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() || fs.statSync(marker).uid !== process.getuid()) throw new Error("TEST_SUBJECT_OUTSIDE_MARKED_FIXTURE");
}
try { validateFixture(); } catch { console.error("STOP: TEST_SUBJECT_OUTSIDE_MARKED_FIXTURE"); process.exit(2); }
if (mode === "--check-root") process.exit(0);
const root = input, source = fs.readFileSync(helper, "utf8"), sweep = fs.readFileSync(runner, "utf8");
const marker = "wheelhouse-selftest-sweep", anchor = marker + "-host", token = "b".repeat(32), sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
let sequence = 0;
const facts: object[] = [], actors: { child: ChildProcess; done: Promise<{ code: number | null; signal: string | null }>; closed: () => boolean; release?: string }[] = [];
function command(dir: string, argv: string[], env = process.env) {
  const id = String(++sequence).padStart(4, "0"), out = path.join(dir, id + ".stdout"), err = path.join(dir, id + ".stderr");
  const a = fs.openSync(out, "wx", 0o600), b = fs.openSync(err, "wx", 0o600);
  let r;
  try { r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env, stdio: ["ignore", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  const result = { command: argv, status: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: fs.readFileSync(out, "utf8"), stderr: fs.readFileSync(err, "utf8") };
  fs.writeFileSync(path.join(dir, id + ".native.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  assert.equal(result.error, null); assert.equal(result.signal, null);
  return result;
}
function start(dir: string, argv: string[], env: NodeJS.ProcessEnv) {
  const a = fs.openSync(path.join(dir, "actor.stdout"), "wx", 0o600), b = fs.openSync(path.join(dir, "actor.stderr"), "wx", 0o600);
  let child: ChildProcess;
  try { child = spawn(argv[0], argv.slice(1), { cwd: dir, env, stdio: ["pipe", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  child.stdin!.on("error", error => { if ((error as any).code !== "EPIPE") throw error; });
  let closed = false;
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  const actor = { child, done, closed: () => closed, release: env.CLEANER_RELEASE }; actors.push(actor); return actor;
}
async function until(check: () => boolean, actor?: ReturnType<typeof start>) {
  const deadline = performance.now() + 300_000;
  while (!check()) {
    if (actor?.closed()) throw new Error("INCOMPLETE: actor closed before native checkpoint");
    if (performance.now() > deadline) throw new Error("INCOMPLETE: native checkpoint not observed");
    await Bun.sleep(10);
  }
}
function snapshot(state: string) {
  const rows: Record<string, { ino: string; sha: string; atime: number; mtime: number; ctime: number }> = {};
  for (const dir of ["host.lock", "host.lock.host", "host.lock.queue"]) for (const name of fs.readdirSync(path.join(state, dir))) {
    const file = path.join(state, dir, name), bytes = fs.readFileSync(file), st = fs.lstatSync(file);
    assert(st.isFile() && !st.isSymbolicLink());
    rows[path.join(dir, name)] = { ino: String(st.ino), sha: sha(bytes), atime: st.atimeMs, mtime: st.mtimeMs, ctime: st.ctimeMs };
  }
  return rows;
}
async function cutoff(dir: string, before: ReturnType<typeof snapshot>) {
  // ctime cannot be backdated safely. Advance the CLEANER's logical clock,
  // not the host clock: logical now = this reference + three days. Native find
  // compares all THREE real inode times against the same explicit reference.
  const time = Math.max(Date.now(), ...Object.values(before).flatMap(r => [r.atime, r.mtime, r.ctime])) + 50;
  const reference = path.join(dir, "cutoff"); fs.writeFileSync(reference, "three-day age cutoff\n"); fs.utimesSync(reference, time / 1000, time / 1000);
  await until(() => Date.now() > time + 10);
  return { reference, cutoffMs: fs.statSync(reference).mtimeMs, logicalNowMs: time + 3 * 86400_000 };
}
function clean(dir: string, state: string, reference: string) {
  assert(state.startsWith(root + path.sep) && fs.realpathSync(state) === state);
  // Captured macOS policy: local files with a/m/c all older than three days;
  // then old empty directories. No holder exemption. Never run tmp_cleaner.
  const local = process.platform === "darwin" ? ["-fstype", "local"] : [];
  const files = command(dir, ["find", state, "-depth", "-xdev", ...local, "-type", "f", "!", "-neweram", reference, "!", "-newermm", reference, "!", "-newercm", reference, "-delete", "-print"]);
  assert.equal(files.status, 0, files.stderr); assert.equal(files.stderr, "");
  const directories = command(dir, ["find", state, "-depth", "-xdev", ...local, "!", "-path", state, "-type", "d", "-empty", "!", "-newermm", reference, "!", "-name", ".vfs_rsrc_streams_*", "-delete", "-print"]);
  assert.equal(directories.status, 0, directories.stderr); assert.equal(directories.stderr, "");
  return { deleted: files.stdout.trim().split("\n").filter(Boolean).map(f => path.relative(state, f)), directories: directories.stdout.trim().split("\n").filter(Boolean).map(f => path.relative(state, f)) };
}
function named(original: string, host: string) {
  assert.equal(original.split("const HOST = os.hostname();").length, 2);
  return original.replace("const HOST = os.hostname();", `const HOST = ${JSON.stringify(host)};`);
}
async function preservation(kind: "transition" | "supervisor" | "sweep" | "inherited" | "sweep-refusal") {
  const dir = path.join(root, kind); fs.mkdirSync(dir); const state = path.join(dir, "state"); fs.mkdirSync(state);
  const lock = path.join(state, "host.lock"), ready = path.join(dir, "ready"), release = path.join(dir, "release"), receipts = path.join(dir, "refresh.jsonl"), refuse = path.join(dir, "refuse-renewal");
  const hasRenewal = source.includes("function renewFiles("), hasHeartbeat = source.includes("}, 60_000);");
  let tested = named(source, "network-before");
  // Same callback/operations, shorter cadence only in this pinned test copy.
  // Receipt is after successful native refresh/inherited transition, not time.
  if (hasHeartbeat) tested = tested.replace("}, 60_000);", "}, 1_000);");
  if (kind === "sweep-refusal") tested = tested.replace('if (op === "refresh") {', `if (op === "refresh") { if (fs.existsSync(${JSON.stringify(refuse)})) throw new Refused("fixture: refuse renewal");`);
  const end = 'else process.exitCode = main();'; assert.equal(tested.split(end).length, 2);
  tested = tested.replace(end, end + `\n    if (process.exitCode === 0 && ["refresh", "inherited"].includes(operation)) fs.appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({operation, pid:process.pid})+"\\n");`);
  const file = path.join(dir, "helper.ts"), after = path.join(dir, "network-after.ts"); fs.writeFileSync(file, tested); fs.writeFileSync(after, named(source, "network-after"));
  fs.mkdirSync(path.join(dir, "tmp"));
  const env = { ...process.env, TMPDIR: path.join(dir, "tmp"), WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: file };
  let actor: ReturnType<typeof start>, owned = "", ownerPid = 0;
  if (kind === "transition") {
    actor = start(dir, ["bash", "-c", 'printf ready > "$1"; IFS= read -r release', "holder", ready], env);
    await until(() => fs.existsSync(ready), actor); ownerPid = actor.child.pid!;
    const r = command(dir, ["bun", file, "acquire", lock, String(ownerPid), "a".repeat(32)], env); assert.equal(r.status, 0, r.stderr); owned = r.stdout.trim();
  } else if (kind === "supervisor") {
    actor = start(dir, ["bun", file, "supervise", lock, "bash", "-c", 'printf ready > "$1"; IFS= read -r release', "holder", ready], env);
    await until(() => fs.existsSync(ready), actor);
  } else {
    // Complete native runner/runtime, only the callback cadence is shortened.
    const project = path.join(dir, "project"), seats = path.join(project, "seats"); fs.mkdirSync(project);
    const copied = command(dir, ["bash", "-c", '. "$1"; selftest_copy_seat_runtime "$2" "$3" || exit 2', "cleaner-runtime", path.join(path.dirname(runner), "selftest-lib.sh"), project, path.dirname(runner)], env);
    assert.equal(copied.status, 0, copied.stderr);
    let testSweep = sweep;
    if (testSweep.includes("slice=60")) {
      // macOS Bash 3.2 read -t requires whole seconds. Keep its real FIFO read.
      testSweep = testSweep.replace("slice=60", "slice=1");
      const at = 'remaining=$((deadline-SECONDS))', quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      assert.equal(testSweep.split(at).length, 2);
      testSweep = testSweep.replace(at, `printf '%s\\n' '{"operation":"watchdog-tick"}' >> ${quote(receipts)}\n    ` + at);
    }
    fs.writeFileSync(path.join(seats, "selftest-sweep.sh"), testSweep);
    const init = command(dir, ["git", "-C", project, "init", "-q", "-b", "main"], env); assert.equal(init.status, 0, init.stderr);
    const add = command(dir, ["git", "-C", project, "add", "seats"], env); assert.equal(add.status, 0, add.stderr);
    const suite = path.join(seats, "idle.selftest.sh"); fs.writeFileSync(suite, '#!/usr/bin/env bash\nprintf "%s\\n" "$$" > "$CLEANER_READY"\n' + (kind === "sweep-refusal" ? 'sleep 5\nprintf finished > "$CLEANER_RELEASE"\n' : 'while [ ! -f "$CLEANER_RELEASE" ]; do sleep 0.02; done\n'));
    let argv = ["bash", path.join(seats, "selftest-sweep.sh")];
    if (kind === "inherited") {
      // Isolate the inherited-watchdog path: its outer supervisor deliberately
      // has no heartbeat, so it cannot conceal a missing inherited renewal.
      let outer = named(source, "network-before");
      const first = outer.indexOf("      renewal = setInterval(() => {"), last = outer.indexOf('      gate.end("admitted\\n");', first);
      if (first >= 0) { assert(last > first); outer = outer.slice(0, first) + outer.slice(last); }
      const outerFile = path.join(dir, "outer-no-heartbeat.ts"); fs.writeFileSync(outerFile, outer);
      argv = ["bun", outerFile, "supervise", lock, ...argv];
    }
    actor = start(dir, argv, { ...env, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: suite, CLEANER_READY: ready, CLEANER_RELEASE: release, ...(kind === "sweep-refusal" ? { WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S: "2", WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: "1" } : {}) });
    await until(() => fs.existsSync(ready), actor);
  }
  try {
    if (kind === "sweep-refusal") {
      // Arm only after the complete runtime copy and real payload startup;
      // setup's own supervisor must never receive this deliberate refusal.
      fs.writeFileSync(refuse, "armed after ready\n");
      ownerPid = actor.child.pid!;
      const payload = Number(fs.readFileSync(ready, "utf8")); assert(Number.isInteger(payload) && payload > 1);
      const before = command(dir, ["ps", "-ww", "-p", String(payload), "-o", "pid=,uid=,ppid=,pgid=,lstart=,command="], env);
      assert.equal(before.status, 0, before.stderr); assert.equal(before.stderr, "");
      assert.equal(Number(before.stdout.trim().split(/\s+/)[3]), payload, "actual isolated payload group exists");
      await until(() => actor.closed());
      const out = fs.readFileSync(path.join(dir, "actor.stdout"), "utf8"), err = fs.readFileSync(path.join(dir, "actor.stderr"), "utf8"), exit = await actor.done;
      const census = command(dir, ["ps", "-ww", "-axo", "pid=,pgid=,stat="], env); assert.equal(census.status, 0); assert.equal(census.stderr, "");
      const rows = census.stdout.trim().split("\n").map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line); assert(m, "complete native group census row"); return { pid: Number(m[1]), group: Number(m[2]), state: m[3] }; });
      assert(rows.some(row => row.pid === process.pid), "census includes this controller before measuring absence");
      const survivors = rows.filter(row => row.group === payload && !row.state.startsWith("Z"));
      const record = { kind, nativeSetup: true, actualRefusal: err.includes("STOP: sweep lock renewal failed"), nativeExit: exit.code, deadlineEnforced: out.includes("timed out after 2s"), liveCohort: survivors.length, cleaned: survivors.length === 0, payloadCompletedNormally: fs.existsSync(release) };
      fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record, null, 2)); facts.push(record);
      console.log("MEASUREMENT cleaner sweep-refusal " + JSON.stringify(record));
      assert.equal(exit.code, 1); assert.equal(exit.signal, null);
      assert(record.actualRefusal, "RENEWAL_REFUSAL_NOT_OBSERVED");
      // A known renewal error truthfully suppresses CLEAN/green; independently
      // observe the real deadline and native cohort instead of requiring CLEAN.
      assert(record.deadlineEnforced && record.cleaned, "RENEWAL_REFUSAL_DISABLED_CONTAINMENT");
      assert(!record.payloadCompletedNormally, "timed-out payload must not complete normally");
      console.log("PASS cleaner sweep-refusal: actual refusal retains native timeout; live cohort=0");
      return;
    }
    const claim = JSON.parse(fs.readFileSync(path.join(lock, marker), "utf8")); ownerPid = claim.pid;
    assert(Number.isInteger(ownerPid)); process.kill(ownerPid, 0);
    if (kind !== "supervisor" && kind !== "inherited") assert.equal(ownerPid, actor.child.pid, "wire holder is the original spawned actor");
    const identity = command(dir, ["ps", "-ww", "-p", String(ownerPid), "-o", "pid=,uid=,ppid=,lstart=,command="], env);
    assert.equal(identity.status, 0, identity.stderr); assert.equal(identity.stderr, "");
    assert(new RegExp(`^\\s*${ownerPid}\\s+${process.getuid()}\\s+`).test(identity.stdout), "native holder identity exists before measuring");
    if (kind === "supervisor" || kind === "inherited") assert.equal(Number(identity.stdout.trim().split(/\s+/)[2]), actor.child.pid, "supervised holder is the original gated child");
    owned ||= `${fs.statSync(lock).dev}:${fs.statSync(lock).ino}`;
    const waiter = command(dir, ["bun", after, "acquire", lock, String(process.pid), token], env); assert.equal(waiter.status, 75, waiter.stderr);
    const before = snapshot(state); assert.equal(Object.keys(before).length, 9, "3 lock, 3 host (two aliases), 3 FIFO records");
    const clock = await cutoff(dir, before);
    const receiptOffset = fs.existsSync(receipts) ? fs.statSync(receipts).size : 0;
    if (kind === "transition") {
      // A live waiter admission must renew the original holder, old aliases,
      // and preexisting FIFO tickets without changing their identities/bytes.
      if (hasRenewal) { const r = command(dir, ["bun", after, "acquire", lock, String(process.pid), token], env); assert.equal(r.status, 75, r.stderr); }
    } else if ((kind === "supervisor" && hasHeartbeat) || (["sweep", "inherited"].includes(kind) && sweep.includes("slice=60"))) {
      await until(() => fs.existsSync(receipts) && fs.statSync(receipts).size > receiptOffset, actor);
    }
    const renewed = Object.fromEntries(Object.keys(before).map(name => [name, fs.statSync(path.join(state, name)).mtimeMs]));
    const result = clean(dir, state, clock.reference);
    process.kill(ownerPid, 0);
    const identityAfter = command(dir, ["ps", "-ww", "-p", String(ownerPid), "-o", "pid=,uid=,ppid=,lstart=,command="], env);
    assert.equal(identityAfter.status, 0, identityAfter.stderr); assert.equal(identityAfter.stderr, "");
    assert.equal(identityAfter.stdout, identity.stdout, "same native PID/UID/parent/birth/command remains alive during cleaner");
    const survived = fs.existsSync(path.join(lock + ".host", anchor));
    const record = { kind, nativeSetup: true, ownerLiveDuringCleaner: true, ownerIdentitySha256: sha(identity.stdout), clock, selected: result, before, renewed, survived };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record, null, 2)); facts.push(record);
    assert(survived, `LIVE_HOST_RECORD_REMOVED ${kind}`);
    const afterClean = snapshot(state);
    for (const [name, row] of Object.entries(before)) { assert(afterClean[name], `LIVE_RECORD_REMOVED ${kind} ${name}`); assert.equal(afterClean[name].ino, row.ino); assert.equal(afterClean[name].sha, row.sha); }
    assert.equal(result.deleted.length, 0, "all preexisting holder/cache/live-waiter records survive");
    // Ownership still matters; a wrong token may not refresh the holder/FIFO.
    const bad = command(dir, ["bun", file, "refresh", lock, String(ownerPid), "f".repeat(32), owned], env);
    if (hasRenewal) { assert.equal(bad.status, 2); assert(bad.stderr.includes("cannot refresh a different lock owner")); }
    const now = snapshot(state); for (const name of Object.keys(before)) { assert.equal(now[name].sha, before[name].sha); assert.equal(now[name].ino, before[name].ino); }
  } finally {
    // Release only our own actor, never a PID discovered in another run.
    fs.writeFileSync(release, "release\n"); actor.child.stdin!.end("release\n");
    const exit = await actor.done; fs.writeFileSync(path.join(dir, "actor.exit.json"), JSON.stringify(exit));
    if (fs.existsSync(path.join(lock + ".host", anchor))) {
      if (kind === "transition") { const r = command(dir, ["bun", file, "release", lock, String(ownerPid), "a".repeat(32), owned], env); assert.equal(r.status, 0, r.stderr); }
      const r = command(dir, ["bun", file, "release", lock, String(process.pid), token, ""], env); assert.equal(r.status, 0, r.stderr);
      assert.equal(exit.code, kind === "sweep-refusal" ? 1 : 0, "healthy actor must complete natively"); assert.equal(exit.signal, null);
      if (kind === "sweep") assert(!fs.readFileSync(path.join(dir, "actor.stderr"), "utf8").includes("invalid timeout specification"));
    }
  }
  console.log(`PASS cleaner ${kind}: native find deleted=0; original live holder + two aliases + FIFO preserved; actor joined`);
}
async function missing() {
  const dir = path.join(root, "missing"); fs.mkdirSync(dir); const lock = path.join(dir, "host.lock");
  const r = command(dir, ["bun", helper, "acquire", lock, String(process.pid), token]); assert.equal(r.status, 0, r.stderr);
  const owned = r.stdout.trim(), file = path.join(lock + ".host", anchor); fs.unlinkSync(file);
  const before = snapshotWithoutAnchor();
  function snapshotWithoutAnchor() { return [lock, lock + ".queue", lock + ".host"].flatMap(d => fs.readdirSync(d).map(n => { const f = path.join(d, n); return [f, fs.statSync(f).ino, sha(fs.readFileSync(f))]; })); }
  const refused = command(dir, ["bun", helper, "acquire", lock, String(process.pid), token]);
  assert.equal(refused.status, 2); assert(refused.stderr.includes(file) && refused.stderr.includes("trusted same-machine backup") && refused.stderr.includes("Do not delete a live lock"), "MISSING_HOST_REPAIR_NOT_EXPLAINED");
  assert.deepEqual(snapshotWithoutAnchor(), before); assert(!fs.existsSync(file), "never authenticate leftover aliases by silently recreating the anchor");
  const probe = path.join(dir, "legacy.ts"); fs.writeFileSync(probe, `import fs from "node:fs"; import {legacyHostnameMatches, stableHostIdentity} from ${JSON.stringify(helper)}; const identity=stableHostIdentity(); if(identity.source==="hostname") throw new Error("INCOMPLETE: readonly native hardware identity unavailable"); fs.writeFileSync(${JSON.stringify(path.join(dir, "legacy-identity.json"))}, JSON.stringify({source:identity.source})); console.log(legacyHostnameMatches("unobserved-host"));`);
  const legacy = command(dir, ["bun", probe], { ...process.env, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock });
  assert.equal(legacy.status, 0, "READONLY_MISSING_CACHE_MUST_REMAIN_NO_PROOF"); assert.equal(legacy.stdout, "false\n");
  assert.deepEqual(snapshotWithoutAnchor(), before);
  console.log("PASS cleaner missing: exact anchor + trusted restore named; readonly legacy returns no proof; holder/FIFO unchanged");
}
let failures = 0;
for (const kind of ["transition", "supervisor", "sweep", "inherited", "sweep-refusal"] as const) {
  try { await preservation(kind); } catch (e: any) { failures++; console.error("FAIL " + e.message); }
}
try { await missing(); } catch (e: any) { failures++; console.error("FAIL " + e.message); }
for (const forbidden of ["/tmp/wheelhouse-selftest-sweep.lock", "/private/tmp/wheelhouse-selftest-sweep.lock", "/tmp/wheelhouse-selftest-sweep.lock.host"]) {
  const r = command(root, ["bun", import.meta.path, forbidden, helper, runner, "--check-root"]);
  if (r.status !== 2 || !r.stderr.includes("TEST_SUBJECT_OUTSIDE_MARKED_FIXTURE")) { failures++; console.error("FAIL LIVE_PATH_NOT_REFUSED"); }
}
for (const actor of actors) {
  if (!actor.closed()) { if (actor.release) fs.writeFileSync(actor.release, "release\n"); actor.child.stdin!.end("release\n"); }
  await actor.done;
}
assert(actors.every(a => a.closed()), "every test actor joined");
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ failures, actorsJoined: actors.length, facts }, null, 2));
console.log(`sweep-cleaner: ${failures ? "FAIL" : "PASS"} (${failures} failures; ${actors.length} actors joined)`);
process.exitCode = failures ? 1 : 0;
