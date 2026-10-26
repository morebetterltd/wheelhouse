import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [runtime, parent] = process.argv.slice(2);
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(path.join(runtime, "seats/adapter.ts")).isFile());
assert(!fs.existsSync(path.join(runtime, "seats/state.json")), "copy code, never a live fleet state");
const source = fs.readFileSync(path.join(runtime, "seats/adapter.ts"), "utf8");
for (const harness of ["pi", "claude-code", "codex"]) {
  for (const mode of ["observed", "unavailable"]) {
    const label = `${harness}-${mode}`;
    function run(removed: boolean) {
      const root = path.join(parent, `birth-${label}-${removed ? "removed" : "positive"}`);
      fs.cpSync(runtime, root, { recursive: true });
      if (removed) {
        let changed: string;
        if (mode === "observed") {
          assert.equal(source.split("...birth").length - 1, 3, "three actual launch-record producers required");
          changed = source.replaceAll("...birth", "startedAt: new Date().toISOString()");
        } else {
          const old = 'return { startedAt: "", birthUnverified: detail };';
          assert.equal(source.split(old).length - 1, 1, "specific uncertain-birth refusal required");
          changed = source.replace(old, 'return { startedAt: new Date().toISOString(), birthUnverified: detail };');
        }
        fs.writeFileSync(path.join(root, "seats/adapter.ts"), changed);
      }
      const out = fs.openSync(path.join(root, "driver.out"), "wx", 0o600), err = fs.openSync(path.join(root, "driver.err"), "wx", 0o600);
      let r;
      try { r = spawnSync("bun", [path.join(import.meta.dir, "native-birth-child.ts"), root, harness, mode], { cwd: root, env: process.env, stdio: ["ignore", out, err] }); }
      finally { fs.closeSync(out); fs.closeSync(err); }
      const stdout = fs.readFileSync(path.join(root, "driver.out"), "utf8"), stderr = fs.readFileSync(path.join(root, "driver.err"), "utf8");
      assert(!r.error && !r.signal, "native birth fixture must start and complete");
      assert.equal(r.status, 0, "setup/retirement failure is NOT a sensitivity success: " + stderr);
      const lines = stdout.split("\n").filter(line => line.startsWith("NATIVE_BIRTH_RESULT "));
      assert.equal(lines.length, 1); const result = JSON.parse(lines[0].slice("NATIVE_BIRTH_RESULT ".length));
      assert.equal(result.inputComplete, true); assert.equal(result.cliNative, 0);
      console.log(lines[0]);
      return result;
    }
    const positive = run(false);
    assert.equal(positive.checkerAccepted, true, positive.error);
    console.log("PASS native-birth " + label);
    const removed = run(true);
    assert.equal(removed.checkerAccepted, false, "meaningful producer removal must reject with all native input/close proofs intact");
    console.log("REJECT native-birth " + label + " driverNative=0 originalChildClose=0");
  }
}
console.log("PASS native-birth: 6 observations, 6 meaningful removals; true child births or explicit uncertainty, unchanged timestamp tolerance, no added signals");
