import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { recordCleanupScratch } from "../cleanup-identity";

const root = fs.realpathSync(process.argv[2]), project = path.join(root, "project");
assert(fs.existsSync(path.join(root, ".wheelhouse-selftest-fixture")));
assert.equal(fs.realpathSync(process.env.WHEELHOUSE_SELFTEST_BD_ROOT!), path.join(root, "graph"));
const account = path.join(root, "account"), bin = path.join(root, "bin"), outside = path.join(root, "outside");
for (const dir of [account, bin, outside, path.join(project, "contracts"), path.join(project, ".beads")]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(project, "contracts/REVIEWER.md"), "Isolated cleanup integration reviewer.\n");
fs.writeFileSync(path.join(account, "auth.json"), '{"fixture":"not-a-credential"}\n');
fs.writeFileSync(path.join(project, "seats/seats.json"), JSON.stringify({ seats: {
  "reviewer-1": { role: "reviewer", harness: "pi", worktree: false, provider: "anthropic", model: "fixture", account: { dir: account } },
} }));
// JSONL protocol stub only. Graph status and cleanup are the real executables.
const peer = path.join(root, "peer.mjs");
fs.writeFileSync(peer, `import fs from 'node:fs';import readline from 'node:readline';
const file=${JSON.stringify(path.join(account, "session.jsonl"))};fs.writeFileSync(file,'{}\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);const data=c.type==='get_state'?{isStreaming:false,sessionFile:file,sessionId:'cleanup-fixture',messageCount:0}:{};console.log(JSON.stringify({id:c.id,type:'response',command:c.type,success:true,data}));if(c.type==='prompt'){console.log(JSON.stringify({type:'agent_start'}));console.log(JSON.stringify({type:'agent_end',messages:[]}));}});
process.on('SIGTERM',()=>process.exit(0));\n`);
fs.writeFileSync(path.join(bin, "pi"), '#!/usr/bin/env bash\nexec node "$WHEELHOUSE_CLEANUP_FIXTURE_PEER" "$@"\n', { mode: 0o755 });
// All dispatches, including unsafe-path probes, must reach the real contract gate.
const contract = path.join(root, "dispatch-contract.md");
fs.writeFileSync(contract, `Trace: Real dispatch and closed-task scratch cleanup regression fixture
Signal: isa-gap: K1
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Keep scratch data while its task is open and remove it after the task closes only when ownership is proven. Unsafe or unowned paths must remain untouched when another task is dispatched.

Outcomes:
- O1 Dispatch cleans only the closed task's proven-owned scratch directory.
  consumer: machine — the isolated cleanup fixture controller
  surface: task status, scratch ownership marker, retained file bytes and adapter output
  check: run — dispatch, close the scratch task, dispatch another task and compare owned, unmarked and unsafe paths
`);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WHEELHOUSE_CONTRACT_FIXTURE: contract, WHEELHOUSE_CLEANUP_FIXTURE_PEER: peer,
  WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CLEANUP_SYNC: "1" };
delete env.WHEELHOUSE_CLEANUP;
const invocations: any[] = [], failures: string[] = [];
async function command(argv: string[], cwd = project) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const r = { argv, code, signal: child.signalCode ?? null, stdout, stderr, stdoutEOF: true, stderrEOF: true };
  invocations.push(r);
  fs.writeFileSync(path.join(root, "invocations.json"), JSON.stringify(invocations, null, 2) + "\n");
  return r;
}
async function ok(argv: string[]) { const r = await command(argv); assert.equal(r.signal, null); assert.equal(r.code, 0, JSON.stringify(r)); return r; }
const cli = (...args: string[]) => ok(["bun", path.join(project, "seats/adapter.ts"), ...args]);
const prune = (bead: string) => ok(["bun", path.join(project, "seats/prune.ts"), "cleanup", "--bead", bead]);
function check(name: string, condition: boolean) { console.log(`${condition ? "PASS" : "FAIL"} cleanup dispatch: ${name}`); if (!condition) failures.push(name); }
const scratch = (id: string) => path.join(project, ".wheelhouse-runs", id);
const marker = (id: string) => path.join(scratch(id), ".wheelhouse-cleanup-scratch.json");
const markerBytes = (id: string) => fs.existsSync(marker(id)) ? fs.readFileSync(marker(id), "utf8") : null;
async function create(title: string) {
  const r = await ok(["bd", "create", title, "--type", "task", "--json"]);
  const task = JSON.parse(r.stdout); assert.match(task.id, /^scratch-/); return task.id as string;
}
async function close(id: string) {
  await ok(["bd", "close", id, "--reason", "isolated cleanup regression", "--json"]);
  const r = await ok(["bd", "show", id, "--json"]);
  assert.equal(JSON.parse(r.stdout)[0].status, "closed", "assert the real graph transition before measuring cleanup");
}
let primaryFailed = false, primaryError: unknown;
try {
  await ok(["git", "init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(project, ".gitignore"), "seats/\n.wheelhouse-runs/\n.beads/\n");
  await ok(["git", "add", ".gitignore", "contracts"]); await ok(["git", "commit", "-qm", "isolated cleanup install"]);
  const owned = await create("dispatch-owned scratch"), next = await create("next task"), legacy = await create("legacy unmarked scratch");
  await cli("spawn", "reviewer-1");
  await cli("dispatch", "reviewer-1", owned, "prepare owned scratch");
  const before = markerBytes(owned);
  let correctMarker = false;
  if (before) { const m = JSON.parse(before), st = fs.statSync(scratch(owned), { bigint: true }); correctMarker = m.root === project && m.target === scratch(owned) && m.bead === owned && m.identity === `${st.dev}:${st.ino}`; }
  check("dispatch writes marker bound to actual root/task/path/inode", correctMarker);
  // Subdirectory use follows production. The fallback mkdir also lets a
  // writer-removed control reach the removal assertion instead of setup-aborting.
  fs.mkdirSync(path.join(scratch(owned), "evidence"), { recursive: true });
  fs.writeFileSync(path.join(scratch(owned), "evidence/KEEP"), "owned payload\n");
  await cli("dispatch", "reviewer-1", owned, "same task again");
  check("same-task redispatch preserves the existing creation record", before !== null && markerBytes(owned) === before);
  const renamed = JSON.parse(before!);
  assert.equal(renamed.version, 2); assert.match(renamed.hostId, /^[0-9a-f]{64}$/);
  // Restart-after-rename condition: only the stored diagnostic name differs.
  renamed.hostname = "previous-network-name";
  fs.writeFileSync(marker(owned), JSON.stringify(renamed) + "\n");
  const renamedBytes = markerBytes(owned);
  const redispatched = await command(["bun", path.join(project, "seats/adapter.ts"), "dispatch", "reviewer-1", owned, "same machine after hostname change"]);
  check("same-task redispatch after hostname change preserves its record", redispatched.code === 0 && markerBytes(owned) === renamedBytes);
  await prune(owned);
  check("marked open task is retained", before !== null && fs.existsSync(path.join(scratch(owned), "evidence/KEEP")));
  await close(owned);
  const removed = await cli("dispatch", "reviewer-1", next, "leave the now-closed task");
  check("real dispatch -> real close -> cross-bead cleanup removes scratch", !fs.existsSync(scratch(owned)) && removed.stdout.includes(`removed run-scratch ${scratch(owned)} `));
  fs.mkdirSync(scratch(legacy)); fs.writeFileSync(path.join(scratch(legacy), "KEEP"), "legacy payload\n");
  const old = await cli("dispatch", "reviewer-1", legacy, "do not adopt legacy scratch");
  check("dispatch leaves preexisting unmarked task scratch unmarked", markerBytes(legacy) === null && old.stdout.includes("kept unowned"));
  await close(legacy);
  const kept = await cli("dispatch", "reviewer-1", next, "leave legacy task");
  check("closed legacy unmarked scratch is still refused", fs.readFileSync(path.join(scratch(legacy), "KEEP"), "utf8") === "legacy payload\n" && markerBytes(legacy) === null && kept.stdout.includes(`kept run-scratch ${scratch(legacy)} reason=unproven scratch ownership`));
  const seatBefore = JSON.parse(fs.readFileSync(path.join(project, "seats/state.json"), "utf8")).seats["reviewer-1"].lastBead;
  fs.writeFileSync(path.join(outside, "KEEP"), "outside payload\n");
  fs.symlinkSync(outside, scratch("unsafe-link"));
  const linked = await command(["bun", path.join(project, "seats/adapter.ts"), "dispatch", "reviewer-1", "unsafe-link", "refuse symlink"]);
  check("dispatch refuses symlink task root without marking outside", linked.code !== 0 && fs.readFileSync(path.join(outside, "KEEP"), "utf8") === "outside payload\n" && !fs.existsSync(path.join(outside, ".wheelhouse-cleanup-scratch.json")));
  fs.mkdirSync(scratch("foreign-marker")); const foreign = markerBytes(next) ?? "{}\n";
  fs.writeFileSync(marker("foreign-marker"), foreign);
  const mismatched = await command(["bun", path.join(project, "seats/adapter.ts"), "dispatch", "reviewer-1", "foreign-marker", "refuse foreign marker"]);
  check("dispatch refuses foreign marker without overwriting it", mismatched.code !== 0 && markerBytes("foreign-marker") === foreign);
  fs.mkdirSync(scratch("foreign-host")); recordCleanupScratch(project, scratch("foreign-host"), "foreign-host");
  const foreignHost = JSON.parse(markerBytes("foreign-host")!);
  foreignHost.hostId = (foreignHost.hostId[0] === "a" ? "b" : "a") + foreignHost.hostId.slice(1);
  fs.writeFileSync(marker("foreign-host"), JSON.stringify(foreignHost) + "\n");
  const foreignHostBytes = markerBytes("foreign-host");
  const foreignMachine = await command(["bun", path.join(project, "seats/adapter.ts"), "dispatch", "reviewer-1", "foreign-host", "refuse foreign stable ID"]);
  check("foreign stable machine ID refuses dispatch without replacing its record", foreignMachine.code !== 0 && markerBytes("foreign-host") === foreignHostBytes);
  const runs = path.dirname(scratch(next)); fs.renameSync(runs, runs + ".original"); fs.symlinkSync(outside, runs);
  try {
    const parent = await command(["bun", path.join(project, "seats/adapter.ts"), "dispatch", "reviewer-1", "unsafe-parent", "refuse parent symlink"]);
    check("dispatch refuses symlink scratch parent without creating outside", parent.code !== 0 && !fs.existsSync(path.join(outside, "unsafe-parent")));
  } finally { fs.unlinkSync(runs); fs.renameSync(runs + ".original", runs); }
  check("unsafe-root refusals leave recorded task unchanged", JSON.parse(fs.readFileSync(path.join(project, "seats/state.json"), "utf8")).seats["reviewer-1"].lastBead === seatBefore);
} catch (error) {
  primaryFailed = true;
  primaryError = error;
} finally {
  try { await cli("stop", "reviewer-1"); }
  catch (teardownError) {
    if (primaryFailed) throw new AggregateError([primaryError, teardownError], "cleanup dispatch: primary and teardown failures");
    throw teardownError;
  } finally { console.log("MEASUREMENTS " + JSON.stringify(invocations)); }
}
if (primaryFailed) throw primaryError;
console.log(`cleanup dispatch fixtures: ${failures.length ? "FAIL" : "PASS"} failures=${failures.length}`);
process.exit(failures.length ? 1 : 0);
