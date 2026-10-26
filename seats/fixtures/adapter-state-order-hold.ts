// Scheduling seam ONLY for the fault-planted order-control adapter copy.
// The real SIGTERM has already been sent. Keep deliberately held test setup
// outside the production stop grace; neither that grace nor positive proof
// is changed. The owner releases this gate AFTER joining the peer's exit.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import conditionWait from "./wait-for-condition.cjs";
const { waitForCondition } = conditionWait;

export async function holdStopForOrderControl(root: string, name: string, peerPid: number) {
  assert(["worker-a", "worker-b"].includes(name));
  const dir = path.join(root, "barriers"), release = path.join(dir, `${name}.stop-release`);
  const peer = JSON.parse(fs.readFileSync(path.join(dir, `${name}.ready`), "utf8"));
  assert.equal(peer.pid, peerPid);
  const observed = waitForCondition({ site: 'adapter-state-order-hold.release', paths: [dir], predicate: () => fs.existsSync(release) });
  try {
    const checkpoint = { stopPid: process.pid, peerPid, token: peer.token,
      gatePresent: fs.existsSync(release), pendingConditions: conditionWait.pendingConditions() };
    fs.writeFileSync(path.join(dir, `${name}.stop-held`), JSON.stringify(checkpoint));
    // A resolved/ungated observer must not masquerade as held native setup.
    assert.equal(checkpoint.gatePresent, false, "CONTROL_NATIVE_HOLD_ORACLE: owner release must not precede setup");
    assert.equal(checkpoint.pendingConditions, 1, "CONTROL_NATIVE_HOLD_ORACLE: native stop must await the owner event before its grace starts");
    await observed.promise;
    assert(fs.existsSync(release), "control stop release event must exist");
    fs.writeFileSync(path.join(dir, `${name}.stop-returned`), JSON.stringify({ ...checkpoint, releaseObserved: true }));
  } finally { observed.cancel(); }
}
