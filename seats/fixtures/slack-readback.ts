// Offline Slack protocol fixtures, explicitly docs-derived, not live recordings.
// Sources/provenance and literal raw/entity text live in slack-readback-docs.json.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { completedCommand } from "../completed-command";
const [here, base, implementation, kind, mutation = "none"] = process.argv.slice(2);
assert(fs.statSync(implementation).isFile());
let marked = false;
for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, ".wheelhouse-selftest-fixture"))) { marked = true; break; }
  if (path.dirname(dir) === dir) break;
}
assert(marked, "Slack fixture requires an owned scratch ancestor");
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "slack-readback-docs.json"), "utf8"));
assert(fixture.provenance.kind.includes("docs-derived"));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const save = (file: string, value: any) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const marker = (name: string) => `SLACK_READBACK_ASSERTION ${name}`;
if (!kind) {
  fs.mkdirSync(base);
  const results = [];
  const cases = [
    ["escaped", "none"], ["plain", "none"], ["missing-ts", "none"], ["wrong-content", "none"],
    ["nested-escape", "none"], ["message-channel", "none"], ["ref-channel", "none"], ["need-send", "none"],
    ["escaped", "exact-text"], ["need-send", "exact-text"], ["missing-ts", "ignore-ts"],
    ["wrong-content", "ignore-content"], ["nested-escape", "double-decode"],
    ["message-channel", "ignore-message-channel"], ["ref-channel", "ignore-ref-channel"],
  ];
  for (const [name, change] of cases) {
    const dir = path.join(base, name + "-" + change);
    const child = completedCommand("bun", [import.meta.path, here, dir, implementation, name, change]);
    fs.writeFileSync(dir + ".stdout", child.stdout); fs.writeFileSync(dir + ".stderr", child.stderr);
    save(dir + ".native.json", { status: child.status, signal: child.signal ?? null, error: child.error?.message ?? null });
    assert(!child.signal && !child.error, "case must finish naturally");
    // Measurement and protocol setup must exist before a negative can grade.
    const record = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    results.push(record);
    if (change === "none") {
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(`PASS Slack read-back ${name}: native client${record.client.code}, verified=${record.verified}, posts=${record.posts}, reads=${record.reads}`);
    } else {
      assert.equal(child.status, 1, "removal must reject at its consumer assertion");
      assert(child.stderr.includes("AssertionError: " + marker(name)), child.stderr);
      if (change === "exact-text") {
        assert.equal(record.client.code, 1); assert.equal(record.verified, false);
        assert(record.client.stderr.includes("send unverified"));
        assert.equal(record.targetPresent, true); assert.equal(record.posts, 1); assert.equal(record.reads, 1);
      } else {
        assert.equal(record.client.code, 0); assert.equal(record.verified, true);
        if (name !== "ref-channel") assert.equal(record.ledger.filter((x: any) => x.type === "sent").length, 1);
      }
      console.log(`REJECT Slack read-back ${name}/${change}: native case1 at ${marker(name)}; actual client${record.client.code}, verified=${record.verified}`);
    }
  }
  save(path.join(base, "result.json"), results);
  const evidence = process.env.WHEELHOUSE_SLACK_READBACK_EVIDENCE;
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(base, entry.name), path.join(evidence, entry.name));
      else if (entry.isDirectory()) {
        const file = path.join(base, entry.name, "result.json");
        assert(fs.lstatSync(file).isFile());
        fs.copyFileSync(file, path.join(evidence, entry.name + ".result.json"));
      }
    }
  }
  console.log("slack-readback: PASS (8 consumer cases, 7 meaningful removals; loopback/docs only)");
} else {
  fs.mkdirSync(base);
  const project = path.join(base, "project"), home = path.join(base, "home");
  fs.mkdirSync(project); fs.mkdirSync(home);
  const copy = completedCommand("bash", ["-c", '. "$1/selftest-lib.sh"; selftest_copy_seat_runtime "$2" "$1"', "copy", here, project]);
  assert.equal(copy.status, 0, copy.stderr); assert(!copy.signal && !copy.error);
  const moduleFile = path.join(project, "seats/transports/slack.ts"); fs.copyFileSync(implementation, moduleFile);
  const original = fs.readFileSync(moduleFile, "utf8");
  const normalized = 'comparisonText(String(m.text ?? "")) === comparisonText(text)';
  const refGuard = '    if (parts.length > 1 || (parts[0] && parts[0] !== destination)) return false;';
  const singlePass = 'return text.replace(/&(amp|lt|gt);/g, (_, entity) => decoded[entity]);';
  const replacements: Record<string, [string, string]> = {
    "exact-text": [normalized, 'String(m.text ?? "") === text'],
    "ignore-ts": ['String(m.ts) === String(ts)', 'true'],
    "ignore-content": [normalized, 'true'],
    "double-decode": [singlePass, 'return text.replace(/&(amp|lt|gt);/g, (_, entity) => decoded[entity]).replace(/&(amp|lt|gt);/g, (_, entity) => decoded[entity]);'],
    "ignore-message-channel": ['(m.channel === undefined || String(m.channel) === destination)', 'true'],
    "ignore-ref-channel": [refGuard, '    // reference channel check removed'],
  };
  if (mutation !== "none") {
    const [needle, replacement] = replacements[mutation];
    assert(needle && original.split(needle).length === 2, "unique actual read-back mutation");
    fs.writeFileSync(moduleFile, original.replace(needle, replacement));
  }
  fs.writeFileSync(path.join(project, "seats/seats.json"), '{"seats":{"worker-1":{"role":"worker"}}}\n');
  fs.writeFileSync(path.join(project, "seats/channels.json"), JSON.stringify({ version: 1, channels: { partners: {
    kind: "slack", destination: fixture.channel, audience: "stakeholders", members: [], read: true,
  } } }));
  const ledgerFile = path.join(project, "seats/comms.jsonl"); fs.writeFileSync(ledgerFile, "");
  const text = kind === "plain" ? "shipping tonight" : fixture.submitted;
  const post = structuredClone(fixture.post), history = structuredClone(fixture.history);
  if (kind === "plain") { post.message.text = text; history.messages[0].text = text; }
  if (kind === "missing-ts") history.messages[0].ts = "1503435955.000247";
  if (kind === "wrong-content") history.messages[0].text = "a different message";
  if (kind === "nested-escape") history.messages[0].text = history.messages[0].text.replaceAll("&", "&amp;");
  if (kind === "message-channel") history.messages[0].channel = "C_OTHER";
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url), body: any = await req.json();
    assert.equal(req.headers.get("authorization"), "Bearer fixture-slack-not-a-token");
    let response: any;
    if (u.pathname === "/chat.postMessage") {
      assert.equal(body.channel, fixture.channel); assert.equal(body.text, text); response = post;
    } else if (u.pathname === "/conversations.history") {
      assert.equal(body.channel, fixture.channel); assert.equal(body.latest, fixture.ts);
      assert.equal(body.inclusive, true); assert.equal(body.limit, 20); response = history;
    } else throw new Error("unexpected fixture API path: " + u.pathname);
    requests.push({ path: u.pathname, body, response }); return Response.json(response);
  } });
  const origin = "http://127.0.0.1:" + server.port, guard = path.join(base, "offline.ts");
  fs.writeFileSync(guard, `const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{
const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
if(url.origin!==process.env.AR34_FIXTURE_ORIGIN)throw Error('fixture refuses external network');
return nativeFetch(input,init);};`);
  const direct = path.join(project, "direct.ts");
  fs.writeFileSync(direct, `import {SlackTransport} from './seats/transports/slack';
const t=new SlackTransport(process.env.WHEELHOUSE_COMMS_ROOT);
try { if(process.argv[2]==='ref-channel')console.log(JSON.stringify({verified:await t.readBack(${JSON.stringify(fixture.channel)},${JSON.stringify("C_OTHER:" + fixture.ts)},${JSON.stringify(text)})}));
else console.log(JSON.stringify({ref:(await t.send({type:'message',id:'fixture-need',at:'2000-01-01T00:00:00Z',from:'commander',text:${JSON.stringify(text)}})).ref}));
} catch(error){console.error(error.message);process.exitCode=1;}
`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), BEADS_ACTOR: "commander",
    WHEELHOUSE_COMMS_ROOT: project, WHEELHOUSE_NEEDS_ROOT: project, WHEELHOUSE_SLACK_CHANNEL: fixture.channel,
    WHEELHOUSE_SLACK_TOKEN: "fixture-slack-not-a-token", WHEELHOUSE_SLACK_API_BASE: origin, AR34_FIXTURE_ORIGIN: origin };
  try {
    const isDirect = kind === "ref-channel" || kind === "need-send";
    const args = ["--preload", guard, ...(isDirect ? [direct, kind] : ["seats/comms.ts", "send", "partners", "--from-stdin"])];
    const child = spawn("bun", args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false;
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.stdout.on("end", () => { stdoutEOF = true; }); child.stderr.on("end", () => { stderrEOF = true; });
    child.stdin.end(isDirect ? undefined : text);
    const client = await new Promise<any>((yes, no) => { child.once("error", no); child.once("close", (code, signal) => yes({ pid: child.pid, code, signal, stdout, stderr, stdoutEOF, stderrEOF })); });
    const ledgerText = fs.readFileSync(ledgerFile, "utf8"), ledger = ledgerText.split("\n").filter(Boolean).map(x => JSON.parse(x));
    const directResult = isDirect && client.code === 0 ? JSON.parse(client.stdout) : null;
    const verified = kind === "ref-channel" ? directResult?.verified === true : client.code === 0;
    const posts = requests.filter(x => x.path === "/chat.postMessage").length, reads = requests.filter(x => x.path === "/conversations.history").length;
    const expected = ["escaped", "plain", "need-send"].includes(kind);
    const record = { kind, mutation, client, verified, expected, posts, reads, requests, ledger,
      targetPresent: history.messages.some((m: any) => m.ts === fixture.ts), inputSha256: hash(text),
      moduleSha256: hash(fs.readFileSync(moduleFile, "utf8")), fixtureKind: fixture.provenance.kind,
      endpoint: { host: "127.0.0.1", port: server.port } };
    save(path.join(base, "result.json"), record);
    console.log("MEASUREMENT Slack read-back " + JSON.stringify({ kind, mutation, client, verified, expected, posts, reads }));
    assert.equal(client.signal, null); assert(client.stdoutEOF && client.stderrEOF);
    // These are setup/protocol assertions, outside the consumer verdict.
    assert.equal(posts, kind === "ref-channel" ? 0 : 1, "exactly one post; never resend");
    assert.equal(reads, kind === "ref-channel" && mutation === "none" ? 0 : 1, "one read-back except invalid reference refused before API");
    assert.equal(verified, expected, marker(kind) + ": identity and documented-equivalent content must both verify, unrelated messages must not");
    if (!isDirect) {
      assert.equal(client.code, expected ? 0 : 1, marker(kind));
      assert.equal(ledger.length, 1); assert.equal(ledger[0].type, expected ? "sent" : "failed");
      assert.equal(ledger[0].ref, fixture.channel + ":" + fixture.ts);
      if (expected) { assert.equal(ledger[0].sha256, hash(text)); assert.equal(ledger[0].readBack, "fetched"); assert(!ledgerText.includes(text)); assert(client.stdout.startsWith("sent partners ")); assert.equal(client.stderr, ""); }
      else assert(client.stderr.includes("STOP: send unverified: slack read-back did not return"));
    } else {
      assert.equal(ledger.length, 0, "direct transport must not manufacture comms ledger rows");
      assert.equal(client.code, 0, marker(kind)); assert.equal(client.stderr, "");
      if (kind === "need-send") assert.equal(directResult.ref, fixture.channel + ":" + fixture.ts);
    }
  } finally { server.stop(true); }
}
