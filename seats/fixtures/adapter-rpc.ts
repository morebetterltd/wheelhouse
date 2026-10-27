import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import assert from "node:assert/strict";
import conditionWait from './wait-for-condition.cjs';
const { waitForCondition } = conditionWait;

const root = path.resolve(process.argv[2]);
const runtime = path.join(root, "runtime/seats");
const peerFile = path.join(import.meta.dir, "adapter-rpc-peer.mjs");
const clockFile = path.join(import.meta.dir, "adapter-rpc-clock.ts");
const caseNames = ["held-reply", "swallowed-reply", "unbudgeted-reply", "working-reply", "steer-budget", "resume-budget", "dead-peer", "closed-pipe", "backpressure", "partial-eof", "missing-log", "lost-log", "replaced-log"];
// Optional exact-case diagnosis; the unfiltered full sweep runs every case.
const wanted = process.env.WHEELHOUSE_TEST_RPC_CASES?.split(",").map(s => s.trim());
if (wanted) assert(wanted.every(name => caseNames.includes(name)), "unknown RPC case selection");
const cases = caseNames.filter(name => !wanted || wanted.includes(name));
assert(cases.length > 0, "RPC selection must exercise a case");
const results: any[] = [];
const evidence = process.env.WHEELHOUSE_RPC_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });

function fileSignal(file: string, ready = () => fs.existsSync(file)) {
  return waitForCondition({ site: 'adapter-rpc.fileSignal', paths: [path.dirname(file)], predicate: ready });
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
  delete env.WHEELHOUSE_RPC_GIVE_UP_AFTER_MS;
  if (['held-reply','swallowed-reply','unbudgeted-reply','working-reply','steer-budget','resume-budget'].includes(kind)) env.WHEELHOUSE_RPC_VIRTUAL_CLOCK = '1';
  const invocations: any[] = [];
  function cli(args: string[], preload = false, extra: Record<string,string> = {}) {
    const command = ["bun", ...(preload ? ["--preload", clockFile] : []), path.join(project, "seats/adapter.ts"), ...args];
    const child = Bun.spawn(command, { env: {...env,...extra}, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    const log = state.seats["reviewer-1"].log;
    const originalLog = fs.statSync(log, { bigint: true });
    const assertSourceLost = async (request: ReturnType<typeof cli>, forbiddenEvent: Promise<any>) => {
      const outcome = await Promise.race([
        request.finished.then(result => ({ result })),
        forbiddenEvent.then(event => ({ event })),
      ]);
      if ("event" in outcome) {
        // An actual request on a missing established channel, or an explicit
        // WAIT after loss, proves the guard is absent. No elapsed-time verdict:
        // cancel only this directly owned client AFTER recording that event.
        const current = fs.existsSync(log) ? fs.statSync(log, { bigint: true }) : null;
        if (kind !== "missing-log") assert(outcome.event.observations >= 2, "one in-flight pre-loss snapshot may still report WAIT");
        const proof = { kind, event: outcome.event, pid, log, original: `${originalLog.dev}:${originalLog.ino}`, current: current ? `${current.dev}:${current.ino}` : null };
        assert(current === null || proof.current !== proof.original);
        assert.equal(peer.closed, false);
        assert.doesNotThrow(() => process.kill(pid, 0));
        fs.writeFileSync(path.join(dir, "source-loss-before-client-cancel.json"), JSON.stringify(proof));
        if (evidence) {
          fs.mkdirSync(path.join(evidence, kind), { recursive: true });
          fs.writeFileSync(path.join(evidence, kind, "source-loss-before-client-cancel.json"), JSON.stringify(proof));
        }
        request.child.kill("SIGTERM");
        await request.finished;
        throw new Error(`continued RPC after response source loss: ${kind}; observed ${JSON.stringify(outcome.event)} before owned-client cancellation`);
      }
      const result = outcome.result;
      assert.notEqual(result.rc, 0, "lost response source must refuse");
      assert.match(result.err, /response source lost/);
      assert(result.err.includes(`seat "reviewer-1" (pid ${pid})`), result.err);
      assert(result.err.includes(log), result.err);
      assert.match(result.err, kind === "replaced-log" ? /inode changed/ : /path missing/);
      assert.doesNotMatch(result.err, /timed out|process died/);
      assert.equal(peer.closed, false, "loss is unobservable, not proof of death");
      assert.doesNotThrow(() => process.kill(pid, 0));
      assert(!events.some(e => e.type === "term"), "refusal must not signal the seat");
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), state, "PID/session/bead context remains unchanged");
      assert.equal(fs.existsSync(path.join(clock, "advance")), false);
      console.log(`PASS ${kind}: response source lost names seat/pid/path; same live unsignalled peer and unchanged PID/session/bead context`);
    };
    if (kind === "missing-log") {
      const holding = next("holding"); send("hold"); await holding;
      fs.unlinkSync(log);
      const forbidden = next("held");
      await assertSourceLost(cli(["dispatch", "reviewer-1", "new-bead", kind], true), forbidden);
      continue;
    }
    if(kind==='resume-budget') {
      let barrier=next('peer-closed');send('exit');await barrier;
      const ready=next('ready'),held=next('held');
      const request=cli(['resume','reviewer-1'],true,{WHEELHOUSE_RPC_GIVE_UP_AFTER_MS:'40000',WHEELHOUSE_RPC_FIXTURE_START_HELD:'1'});
      const beforeExit=(event:Promise<any>)=>Promise.race([event,request.finished.then(result=>{throw Error('resume exited before barrier: '+JSON.stringify(result));})]);
      const fresh=await beforeExit(ready),command=await beforeExit(held);
      const armed=fileSignal(path.join(clock,'armed'));try{await beforeExit(armed.promise);}finally{armed.close();}
      fs.writeFileSync(path.join(clock,'observe'),'readiness budget control\n');
      const forbidden=fileSignal(path.join(clock,'progress'));
      fs.writeFileSync(path.join(clock,'step'),'60001');
      try{
        const outcome=await Promise.race([request.finished.then(result=>({result})),forbidden.promise.then(()=>({continued:true}))]);
        if('continued' in outcome){request.child.kill('SIGTERM');await request.finished;throw Error('resume budget ignored: WAIT before owned-client cancellation');}
        assert.equal(outcome.result.rc,3,outcome.result.err);assert.match(outcome.result.err,/STOP: seat "reviewer-1" .*has not answered get_state/);
        const after=JSON.parse(fs.readFileSync(stateFile,'utf8')).seats['reviewer-1'];
        assert.equal(after.pid,fresh.pid);assert.notEqual(after.pid,pid);assert.equal(after.sessionFile,state.seats['reviewer-1'].sessionFile);
        assert.doesNotThrow(()=>process.kill(fresh.pid,0));assert.equal(peers.get(fresh.pid).closed,false);
        assert(!events.some(event=>event.type==='term'||event.type==='signal'),'readiness refusal must bypass launch-only termination');
        const notes=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='wheelhouse_note'&&row.message.startsWith('rpc unanswered:'));
        assert.equal(notes.length,1);assert.equal(notes[0].rpc.id,command.id);
      }finally{forbidden.close();}
      console.log('PASS resume-budget: readiness exit 3; fresh pid and known session retained; no launch-only signal');
      continue;
    }
    if (['held-reply','swallowed-reply','unbudgeted-reply','working-reply','steer-budget'].includes(kind)) {
      const budgeted=kind==='swallowed-reply'||kind==='steer-budget';
      const notes = () => fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='wheelhouse_note'&&/^rpc (unanswered|answered late):/.test(row.message));
      const assertFacts = (message:string) => {
        assert.match(message,/seat "reviewer-1" \(pid \d+\) has not answered get_state across \d+ reports/);
        assert.match(message,/command taken from FIFO \(unread bytes 0, non-consuming descriptor\)|FIFO unread bytes unknown/);
        assert.match(message,/CPU time delta \d+ ms; seat log byte size \d+/);
        assert(message.includes(`fd 0: FIFO held by pid ${pid}`),message);
        assert(message.includes(`fd 1: pipe to seat-event-log held by pid ${pid}`),message);
        assert(message.includes('Recovery: bun seats/adapter.ts stop reviewer-1 (session kept), then bun seats/adapter.ts dispatch reviewer-1'),message);
        assert(message.includes('bun seats/adapter.ts resume reviewer-1'),message);
      };
      const rounds = kind==='held-reply'?2:1;
      for(let round=0;round<rounds;round++) {
        fs.writeFileSync(stateFile,JSON.stringify(state)); // force the same owned cross-bead preflight each round
        for(const file of ['progress','observe','armed','step','history.jsonl']) fs.rmSync(path.join(clock,file),{force:true});
        let barrier=next('holding');send('hold');await barrier;
        barrier=next('held');
        const request=cli(kind==='steer-budget'?['steer','reviewer-1','owned fixture steer']:['dispatch','reviewer-1','new-bead',kind],true,budgeted?{WHEELHOUSE_RPC_GIVE_UP_AFTER_MS:'40000'}:{});
        const beforeExit=(event:Promise<any>)=>Promise.race([event,request.finished.then(result=>{throw Error('client exited before held barrier: '+JSON.stringify(result));})]);
        const held=await beforeExit(barrier);
        const armed=fileSignal(path.join(clock,'armed'));try{await beforeExit(armed.promise);}finally{armed.close();}
        fs.writeFileSync(path.join(clock,'observe'),'native WAIT observation\n');
        let logical=0,observations=0,named=false;
        async function tick(nextLogical=logical+5001) {
          const wait=fileSignal(path.join(clock,'progress'),()=>fs.existsSync(path.join(clock,'progress'))&&JSON.parse(fs.readFileSync(path.join(clock,'progress'),'utf8')).observations>observations);
          logical=nextLogical;fs.writeFileSync(path.join(clock,'step'),String(logical));
          try{await beforeExit(wait.promise);}finally{wait.close();}
          const progress=JSON.parse(fs.readFileSync(path.join(clock,'progress'),'utf8'));observations=progress.observations;
          if(observations<6)assert(!progress.message.includes('has not answered'),progress.message);
          if(progress.message.includes('has not answered')){assertFacts(progress.message);named=true;}
          else assert.match(progress.message,/pipe open; process alive; waiting for a signal, not a timeout/);
          return progress;
        }
        if(kind==='working-reply') {
          for(let i=0;i<36;i++) {
            if(i<12){const burned=next('burned');send('burn');await burned;}
            else fs.appendFileSync(i<24?log:log.replace(/\.jsonl$/,'.stderr.log'),i<24?'{}\n':'fixture stderr progress\n');
            const progress=await tick();assert(!progress.message.includes('has not answered'),'working seat must not be named');
          }
          assert.equal(named,false);assert.equal(notes().length,0);
        } else if(budgeted) {
          for(let i=0;i<6;i++)await tick();
        } else {
          for(let i=0;i<20&&!named;i++)await tick();
          assert(named,'six consecutive no-progress reports must name the seat');
          await tick();await tick(); // no duplicate note while still unanswered
          if(logical<60001)await tick(60001);
          assert(logical>60000,'unset-budget control must pass old 20s/60s budgets');
        }
        if(budgeted) {
          const forbidden=fileSignal(path.join(clock,'progress'),()=>JSON.parse(fs.readFileSync(path.join(clock,'progress'),'utf8')).observations>observations);
          fs.writeFileSync(path.join(clock,'step'),'60001');
          try {
            const outcome=await Promise.race([request.finished.then(result=>({result})),forbidden.promise.then(()=>({continued:true}))]);
            if('continued' in outcome){request.child.kill('SIGTERM');await request.finished;throw Error('budget ignored: native WAIT after 60001ms, before owned-client cancellation');}
            assert.equal(outcome.result.rc,3,outcome.result.err);assert.match(outcome.result.err,/^STOP: seat "reviewer-1" \(pid \d+\) has not answered get_state/m);assertFacts(outcome.result.err);
            assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),state,'budget leaves seat state untouched');
            assert.equal(peer.closed,false);assert.doesNotThrow(()=>process.kill(pid,0));
            const unanswered=notes();assert.equal(unanswered.length,1);assert.equal(unanswered[0].rpc.id,held.id);
          }finally{forbidden.close();}
        } else {
          barrier=next('released');send('release');await barrier;
          const result=await request.finished;
          assert.equal(result.rc,0,result.err);assert.match(result.out,/dispatched new-bead to reviewer-1/);
          assert.doesNotMatch(result.out+result.err,/timed out|WEDGED/);
          const after=JSON.parse(fs.readFileSync(stateFile,'utf8')).seats['reviewer-1'];
          assert.equal(after.pid,pid);assert.equal(after.sessionFile,state.seats['reviewer-1'].sessionFile);assert.equal(after.lastBead,'new-bead');
          if(kind!=='working-reply') {
            const pair=notes().filter(row=>row.rpc.id===held.id);assert.equal(pair.length,2);
            assert(pair[0].message.startsWith('rpc unanswered:'));assert(pair[1].message.startsWith('rpc answered late:'));
            assert.equal(pair[0].rpc.command,'get_state');assert.equal(pair[0].rpc.noProgressReports,6);assert.equal(pair[0].rpc.cpuDeltaMs,0);
            assert.equal(typeof pair[0].rpc.logBytes,'number');assert('fifoUnreadBytes' in pair[0].rpc);assert(pair[0].rpc.fd0.includes(String(pid)));assert(pair[0].rpc.fd1.includes(String(pid)));
            assert(pair[1].rpc.reports>=pair[0].rpc.reports);assertFacts(result.err);
          }
        }
        assert(!events.some(event=>event.type==='term'||event.type==='signal'),'diagnosis/budget never signals the seat');
      }
      if(kind==='held-reply') {assert.equal(notes().length,4);assert.equal(new Set(notes().map(row=>row.rpc.id)).size,2);}
      console.log(`PASS ${kind}: controlled WAIT clock; facts/recovery and once-only note pairs; same live unsignalled pid/session; budget policy verified`);
      continue;
    }
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
    if (kind === "lost-log" || kind === "replaced-log") {
      const progressFile = path.join(clock, "progress");
      // One loop may have checked the old file just before loss and report
      // afterwards. Only a second post-enable WAIT proves another loop failed
      // to refuse loss. This is a native event fence, not an elapsed budget.
      signal = fileSignal(progressFile, () => fs.existsSync(progressFile) && JSON.parse(fs.readFileSync(progressFile, "utf8")).observations >= 2);
      if (kind === "lost-log") fs.unlinkSync(log);
      else {
        const replacement = log + ".replacement";
        fs.writeFileSync(replacement, "");
        fs.renameSync(replacement, log); // atomic identity change, no missing-path gap
        assert.notEqual(fs.statSync(log, { bigint: true }).ino, originalLog.ino);
      }
      // Enable observation only AFTER loss; a valid pre-loss WAIT is not a
      // counterexample, even if the controller was descheduled for a while.
      fs.writeFileSync(path.join(clock, "observe"), "report actual WAIT after loss, never a time budget\n");
      await assertSourceLost(request, signal.promise.then(() => JSON.parse(fs.readFileSync(path.join(clock, "progress"), "utf8"))));
      continue;
    }
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
    if (evidence) {
      fs.mkdirSync(path.join(evidence, kind), { recursive: true });
      fs.writeFileSync(path.join(evidence, kind, "result.json"), JSON.stringify(result, null, 2) + "\n");
    }
    results.push(result);
  }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2) + "\n");
if (evidence) fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
const failures = results.filter(r => r.failure).length;
console.log(`adapter-rpc.selftest: ${cases.length} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
