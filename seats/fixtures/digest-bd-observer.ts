// Test-only interposer: capture the ORIGINAL native result, never replace it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mock } from "bun:test";
import * as native from "node:child_process";

const originals = { ...native }, dir = process.env.DIGEST_BD_DIAG;
const data = (v: any) => v === null || v === undefined ? null : {
  bytes: Buffer.byteLength(v), base64: Buffer.from(v).toString("base64"),
};
if (dir && /\/seats\/digest\.ts$/.test(process.argv[1] ?? "")) {
  mock.module("node:child_process", () => ({ ...originals, spawnSync: (file: any, args: any[], options: any) => {
    if (file !== "bd") return originals.spawnSync(file, args, options);
    const cwd = options?.cwd, owned = path.join(path.dirname(cwd), ".wheelhouse-selftest-fixture"), stub = path.join(cwd, "bin/bd");
    if (process.env.DIGEST_BD_INSTALL_FIXTURE === "1" && fs.existsSync(stub)) {
      if (!fs.statSync(owned).isFile()) throw Error("fixture ownership missing");
      const before = fs.readFileSync(stub);
      if (!before.includes("digest-bd-fixture")) {
        fs.appendFileSync(path.join(dir, "installed.jsonl"), JSON.stringify({ cwd, sha256: crypto.createHash("sha256").update(before).digest("hex") }) + "\n", { mode: 0o600 });
        fs.writeFileSync(stub, "#!/usr/bin/env node\n" + fs.readFileSync(path.join(import.meta.dir, "digest-bd.cjs"), "utf8"), { mode: 0o700 });
        fs.chmodSync(stub, 0o700);
      }
    }
    const before = new Date().toISOString(), result = originals.spawnSync(file, args, options);
    fs.appendFileSync(path.join(dir, "native.jsonl"), JSON.stringify({
      pid: process.pid, childPid: result.pid, command: [file, ...args], cwd, before, after: new Date().toISOString(),
      options: { timeout: options?.timeout ?? null, encoding: options?.encoding ?? null, stdio: options?.stdio ?? null },
      status: result.status, signal: result.signal,
      error: result.error ? { message: result.error.message, code: result.error.code, errno: result.error.errno, syscall: result.error.syscall } : null,
      stdout: data(result.stdout), stderr: data(result.stderr),
    }) + "\n", { mode: 0o600 });
    return result;
  } }));
}
