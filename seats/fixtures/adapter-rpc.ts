import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import assert from "node:assert/strict";

const root = path.resolve(process.argv[2]);
const runtime = path.join(root, "runtime/seats");
const peerFile = path.join(import.meta.dir, "adapter-rpc-peer.mjs");
const clockFile = path.join(import.meta.dir, "adapter-rpc-clock.ts");
const cases = ["held-reply", "dead-peer", "closed-pipe", "backpressure", "partial-eof"];
const results: any[] = [];

function fileSignal(file: string) {
  let resolve: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const watcher = fs.watch(path.dirname(file), () => { if (fs.existsSync(file)) resolve(); });
  if (fs.existsSync(file)) resolve!();
  return { promise, close: () => watcher.close() };
}

for (const kind of cases) {
  const dir = path.join(root, kind), project = path.join(dir, "project");
  const account = path.join(dir, "home/account"), bin = path.join(dir, "bin");
  const clock = path.join(dir, "clock"), token = crypto.randomUUID();
  for (const d of [account, bin, clock, path.join(project, "contracts")]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(runtime, path.join(project, "seats"), { recursive: true });
  fs.writeFileSync(path.join(project, "contracts/REVIEWER.md"), "Owned RPC fixture reviewer.\n");
  fs.writeFileSync(path.join(account, "auth.json"), '{"fixture":"not-a-credential"}\n');
  fs.writeFileSync(path.join(project, "seats/seats.json"), JSON.stringify({ seats: {
    "reviewer-1": { role: "reviewer", harness: "pi", worktree: false, model: "fixture", account: { dir: account } },
  } }));
  fs.writeFileSync(path.join(bin, "pi"), '#!/usr/bin/env bash\nexec node "$WHEELHOUSE_RPC_FIXTURE_PEER" "$@"\n', { mode: 0o755 });
  // Relative Unix socket names avoid Darwin's sockaddr_un pathname limit;
  // the actual socket and all state still live beneath this bead's fixture.
  process.chdir(dir);
  const events: any[] = [], waiters: any[] = [], peers = new Map<number, any>();
  function note(message: any) {
    events.push(message);
    for (const waiter of [...waiters]) if (waiter.type === message.type) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }
  const next = (type: string): Promise<any> => new Promise(resolve => waiters.push({ type, resolve }));
  const server = net.createServer(socket => {
    let buffer = "", peer: any;
    socket.on("data", data => {
      buffer += data;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (message.type === "ready") {
          assert.equal(message.token, token);
          assert.equal(message.cwd, project);
          assert.equal(message.uid, process.getuid!());
          peer = { ...message, socket, closed: false };
          peers.set(message.pid, peer);
        }
        if (message.type === "term") {
          assert.equal(message.pid, peer.pid);
          socket.write('{"type":"exit"}\n');
        }
        note(message);
      }
    });
    socket.on("close", () => { if (peer) { peer.closed = true; note({ type: "peer-closed", pid: peer.pid }); } });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen("control.sock", resolve); });
  const env = {
    ...process.env, HOME: path.join(dir, "home"), PATH: `${bin}:${process.env.PATH}`,
    WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CLEANUP: "0",
    WHEELHOUSE_RPC_FIXTURE_SOCKET: "../control.sock", WHEELHOUSE_RPC_FIXTURE_TOKEN: token,
    WHEELHOUSE_RPC_FIXTURE_PEER: peerFile,
    WHEELHOUSE_RPC_CLOCK_DIR: clock,
  };
  // No low budget override: the logical clock crosses the original defaults.
  delete env.WHEELHOUSE_RPC_TIMEOUT_MS;
  delete env.WHEELHOUSE_PROMPT_ACK_MS;
  delete env.WHEELHOUSE_FIFO_WRITE_MS;
  const invocations: any[] = [];
  function cli(args: string[], preload = false) {
    const command = ["bun", ...(preload ? ["--preload", clockFile] : []), path.join(project, "seats/adapter.ts"), ...args];
    const child = Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(([rc, out, err]) => {
        const result = { args, rc, out, err };
        invocations.push(result);
        return result;
      });
    return { child, finished };
  }
  let signal: ReturnType<typeof fileSignal> | undefined;
  let failure: string | undefined;
  try {
    const spawned = await cli(["spawn", "reviewer-1"]).finished;
    assert.equal(spawned.rc, 0, spawned.err);
    const stateFile = path.join(project, "seats/state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const pid = state.seats["reviewer-1"].pid, peer = peers.get(pid);
    assert.ok(peer, "recorded pid must be the nonce-authenticated peer");
    state.seats["reviewer-1"].lastBead = "old-bead";
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const send = (type: string) => peer.socket.write(JSON.stringify({ type }) + "\n");
    const waitingForDrain = kind === "backpressure" || kind === "partial-eof";
    let barrier = next(waitingForDrain ? "pause-armed" : "holding");
    send(waitingForDrain ? "pause-after-state" : "hold");
    await barrier;
    barrier = next(waitingForDrain ? "input-paused" : "held");
    const request = cli(["dispatch", "reviewer-1", "new-bead", waitingForDrain ? "H".repeat(128 * 1024) : kind], true);
    const expectBeforeExit = async (event: Promise<any>) => Promise.race([
      event,
      request.finished.then(result => { throw new Error(`adapter exited before barrier: ${JSON.stringify({ rc: result.rc, out: result.out, err: result.err })}`); }),
    ]);
    await expectBeforeExit(barrier);
    assert.equal(peer.closed, false);
    assert.doesNotThrow(() => process.kill(pid, 0));
    if (kind === "held-reply" || waitingForDrain) {
      signal = fileSignal(path.join(clock, "progress"));
      fs.writeFileSync(path.join(clock, "observe"), "report progress AFTER this barrier\n");
      if (kind === "held-reply") fs.writeFileSync(path.join(clock, "advance"), "60001 logical ms\n");
      await expectBeforeExit(signal.promise);
      const progress = JSON.parse(fs.readFileSync(path.join(clock, "progress"), "utf8"));
      assert.match(progress.message, /WAIT: seat "reviewer-1" \(pid \d+\)/);
      assert.match(progress.message, /process alive/);
      if (kind === "held-reply") {
        assert.equal(progress.virtualAdvanceMs, 60001);
        assert.match(progress.message, /waiting for get_state response/);
      } else {
        assert.match(progress.message, /writing prompt, [1-9]\d*\/\d+ bytes/);
      }
      barrier = next(kind === "partial-eof" ? "pipe-closed" : waitingForDrain ? "input-resumed" : "released");
      send(kind === "partial-eof" ? "close-input" : waitingForDrain ? "resume-input" : "release");
      await barrier;
    } else {
      barrier = next(kind === "dead-peer" ? "peer-closed" : "pipe-closed");
      send(kind === "dead-peer" ? "exit" : "close-input");
      await barrier;
    }
    const result = await request.finished;
    if (kind === "held-reply" || kind === "backpressure") {
      assert.equal(result.rc, 0, result.err);
      assert.match(result.out, /dispatched new-bead to reviewer-1/);
      const after = JSON.parse(fs.readFileSync(stateFile, "utf8")).seats["reviewer-1"];
      assert.equal(after.pid, pid, "slow response/drain must not restart a live seat");
      assert.equal(after.sessionFile, state.seats["reviewer-1"].sessionFile);
      assert.equal(after.lastBead, "new-bead");
      assert.doesNotMatch(result.out + result.err, /timed out|WEDGED/);
    } else {
      assert.notEqual(result.rc, 0);
      assert.ok(result.err.includes(`seat "reviewer-1" (pid ${pid})`), result.err);
      assert.match(result.err, /process died|pipe closed \(EOF\)/);
      assert.doesNotMatch(result.err, /timed out/);
      if (kind !== "dead-peer") {
        assert.equal(peer.closed, false, "EOF, not process death, must decide this outcome");
        assert.doesNotThrow(() => process.kill(pid, 0));
      }
      if (kind === "partial-eof") assert.match(result.err, /partial FIFO write\?[^\n]*wrote [1-9]\d*\/\d+ bytes/);
      assert.equal(fs.existsSync(path.join(clock, "advance")), false, "death/EOF must fail without advancing the deadline clock");
    }
    console.log(`PASS ${kind}: ${kind === "held-reply" ? "held beyond old 20s/60s logical budgets; progress then reply; same pid/session" : kind === "backpressure" ? "full pipe waits for drain with progress, then delivers" : "process/EOF signal fails nonzero with seat and pid, without a deadline"}`);
  } catch (error: any) {
    failure = error.stack ?? String(error);
    console.log(`FAIL ${kind}: ${error.message ?? error}`);
  } finally {
    signal?.close();
    for (const peer of peers.values()) if (!peer.closed) peer.socket.write('{"type":"exit"}\n');
    await new Promise<void>(resolve => server.close(() => resolve()));
    const result = { kind, failure: failure ?? null, events, invocations };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
    results.push(result);
  }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2) + "\n");
const failures = results.filter(r => r.failure).length;
console.log(`adapter-rpc.selftest: ${cases.length} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
