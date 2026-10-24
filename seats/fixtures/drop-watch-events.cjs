// Deterministic test instrumentation: suppress notifications, not file state.
const fs = require('node:fs');
const {EventEmitter} = require('node:events');
const nativeWatch = fs.watch;
const stats = { subscriptions: 0, closed: 0 };
fs.watch = function droppedWatch() {
  stats.subscriptions++;
  const watcher = new EventEmitter();
  let closed = false;
  watcher.close = () => { if (!closed) { closed = true; stats.closed++; } };
  return watcher;
};
// Node named builtin exports must see the same hook as default/CJS imports.
if (!process.versions.bun) require('node:module').syncBuiltinESMExports();
module.exports = { stats, nativeWatch };
