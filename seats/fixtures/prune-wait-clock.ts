// The parallel-cleanup selftest asserts progress, not deadline expiry. Keep
// its 30-second lock budget stationary while real Git/bd/lsof work runs. The
// containing suite still owns the real wall-clock containment deadline.
if (!process.argv.includes("cleanup") || !process.argv.includes("--wait")) {
  throw new Error("prune wait clock is only for the explicit cleanup --wait fixture");
}
const started = Date.now();
Date.now = () => started;
