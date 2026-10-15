#!/usr/bin/env bun
/** Claims are data: only intake.ts posts signals; this bridge never edits the ISA. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { acquirePidLock, releasePidLock } from "./lock";

const ROOT = path.resolve(process.env.WHEELHOUSE_ISA_SIGNALS_ROOT || path.join(import.meta.dir, ".."));
const SNAPSHOT = path.join(ROOT, "seats", "run", "isa-claims.json");
const LOCK = path.join(ROOT, "seats", "run", "isa-signals.lock");
type Claim = { open: boolean; sha256: string };
type Snapshot = Record<string, Claim>;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function snapshot(): Snapshot | null {
  let raw: string;
  try { raw = fs.readFileSync(SNAPSHOT, "utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  const data = JSON.parse(raw);
  if (!data || Array.isArray(data) || typeof data !== "object" || Object.values(data).some((c: any) =>
    !c || typeof c.open !== "boolean" || !/^[a-f0-9]{64}$/.test(c.sha256))) throw new Error("invalid ISA claims snapshot");
  return data;
}
function claims(file: string): Map<string, { line: string; claim: Claim }> {
  const found = new Map<string, { line: string; claim: Claim }>();
  let inClaims = false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^## Claims\s*$/.test(line)) { inClaims = true; continue; }
    if (/^## /.test(line)) { inClaims = false; continue; }
    if (!inClaims) continue;
    const box = /^- \[([ x])\] (\S+)(?:\s.*)?$/.exec(line);
    const anti = /^- Anti: (\S+)(?:\s.*)?$/.exec(line);
    if (!box && !anti) continue;
    const id = box ? box[2] : anti![1];
    if (found.has(id)) throw new Error("duplicate ISA claim id");
    found.set(id, { line, claim: { open: box ? box[1] === " " : true, sha256: sha256(line) } });
  }
  return found;
}
function intake(args: string[], input = ""): string {
  const r = spawnSync("bun", [path.join(ROOT, "seats", "intake.ts"), ...args], {
    env: { ...process.env, WHEELHOUSE_INTAKE_ROOT: ROOT }, input, encoding: "utf8",
  });
  if (r.error || r.status !== 0) throw new Error(`intake ${args[0]} failed (exit ${r.status ?? "none"}): ${r.stderr.trim()}`);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.stdout;
}
function main(argv: string[]): void {
  const [command, ...args] = argv;
  if ((command !== "sync" && command !== "status") ||
    (command === "status" && args.length) ||
    (command === "sync" && args.length && (args.length !== 2 || args[0] !== "--isa" || !args[1]))) {
    throw new Error("usage: isa-signals.ts sync [--isa <path>] | status");
  }
  const fd = acquirePidLock(LOCK);
  if (fd === null) throw new Error("ISA claims sync busy; retry");
  try {
    const before = snapshot();
    if (command === "status") { console.log(`snapshot ${Object.keys(before ?? {}).length} claims`); return; }
    const current = claims(path.resolve(ROOT, args[1] || "wheelhouse/ISA.md"));
    let posted = 0;
    if (before !== null) {
      // The intake CLI owns its ledger. Retry after a partial sync does not
      // duplicate an undisposed row, even if the snapshot was not yet saved.
      const open = JSON.parse(intake(["list", "--open", "--json"]));
      if (!Array.isArray(open)) throw new Error("invalid open intake rows");
      const pending = new Set(open.map((r: any) => `${r.posted.source}\0${sha256(r.posted.text)}`));
      for (const [id, { line, claim }] of current) {
        if (!claim.open || before[id]?.sha256 === claim.sha256) continue;
        const key = `isa:${id}\0${claim.sha256}`;
        if (pending.has(key)) continue;
        intake(["post", "--kind", "isa-change", "--source", `isa:${id}`, "--title", `ISA claim ${id} changed`, "--ref", id, "--from-stdin"], line);
        pending.add(key);
        posted++;
      }
    }
    fs.writeFileSync(SNAPSHOT, JSON.stringify(Object.fromEntries([...current].map(([id, c]) => [id, c.claim])), null, 2) + "\n", { mode: 0o600 });
    console.log(`posted ${posted}`);
  } finally { releasePidLock(LOCK, fd); }
}
if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (e: any) { console.error(`STOP: ${e.message}`); process.exitCode = 2; }
}
