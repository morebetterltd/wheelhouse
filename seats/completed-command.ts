// Observe native completion and the bytes it actually wrote. A busy host is
// neither a command deadline nor a bound on process-list / graph output size.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | NodeJS.ArrayBufferView };
type CommandResult<T> = Omit<SpawnSyncReturns<Buffer>, "stdout" | "stderr"> & { stdout: T; stderr: T };

// Preserve the original UTF-8 default. Callers needing exact binary bytes opt
// in with encoding: null, including wrappers emulating execFileSync's default.
export function completedCommand(file: string, args: string[], options: CommandOptions & { encoding: null }): CommandResult<Buffer>;
export function completedCommand(file: string, args: string[], options?: CommandOptions & { encoding?: BufferEncoding }): CommandResult<string>;
export function completedCommand(file: string, args: string[], options: CommandOptions & { encoding?: BufferEncoding | null }): CommandResult<string | Buffer>;
export function completedCommand(file: string, args: string[], options: CommandOptions & { encoding?: BufferEncoding | null } = {}): CommandResult<string | Buffer> {
  const { input, encoding = "utf8", ...spawnOptions } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheelhouse-command-"));
  const descriptors: number[] = [];
  try {
    const stdout = path.join(dir, "stdout"), stderr = path.join(dir, "stderr");
    descriptors.push(fs.openSync(stdout, "wx", 0o600));
    descriptors.push(fs.openSync(stderr, "wx", 0o600));
    let stdin: number | "ignore" = "ignore";
    if (input !== undefined) {
      const file = path.join(dir, "stdin");
      fs.writeFileSync(file, input, { encoding: encoding ?? "utf8", flag: "wx", mode: 0o600 });
      stdin = fs.openSync(file, "r");
      descriptors.push(stdin);
    }
    // Regular descriptors avoid both pipe maxBuffer and synchronous runtime
    // capture loss. Stdin is also a regular descriptor, positioned at byte zero;
    // empty input delivers EOF rather than inheriting a live terminal or pipe.
    // No timeout/retry: native exit, signal or spawn error decides.
    const result = spawnSync(file, args, { ...spawnOptions, stdio: [stdin, descriptors[0], descriptors[1]] });
    return { ...result, stdout: fs.readFileSync(stdout, encoding), stderr: fs.readFileSync(stderr, encoding) };
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
