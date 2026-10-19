// Real bd, isolated HOME/graphs, and a loopback-only endpoint. No fake sender,
// external telemetry upload, process signals, or production metrics changes.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
const [root, library, bd, lockHelper, runtime] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
for (const file of [library, bd, lockHelper]) assert(fs.statSync(file).isFile());
let failed = 0;
const script = path.join(root, "install.sh");
fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
. "$METRICS_LIB"
if [ "$METRICS_MODE" = fixture ]; then
  selftest_disable_bd_metrics "$METRICS_CASE" || exit 2
  install="$METRICS_CASE/install"
  mkdir -p "$install"
  git -C "$install" init -q -b main
  test -d "$install/.git" || exit 2
  (cd "$install" && bd init --non-interactive --skip-agents -p metrics)
  (cd "$install" && bd list --json)
else
  eval "$(selftest_scratch_graph "$METRICS_CASE/graph")"
  test -d "$METRICS_CASE/graph/.git" || exit 2
  (cd "$METRICS_CASE/graph" && bd list --json)
fi
printf 'METRICS_INSTALL_DONE %s\\n' "$METRICS_MODE"
`);
const modes = process.env.WHEELHOUSE_TEST_METRICS_REVIEW_ONLY === "1" ? ["review-sweep"] : ["fixture", "scratch-graph", "review-sweep"];
for (const mode of modes) {
  const dir = path.join(root, mode); fs.mkdirSync(dir);
  const raw = path.join(dir, "raw"); fs.mkdirSync(raw); let sequence = 0;
  function command(bin: string, args: string[], cwd = dir) {
    const r = spawnSync(bin, args, { cwd, encoding: "utf8" });
    const record = { bin, args, cwd, code: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    fs.writeFileSync(path.join(raw, String(++sequence) + ".json"), JSON.stringify(record, null, 2));
    if (r.error || r.signal) throw new Error(`${bin} incomplete: ${r.error ?? r.signal}`);
    return record;
  }
  const requests: { method?: string; path?: string; bytes: number }[] = [], pending: http.ServerResponse[] = [];
  let released = false;
  const respond = (res: http.ServerResponse) => { res.statusCode = 204; res.setHeader("Connection", "close"); res.end(); };
  const server = http.createServer((req, res) => {
    let bytes = 0; req.on("data", b => bytes += b.length);
    req.on("end", () => { requests.push({ method: req.method, path: req.url?.split("?")[0], bytes }); if (released) respond(res); else pending.push(res); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, endpoint = `http://127.0.0.1:${port}/mp/collect`;
  const home = path.join(dir, "pre-setup-home"); fs.mkdirSync(home);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(BD_|BEADS_|DOLT_|GIT_)/.test(key) || key === "DO_NOT_TRACK") delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CEILING_DIRECTORIES: root + ":" + path.dirname(root), BEADS_ACTOR: "wheelhouse-selftest", BEADS_METRICS_ENDPOINT: endpoint, METRICS_LIB: library, METRICS_CASE: dir, METRICS_MODE: mode, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: lockHelper });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL!, "[user]\n name = fixture\n email = fixture@local\n[init]\n defaultBranch = main\n[commit]\n gpgsign = false\n");
  let driver = script;
  const ready = path.join(dir, "setup-ready"), release = path.join(dir, "release.fifo");
  if (mode === "review-sweep") {
    assert(runtime && fs.statSync(path.join(runtime, "verify.ts")).isFile());
    const project = path.join(dir, "project"); fs.mkdirSync(project);
    fs.cpSync(runtime, path.join(project, "seats"), { recursive: true });
    const made = command("mkfifo", [release]); assert.equal(made.code, 0, made.stderr);
    // The outer canonical host lock is held. This tiny fixture payload is not
    // a second full product sweep: stop after the real verifier setup completes.
    fs.writeFileSync(path.join(project, "seats/metrics-fixture.selftest.sh"), '#!/usr/bin/env bash\nset -eu\nbd list --json >/dev/null\nprintf "%s\\n" "$PWD" > "$METRICS_CASE/review-cwd"\nprintf "%s\\n" "$HOME" > "$METRICS_CASE/review-home"\nprintf "ready\\n" > "$METRICS_CASE/setup-ready"\nread -r release < "$METRICS_CASE/release.fifo"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(project, "seats/selftest-sweep.sh"), '#!/usr/bin/env bash\nset -eu\nexec bash "$(dirname "$0")/metrics-fixture.selftest.sh"\n', { mode: 0o700 });
    for (const args of [["init", "-q", "-b", "main"], ["add", "seats"], ["-c", "user.name=fixture", "-c", "user.email=fixture@local", "-c", "commit.gpgsign=false", "commit", "-qm", "review metrics fixture"]]) {
      const r = command("git", args, project); assert.equal(r.code, 0, r.stderr);
    }
    assert.equal(fs.realpathSync(command("git", ["rev-parse", "--show-toplevel"], project).stdout.trim()), fs.realpathSync(project));
    const tip = command("git", ["rev-parse", "HEAD"], project).stdout.trim();
    driver = path.join(dir, "review-driver.ts");
    fs.writeFileSync(driver, `import {runDispatcherFullSweep} from ${JSON.stringify(path.join(project, "seats/verify.ts"))};\nconst r=await runDispatcherFullSweep(${JSON.stringify(project)},${JSON.stringify(tip)},${JSON.stringify(bd)},process.env.PATH!);\nconsole.log("REVIEW_SETUP_RESULT "+JSON.stringify(r));\nprocess.exitCode=r.rc===0?0:1;\n`);
    env.TMPDIR = path.join(dir, "tmp"); fs.mkdirSync(env.TMPDIR);
  }
  function senders() {
    const ps = command("ps", ["axww", "-o", "pid=,ppid=,uid=,command="]); assert.equal(ps.code, 0, ps.stderr);
    // p/c/n and whitespace-padded ps fields come from the native capture on
    // m3xm, not a guessed 'no holders' fixture. Socket membership also catches
    // an uploader that a future bd version moves to a neutral cwd.
    const sockets = command("lsof", ["-nP", `-iTCP:${port}`, "-Fpcn"]);
    assert([0, 1].includes(sockets.code!), sockets.stderr);
    const connected = new Set(sockets.stdout.split("\n").filter(l => /^p\d+$/.test(l)).map(l => Number(l.slice(1))));
    const found = [];
    for (const line of ps.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!m || Number(m[3]) !== process.getuid!() || !m[4].endsWith(" send-metrics")) continue;
      // Accept a forwarding bd wrapper: os.Executable() names the real binary
      // in the spawned child, not necessarily the caller's PATH entry.
      const executable = m[4].slice(0, -" send-metrics".length);
      try { if (!fs.statSync(executable).isFile()) continue; } catch { continue; }
      const cwd = command("lsof", ["-a", "-p", m[1], "-d", "cwd", "-Fpn"]);
      const physical = cwd.stdout.split("\n").find(l => l.startsWith("n"))?.slice(1);
      const ownsCwd = physical === dir || physical?.startsWith(dir + path.sep);
      if (!ownsCwd && !connected.has(Number(m[1]))) continue;
      found.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), argv: m[4], cwd: physical, psLine: line, cwdProbe: cwd, endpointSocket: connected.has(Number(m[1])) });
    }
    return { found, sockets };
  }
  let beforeCleanup: ReturnType<typeof senders> | undefined, ended = false;
  let stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false;
  let joined: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    assert.equal(senders().found.length, 0, "fresh fixture subject has no existing sender");
    const child = spawn(mode === "review-sweep" ? "bun" : "bash", [driver], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
    child.stdout.on("end", () => stdoutEOF = true); child.stderr.on("end", () => stderrEOF = true);
    joined = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { ended = true; resolve({ code, signal }); }); });
    let native: Awaited<typeof joined> | undefined;
    if (mode === "review-sweep") {
      const limit = performance.now() + 60000; // incomplete setup guard, not absence proof
      while (!fs.existsSync(ready)) {
        if (ended) throw new Error("review exited before setup barrier: " + stderr + stdout);
        if (performance.now() > limit) throw new Error("INCOMPLETE review setup barrier");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(!ended, "review setup must still exist when measured, before teardown");
      assert.equal(fs.readFileSync(path.join(dir, "review-home"), "utf8").trim(), path.join(fs.readFileSync(path.join(dir, "review-cwd"), "utf8").trim(), ".wheelhouse-sweep-graph/home"));
      assert(!fs.existsSync(path.join(home, ".config/bd")), "do not write bd metrics configuration into inherited HOME");
    } else {
      native = await joined;
      assert.equal(native.code, 0, stderr); assert.equal(native.signal, null); assert(stdoutEOF && stderrEOF); assert(stdout.includes("METRICS_INSTALL_DONE " + mode));
    }
    const install = mode === "review-sweep" ? fs.readFileSync(path.join(dir, "review-cwd"), "utf8").trim() : path.join(dir, mode === "fixture" ? "install" : "graph");
    assert(fs.statSync(path.join(install, ".beads")).isDirectory(), "actual fixture graph was created before measuring survivors");
    assert.equal(fs.realpathSync(command("git", ["rev-parse", "--show-toplevel"], install).stdout.trim()), fs.realpathSync(install));
    beforeCleanup = senders();
    const record = { mode, install, endpoint, setupBarrierReached: mode === "review-sweep", parent: { ...native, stillRunning: !ended, stdout, stderr, stdoutEOF, stderrEOF }, survivors: beforeCleanup.found, sockets: beforeCleanup.sockets, requests: [...requests], measuredBeforeCleanup: true };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record, null, 2));
    console.log("MEASUREMENT " + JSON.stringify(record));
    const ok = beforeCleanup.found.length === 0 && requests.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"} bd metrics: ${mode} leaves no send-metrics after actual install`); if (!ok) failed++;
  } finally {
    // Let only our local endpoint's real uploads complete. No broad pkill or
    // signal, and cleanup never turns a measured survivor into an earlier pass.
    released = true; for (const res of pending) respond(res);
    server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (;;) { const after = senders(); if (!after.found.length) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    if (mode === "review-sweep" && fs.existsSync(ready)) fs.writeFileSync(release, "release\n");
    const native = joined ? await joined : undefined;
    const joinedRecord = { mode, localEndpointClosed: true, remainingOwnedSenders: 0, signalsSent: false, beforeCount: beforeCleanup?.found.length, parent: { ...native, stdoutEOF, stderrEOF, stdout, stderr } };
    fs.writeFileSync(path.join(dir, "joined.json"), JSON.stringify(joinedRecord, null, 2));
    console.log("CLEANUP " + JSON.stringify(joinedRecord));
    if (native) { assert.equal(native.code, 0, stderr + stdout); assert.equal(native.signal, null); assert(stdoutEOF && stderrEOF); }
  }
}
console.log(`bd metrics regression: ${modes.length} native setup legs, ${failed} failures`);
process.exitCode = failed ? 1 : 0;
