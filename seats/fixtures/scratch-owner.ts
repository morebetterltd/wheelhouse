// Benign owner for janitor fixtures: real makeScratchCwd, no model or account.
import * as fs from "node:fs";
const [mode, moduleFile, repo, kind, receipt] = process.argv.slice(2);
if (!["dead", "live"].includes(mode) || !["verify", "review"].includes(kind)) throw Error("bad scratch-owner fixture arguments");
const { makeScratchCwd } = await import(moduleFile);
const dir = makeScratchCwd(repo, kind);
fs.writeFileSync(receipt, JSON.stringify({ pid: process.pid, dir }) + "\n");
if (mode === "dead") process.kill(process.pid, "SIGKILL");
else setInterval(() => {}, 1000);
