// Deterministic fixture instrumentation, loaded by Node --import (never eval).
import fs from 'node:fs';
const nativeWatch = fs.watch, nativeWatchFile = fs.watchFile, write = fs.writeSync;
const reconciliations = [];
let probes = 0, injected = false, readySent = false;
function ready() {
  if (readySent) return;
  readySent = true;
  setImmediate(() => process.send?.({ type: 'armed', reconciliations: reconciliations.length }));
}
fs.watch = function(target, ...args) {
  if (process.env.WHEELHOUSE_BARRIER_OBSERVE === 'arm-race' && !injected && String(target).endsWith('worker-a.jsonl')) {
    injected = true;
    fs.appendFileSync(target, JSON.stringify({ type: 'agent_end' }) + '\n');
    ready();
  }
  if (process.env.WHEELHOUSE_BARRIER_OBSERVE === 'lost-wake') {
    const i = args.findIndex(arg => typeof arg === 'function');
    if (i >= 0) args[i] = () => {}; // OS notifications suppressed, not file state.
  }
  return nativeWatch.call(this, target, ...args);
};
fs.watchFile = function(target, ...args) {
  const listener = args.find(arg => typeof arg === 'function');
  if (listener) reconciliations.push(listener);
  return nativeWatchFile.call(this, target, ...args);
};
fs.writeSync = function(...args) {
  const result = write.apply(this, args);
  try { if (JSON.parse(String(args[1])).type === 'barrier_probe' && ++probes === 2) ready(); } catch {}
  return result;
};
process.on('message', message => {
  if (message.type !== 'checkpoint') return;
  // An explicit observation wake after native peer output has reached the
  // state files. No sleep, deadline, iteration budget or elapsed-time verdict.
  for (const listener of reconciliations) listener();
  process.send?.({ type: 'checkpoint', exitCode: process.exitCode ?? null });
});
// Instrumentation must not keep an otherwise completed barrier alive.
process.channel?.unref();
