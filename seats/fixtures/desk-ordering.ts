// Real desk + real digest + gated native bd children. Assert server event order,
// never response latency. A rescue releases stuck observations, not a pass.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { observeDesk, observeDigest, events, completion, http } from "./desk-observation";
const [fixture, template] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, ".wheelhouse-selftest-fixture")).isFile());
async function until(test: () => boolean, child: ReturnType<typeof Bun.spawn>, label: string) {
  const end = performance.now() + 20000;
  while (!test()) { if (child.exitCode != null || child.signalCode != null) throw Error("INCOMPLETE desk exited before " + label); if (performance.now() >= end) throw Error("INCOMPLETE " + label); await Bun.sleep(25); }
}
async function join(child: ReturnType<typeof Bun.spawn>) { let timer: any; try { return await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("INCOMPLETE original desk join")), 20000); })]); } finally { clearTimeout(timer); } }
const results: any[] = [];
for (const kind of ["board", "digest-page", "needs-during-digest"]) for (const broken of [false, true]) {
  const name = kind + (broken ? "-coupled" : "-independent"), root = path.join(fixture, "ordering-" + name), seats = path.join(root, "seats"), run = path.join(seats, "run");
  fs.mkdirSync(root); fs.cpSync(path.join(template, "seats"), seats, { recursive: true }); fs.rmSync(run,{recursive:true,force:true}); fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(root, "bin")); fs.mkdirSync(path.join(root, "wheelhouse")); fs.mkdirSync(path.join(root, "bd-enter"));
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "namespace=ordering\n");
  fs.writeFileSync(path.join(seats, "needs.jsonl"), JSON.stringify({ type: "opened", id: "ordering-need", at: new Date().toISOString(), kind: "question", title: "Ordering fixture", body: "A real response", options: [], machine: {} }) + "\n");
  const gate = path.join(root, "release"), stub = path.join(root, "bin/bd");
  fs.writeFileSync(stub, `#!/usr/bin/env bun\nimport fs from "node:fs";const root=${JSON.stringify(root)};fs.writeFileSync(root+"/bd-enter/"+process.pid+".json",JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\nprocess.on("SIGTERM",()=>{fs.appendFileSync(root+"/bd-exits",String(process.pid)+"\\n");process.exit(143);});\nwhile(!fs.existsSync(root+"/release"))await Bun.sleep(25);console.log(process.argv[2]==="ready"?"":"[]");process.exit(0);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(seats,"digest.ts"),observeDigest(fs.readFileSync(path.join(seats,"digest.ts"),"utf8")));
  let source = observeDesk(fs.readFileSync(path.join(seats, "desk.ts"), "utf8"));
  if (broken) {
    const anchor = 'async function handle(req: Request): Promise<Response> { const u=new URL(req.url);'; assert.equal(source.split(anchor).length, 2);
    const fault = kind === "board" ? 'if(u.pathname==="/needs")while(boardRefreshing)await Bun.sleep(25);' : kind === "needs-during-digest" ? 'if(u.pathname==="/needs")while(digestRefreshing.has("hours:1"))await Bun.sleep(25);' : '';
    if (kind === "digest-page") { const before = 'if(req.method==="GET" && u.pathname==="/digest") { const r=digestFor(u);'; assert.equal(source.split(before).length, 2); source = source.replace(before, before + 'while(digestRefreshing.has(digestWindow(u).key))await Bun.sleep(25);'); }
    else source = source.replace(anchor, anchor + fault);
  }
  fs.writeFileSync(path.join(seats, "desk.ts"), source);
  console.log("DESK_ORDER_INPUT " + JSON.stringify({ name, broken, kind, sourceSha256: createHash("sha256").update(source).digest("hex"), gate: "native bd children held before output; server return vs background completion", policy: "no changed desk/digest deadlines, cache TTL or refresh cadence" }));
  const fds = ["out", "err"].map(s => fs.openSync(path.join(root, "desk." + s), "wx", 0o600));
  const child = Bun.spawn([process.execPath, path.join(seats, "desk.ts")], { cwd: root, env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH, WHEELHOUSE_DESK_ROOT: root, WHEELHOUSE_NEEDS_ROOT: root, WHEELHOUSE_DESK_PORT: "0" }, stdin: "ignore", stdout: fds[0], stderr: fds[1] });
  let rescued = false, timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => { if (!fs.existsSync(gate)) fs.writeFileSync(gate, "release\n"); };
  try {
    await until(() => fs.existsSync(path.join(run, "desk.port")), child, "listener publication");
    const base = new URL(fs.readFileSync(path.join(run, "desk.port"), "utf8").trim()).origin;
    await http(base + "/api/needs.json", path.join(root, "ready.json"), child.pid);
    await until(() => fs.readdirSync(path.join(root, "bd-enter")).length > 0, child, "real native bd entry");
    let response: Promise<{ status: number; body: string }>;
    const request = async (url: string) => { const r = await fetch(url); return { status: r.status, body: await r.text() }; };
    if (kind === "board") response = request(base + "/needs");
    else {
      const query = request(base + "/digest?hours=1");
      await until(() => { const rows = events(root), started = rows.find(x => x.kind === "digest-start" && x.key === "hours:1"); return started && rows.some(x => x.kind === "worker-enter" && x.since === started.since && x.until === started.until); }, child, "actual query worker entry");
      if (kind === "digest-page") response = query;
      else { const page = await query; assert.equal(page.status, 200, "query kickoff response"); response = request(base + "/needs"); }
    }
    // If a planted request awaits the background dependency, release it only
    // as rescue, then still require a genuine HTTP response and compare order.
    timer = setTimeout(() => { rescued = true; release(); }, 15000);
    const reply = await response;
    clearTimeout(timer); timer = undefined;
    assert.equal(reply.status, 200, "real HTTP response required even for a rejected control");
    assert(reply.body.includes(kind === "digest-page" ? "Wheelhouse digest" : "Ordering fixture"), "real response body");
    release();
    await completion(root, kind === "board" ? "board" : "digest", kind === "board" ? "" : "hours:1", child.pid);
    const rows = events(root), route = kind === "digest-page" ? "/digest" : "/needs";
    const entered = rows.findIndex(x => x.kind === "request-enter" && x.key === route), returned = rows.findIndex(x => x.kind === "request-return" && x.key === route), completed = rows.findIndex(x => x.kind === (kind === "board" ? "board" : "digest") && x.key === (kind === "board" ? "" : "hours:1"));
    assert(entered >= 0 && returned > entered && completed >= 0, "complete native request/background observations");
    if (kind !== "digest-page") assert(kind === "board" ? rows[entered].boardRefreshing : rows[entered].digestKeys.includes("hours:1"), "setup: actual dependency pending when handler entered");
    const accepted = returned < completed;
    let assertionRejected=false;try{assert(accepted,"request returned only after its background dependency completed");}catch(e){if(!(e instanceof assert.AssertionError))throw e;assertionRejected=true;}
    assert.equal(assertionRejected,broken,"same order assertion must reject the meaningful coupling break");
    const result = { name, broken, checkerAccepted: accepted, assertionRejected, requestEntered: entered, requestReturned: returned, backgroundCompleted: completed, rescued, inputComplete: true, httpStatus: reply.status, events: rows };
    results.push(result); fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log((broken ? "EXPECTED_REJECTION " : "PASS ") + "DESK_ORDER " + JSON.stringify(result));
  } finally {
    if (timer) clearTimeout(timer); release();
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    await join(child); for (const fd of fds) fs.closeSync(fd);
    console.log("DESK_CHILD_STREAMS " + JSON.stringify({ name, code: child.exitCode, signal: child.signalCode, stdout: fs.readFileSync(path.join(root, "desk.out"), "utf8"), stderr: fs.readFileSync(path.join(root, "desk.err"), "utf8") }));
  }
}
assert.equal(results.length, 6); console.log("desk-ordering: 3 independent request observations, 3 meaningful coupling rejections");
