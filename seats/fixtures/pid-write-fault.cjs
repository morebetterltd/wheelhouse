// File invocation is deliberate: Bun's default ESM fs export is not the mutable
// CommonJS builtin object used by the lock module. Inline CJS can swallow errors.
const fs = require("node:fs");
const path = require("node:path");
const [mode, moduleFile, file] = process.argv.slice(2);
if (!["adapter", "lock"].includes(mode) || !moduleFile || (mode === "lock" && !file)) {
  throw Error("usage: pid-write-fault.cjs adapter <adapter> | lock <module> <owned-lock>");
}
const message = mode === "adapter" ? "fixture PID write refusal" : "injected PID write failure";
const original = fs.writeFileSync;
let injected = false;
fs.writeFileSync = function (fd, ...args) {
  if (typeof fd === "number") { injected = true; throw Error(message); }
  return original.call(this, fd, ...args);
};
async function main() {
  if (mode === "adapter") {
    process.argv = [process.execPath, moduleFile, "stop", "worker-1"];
    await import(moduleFile);
    return;
  }
  const { acquirePidLock } = await import(moduleFile);
  let failed = false;
  try { acquirePidLock(file); }
  catch (error) { if (error.message !== message) throw error; failed = true; }
  if (!injected || !failed) throw Error("write fault did not reach the lock module");
  if (fs.existsSync(file)) throw Error("failed write left an empty public lock");
  if (fs.readdirSync(path.dirname(file)).some(name => name.startsWith(path.basename(file) + ".tmp."))) {
    throw Error("failed write left a temp candidate");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
