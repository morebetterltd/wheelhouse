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

// New reply diagnostics use the same monotonic clock as WAIT and the opt-in
// budget. Only controlled held cases freeze it; drain/source-loss cases keep
// native time. Each step is released by the fixture after an observed report.
if (process.env.WHEELHOUSE_RPC_VIRTUAL_CLOCK === '1') {
  Object.defineProperty(performance, 'now', { value: () => {
    const step = path.join(dir, 'step');
    const value = fs.existsSync(step) ? Number(fs.readFileSync(step, 'utf8')) : 0;
    if (new Error().stack?.includes('at rpcReplyProgress (')) fs.writeFileSync(path.join(dir, 'armed'), 'reply monitor observed\n');
    return value;
  } });
}
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
    fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify({message:String(chunk),observations})+'\n');
  }
  return write(chunk, ...args);
}) as typeof process.stderr.write;
