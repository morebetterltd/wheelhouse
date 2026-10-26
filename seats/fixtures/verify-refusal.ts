// Owned fake-reviewer regression. No provider, service, deadline or real sweep.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "./fixture-command.cjs";
import { randomUUID } from "node:crypto";
import { instrument, until } from "./verify-readiness";

type Harness = "pi" | "claude-code" | "codex";
const read = (file: string) => fs.readFileSync(file, "utf8");
const rows = (file: string): any[] => fs.existsSync(file) ? read(file).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
function wire(harness: Harness, text: string): string {
  text = require("./reviewer-reply.cjs").fourQuestions(text);
  // Envelopes from the checked-in verify-real captures, not tool-call text.
  return JSON.stringify(harness === "pi"
    ? { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }
    : harness === "claude-code"
      ? { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
      : { type: "item.completed", item: { type: "agent_message", text } }) + "\n";
}
const refusedText = (attempt: number) => require("./reviewer-reply.cjs").fourQuestions(`retained answer ${attempt}: checked the pinned tree, but omitted sweep evidence\nVERDICT: APPROVE\nPUSH: NOT CONSIDERED\n`);
// Large diagnostic fixture: preserve all bytes without unnecessarily putting
// the entire tool/stderr stream in the retry's command-line prompt.
const errText = (attempt: number) => `retained stderr ${attempt}\n${attempt === 1 ? "x".repeat(300_000) + "\n" : ""}`;

export async function fake(): Promise<void> {
  const dir = process.env.WHEELHOUSE_TEST_REFUSAL_DIR!;
  assert(fs.statSync(dir).isDirectory(), "fake requires an owned state directory");
  const harness = process.env.WHEELHOUSE_TEST_REFUSAL_HARNESS as Harness;
  const calls = path.join(dir, "calls.jsonl");
  const attempt = rows(calls).length + 1;
  const argv = process.argv.slice(2), prompt = argv.at(-1)!;
  const account = process.env.PI_CODING_AGENT_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME;
  fs.appendFileSync(calls, JSON.stringify({ attempt, pid: process.pid, cwd: process.cwd(), account, actor: process.env.BEADS_ACTOR, argv: argv.slice(0, -1), prompt }) + "\n");
  assert(attempt <= 2, "dispatcher offered more than one retry");
  if (attempt === 2) {
    fs.writeFileSync(path.join(dir, "retry-ready"), "yes");
    // A readiness barrier, not a timed success/failure decision.
    while (!fs.existsSync(path.join(dir, "release"))) await Bun.sleep(10);
  }
  const rc = prompt.match(/^- rc: (\d+)$/m)?.[1];
  const log = prompt.match(/^- log: (.+)$/m)?.[1];
  const text = attempt === 2 && process.env.WHEELHOUSE_TEST_REFUSAL_MODE === "recover"
    ? `reused checked evidence rc=${rc} log=${log}\nVERDICT: APPROVE\nPUSH: NOT CONSIDERED\n`
    : refusedText(attempt);
  process.stdout.write(wire(harness, text));
  process.stderr.write(errText(attempt));
}

async function checkCase(source: string, project: string, dir: string, bdShow: string, lock: string, harness: Harness, mode: "recover" | "exhaust"): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "bin"), clock = path.join(dir, "clock");
  fs.mkdirSync(bin); fs.mkdirSync(clock);
  const stub = `#!/usr/bin/env bun\nimport { fake } from ${JSON.stringify(import.meta.path)};\nawait fake();\n`;
  for (const name of ["pi", "claude", "codex"]) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755, flag: "wx" });
  const copy = path.join(project, "seats", `.verify-refusal-${randomUUID()}.ts`);
  fs.writeFileSync(copy, instrument(read(source)), { flag: "wx" });
  const bead = `bead-refusal-${harness}-${mode}`, verdicts = path.join(project, "seats", "verdicts");
  const canonical = path.join(verdicts, `${bead}.md`), inbox = path.join(project, "seats", "inbox.jsonl");
  const sweepLedger = path.join(dir, "sweeps"), callsFile = path.join(dir, "calls.jsonl");
  const refused = () => fs.existsSync(path.join(verdicts, "refused"))
    ? fs.readdirSync(path.join(verdicts, "refused")).filter(name => name.startsWith(`${bead}.`)).map(name => path.join(verdicts, "refused", name)) : [];
  const settles = () => rows(inbox).filter(row => row.class === "settle" && row.title === `verifier gate verdict — ${bead}`);
  assert(!fs.existsSync(canonical), "test bead already has a verdict");
  assert.equal(refused().length, 0, "test bead already has refused output");
  assert(!fs.existsSync(sweepLedger), "sweep measurement requires a fresh ledger");
  let ended = false, nativeExit = false, stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false;
  const child = spawn("bun", [copy, bead, "fleet/bead-1", "worker-1"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_BD_SHOW_FILE: bdShow,
      WHEELHOUSE_TEST_WATCHDOG_DIR: clock, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock,
      WHEELHOUSE_TEST_REFUSAL_DIR: dir, WHEELHOUSE_TEST_REFUSAL_HARNESS: harness,
      WHEELHOUSE_TEST_REFUSAL_MODE: mode, STUB_REFUSAL_SWEEP_LEDGER: sweepLedger },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("exit", () => { nativeExit = true; });
  child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
  child.stdout!.on("end", () => { stdoutEOF = true; }); child.stderr!.on("end", () => { stderrEOF = true; });
  const result = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  try {
    await until(() => fs.existsSync(path.join(dir, "retry-ready")), () => nativeExit, "one in-invocation retry (no restart)");
    assert(!fs.existsSync(canonical), "refused first answer wrote a verdict before retry");
    assert.equal(settles().length, 0, "refused first answer emitted a verdict settle event");
    const files = refused();
    assert.equal(files.length, 1, "raw first answer must be saved before offering retry");
    const firstBytes = read(files[0]), first = JSON.parse(firstBytes);
    assert.equal(first.status, "REFUSED"); assert.equal(first.notAVerdict, true);
    assert.equal(first.stdout, wire(harness, refusedText(1))); assert.equal(first.stderr, errText(1));
    assert.match(first.reason, /^reviewer must cite full-sweep rc=0 and log=/);
    assert.equal(first.attempt, 1); assert.equal(first.verifierSeat, "reviewer");
    assert.equal(first.harness, harness);
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
    assert(!/^\s*(?:- verdict:|VERDICT:|PUSH:)/m.test(firstBytes), "diagnostic must not have live Markdown verdict lines");
    assert(files[0].endsWith(".json"), "recursive *.md readers must not inventory diagnostic as a verdict");
    const calls = rows(callsFile);
    assert.equal(calls.length, 2);
    for (const field of ["cwd", "account", "actor"]) assert.equal(calls[0][field], calls[1][field], `retry changed ${field}`);
    assert.equal(calls[0].actor, "reviewer");
    assert.deepEqual(calls[0].argv, calls[1].argv, "retry changed harness/model/provider/tool arguments");
    assert(calls[1].prompt.includes(first.reason), "retry lacks refusal reason");
    assert(calls[1].prompt.includes(JSON.stringify({ answer: refusedText(1) })), "retry lacks complete prior-answer context");
    assert(calls[1].prompt.includes(files[0]), "retry lacks the retained raw diagnostic path");
    assert(calls[1].prompt.includes("NEVER rerun that sweep"));
    assert(calls[1].prompt.includes(`- log: ${first.sweep.logPath}`));
    assert.equal(calls[0].prompt.match(/^- log: (.+)$/m)?.[1], first.sweep.logPath);
    assert(fs.statSync(first.sweep.logPath).isFile(), "completed sweep log must exist before measuring reuse");
    assert(read(first.sweep.logPath).includes("fixture sweep PASS"));
    assert(fs.statSync(sweepLedger).isFile(), "fixture sweep must have run before counting it");
    assert.deepEqual(read(sweepLedger).trim().split("\n"), [first.tip], "retry reran the completed sweep");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: calls[1].cwd, encoding: "utf8" }).trim(), first.tip);
    fs.writeFileSync(path.join(dir, "release"), "yes");
    const status = await result;
    assert.deepEqual(status, { code: mode === "recover" ? 0 : 1, signal: null }, `unexpected dispatcher result: ${stderr}`);
    assert(stdoutEOF && stderrEOF, "must join both output EOFs");
    assert.equal(rows(callsFile).length, 2, "dispatcher made more than two reviewer attempts");
    assert.equal(read(files[0]), firstBytes, "retry overwrote first refused output");
    assert.deepEqual(read(sweepLedger).trim().split("\n"), [first.tip], "sweep reran after the retry barrier");
    if (mode === "recover") {
      assert(fs.statSync(canonical).isFile());
      const accepted = read(canonical);
      assert.match(accepted, /^- verdict: APPROVE$/m);
      assert(accepted.includes(`rc=0 log=${first.sweep.logPath}`));
      assert(!accepted.includes("retained answer 1:"), "refused text leaked into accepted output");
      assert.equal(settles().length, 1); assert.equal(refused().length, 1);
    } else {
      assert(!fs.existsSync(canonical), "twice-refused output wrote a verdict");
      assert.equal(settles().length, 0); assert.equal(refused().length, 2);
      const second = refused().map(file => JSON.parse(read(file))).find(row => row.attempt === 2);
      assert(second, "second refused answer must also be retained");
      assert.equal(second.status, "REFUSED"); assert.equal(second.notAVerdict, true);
      assert.equal(second.stdout, wire(harness, refusedText(2))); assert.equal(second.stderr, errText(2));
      assert.equal(second.reason, first.reason); assert.deepEqual(second.sweep, first.sweep);
    }
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ...status, stdoutEOF, stderrEOF, attempts: 2, sweeps: 1, refused: refused().length, verdict: mode === "recover" }, null, 2) + "\n");
    console.log(`PASS refusal ${harness}/${mode}: raw stdout+${Buffer.byteLength(first.stderr)} stderr bytes+reason retained, no premature verdict, same identity/context, attempts=2 sweeps=1 refused=${refused().length} verdict=${fs.existsSync(canonical)} settles=${settles().length}, both EOF`);
  } finally {
    fs.writeFileSync(path.join(dir, "release"), "cleanup"); // Release only our fake's file waiter on assertion failure.
    if (!nativeExit) child.kill("SIGTERM");
    if (!ended) await result;
    fs.writeFileSync(path.join(dir, "stdout"), stdout); fs.writeFileSync(path.join(dir, "stderr"), stderr);
    fs.unlinkSync(copy);
  }
}

async function main(): Promise<void> {
  const [source, project, state, bdShow, lock] = process.argv.slice(2);
  for (const file of [source, bdShow]) assert(fs.statSync(file).isFile(), `missing fixture input ${file}`);
  let parent = path.dirname(state);
  while (parent !== path.dirname(parent) && !fs.existsSync(path.join(parent, ".wheelhouse-selftest-fixture"))) parent = path.dirname(parent);
  assert(fs.existsSync(path.join(parent, ".wheelhouse-selftest-fixture")), "state must descend from the isolated shell fixture");
  const rosterFile = path.join(project, "seats", "seats.json"), original = read(rosterFile);
  let failed = 0;
  try {
    for (const harness of ["pi", "claude-code", "codex"] as const) {
      const roster = JSON.parse(original), entry = roster.seats.reviewer;
      entry.harness = harness;
      if (harness === "claude-code") {
        entry.provider = "anthropic"; entry.account.authRoute = "oauth";
        const account = entry.account.dir.replace(/^~/, process.env.HOME!);
        fs.writeFileSync(path.join(account, ".claude.json"), JSON.stringify({ oauthAccount: { email: "reviewer@example.test", accessToken: "fixture-token" } }));
      }
      fs.writeFileSync(rosterFile, JSON.stringify(roster));
      for (const mode of ["recover", "exhaust"] as const) {
        try { await checkCase(source, project, path.join(state, `${harness}-${mode}`), bdShow, lock, harness, mode); }
        catch (error) { failed++; console.error(`FAIL refusal ${harness}/${mode}: ${error instanceof Error ? error.message : error}`); }
      }
    }
  } finally { fs.writeFileSync(rosterFile, original); }
  assert.equal(failed, 0, `${failed} refusal/retry regression legs failed`);
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
