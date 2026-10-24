import * as fs from "node:fs";
import * as path from "node:path";
export interface QuarantineEntry { suite: string; owner: string; deadline: string }
export function localDay(now = new Date()): string { return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`; }
export function parseQuarantine(raw: string, available: readonly string[], today = localDay()): QuarantineEntry[] {
  const entries: QuarantineEntry[] = [], seen = new Set<string>();
  for (const [index, row] of raw.split(/\n/).entries()) {
    const line = row.replace(/#.*$/, "").trim(); if (!line) continue;
    const stop = (why: string): never => { throw new Error(`quarantine line ${index+1}: ${why}`); };
    const fields = line.split(/\s+/); if (fields.length !== 3) stop("expected suite, owner task and YYYY-MM-DD deadline");
    const [suite, owner, deadline] = fields;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.selftest\.sh$/.test(suite) || !available.includes(suite)) stop("missing or invalid suite");
    if (seen.has(suite)) stop("duplicate suite");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) stop("invalid owner task id");
    const date = new Date(deadline + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== deadline) stop("invalid calendar deadline");
    if (deadline <= today) stop("deadline is today or expired; remove or renew by reviewed change");
    seen.add(suite); entries.push({suite, owner, deadline});
  }
  return entries.sort((a,b)=>a.suite.localeCompare(b.suite));
}
// Older installs/tips without a list have no exemptions, never implicit ones.
export function readQuarantine(root: string): QuarantineEntry[] {
  const file = path.join(root, "seats/selftest-quarantine.list"); let before: fs.Stats;
  try { before = fs.lstatSync(file); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  if (!before.isFile() || !(before.mode & 0o444) || before.size > 65536) throw new Error("quarantine line 0: unreadable regular list required (64KiB maximum)");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("quarantine line 0: list changed while opening");
    const raw = fs.readFileSync(fd, "utf8"), after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error("quarantine line 0: list changed while reading");
    const available = fs.readdirSync(path.join(root,"seats")).filter(name=>name.endsWith(".selftest.sh") && fs.lstatSync(path.join(root,"seats",name)).isFile());
    return parseQuarantine(raw, available);
  } finally { fs.closeSync(fd); }
}
