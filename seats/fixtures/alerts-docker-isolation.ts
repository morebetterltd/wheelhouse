// Closed PATH: "host Docker" below is an owned canary, never the installed CLI.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [implementation, scratch, mode = "all"] = process.argv.slice(2);
assert(process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE, "source selftest-lib before running this fixture");
assert(["all", "guard", "outside", "symlink", "over-budget", "oversize"].includes(mode), "known isolation case");
fs.mkdirSync(scratch, { recursive: true });
const base = fs.realpathSync(scratch), runtime = path.dirname(implementation);
const capture = fs.readFileSync(path.join(import.meta.dir, "docker-system-df.jsonl"), "utf8");
const payload = capture.trim().split("\n").map(s => { const r = JSON.parse(s); return JSON.stringify(r.Type === "Build Cache" ? { ...r, Size: "19.5GB" } : r); }).join("\n") + "\n";
const records: any[] = [], tag = "DOCKER_ISOLATION_ASSERTION";
function save() {
  const text = JSON.stringify({ implementation, source: fs.readFileSync(implementation, "utf8"), records }, null, 2) + "\n";
  fs.writeFileSync(path.join(base, "results.json"), text);
  if (process.env.WHEELHOUSE_DOCKER_ISOLATION_EVIDENCE) fs.writeFileSync(path.join(process.env.WHEELHOUSE_DOCKER_ISOLATION_EVIDENCE, `isolation-${process.pid}.json`), text);
}
function setup(name: string) {
  const dir = path.join(base, name), root = path.join(dir, "install"), seats = path.join(root, "seats"), bin = path.join(root, "bin"), host = path.join(dir, "host-bin"), home = path.join(dir, "home");
  for (const d of [seats, bin, host, home, path.join(root, "wheelhouse")]) fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(runtime)) if (/\.(ts|sh)$/.test(f) && !f.endsWith(".selftest.sh")) fs.copyFileSync(path.join(runtime, f), path.join(seats, f));
  fs.copyFileSync(implementation, path.join(seats, "alerts.ts"));
  fs.writeFileSync(path.join(seats, "seats.json"), '{"seats":{}}\n'); fs.writeFileSync(path.join(seats, "state.json"), '{"seats":{}}\n');
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), "github-issue-watch=off\nalert-low-disk-gb=0\nalert-human-after-minutes=999999\n");
  fs.writeFileSync(path.join(seats, "template-drift.sh"), '#!/usr/bin/env bash\nprintf \'{"modified":[],"localOnly":[],"missing":[],"aheadBy":0}\\n\'\n');
  for (const tool of ["bun", "bash"]) { const executable = Bun.which(tool); assert(executable); fs.symlinkSync(executable, path.join(bin, tool)); }
  fs.writeFileSync(path.join(dir, "ready"), "1");
  fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bun\nconst fs=require('fs');console.log(fs.readFileSync(${JSON.stringify(path.join(dir, "ready"))},'utf8')==='1'?'[{"id":"fixture-ready","title":"fixture"}]':'[]');\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "response"), payload);
  fs.writeFileSync(path.join(dir, "mode"), "normal");
  const program = (calls: string) => ["#!/usr/bin/env bun", "const fs=require('fs');", `const dir=${JSON.stringify(dir)};`, `fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid,ppid:process.ppid,args:process.argv.slice(2),uid:process.getuid()})+'\\n');`, "const mode=fs.readFileSync(dir+'/mode','utf8');", "if(mode==='hold')setTimeout(()=>{fs.writeFileSync(dir+'/late','late');process.stdout.write(fs.readFileSync(dir+'/response'));},8000);", "else if(mode==='large'){process.stdout.write(fs.readFileSync(dir+'/response')+' '.repeat(70000));setTimeout(()=>{},8000);}", "else process.stdout.write(fs.readFileSync(dir+'/response'));", ""].join("\n");
  const fixture = path.join(bin, "fixture-docker"), canary = path.join(host, "docker");
  fs.writeFileSync(fixture, program(path.join(dir, "fixture-calls")), { mode: 0o755 });
  fs.writeFileSync(canary, program(path.join(dir, "host-calls")), { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${host}`, WHEELHOUSE_ALERTS_ROOT: root };
  delete env.WHEELHOUSE_ALERTS_FIXTURE_DOCKER;
  const rec: any = { name, dir, root, fixture, canary, attempts: [] }; records.push(rec);
  async function check(executable?: string) {
    const child = spawn(path.join(bin, "bun"), [path.join(seats, "alerts.ts"), "check", "--json"], { cwd: root, env: { ...env, ...(executable ? { WHEELHOUSE_ALERTS_FIXTURE_DOCKER: executable } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = []; let stdoutEOF = false, stderrEOF = false;
    child.stdout!.on("data", b => out.push(b)); child.stderr!.on("data", b => err.push(b)); child.stdout!.on("end", () => stdoutEOF = true); child.stderr!.on("end", () => stderrEOF = true);
    const native: any = await new Promise((yes, no) => { child.once("error", no); child.once("close", (code, signal) => yes({ pid: child.pid, code, signal })); });
    Object.assign(native, { stdoutEOF, stderrEOF, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    rec.attempts.push({ executable, native }); save();
    assert.equal(native.code, 0, `${tag} ${name}: healthy alerts CLI: ${native.stderr}`); assert.equal(native.signal, null); assert(stdoutEOF && stderrEOF);
    const snapshot = JSON.parse(fs.readFileSync(path.join(seats, "run/fleet-snapshot.json"), "utf8"));
    const inbox = fs.existsSync(path.join(seats, "inbox.jsonl")) ? fs.readFileSync(path.join(seats, "inbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    Object.assign(rec.attempts.at(-1), { snapshot, inbox }); save();
    assert(!fs.existsSync(path.join(dir, "host-calls")), `${tag} ${name}: fallback host Docker executed`);
    return { snapshot, inbox };
  }
  return { dir, fixture, canary, check };
}
function otherChecks(result: any, name: string) {
  assert.equal(result.snapshot.snapshot.readyCount, 1, `${tag} ${name}: ready work observed`);
  assert(result.inbox.some((r: any) => r.source?.name === "idle-fleet-ready-work"), `${tag} ${name}: other alert fired`);
}
function noDockerRows(result: any, name: string) {
  assert(!result.inbox.some((r: any) => r.source?.name === "docker-cache-pressure"), `${tag} ${name}: no Docker row`);
  assert(result.inbox.every((r: any) => ["idle-fleet-ready-work", "cold-seats-ready-work"].includes(r.source?.name)), `${tag} ${name}: no error row`);
}
try {
  if (mode === "all" || mode === "guard") {
  const off = setup("default-off"), quiet = await off.check();
  assert.equal(quiet.snapshot.docker.status, "disabled", `${tag} default-off: fixture probe disabled`); noDockerRows(quiet, "default-off"); otherChecks(quiet, "default-off");
  assert(!fs.existsSync(path.join(off.dir, "fixture-calls")), `${tag} default-off: no implicit fixture opt-in`);
  console.log("PASS Docker isolation default-off: host canary calls0, implicit fixture calls0, other alert fired");
  }
  if (mode !== "guard") {
    for (const kind of ["outside", "symlink"]) {
      if (mode !== "all" && mode !== kind) continue;
      const p = setup(kind); let executable = p.canary;
      if (kind === "symlink") { executable = path.join(path.dirname(p.fixture), "linked-docker"); fs.symlinkSync(p.canary, executable); }
      const r = await p.check(executable); assert.equal(r.snapshot.docker.status, "unavailable", `${tag} ${kind}: bad override unavailable`); noDockerRows(r, kind); otherChecks(r, kind);
      console.log(`PASS Docker isolation ${kind}: invalid override never falls back to host PATH`);
    }
    if (mode === "all" || mode === "over-budget") {
    const held = setup("over-budget"); fs.writeFileSync(path.join(held.dir, "ready"), "0");
    const first = await held.check(held.fixture); assert.equal(first.snapshot.docker.status, "ok", `${tag} over-budget: healthy initial pressure`);
    assert(first.snapshot.alerts["docker-cache-pressure"].active, `${tag} over-budget: initial pressure active`);
    fs.writeFileSync(path.join(held.dir, "mode"), "hold"); fs.writeFileSync(path.join(held.dir, "ready"), "1");
    const second = await held.check(held.fixture);
    assert.equal(second.snapshot.docker.signal, "SIGKILL", `${tag} over-budget: client retired by deadline`);
    assert.equal(second.snapshot.docker.status, "unavailable", `${tag} over-budget: not a completed measurement`);
    assert.deepEqual(second.snapshot.alerts["docker-cache-pressure"], first.snapshot.alerts["docker-cache-pressure"], `${tag} over-budget: unknown must preserve pressure`);
    assert.equal(second.inbox.filter((r: any) => r.source?.name === "docker-cache-pressure").length, 1, `${tag} over-budget: no repeat/error row`);
    assert(!fs.existsSync(path.join(held.dir, "late")), `${tag} over-budget: no late output after deadline`); otherChecks(second, "over-budget");
    console.log("PASS Docker isolation over-budget: native SIGKILL, pressure preserved, no late output, other alert fired");
    }
    if (mode === "all" || mode === "oversize") {
    const large = setup("oversize"); fs.writeFileSync(path.join(large.dir, "mode"), "large");
    const r = await large.check(large.fixture); assert.equal(r.snapshot.docker.status, "unavailable", `${tag} oversize: no partial measurement`);
    assert(Buffer.byteLength(r.snapshot.docker.stdout) <= 65536, `${tag} oversize: bounded diagnostics`); noDockerRows(r, "oversize"); otherChecks(r, "oversize");
    console.log("PASS Docker isolation oversize: bounded unknown observation, other alert fired");
    }
  }
} finally { save(); }
