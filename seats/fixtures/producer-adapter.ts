import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { run, retain, copyRuntime, changed } from "./producer-test-support";
import conditionWait from "./wait-for-condition.cjs";
const { waitForCondition } = conditionWait;
const [implementation, scratch, bins, codexBin, repo] = process.argv.slice(2);
fs.mkdirSync(scratch, { recursive: true }); const root = fs.realpathSync(scratch), records: any[] = [], original = fs.readFileSync(implementation, "utf8");
const tag = "PRODUCER_ADAPTER_ASSERTION", hash = (b: any) => createHash("sha256").update(b).digest("hex");
const save = () => retain(root, "producer-adapter", { implementation, original, records });
function expected(project: string) {
  let result = fs.readFileSync(path.join(project, "contracts/PRODUCER.md"), "utf8");
  for (const n of ["intent", "outcomes"]) { const s = fs.readFileSync(path.join(project, ".agents/skills", n, "SKILL.md"), "utf8"), version = s.split("\n").find(l => l.startsWith("version:"))!.slice(8).trim(); result += `\n\n# Skill: ${n} (version ${version})\n\n` + s.slice(s.indexOf("\n---\n", 4) + 5); }
  return result;
}
async function scenario(name: string, harness: string, focus = "all", mutation?: any, splitReceipt = false) {
  const dir = path.join(root, name), project = path.join(dir, "proj"), home = path.join(dir, "home"), account = path.join(home, "account"), bin = path.join(dir, "bin");
  fs.mkdirSync(account, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(project, "contracts"), { recursive: true });
  const runtime = copyRuntime(path.dirname(implementation), project);
  fs.writeFileSync(path.join(runtime, "adapter.ts"), original);
  if (mutation) { const file = path.join(runtime, mutation.file); fs.writeFileSync(file, changed(fs.readFileSync(file, "utf8"), mutation.old, mutation.replacement)); }
  fs.writeFileSync(path.join(runtime, "state.json"), '{"seats":{}}\n');
  const entry = { role: "producer", harness, provider: "anthropic", model: "stub-model", allowedTools: "Read,Bash(bd:*)", disallowedTools: "Edit,Write", account: { dir: account, authRoute: "oauth" } };
  fs.writeFileSync(path.join(runtime, "seats.json"), JSON.stringify({ seats: { producer: entry } }));
  fs.writeFileSync(path.join(project, "contracts/PRODUCER.md"), "# Crew: Producer\nfixture brief — producer role bytes\n");
  fs.mkdirSync(path.join(project, "wheelhouse")); fs.writeFileSync(path.join(project, "wheelhouse/.template-source"), "cleanup=off\n");
  for (const n of ["intent", "outcomes"]) { const dest = path.join(project, ".agents/skills", n, "SKILL.md"); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(repo, ".agents/skills", n, "SKILL.md"), dest); }
  fs.writeFileSync(path.join(account, "auth.json"), '{"fixture":true}\n'); fs.writeFileSync(path.join(account, ".claude.json"), '{"fixture":true}\n');
  fs.writeFileSync(path.join(account, "trust.json"), JSON.stringify({ [project]: true }));
  const launchesFile = path.join(dir, "native-launches.jsonl");
  for (const [tool, source] of [["pi", path.join(bins, "pi")], ["claude", path.join(bins, "claude")], ["codex", path.join(codexBin, "codex")]]) {
    const text = fs.readFileSync(source, "utf8"), first = text.indexOf("\n") + 1;
    const receipt = `(() => {
  const fs=require('node:fs'), path=require('node:path'), file=process.env.PRODUCER_TEST_LAUNCHES;
  const rpc=path.join(process.env.CODEX_HOME||process.env.HOME,'codex-rpc.jsonl');
  const line=JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv,cwd:process.cwd(),rpcOffset:fs.existsSync(rpc)?fs.statSync(rpc).size:0})+'\\n';
  const delay=Number(process.env.PRODUCER_TEST_RECEIPT_SPLIT_MS||0);
  if(!delay) { fs.appendFileSync(file,line); return; }
  // Split before the first JSON value: the legacy reader reports Unexpected
  // EOF, rather than a different syntax error from cutting inside argv/a key.
  const bytes=Buffer.from(line), cut=bytes.indexOf(58)+1; fs.appendFileSync(file,bytes.subarray(0,cut));
  // Keep protocol startup live. Only this fixture's first evidence read opens
  // the gate; even a slow adapter return must see the deliberately partial line.
  setTimeout(() => {
    const {waitForCondition}=require(process.env.PRODUCER_TEST_CONDITION_HELPER);
    const landed=waitForCondition({site:'producer-adapter.stub-receipt-release',paths:[path.dirname(file)],predicate:()=>fs.existsSync(process.env.PRODUCER_TEST_RECEIPT_RELEASE)});
    landed.promise.then(()=>fs.appendFileSync(file,bytes.subarray(cut))).finally(()=>landed.cancel());
  },delay);
})();\n`;
    fs.writeFileSync(path.join(bin, tool), text.slice(0, first) + receipt + text.slice(first), { mode: 0o755 });
  }
  const contract = path.join(dir, "valid.md"), unstamped = path.join(dir, "unstamped.md");
  const valid = fs.readFileSync(path.join(repo, "seats/fixtures/contracts/valid.md"), "utf8"); fs.writeFileSync(contract, valid); fs.writeFileSync(unstamped, valid.replace(/^Skills:.*\n/m, ""));
  const env = { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CONTRACT_FIXTURE: contract, PRODUCER_TEST_LAUNCHES: launchesFile };
  for (const k of Object.keys(env)) if (k.startsWith("STUB_") || ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PRODUCER_TEST_RECEIPT_SPLIT_MS", "PRODUCER_TEST_RECEIPT_RELEASE", "PRODUCER_TEST_CONDITION_HELPER"].includes(k)) delete env[k];
  const receiptRelease = path.join(dir, "receipt-release");
  if (splitReceipt) Object.assign(env, { PRODUCER_TEST_RECEIPT_SPLIT_MS: "400", PRODUCER_TEST_RECEIPT_RELEASE: receiptRelease, PRODUCER_TEST_CONDITION_HELPER: path.join(import.meta.dir, "wait-for-condition.cjs") });
  const rec: any = { name, harness, focus, mutation, splitReceipt, waits: [], sources: Object.fromEntries(["adapter.ts", "briefs.ts", "contract.ts", "drivers/codex/shim.ts"].map(f => [f, fs.readFileSync(path.join(runtime, f), "utf8")])), calls: [] }; records.push(rec); save();
  const stateFile = path.join(runtime, "state.json"), stateBytes = () => fs.readFileSync(stateFile, "utf8"), state = () => JSON.parse(stateBytes()).seats.producer;
  function receiptRead() {
    const lines = (fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, "utf8") : "").split("\n");
    const tail = lines.pop()!; // Only LF-terminated segments are complete records.
    return { launches: lines.map(l => JSON.parse(l)), pendingReceipt: tail.slice(0, 200) };
  }
  const launches = () => receiptRead().launches;
  let lastActorPid: number | undefined;
  async function invoke(args: string[], extra: any = {}) {
    // Join a pending receipt before stopping its writer (also in cleanup).
    if (args[0] === "stop" && lastActorPid) await landed("before stop");
    const r = await run("bun", [path.join(runtime, "adapter.ts"), ...args], project, { ...env, ...extra });
    if (splitReceipt && !fs.existsSync(receiptRelease)) {
      // Claude's shim may answer before its child even creates the file. Set
      // up the real split window before observing it; the writer gate is shut.
      const partial = waitForCondition({ site: `producer-adapter.${name}.partial-setup`, paths: [dir], predicate: () => {
        const bytes = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, "utf8") : "";
        return bytes.length > 0 && !bytes.endsWith("\n");
      } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([partial.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CONTROL_SETUP ${name}: split receipt did not enter partial window within 10s`)), 10000); })]); }
      finally { clearTimeout(timer); partial.cancel(); }
    }
    const call: any = { phase: rec.phase, native: r }; rec.calls.push(call);
    try {
      call.state = stateBytes(); Object.assign(call, receiptRead());
      const actor = JSON.parse(call.state).seats.producer; if (actor?.pid) lastActorPid = actor.pid;
    } catch (e: any) { call.readError = e.message; }
    // The split control's writer can finish only AFTER evidence of the partial
    // line was captured. No adapter invocation/result is retried.
    if (splitReceipt) fs.writeFileSync(receiptRelease, "observed by fixture\n");
    save(); assert(!r.error && r.signal === null && r.stdoutEOF && r.stderrEOF, "CONTROL_SETUP adapter completion"); return r;
  }
  function code(r: any, want: number, message: string, setup = false) { assert.equal(r.code, want, `${setup ? "CONTROL_SETUP" : tag} ${name}: ${message}: ${r.stderr}`); }
  function delivered() {
    if (harness === "pi" || harness === "claude-code") { const file = path.join(account, harness === "pi" ? "argv.json" : "claude-argv.json"), args = JSON.parse(fs.readFileSync(file, "utf8")); return args[args.indexOf("--append-system-prompt") + 1]; }
    const rpc = fs.readFileSync(path.join(account, "codex-rpc.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const request = rpc.filter(r => r.method === "thread/start" || r.method === "thread/resume").at(-1); rec.codexInput = request; return request?.params?.developerInstructions;
  }
  async function landed(reason: string) {
    const note: any = { phase: rec.phase, reason, actorPid: lastActorPid }; rec.waits.push(note);
    const publication = path.join(account, harness === "pi" ? "argv.json" : harness === "claude-code" ? "claude-argv.json" : "codex-rpc.jsonl");
    const observed = waitForCondition({ site: `producer-adapter.${name}.${rec.phase}.${reason}`, paths: [dir, account], predicate: () => {
      try {
        const input = receiptRead();
        if (input.pendingReceipt || !input.launches.length || !fs.existsSync(publication)) return false;
        const actor = input.launches.at(-1);
        if (harness === "pi" ? actor.pid !== lastActorPid : actor.ppid !== lastActorPid) return false;
        const bytes = fs.readFileSync(publication, "utf8");
        if (harness === "codex") {
          if (!bytes.endsWith("\n") || Buffer.byteLength(bytes) <= actor.rpcOffset) return false;
          const fresh = Buffer.from(bytes).subarray(actor.rpcOffset).toString().trimEnd().split("\n").map(l => JSON.parse(l));
          if (!fresh.some(r => r.method === "thread/start" || r.method === "thread/resume")) return false;
        } else if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(actor.argv.slice(2))) return false;
        delivered(); // Observe the same published argv/RPC input the oracle reads.
        Object.assign(note, { complete: input.launches.length, pendingReceipt: input.pendingReceipt, publication, publishedBytes: Buffer.byteLength(bytes), landed: true });
        return true;
      } catch (e: any) { note.readError = e.message; return false; }
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([observed.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CONTROL_SETUP ${name}: ${reason} receipt/publication did not land within 10s: ${JSON.stringify(note)}`)), 10000); })]);
    } finally { clearTimeout(timer); observed.cancel(); save(); }
  }
  async function snapshot() { await landed("snapshot"); return { state: stateBytes(), launches: launches().length, session: state()?.sessionFile ? fs.readFileSync(state().sessionFile, "utf8") : null }; }
  try {
    rec.phase = "spawn"; code(await invoke(["spawn", "producer"]), 0, "initial native spawn", true);
    // A shim's get_state can precede its native child's startup. A real prompt
    // delivery joins that child's published session before argv/RPC inspection.
    rec.phase = "initial-dispatch"; code(await invoke(["dispatch", "producer", "initial", "fixture producer turn"]), 0, "valid initial dispatch", true);
    rec.phase = "payload"; rec.delivered = delivered(); save(); assert.equal(rec.delivered, expected(project), `${tag} ${name}: full native harness skill payload`);
    if (focus === "all") assert.equal(state().roleBriefHash, hash(expected(project)), `${tag} ${name}: loaded assembled hash`);
    if (focus === "payload") return;
    if (focus === "all" || focus === "unstamped") {
      rec.phase = "unstamped"; const before = await snapshot(), r = await invoke(["dispatch", "producer", "unstamped", "must not arrive"], { WHEELHOUSE_CONTRACT_FIXTURE: unstamped, WHEELHOUSE_DISPATCH_FORCE: "1" }); rec.unstamped = { before, after: await snapshot(), native: r }; save();
      code(r, 1, "unstamped forced dispatch refusal"); assert(r.stderr.includes("Skills: missing"), `${tag} ${name}: stamp refusal names field`); assert.deepEqual(rec.unstamped.after, before, `${tag} ${name}: refusal changes no state/session/launch`);
      if (focus === "unstamped") return;
    }
    if (focus === "all" || focus === "missing") {
      rec.phase = "missing"; const file = path.join(project, ".agents/skills/outcomes/SKILL.md"), bytes = fs.readFileSync(file), before = await snapshot(); fs.unlinkSync(file);
      try { const r = await invoke(["reset", "producer"]); rec.missing = { before, after: await snapshot(), native: r }; save(); code(r, 1, "missing skill reset must refuse before stop/discard"); assert(r.stderr.includes(file), `${tag} ${name}: missing skill path`); assert.deepEqual(rec.missing.after, before, `${tag} ${name}: missing skill touched state/session/launch`); assert.doesNotThrow(() => process.kill(state().pid, 0), `${tag} ${name}: original actor remains alive`); }
      finally { fs.writeFileSync(file, bytes); }
      if (focus === "missing") return;
    }
    if (focus === "all" || focus === "unknown-resume" || focus === "resume-payload") {
      rec.phase = "stop"; code(await invoke(["stop", "producer"]), 0, "stop");
      if (focus === "all" || focus === "resume-payload") {
        rec.phase = "resume"; code(await invoke(["resume", "producer"]), 0, "healthy resume"); rec.phase = "resume-payload"; rec.resumedPayload = delivered(); save(); assert.equal(rec.resumedPayload, expected(project), `${tag} ${name}: resume carries full native payload`);
        if (focus === "resume-payload") return;
        rec.phase = "stop-again"; code(await invoke(["stop", "producer"]), 0, "second stop");
      }
      const s = JSON.parse(stateBytes()); delete s.seats.producer.roleBriefHash; fs.writeFileSync(stateFile, JSON.stringify(s));
      rec.phase = "unknown-resume"; const before = await snapshot(), r = await invoke(["resume", "producer"]); rec.unknown = { before, after: await snapshot(), native: r }; save(); code(r, 1, "unknown loaded hash must require reset"); assert(r.stderr.includes("reset instead of resume"), `${tag} ${name}: unknown hash remedy`); assert.deepEqual(rec.unknown.after, before, `${tag} ${name}: unknown resume changed state or launched`);
      if (focus === "unknown-resume") return;
      rec.phase = "reset"; code(await invoke(["reset", "producer"]), 0, "explicit reset"); assert.equal(delivered(), expected(project), `${tag} ${name}: reset full native payload`);
    }
    if (focus === "all" || focus === "stale") {
      const skill = path.join(project, ".agents/skills/intent/SKILL.md"); fs.writeFileSync(skill, fs.readFileSync(skill, "utf8").replace("version: 1.0.0", "version: 1.0.1") + "\nPrivate fixture revision.\n");
      rec.phase = "stale"; const before = await snapshot(), r = await invoke(["dispatch", "producer", "changed-skill", "must not reach stale producer"]); rec.stale = { before, after: await snapshot(), native: r }; save(); code(r, 1, "changed skill must require reset"); assert(r.stderr.includes("reset instead of resume"), `${tag} ${name}: stale remedy`); assert.deepEqual(rec.stale.after, before, `${tag} ${name}: stale dispatch changed state/session/launch`);
    }
  } catch (error: any) { rec.failedPhase = rec.phase; rec.failedNative = rec.calls.at(-1)?.native; rec.rejection = error.message; save(); throw error; }
  finally { rec.phase = "cleanup-stop"; const s = state(); if (s?.pid) { const r = await invoke(["stop", "producer"]); code(r, 0, "join own actor via adapter stop"); } rec.launches = launches(); save(); }
}
try {
  for (const h of ["pi", "claude-code", "codex"]) { await scenario("normal-" + h, h); console.log(`PASS producer native ${h}: full spawn/resume/reset bodies, stamp/missing/stale/unknown refusals unchanged`); }
  for (const h of ["pi", "claude-code", "codex"]) {
    await scenario("receipt-race-" + h, h, "all", undefined, true);
    const rec = records.at(-1), normal = records.find(r => r.name === "normal-" + h);
    assert(rec.calls.some((c: any) => c.pendingReceipt || c.launches?.length < rec.launches.length), `${tag} receipt race ${h}: no pending or short receipt observed`);
    assert(rec.calls.some((c: any) => c.pendingReceipt), `${tag} receipt race ${h}: no actual partial bytes observed`);
    assert.equal(rec.launches.length, normal.launches.length, `${tag} receipt race ${h}: slow receipts counted exactly once after landing`);
    assert(rec.waits.some((w: any) => w.landed && w.complete === rec.launches.length), `${tag} receipt race ${h}: final full receipt not observed by bounded condition wait`);
    console.log(`PASS producer receipt race ${h}: partial receipt tolerated, counted after landing`);
  }
  const fallible = 'catch (e: any) { throw new Error(`STOP: required producer skill ${file}: ${e.message}`); }';
  const variants = [
    { name: "drop-resume-brief", focus: "resume-payload", harnesses: ["codex"], file: "drivers/codex/shim.ts", old: 'model, cwd, developerInstructions: briefText } as any; const res = resumeThread ? await sendRpc("thread/resume", { threadId: resumeThread, ...policy }) : await sendRpc("thread/start", { ...policy });', replacement: 'model, cwd } as any; const res = resumeThread ? await sendRpc("thread/resume", { threadId: resumeThread, ...policy }) : await sendRpc("thread/start", { ...policy, developerInstructions: briefText });' },
    { name: "no-assembly", focus: "payload", file: "adapter.ts", old: "text = assembleBrief(ROOT, role);", replacement: 'text = fs.readFileSync(file, "utf8");' },
    { name: "stamp-off", focus: "unstamped", file: "contract.ts", old: "const REQUIRE_SKILLS = true;", replacement: "const REQUIRE_SKILLS = false;" },
    { name: "raw-hash", focus: "stale", file: "adapter.ts", old: 'role === "producer" ? text : fs.readFileSync(file)', replacement: "fs.readFileSync(file)" },
    { name: "unknown-hash", focus: "unknown-resume", file: "adapter.ts", old: 'role === "producer" && sessionFile && prior?.roleBriefHash !== hash', replacement: 'role === "producer" && sessionFile && prior?.roleBriefHash && prior.roleBriefHash !== hash' },
    { name: "fallback-missing", focus: "missing", file: "briefs.ts", old: fallible, replacement: 'catch { text = "---\\nname: " + name + "\\nversion: 1.0.0\\n---\\nfallback"; }' },
  ];
  for (const v of variants) for (const h of v.harnesses ?? ["pi", "claude-code", "codex"]) {
    let rejection: any; try { await scenario(v.name + "-" + h, h, v.focus, v); } catch (e) { rejection = e; }
    const rec = records.at(-1); assert(rejection?.message.includes(tag), `CONTROL_SETUP ${v.name}/${h}: intended oracle not reached: ${rejection?.stack}`); assert.equal(rec.failedPhase, v.focus); assert.equal(rec.failedNative.code, 0, "CONTROL_SETUP removal never reached its unsafe native0");
    console.log(`PASS producer adapter removal ${v.name}/${h}: actual native0 rejected at ${tag}`);
  }
} finally { save(); }
