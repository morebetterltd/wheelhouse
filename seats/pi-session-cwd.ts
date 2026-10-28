import * as fs from "node:fs";
import * as path from "node:path";

/** Only a proven missing cwd in a pi header authorizes dropping continuity.
 * Read at most the header, never a potentially enormous conversation. Unknown,
 * unreadable, legacy and other-harness formats retain their existing launch path.
 */
export function missingPiSessionCwd(file: string, launchCwd = process.cwd()): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      const newline = buffer.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline < 0 ? n : newline)));
      if (newline >= 0) break;
    }
    const header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (header?.type !== "session" || typeof header.id !== "string" ||
        typeof header.cwd !== "string" || !header.cwd) return null;
    try { fs.statSync(path.resolve(launchCwd, header.cwd)); }
    catch (error: any) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return header.cwd;
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
