// Test-only logical clock. The first deadline read gets the original epoch;
// subsequent rpc() reads cross the OLD 20s/60s budgets after the peer barrier.
// Captured native Bun stack shape: Error -> Date.now shim -> at rpc (...).
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.env.WHEELHOUSE_RPC_CLOCK_DIR!;
const nativeNow = Date.now.bind(Date);
const epoch = nativeNow();
let primed = false;
Date.now = () => {
  const caller = new Error().stack?.split("\n")[2] ?? "";
  if (/\bat rpc \(/.test(caller)) {
    if (!primed) {
      primed = true;
      fs.writeFileSync(path.join(dir, "old-clock-armed"), caller + "\n");
      return epoch;
    }
    return epoch + (fs.existsSync(path.join(dir, "advance")) ? 60001 : 0);
  }
  return nativeNow();
};

let observations = 0;
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: any, ...args: any[]) => {
  if (String(chunk).startsWith("WAIT:") && fs.existsSync(path.join(dir, "observe"))) {
    const progress = path.join(dir, "progress"), next = progress + ".next";
    fs.writeFileSync(next, JSON.stringify({
      message: String(chunk), observations: ++observations,
      virtualAdvanceMs: fs.existsSync(path.join(dir, "advance")) ? 60001 : 0,
    }) + "\n");
    fs.renameSync(next, progress); // the controller never reads a partial record
  }
  return write(chunk, ...args);
}) as typeof process.stderr.write;
