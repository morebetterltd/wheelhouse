import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [moduleFile, root, bead, action] = process.argv.slice(2);
try {
  const lib = await import(pathToFileURL(moduleFile).href);
  if (action === "prepare") {
    const result = lib.prepareTaskScratch(root, bead);
    const marker = JSON.parse(fs.readFileSync(path.join(result.target, lib.SCRATCH_MARKER), "utf8"));
    console.log(JSON.stringify({ owned: result.owned, version: marker.version, hostId: marker.hostId, hostname: marker.hostname }));
  } else if (action === "read") {
    lib.scratchOwnership(root, path.join(root, ".wheelhouse-runs", bead), bead);
    console.log(JSON.stringify({ accepted: true }));
  } else if (action === "lock" || action === "seed-lock") {
    const release = lib.acquireCleanupLock(root, 0);
    assert(release, "fixture lock must be acquired");
    const marker = JSON.parse(fs.readFileSync(path.join(root, "seats/run/cleanup.lock/wheelhouse-cleanup-lock"), "utf8"));
    if (action === "lock") release(); // seed-lock deliberately leaves a dead child owner.
    console.log(JSON.stringify({ version: marker.version, hostId: marker.hostId, hostname: marker.hostname }));
  } else throw new Error("unknown cleanup host probe action");
} catch (e: any) { console.error(e.message); process.exitCode = 2; }
