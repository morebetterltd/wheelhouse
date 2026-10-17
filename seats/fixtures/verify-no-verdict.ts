// Terminal events come from the existing captured verify-real streams; only
// their assistant text is replaced. No live provider, installed login, or sweep.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { instrument, until } from "./verify-readiness";

export function afterResult(done: boolean): void {
  const dir = process.env.WHEELHOUSE_NO_VERDICT_CASE!;
  if (!fs.existsSync(path.join(dir, "observed.json"))) fs.writeFileSync(path.join(dir, "observed.json"), JSON.stringify({ done }));
}

async function fakeReviewer(): Promise<void> {
  const dir = process.env.WHEELHOUSE_NO_VERDICT_CASE!;
  fs.writeFileSync(path.join(dir, "prompt.txt"), process.argv.at(-1)!);
  fs.writeFileSync(path.join(dir, "reviewer.pid"), String(process.pid));
  const interim = process.env.WHEELHOUSE_NO_VERDICT_INTERIM!;
  fs.writeFileSync(interim, "Static half complete; bench pending; collecting dispatch owed.\n");
  const scratch = path.join(process.cwd(), "seats/verdicts"); fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, path.basename(interim)), "Scratch-only interim must survive checkout removal.\n");
  process.once("SIGTERM", () => { fs.writeFileSync(path.join(dir, "terminated"), "yes"); process.exit(0); });
  const stream = fs.readFileSync(path.join(dir, "stream.jsonl"), "utf8");
  // Split the terminal frame to test a partial JSON chunk as well as a live
  // stdout FD after result. setImmediate is ordering, not an elapsed deadline.
  const cut = stream.lastIndexOf("\n", stream.length - 2) + 8;
  process.stdout.write(stream.slice(0, cut));
  await new Promise<void>(resolve => setImmediate(resolve));
  process.stdout.write(stream.slice(cut), () => {
    if (process.env.WHEELHOUSE_NO_VERDICT_HOLD === "1") setInterval(() => {}, 1000);
    else process.exit(0);
  });
}

async function test(): Promise<void> {
  const [here, root, source] = process.argv.slice(2);
  assert(here && root && source && fs.statSync(source).isFile());
  assert(fs.existsSync(path.join(root, ".wheelhouse-selftest-fixture")));
  const raw = fs.readFileSync(source, "utf8");
  const anchor = "      reapAfterFinalVerdict();";
  assert.equal(raw.split(anchor).length, 2, "result observation anchor");
  const observer = `\n      if (sawFinalReviewerResult(out(), opts.harness)) fixtureAfterResult(done);`;
  const timed = instrument(raw.replace(anchor, anchor + observer));
  const at = timed.startsWith("#!") ? timed.indexOf("\n") + 1 : 0;
  const code = timed.slice(0, at) + `import { afterResult as fixtureAfterResult } from ${JSON.stringify(import.meta.path)};\n` + timed.slice(at);
  const runtime = path.join(root, "runtime/seats");
  const command = (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, dir: string, label: string) => {
    const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
    fs.writeFileSync(path.join(dir, label + ".out"), r.stdout ?? ""); fs.writeFileSync(path.join(dir, label + ".err"), r.stderr ?? "");
    assert.equal(r.status, 0, `${label}: ${r.stderr}`); return r.stdout;
  };
  const fixtures = [
    ["pi", "pi-v3-message-end.jsonl", "agent_end"],
    ["claude-code", "claude-code-2.1.278-assistant.jsonl", "result"],
    ["codex", "codex-0.144.0-item-completed-agent-message.jsonl", "turn.completed"],
  ];
  let failures = 0;
  for (const [harness, capture, terminalType] of fixtures) for (const hold of [true, false]) {
    const name = `${harness}-${hold ? "held" : "eof"}`, dir = path.join(root, name), proj = path.join(dir, "project"), bin = path.join(dir, "bin");
    fs.mkdirSync(dir); fs.mkdirSync(proj); fs.mkdirSync(bin); fs.mkdirSync(path.join(proj, "contracts"));
    fs.cpSync(runtime, path.join(proj, "seats"), { recursive: true });
    fs.writeFileSync(path.join(proj, "seats/verify.ts"), code);
    fs.writeFileSync(path.join(proj, "contracts/REVIEWER.md"), "# Reviewer\nReview this local fixture.\n");
    const author = path.join(dir, "author"), reviewer = path.join(dir, "reviewer"); fs.mkdirSync(author); fs.mkdirSync(reviewer);
    fs.writeFileSync(path.join(reviewer, "auth.json"), JSON.stringify({ fixture: true }));
    fs.writeFileSync(path.join(reviewer, ".claude.json"), JSON.stringify({ oauthAccount: { email: "fixture@example.invalid", accessToken: "fixture-token" } }));
    fs.writeFileSync(path.join(proj, "seats/seats.json"), JSON.stringify({ seats: {
      author: { role: "worker", account: { dir: author } },
      reviewer: { role: "verifier", harness, provider: harness === "claude-code" ? "anthropic" : "openai", model: "fixture", account: { dir: reviewer } },
    } }));
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    for (const cli of ["pi", "claude", "codex"]) fs.writeFileSync(path.join(bin, cli), `#!/usr/bin/env bash\nexec bun ${quote(import.meta.path)} --reviewer "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_TEST_WATCHDOG_DIR: dir, WHEELHOUSE_NO_VERDICT_CASE: dir, WHEELHOUSE_NO_VERDICT_HOLD: hold ? "1" : "0" };
    const created = JSON.parse(command("bd", ["create", `no-verdict ${name}`, "--description", "## Done\nA local fake reviewer fixture completes.", "--json"], proj, env, dir, "create"));
    assert(created.id); const bead = created.id;
    const vdir = path.join(proj, "seats/verdicts"); fs.mkdirSync(vdir);
    const saved = [".md", ".partial.md"].map(suffix => path.join(vdir, bead + suffix));
    for (const file of saved) fs.writeFileSync(file, "Existing interim record must survive.\n");
    const interim = path.join(vdir, bead + ".interim.md"); env.WHEELHOUSE_NO_VERDICT_INTERIM = interim;
    const events = fs.readFileSync(path.join(here, "fixtures/verify-real", capture), "utf8").trim().split("\n").map(x => JSON.parse(x));
    const terminal = structuredClone(events.find(x => x.type === terminalType)); assert(terminal);
    const text = "I started the background sweep. I'll write the verdict when it finishes.";
    let assistant: any;
    if (harness === "pi") {
      assistant = structuredClone(events.find(x => x.type === "message_end" && x.message?.role === "assistant"));
      assistant.message.content = [{ type: "text", text }]; terminal.messages = [{ role: "assistant", content: [{ type: "text", text }] }];
    } else if (harness === "claude-code") {
      assistant = structuredClone(events.find(x => x.type === "assistant")); assistant.message.content = [{ type: "text", text }]; terminal.result = text;
    } else {
      assistant = structuredClone(events.find(x => x.type === "item.completed")); assistant.item.text = text;
    }
    fs.writeFileSync(path.join(dir, "stream.jsonl"), [assistant, terminal].map(x => JSON.stringify(x)).join("\n") + "\n");
    command("git", ["init", "-q", "-b", "main"], proj, env, dir, "init");
    command("git", ["add", "seats", "contracts"], proj, env, dir, "add");
    command("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], proj, env, dir, "commit");
    const child = spawn("bun", [path.join(proj, "seats/verify.ts"), bead, "main", "author", "reviewer", "--timeout-ms", "900000", "--no-event-timeout-ms", "600000"], { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", ended = false;
    child.stdout!.on("data", b => { out += b; }); child.stderr!.on("data", b => { err += b; }); child.once("exit", () => { ended = true; });
    const closed = new Promise<{ status: number | null; signal: string | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (status, signal) => resolve({ status, signal })); });
    try {
      await until(() => fs.existsSync(path.join(dir, "observed.json")), () => ended, "terminal event consumption");
    } catch (error: any) {
      const result = await closed;
      fs.writeFileSync(path.join(dir, "verify.out"), out); fs.writeFileSync(path.join(dir, "verify.err"), err);
      throw new Error(`${name}: ${error.message}; status=${result.status} signal=${result.signal}\nstdout:\n${out}\nstderr:\n${err}`);
    }
    const observed = JSON.parse(fs.readFileSync(path.join(dir, "observed.json"), "utf8"));
    // Fix-removed control: explicitly expire the manual watchdog to unwind it,
    // then reject it. No ten-minute sleep and no wall-clock success threshold.
    if (!observed.done && !ended) fs.writeFileSync(path.join(dir, "expire-event"), "control unwind\n");
    const result = await closed;
    fs.writeFileSync(path.join(dir, "verify.out"), out); fs.writeFileSync(path.join(dir, "verify.err"), err);
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ...result, observed, stdoutEOF: child.stdout!.readableEnded, stderrEOF: child.stderr!.readableEnded }));
    try {
      assert(observed.done, "terminal callback must finish before any watchdog is advanced");
      assert.equal(result.status, 5); assert.equal(result.signal, null); assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
      assert(!fs.existsSync(path.join(dir, "stop")) && !fs.existsSync(path.join(dir, "expire-event")));
      assert(fs.existsSync(path.join(dir, "cancelled-event")) && fs.existsSync(path.join(dir, "cancelled-first")));
      assert(err.includes("NO-VERDICT:"));
      for (const file of saved) assert.equal(fs.readFileSync(file, "utf8"), "Existing interim record must survive.\n");
      assert.equal(fs.readFileSync(interim, "utf8"), "Static half complete; bench pending; collecting dispatch owed.\n");
      const prompt = fs.readFileSync(path.join(dir, "prompt.txt"), "utf8");
      assert(prompt.includes("sweep cannot finish inside this turn") && prompt.includes("write an interim record") && prompt.includes("never end the turn with a promise to return"));
      const retained = fs.readdirSync(vdir).filter(x => x.startsWith(bead + ".retained."));
      assert(retained.some(x => fs.readFileSync(path.join(vdir, x), "utf8") === "Scratch-only interim must survive checkout removal.\n"));
      const records = fs.readdirSync(vdir).filter(x => x.startsWith(bead + ".no-verdict.")); assert.equal(records.length, 1);
      const record = fs.readFileSync(path.join(vdir, records[0]), "utf8"); assert(record.includes("outcome: no-verdict") && record.includes(text));
      const inbox = fs.readFileSync(path.join(proj, "seats/inbox.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x));
      assert.equal(inbox.length, 1); assert.equal(inbox[0].source.type, "verifier-no-verdict"); assert(inbox[0].detail.includes("outcome: no-verdict") && inbox[0].detail.includes("task comment recorded"));
      const comments = JSON.parse(command("bd", ["comments", bead, "--json"], proj, env, dir, "comments"));
      assert.equal(comments.length, 1); assert.equal(comments[0].author, "verifier-gate"); assert(comments[0].text.includes("outcome: no-verdict") && comments[0].text.includes("without a live VERDICT line"));
      console.log(`PASS ${name}: terminal -> no-verdict5 before watchdog; task+inbox recorded; interim byte-preserved; both EOF`);
    } catch (error: any) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`verify-no-verdict: ${6 - failures}/6 passed`);
  assert.equal(failures, 0);
}
if (import.meta.main) (process.argv[2] === "--reviewer" ? fakeReviewer() : test()).catch(error => { console.error(error); process.exitCode = 1; });
