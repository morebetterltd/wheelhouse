// Deterministic fixture instrumentation, loaded by Node --import (never eval).
import fs from 'node:fs';
import conditionWait from './wait-for-condition.cjs';
const nativeWatch = fs.watch, write = fs.writeSync;
let probes = 0, injected = false, readySent = false;
function ready() {
  if (readySent) return;
  readySent = true;
  setImmediate(() => process.send?.({ type: 'armed', reconciliations: conditionWait.pendingConditions() }));
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
fs.writeSync = function(...args) {
  const result = write.apply(this, args);
  try { if (JSON.parse(String(args[1])).type === 'barrier_probe' && ++probes === 2) ready(); } catch {}
  return result;
};
process.on('message', message => {
  if (message.type !== 'checkpoint') return;
  // Ordinary regression checkpoint: the parent already observed the native
  // peer acknowledgements and persisted their records. Invoke only callbacks
  // registered by the actual barrier, not a substitute implementation of it.
  // A barrier with no reconciliation stays pending and fails the parent's
  // assertion immediately after this IPC response, without a timeout verdict.
  const reconciliations = conditionWait.reconcileConditions();
  process.send?.({ type: 'checkpoint', exitCode: process.exitCode ?? null, reconciliations });
});
// Instrumentation must not keep an otherwise completed barrier alive.
process.channel?.unref();
