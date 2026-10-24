import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const root = process.argv[2], seats = path.join(root, "seats"), bin = path.join(root, "bin");
for (const p of [bin, path.join(seats, "run"), path.join(seats, "logs"), path.join(root, "wheelhouse")]) fs.mkdirSync(p, { recursive: true });
const command = (file: string, args: string[], env = process.env) => spawnSync(file, args, { cwd: root, env, encoding: "utf8" });
function executable(name: string): string {
  const r = command("sh", ["-c", `command -v ${name}`]);
  assert.equal(r.status, 0); assert(fs.statSync(r.stdout.trim()).isFile()); return r.stdout.trim();
}
const ps = executable("ps"), lsof = executable("lsof");
// Capture the real native failure protocol BEFORE building replay fixtures.
// These are explicit observation-loss controls, not claims about the target pid.
for (const [name, file, args] of [["ps", ps, ["-p", "999999999", "-o", "lstart="]], ["lsof", lsof, ["-Fn", "-p", "999999999"]]] as const) {
  const r = command(file, [...args]);
  console.log("CAPTURE identity native failure " + JSON.stringify({ command: [file, ...args], status: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr }));
  assert(r.status !== 0 && r.status !== null && !r.error && !r.signal);
  fs.writeFileSync(path.join(root, name + ".failure.stdout"), r.stdout);
  fs.writeFileSync(path.join(root, name + ".failure.stderr"), r.stderr);
  fs.writeFileSync(path.join(root, name + ".failure.rc"), String(r.status));
}
const fifo = path.join(seats, "run/worker.stdin"), ready = path.join(root, "holder.ready"), signalled = path.join(root, "holder.signalled");
assert.equal(command("mkfifo", [fifo]).status, 0);
const holder = spawn("node", ["-e", `const fs=require('fs');fs.openSync(process.argv[1],fs.constants.O_RDWR);process.on('SIGTERM',()=>fs.writeFileSync(process.argv[3],'SIGTERM'));fs.writeFileSync(process.argv[2]+'.new',String(process.pid));fs.renameSync(process.argv[2]+'.new',process.argv[2]);setInterval(()=>{},1000);`, fifo, ready, signalled], { cwd: root, stdio: "ignore" });
let failures = 0, checked = 0;
function check(name: string, fn: () => void) {
  if (process.env.WHEELHOUSE_IDENTITY_CASE && process.env.WHEELHOUSE_IDENTITY_CASE !== name) return;
  checked++;
  try { fn(); console.log("PASS identity: " + name); } catch (e: any) { failures++; console.error("FAIL identity: " + name + ": " + e.message); }
}
try {
  console.error(`FIXTURE_WAIT seat identity: holder readiness, pid=${holder.pid}, file=${ready}`);
  while (!fs.existsSync(ready)) {
    assert.equal(holder.exitCode, null, "holder exited before readiness"); assert.equal(holder.signalCode, null, "holder signalled before readiness");
    await Bun.sleep(25);
  }
  assert.equal(Number(fs.readFileSync(ready, "utf8")), holder.pid, "holder readiness names the exact live child");
  const birth = command(ps, ["-p", String(holder.pid), "-o", "lstart="]);
  console.log("CAPTURE identity holder " + JSON.stringify({ pid: holder.pid, status: birth.status, signal: birth.signal, stdout: birth.stdout, stderr: birth.stderr }));
  assert.equal(birth.status, 0); const startedAt = new Date(Date.parse(birth.stdout.trim())).toISOString();
  fs.writeFileSync(path.join(root, "birth.stdout"), birth.stdout);
  const q = (p: string) => "'" + p.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh
if [ "\${1:-}" = -p ] && [ "\${2:-}" = ${holder.pid} ] && [ "\${4:-}" = lstart= ]; then
 case "$IDENTITY_FAULT_MODE" in
 later|stream-later)
 count=0; [ ! -f ${q(path.join(root,"probe.count"))} ] || read -r count < ${q(path.join(root,"probe.count"))}
 count=$((count+1)); printf '%s\\n' "$count" > ${q(path.join(root,"probe.count"))}
 limit=1; [ "$IDENTITY_FAULT_MODE" != stream-later ] || limit=2
 [ "$count" -gt "$limit" ] || exec ${q(ps)} "$@"
 cat ${q(path.join(root,"ps.failure.stdout"))}; cat ${q(path.join(root,"ps.failure.stderr"))} >&2; exit 1;;
 fail) cat ${q(path.join(root, "ps.failure.stdout"))}; cat ${q(path.join(root, "ps.failure.stderr"))} >&2; read -r rc < ${q(path.join(root, "ps.failure.rc"))}; exit "$rc";;
 empty) exit 0;;
 malformed) printf 'not a process start time\\n'; exit 0;;
 partial) cat ${q(path.join(root, "birth.stdout"))}; exit 1;;
 signal) kill -TERM $$; exit 99;;
 esac
fi
exec ${q(ps)} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "lsof"), `#!/bin/sh
if [ "$IDENTITY_FAULT_MODE" != none ] && [ "\${1:-}" = -Fn ] && [ "\${3:-}" = ${holder.pid} ]; then
 [ "$IDENTITY_FAULT_MODE" != empty ] || exit 0
 cat ${q(path.join(root, "lsof.failure.stdout"))}; cat ${q(path.join(root, "lsof.failure.stderr"))} >&2; read -r rc < ${q(path.join(root, "lsof.failure.rc"))}; exit "$rc"
fi
exec ${q(lsof)} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(seats, "seats.json"), JSON.stringify({ seats: { worker: { role: "worker", worktree: false, runtime: "pi", provider: "openai", model: "fixture", account: { dir: path.join(root, "account") } } } }));
  fs.writeFileSync(path.join(seats, "logs/worker.jsonl"), '{"type":"agent_start"}\n{"type":"tool_execution_start","toolName":"fixture"}\n');
  fs.writeFileSync(path.join(root, "session.jsonl"), '{"type":"session"}\n');
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "github-issue-watch=off\nalert-low-disk-gb=0\n");
  const baseRecord = { pid: holder.pid, startedAt, role: "worker", log: path.join(seats, "logs/worker.jsonl"), cwd: root, sessionFile: path.join(root, "session.jsonl"), sessionId: "identity-fixture", lastBead: "identity-old" };
  const stateFile = path.join(seats, "state.json");
  function state(extra: any = {}) {
    // An unsafe removal control may have unlinked it. Later timestamp-only
    // cases must still start with their sentinel present, not inherit a failure.
    if (!fs.existsSync(fifo)) assert.equal(command("mkfifo", [fifo]).status, 0);
    fs.rmSync(path.join(root,"probe.count"),{force:true});
    fs.writeFileSync(stateFile, JSON.stringify({ seats: { worker: { ...baseRecord, ...extra } } }));
  }
  function cli(file: string, args: string[], mode = "fail") {
    const r = command("bun", [path.join(seats, file), ...args], { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1", IDENTITY_FAULT_MODE: mode, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_RPC_TIMEOUT_MS: "250", WHEELHOUSE_ALERTS_ROOT: root, WHEELHOUSE_NEEDS_ROOT: root });
    console.log("CAPTURE identity command " + JSON.stringify({ file, args, mode, code: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr }));
    return r;
  }
  function text(r: ReturnType<typeof cli>) { return `${r.stdout}\n${r.stderr}`; }
  function untouched() {
    process.kill(holder.pid!, 0); assert(!fs.existsSync(signalled), "no SIGTERM may reach the private holder");
    const rec = JSON.parse(fs.readFileSync(stateFile, "utf8")).seats.worker;
    assert.equal(rec.pid, holder.pid); assert.equal(rec.sessionId, baseRecord.sessionId); assert.equal(rec.sessionFile, baseRecord.sessionFile);
    assert(fs.existsSync(fifo));
  }
  check("native matching identity is RUNNING on status and floor", () => {
    state(); const a = cli("adapter.ts", ["status"], "none"), f = cli("floor.ts", ["--once", "--pin", "0"], "none");
    assert.equal(a.status, 0); assert.match(a.stdout, /^worker\s+worker\s+RUNNING/m); assert.equal(f.status, 0); assert.match(f.stdout, /RUNNING — working/); untouched();
  });
  check("definite birth mismatch stays foreign on status and floor", () => {
    state({ startedAt: "2000-01-01T00:00:00.000Z" }); const a = cli("adapter.ts", ["status"], "none"), f = cli("floor.ts", ["--once"], "none");
    assert.match(a.stdout, /DIED\s+pid \d+ foreign/); assert.match(f.stdout, /foreign/); assert.doesNotMatch(a.stdout + f.stdout, /UNVERIFIED/); untouched();
  });
  for (const recorded of [undefined, "not-a-recorded-date"]) check(`missing/invalid recorded proof ${String(recorded)} is UNVERIFIED`, () => {
    state({ startedAt: recorded }); const a = cli("adapter.ts", ["status"], "none"), f = cli("floor.ts", ["--once"], "none");
    assert.equal(a.status, 0); assert.equal(f.status, 0); assert.match(a.stdout, /UNVERIFIED/); assert.match(f.stdout, /UNVERIFIED/); assert.doesNotMatch(a.stdout + f.stdout, /DIED|foreign|PROCESS GONE/); untouched();
  });
  for (const mode of ["fail", "empty", "malformed", "partial", "signal"]) {
    check(`${mode} observation: status UNVERIFIED, never DIED/foreign`, () => {
      state(); const a = cli("adapter.ts", ["status"], mode); assert.equal(a.status, 0); assert.match(a.stdout, /^worker\s+worker\s+UNVERIFIED/m); assert.doesNotMatch(a.stdout, /DIED|foreign/); untouched();
    });
    check(`${mode} observation: floor UNVERIFIED, never dead/foreign`, () => {
      state(); const f = cli("floor.ts", ["--once", "--pin", "0"], mode); assert.equal(f.status, 0); assert.match(f.stdout, /UNVERIFIED/); assert.doesNotMatch(f.stdout, /PROCESS GONE|foreign|RUNNING — working/); untouched();
    });
  }
  for (const behavior of ["return", "throw"]) check(`native ENOENT ${behavior} cannot become false death or ownership`, () => {
    // Capture a real missing-executable result, then replay that record at
    // the ps boundary. PATH stays intact, including any host build shims.
    const code = `const fs=await import('node:fs'),cp=await import('node:child_process'),{mock}=await import('bun:test');const missing=process.argv[4];if(fs.existsSync(missing))throw Error('missing-tool subject unexpectedly exists');const r=cp.spawnSync(missing,[],{encoding:'utf8'});console.error('CAPTURE native ENOENT '+JSON.stringify({status:r.status,signal:r.signal,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}));if(r.error?.code!=='ENOENT')throw Error('native missing-tool protocol not ENOENT');const spawnSync=(file,...args)=>{if(file!=='ps')return cp.spawnSync(file,...args);if(process.argv[5]==='throw')throw r.error;return r;};mock.module('node:child_process',()=>({...cp,spawnSync,default:{...cp.default,spawnSync}}));const m=await import(process.argv[1]);const kind=typeof m.seatIdentity==='function'?m.seatIdentity(Number(process.argv[2]),undefined,process.argv[3]).kind:m.pidAlive(Number(process.argv[2]),undefined,process.argv[3])?'owned':'foreign';console.log(kind);`;
    const r = command("bun", ["-e", code, path.join(seats, "seat-activity.ts"), String(holder.pid), startedAt, path.join(root, "absent-identity-ps"), behavior]);
    console.log("CAPTURE ENOENT helper " + JSON.stringify({ behavior, status:r.status, stdout:r.stdout, stderr:r.stderr }));
    assert.equal(r.status, 0); assert.equal(r.stdout.trim(), "unverified");
  });
  check("fresh kernel ESRCH settles exit during failed inspection", () => {
    // Controlled race: the first kill(0) really succeeds; after the failed
    // observer, replay the real kernel ESRCH shape captured from an absent pid.
    const code = `const cp=await import('node:child_process'),{mock}=await import('bun:test');const kill=process.kill.bind(process);let esrch;try{kill(999999999,0);}catch(e){esrch=e;}if(esrch?.code!=='ESRCH')throw Error('native ESRCH capture required');console.error('CAPTURE kernel absence '+JSON.stringify({code:esrch.code}));const failure=cp.spawnSync(process.argv[4],[],{encoding:'utf8'});if(failure.error?.code!=='ENOENT')throw Error('native ENOENT capture required');let lost=false;const spawnSync=(file,...args)=>{if(file!=='ps')return cp.spawnSync(file,...args);lost=true;return failure;};mock.module('node:child_process',()=>({...cp,spawnSync,default:{...cp.default,spawnSync}}));process.kill=(pid,signal)=>{if(Number(pid)===Number(process.argv[2])&&signal===0&&lost)throw esrch;return kill(pid,signal);};const m=await import(process.argv[1]);const kind=typeof m.seatIdentity==='function'?m.seatIdentity(Number(process.argv[2]),undefined,process.argv[3]).kind:m.pidAlive(Number(process.argv[2]),undefined,process.argv[3])?'owned':'foreign';console.log(kind);`;
    const r = command("bun", ["-e", code, path.join(seats, "seat-activity.ts"), String(holder.pid), startedAt, path.join(root, "absent-identity-ps")]);
    console.log("CAPTURE exit-race helper " + JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}));assert.equal(r.status, 0);assert.equal(r.stdout.trim(), "gone");
  });
  for (const args of [["stop", "worker"], ["stop-all"], ["resume", "worker"], ["spawn", "worker"], ["reset", "worker"], ["dispatch", "worker", "identity-next", "fixture"]]) {
    check(`${args[0]} refuses UNVERIFIED without signal/restart/reclaim`, () => {
      state(); const r = cli("adapter.ts", args); assert.notEqual(r.status, 0); assert.match(text(r), /UNVERIFIED/); untouched();
    });
  }
  check("empty descriptor observation cannot reclaim a live FIFO-only record", () => {
    state({ fifo, startedAt: undefined }); for (const [file, args] of [["adapter.ts", ["status"]], ["floor.ts", ["--once"]], ["recover.ts", []]] as const) {
      const r = cli(file, [...args], "empty"); assert.equal(r.status, 0); assert.match(r.stdout, /UNVERIFIED/); assert.doesNotMatch(r.stdout, /DIED|foreign|PROCESS GONE|removed orphaned FIFO/); untouched();
    }
  });
  // Last FIFO-owning case: restoring old recover deliberately unlinks it.
  check("recover retains UNVERIFIED FIFO/session, offers no resume/spawn", () => {
    state({ fifo }); const r = cli("recover.ts", []); assert.equal(r.status, 0); assert.match(r.stdout, /^worker\s+UNVERIFIED/m); assert.doesNotMatch(r.stdout, /resume: bun|spawn fresh|removed orphaned FIFO/); untouched();
  });
  for (const role of ["worker", "reviewer"]) check(`snapshot reports UNVERIFIED ${role} as occupied, not free`, () => {
    state({ role }); const roster = JSON.parse(fs.readFileSync(path.join(seats, "seats.json"), "utf8")); roster.seats.worker.role = role; fs.writeFileSync(path.join(seats, "seats.json"), JSON.stringify(roster));
    const r = cli("fleet-snapshot.ts", ["--json"]); assert.equal(r.status, 0, text(r)); const snap=JSON.parse(r.stdout);
    assert.equal(snap.unverified.worker.status,"UNVERIFIED");assert.equal(snap.unverified.worker.pid,holder.pid);
    const occupied=(role==='worker'?snap.workers:snap.reviewers);assert.equal(occupied.idle,0);assert(occupied.live.some(s=>s.name==='worker'&&s.identity==='UNVERIFIED'&&s.busy));untouched();
  });
  check("one UNVERIFIED seat does not hide a healthy idle peer", () => {
    state();const born=command(ps,['-p',String(process.pid),'-o','lstart=']);assert.equal(born.status,0);console.log('CAPTURE healthy peer birth '+JSON.stringify({pid:process.pid,status:born.status,stdout:born.stdout,stderr:born.stderr}));
    const roster=JSON.parse(fs.readFileSync(path.join(seats,'seats.json'),'utf8'));roster.seats.worker.role='worker';roster.seats.healthy={...roster.seats.worker,account:{dir:path.join(root,'healthy-account')}};fs.writeFileSync(path.join(seats,'seats.json'),JSON.stringify(roster));
    const s=JSON.parse(fs.readFileSync(stateFile,'utf8'));s.seats.healthy={...baseRecord,pid:process.pid,startedAt:new Date(Date.parse(born.stdout.trim())).toISOString(),log:path.join(seats,'logs/healthy.jsonl')};fs.writeFileSync(s.seats.healthy.log,'{"type":"agent_end"}\n');fs.writeFileSync(stateFile,JSON.stringify(s));
    const r=cli('fleet-snapshot.ts',['--json']);assert.equal(r.status,0,text(r));const snap=JSON.parse(r.stdout);assert.equal(snap.workers.idle,1);assert.equal(snap.workers.busy,1);assert(snap.workers.live.some(w=>w.name==='healthy'&&!w.busy));assert.equal(snap.unverified.worker.status,'UNVERIFIED');untouched();
  });
  for(const mode of ['fail','later','stream-later']) check(`alerts publish snapshot with UNVERIFIED (${mode}), without cold/idle/stalled advice`, () => {
    state();const roster=JSON.parse(fs.readFileSync(path.join(seats,'seats.json'),'utf8'));roster.seats.worker.role='worker';delete roster.seats.healthy;fs.writeFileSync(path.join(seats,'seats.json'),JSON.stringify(roster));
    fs.rmSync(path.join(seats,'inbox.jsonl'),{force:true});fs.rmSync(path.join(seats,'run/fleet-snapshot.json'),{force:true});
    if(mode==='fail')fs.writeFileSync(path.join(seats,'run/fleet-snapshot.json'),JSON.stringify({alerts:{'seat-stalled:worker':{active:true,since:'2026-01-01T00:00:00Z',lastFiredAt:'2026-01-01T00:00:00Z'},'seat-settled-task:worker':{active:true,since:'2026-01-01T00:00:00Z',lastFiredAt:'2026-01-01T00:00:00Z'}}}));
    const r = cli("alerts.ts", ["check", "--json"],mode); assert.equal(r.status,0,text(r));const snapshot=JSON.parse(r.stdout);
    assert.equal(snapshot.snapshot.unverified.worker.status,'UNVERIFIED');assert(snapshot.alerts['seat-unverified:worker'].active);assert.equal(snapshot.snapshot.workers.idle,0);
    if(mode==='fail'){assert(snapshot.alerts['seat-stalled:worker'].active,'uncertainty is not proof of recovery');assert(snapshot.alerts['seat-settled-task:worker'].active);}
    assert(fs.existsSync(path.join(seats,'run/fleet-snapshot.json')));const stored=JSON.parse(fs.readFileSync(path.join(seats,'run/fleet-snapshot.json'),'utf8'));assert.equal(stored.snapshot.unverified.worker.pid,holder.pid);
    const inbox=fs.readFileSync(path.join(seats,'inbox.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));assert(inbox.some(r=>r.source.name==='seat-unverified:worker'));
    assert(!inbox.some(r=>/^(cold-seats-ready-work|idle-fleet-ready-work|seat-stalled:|seat-settled-task:)/.test(r.source.name)));
    if(mode==='fail'){const again=cli('alerts.ts',['check','--json'],mode);assert.equal(again.status,0,text(again));const next=fs.readFileSync(path.join(seats,'inbox.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(next.filter(r=>r.source.name==='seat-unverified:worker').length,inbox.filter(r=>r.source.name==='seat-unverified:worker').length,'identity warning dedupes independently of other fleet alerts');}
    untouched();
  });
  check("cleanup refuses UNVERIFIED before scanning/reclaiming", () => {
    state(); const r = cli("prune.ts", ["cleanup", "--root", root]); assert.notEqual(r.status, 0); assert.match(text(r), /UNVERIFIED/); untouched();
  });
  // Independent native truth after all controlled failures; holder really is
  // alive with the exact seeded birth. No probe failure is a fixture death.
  const after = command(ps, ["-p", String(holder.pid), "-o", "lstart="]);
  console.log("CAPTURE identity final truth " + JSON.stringify({ pid: holder.pid, startedAt, status: after.status, signal: after.signal, stdout: after.stdout, stderr: after.stderr, matches: Date.parse(after.stdout.trim()) === Date.parse(startedAt) }));
  assert.equal(after.status, 0); assert.equal(Date.parse(after.stdout.trim()), Date.parse(startedAt));
} finally {
  holder.kill("SIGKILL"); if (holder.exitCode === null && holder.signalCode === null) await new Promise(resolve => holder.once("exit", resolve));
}
assert(checked > 0, "selected identity test subject must exist and execute");
console.log(`identity fixtures: ${failures ? "FAIL" : "PASS"} cases=${checked} failures=${failures}`);
process.exitCode = failures ? 1 : 0;
