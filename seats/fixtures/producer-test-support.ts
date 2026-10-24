import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
export function copyRuntime(source: string, root: string) {
  const dest = path.join(root, "seats"); fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(source, { withFileTypes: true })) {
    if (f.isFile() && /\.(?:ts|[cm]?js|sh)$/.test(f.name) && !f.name.endsWith(".selftest.sh")) fs.copyFileSync(path.join(source, f.name), path.join(dest, f.name));
  }
  if (fs.existsSync(path.join(source, "drivers"))) fs.cpSync(path.join(source, "drivers"), path.join(dest, "drivers"), { recursive: true });
  return dest;
}
export async function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = []; let stdoutEOF = false, stderrEOF = false, error: any = null;
  child.stdout.on("data", x => out.push(x)); child.stderr.on("data", x => err.push(x));
  child.stdout.on("end", () => stdoutEOF = true); child.stderr.on("end", () => stderrEOF = true);
  child.on("error", e => error = { message: e.message, code: (e as any).code });
  const result = await new Promise<any>(yes => child.on("close", (code, signal) => yes({ code, signal })));
  return { file, args, cwd, pid: child.pid, ...result, error, stdoutEOF, stderrEOF, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}
export function retain(root: string, category: string, data: any) {
  const body = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(path.join(root, category + ".json"), body);
  const evidence = process.env.WHEELHOUSE_PRODUCER_SKILLS_EVIDENCE;
  if (evidence) fs.writeFileSync(path.join(evidence, `${category}-${process.pid}.json`), body);
}
export function changed(text: string, old: string, replacement: string) {
  if (text.split(old).length !== 2) throw Error("CONTROL_SETUP mutation must match once: " + old);
  const result = text.replace(old, replacement);
  if (result === text) throw Error("CONTROL_SETUP mutation changed no bytes");
  return result;
}
