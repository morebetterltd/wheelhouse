// Observe native completion and the bytes it actually wrote. A busy host is
// neither a command deadline nor a bound on process-list / graph output size.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function completedCommand(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheelhouse-command-"));
  const descriptors: number[] = [];
  try {
    const stdout = path.join(dir, "stdout"), stderr = path.join(dir, "stderr");
    descriptors.push(fs.openSync(stdout, "wx", 0o600));
    descriptors.push(fs.openSync(stderr, "wx", 0o600));
    // Regular descriptors avoid both pipe maxBuffer and synchronous runtime
    // capture loss. No timeout/retry: native exit, signal or spawn error decides.
    const result = spawnSync(file, args, { ...options, stdio: ["ignore", descriptors[0], descriptors[1]] });
    return { ...result, stdout: fs.readFileSync(stdout, "utf8"), stderr: fs.readFileSync(stderr, "utf8") };
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
