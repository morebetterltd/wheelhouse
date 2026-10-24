// Shared launcher: readiness is success, an observed exit is failure, and a
// live child past the CLI's observation ceiling is still starting, not failed.
import fs from "node:fs";
import path from "node:path";
const [rootArg, name] = process.argv.slice(2);
if (!rootArg || !["herald", "desk", "courier", "supervisor"].includes(name)) {
  console.error("usage: daemon-start.ts <root> <herald|desk|courier|supervisor>");
  process.exit(2);
}
const root = path.resolve(rootArg), seats = path.join(root, "seats"), run = path.join(seats, "run"), logs = path.join(seats, "logs");
const pidFile = path.join(run, `${name}.pid`), portFile = path.join(run, "desk.port"), startingFile = path.join(run, `${name}.starting.pid`);
const ceilingMs = 5000; // CLI observation ceiling, never a daemon failure verdict.
fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
function text(file: string) { try { return fs.readFileSync(file, "utf8").trim(); } catch (e: any) { if (e.code === "ENOENT") return ""; throw e; } }
function pid(file = pidFile) { const raw = text(file); return /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 0; }
function alive(value: number) { if (!value) return false; try { process.kill(value, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; if (e.code === "EPERM") return true; throw e; } }
function deskPort() {
  let raw: string;
  try { raw = fs.readFileSync(portFile, "utf8").trim(); }
  catch (e: any) { if (e.code === "ENOENT") return ""; throw e; }
  try {
    const u = new URL(raw);
    if (!raw.startsWith("http://") || u.protocol !== "http:" || u.pathname !== "/needs" || u.username || u.password || u.search || u.hash) throw Error("not a desk URL");
  } catch { throw Error(`Invalid desk.port: expected a complete http://host[:port]/needs URL (${portFile})`); }
  return raw;
}
function observation() {
  const published = pid(), url = name === "desk" ? deskPort() : "";
  return { published, url, ready: alive(published) && (name !== "desk" || !!url) };
}
function retireStarting(value: number) { if (pid(startingFile) === value) fs.rmSync(startingFile, { force: true }); }
let child: ReturnType<typeof Bun.spawn> | undefined, exited: { code: number; signal: string | null } | undefined;
// Validate an existing port before a stale-PID restart can remove it. Corrupt
// publication is an error, not evidence that no desk has published.
if (name === "desk") deskPort();
const published = pid(), pending = pid(startingFile);
const prior = alive(published) ? published : (pending || published), existing = alive(prior);
if (!existing) {
  if (prior) console.log(`${name} dead: pid ${prior}; restarting`);
  // Herald/courier/supervisor publish their own readiness PID. Never replace a
  // live singleton winner with a concurrently refused child's launcher PID.
  if (name === "desk") { fs.rmSync(pidFile, { force: true }); fs.rmSync(portFile, { force: true }); }
  const fds = ["out", "stderr"].map(suffix => fs.openSync(path.join(logs, `${name}.${suffix}.log`), "a", 0o600));
  try {
    const command = name === "supervisor" ? ["/bin/bash", path.join(seats, "supervisor.sh")] : [process.execPath, path.join(seats, `${name}.ts`)];
    child = Bun.spawn(["nohup", ...command], { cwd: root, env: { ...process.env,
      [`WHEELHOUSE_${name.toUpperCase()}_ROOT`]: root,
      ...(name === "supervisor" ? { WHEELHOUSE_SUPERVISOR_STARTED_BY_COCKPIT: "1" } : {}),
    }, stdin: "ignore", stdout: fds[0], stderr: fds[1], detached: true });
    child.exited.then(code => { exited = { code, signal: child!.signalCode }; });
    const startingTemp = `${startingFile}.${process.pid}`;
    fs.writeFileSync(startingTemp, `${child.pid}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(startingTemp, startingFile);
    if (name === "desk") { const temp = `${pidFile}.${process.pid}`; fs.writeFileSync(temp, `${child.pid}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, pidFile); }
  } catch (e: any) {
    console.error(`STOP: ${name} launch error: ${e.message}`); process.exitCode = 1;
  } finally { for (const fd of fds) fs.closeSync(fd); }
}
if (existing || child) {
  const began = performance.now();
  try {
    for (;;) {
      const seen = observation();
      if (seen.ready && (!child || !exited || seen.published !== child.pid)) {
        retireStarting(seen.published);
        console.log(`${name} ${existing ? "already running" : "started"}: pid ${seen.published}${seen.url ? ` — ${seen.url}` : ""}`); break;
      }
      if (exited || (!child && !alive(prior))) {
        retireStarting(child?.pid ?? prior);
        console.error(`STOP: ${name} exited${exited ? ` code ${exited.code}${exited.signal ? ` signal ${exited.signal}` : ""}` : " before readiness"}; observed pid-file=${seen.published || "missing"}${name === "desk" ? ` desk.port=${seen.url || "missing"}` : ""}; see ${path.join(logs, name + ".stderr.log")}`);
        process.exitCode = 1; break;
      }
      if (performance.now() - began >= ceilingMs) {
        console.log(`${name} still starting: pid ${child?.pid ?? prior}; observed pid-file=${seen.published || "missing"}${name === "desk" ? ` desk.port=${seen.url || "missing"}` : ""}`); break;
      }
      // Poll spacing only: elapsed time never establishes readiness or death.
      await Bun.sleep(25);
    }
  } finally { child?.unref(); }
}
