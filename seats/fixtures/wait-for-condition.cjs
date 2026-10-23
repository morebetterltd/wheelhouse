// Test-only condition observation. A watch wake is advisory, never the verdict.
// Rechecking has a scheduling cadence, NOT an elapsed correctness deadline.
const fs = require('node:fs');
const active = new Set();
let nextId = 0;
function trace(event) {
  if (process.env.WHEELHOUSE_CONDITION_TRACE) fs.appendFileSync(process.env.WHEELHOUSE_CONDITION_TRACE,
    JSON.stringify({ pid: process.pid, ...event }) + '\n', { mode: 0o600 });
}
function waitForCondition({ predicate, site, paths = [], interval = 50 }) {
  if (typeof predicate !== 'function' || typeof site !== 'string' || !site ||
      !Array.isArray(paths) || !Number.isInteger(interval) || interval <= 0) {
    throw new TypeError('waitForCondition requires a predicate, named site, paths and positive observation interval');
  }
  const id = ++nextId, watchers = [];
  let timer, disposed = false, settled = false, checking = false, initiallyPending = false;
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  function dispose() {
    if (disposed) return [];
    disposed = true;
    clearInterval(timer);
    active.delete(reconcile);
    const errors = [];
    for (const watcher of watchers.splice(0)) {
      try { watcher.close(); } catch (error) { errors.push(error); }
    }
    return errors;
  }
  function failure(error) {
    if (settled) return;
    settled = true;
    dispose();
    const named = new Error(`condition wait ${site}: ${error?.message ?? error}`, { cause: error });
    reject(named);
  }
  function reconcile(origin = 'checkpoint') {
    if (disposed || checking) return;
    checking = true;
    try {
      const value = predicate();
      if (value && typeof value.then === 'function') throw new TypeError('predicate must synchronously observe the condition');
      if (value) {
        const errors = dispose();
        if (errors.length) { failure(errors[0]); return; }
        trace({ id, site, event: 'resolved', origin, initiallyPending });
        settled = true; resolve(value);
      } else if (!initiallyPending) {
        initiallyPending = true;
        trace({ id, site, event: 'pending', origin });
      }
    } catch (error) { failure(error); }
    finally { checking = false; }
  }
  active.add(reconcile);
  for (const target of [...new Set(paths)]) {
    if (disposed) break;
    try {
      const watcher = fs.watch(target, () => reconcile('watch'));
      if (disposed) { watcher.close(); break; }
      watchers.push(watcher);
      // Losing a subscription does not lose the condition observer. A genuine
      // predicate/read error still rejects above; no unknown becomes success.
      watcher.on('error', error => {
        try { trace({ id, site, event: 'watch-unavailable', code: error.code }); } catch (captureError) { failure(captureError); }
      });
    } catch (error) {
      try { trace({ id, site, event: 'watch-unavailable', code: error.code }); } catch (captureError) { failure(captureError); }
    }
  }
  if (!disposed) {
    timer = setInterval(() => reconcile('recheck'), interval);
    reconcile('initial');
  }
  return {
    promise,
    // The owner may abandon a losing race. Disposal invents no condition or
    // verdict, and leaves no ref'ed timer/watch keeping the process alive.
    cancel() { const errors = dispose(); if (errors.length) throw errors[0]; },
    close() { const errors = dispose(); if (errors.length) throw errors[0]; },
  };
}
function reconcileConditions() {
  // Explicit fixture IPC checkpoints invoke the actual registered checks,
  // including lifecycle/EOF predicates; not a second implementation of them.
  const checks = [...active];
  for (const check of checks) check('checkpoint');
  return checks.length;
}
module.exports = { waitForCondition, reconcileConditions, pendingConditions: () => active.size };
