// Regressions for slow native completion and a genuinely missing executable.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const [project, owner] = process.argv.slice(2);
assert(fs.statSync(path.join(owner, ".wheelhouse-selftest-fixture")).isFile());
assert.equal(path.dirname(project), owner);
const evidence = process.env.WHEELHOUSE_DIGEST_BD_EVIDENCE || path.join(owner, "bd-read-evidence");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const stub = path.join(project, "bin/bd"), original = fs.readFileSync(stub), mode = fs.statSync(stub).mode & 0o777;
const readRows = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
try {
  for (const kind of ["slow", "missing", "missing-removal"] as const) {
    const dir = path.join(evidence, kind); fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(stub, original, { mode });
    const env = { ...process.env, WHEELHOUSE_DIGEST_ROOT: project, DIGEST_BD_DIAG: dir,
      DIGEST_BD_INSTALL_FIXTURE: kind === "slow" ? "1" : "0", DIGEST_BD_SLOW_FIRST: kind === "slow" ? "1" : "0" };
    if (kind !== "slow") {
      // Remove only directories that actually provide bd; keep other tooling
      // (including any host-budget shim directory) rather than invent exit127.
      const dirs = (env.PATH || "").split(path.delimiter), removed: string[] = [];
      env.PATH = dirs.filter(d => { try { fs.accessSync(path.join(d, "bd"), fs.constants.X_OK); removed.push(d); return false; } catch { return true; } }).join(path.delimiter);
      assert(!removed.some(d => /\/seats\/bin\/?$/.test(d)), "cannot bypass a host-budget shim to hide bd");
      assert(Bun.which("bun", { PATH: env.PATH }), "the child runtime must remain available");
      assert.equal(Bun.which("bd", { PATH: env.PATH }), null, "missing case must genuinely have no bd executable");
      fs.writeFileSync(path.join(dir, "missing-path.private.json"), JSON.stringify({ removed, bd: null, PATH: env.PATH }) + "\n", { mode: 0o600 });
    }
    let codeRoot = project;
    if (kind === "missing-removal") {
      codeRoot = path.join(owner, "bd-missing-removal");
      fs.cpSync(path.join(project, "seats"), path.join(codeRoot, "seats"), { recursive: true });
      const file = path.join(codeRoot, "seats/digest.ts"), source = fs.readFileSync(file, "utf8");
      const before = "const unknown=(reason:string)=>({rows:[], unavailable:true, diagnostic:";
      assert.equal(source.split(before).length - 1, 1, "remove only main's bd unavailable result");
      fs.writeFileSync(file, source.replace(before, "const unknown=(reason:string)=>({rows:[], unavailable:false, diagnostic:"));
    }
    const command = ["bun", "--preload", path.join(import.meta.dir, "digest-bd-observer.ts"), path.join(codeRoot, "seats/digest.ts"), "--since", "2026-01-01T00:00:00Z", "--until", "2026-01-02T00:00:00Z"];
    const child = Bun.spawn(command, { cwd: project, env, stdin: "ignore", stdout: Bun.file(path.join(dir, "digest.stdout")), stderr: Bun.file(path.join(dir, "digest.stderr")) });
    const code = await child.exited, signal = child.signalCode ?? null;
    fs.writeFileSync(path.join(dir, "digest.native.json"), JSON.stringify({ command, code, signal }) + "\n", { mode: 0o600 });
    assert.equal(code, 0, "digest rendering/setup must succeed independently of bd availability"); assert.equal(signal, null);
    const calls = readRows(path.join(dir, "native.jsonl")); assert.equal(calls.length, 2, "observe both actual bd reads, not zero calls");
    assert.deepEqual(calls.map(r => r.command), [["bd", "list", "--json", "--limit", "0", "--status", "closed"], ["bd", "list", "--json", "--limit", "0", "--label", "needs-review"]]);
    const text = fs.readFileSync(path.join(dir, "digest.stdout"), "utf8");
    if (kind === "slow") {
      for (const call of calls) { assert.equal(call.status, 0, "slow original bd must complete, not time out"); assert.equal(call.signal, null); assert.equal(call.error, null); assert.equal(call.options.timeout, null); }
      const events = readRows(path.join(dir, "producer.jsonl")), delayed = events.filter(r => r.event === "started" && r.slow);
      assert.equal(delayed.length, 1); assert.equal(delayed[0].pid, calls[0].childPid);
      assert(events.some(r => r.event === "payload-written" && r.pid === delayed[0].pid && r.bytes > 0), "original delayed child supplied real fixture JSON");
      assert(text.includes("Build the package") && text.includes("3 tasks titled \"closed holder\"") && text.includes("Review the package"));
      assert(!text.includes("[bd unavailable]"));
      console.log("PASS digest slow closed read: original native child/JSON completed beyond old 5000ms cut; no deadline/retry verdict");
    } else {
      for (const call of calls) {
        // Node uses null; Bun may omit status on a spawn error. Neither is
        // a native exit127 (or any completed command).
        assert(call.status === null || (call.status === undefined && call.statusType === "undefined"));
        assert.equal(call.error?.code, "ENOENT");
      }
      const count = text.split("[bd unavailable]").length - 1;
      const check = () => assert.equal(count, 2, "both unavailable sections must remain explicit, not empty/healthy");
      if (kind === "missing") {
        check();
        console.log("PASS digest missing bd: actual ENOENT, both sections [bd unavailable]");
      } else {
        // Native setup, rendering, both real spawn errors and source mutation
        // are checked above, outside expected-rejection credit.
        assert.equal(count, 0, "removal must actually discard both unavailable flags");
        assert.throws(check, assert.AssertionError, "removing unavailable must reject with valid native setup");
        console.log("REJECT digest missing-bd unavailable removal: native digest0, actual ENOENT, UI checker rejected");
      }
    }
  }
} finally { fs.writeFileSync(stub, original, { mode }); fs.chmodSync(stub, mode); }
