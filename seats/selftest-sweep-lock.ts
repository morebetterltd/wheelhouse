#!/usr/bin/env bun
// Private lock transitions for selftest-sweep.sh; never recursively delete.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { dlopen, FFIType, read, CString, toArrayBuffer } from "bun:ffi";

const MARKER = "wheelhouse-selftest-sweep";
const FILES = ["pid", "started", MARKER].sort();
const QUEUE = `${MARKER}-queue`;
const WAITER = `${MARKER}-waiter`;
const queueMarkers = new Map<number, [string, string]>();
const HOST = os.hostname();
const C = fs.constants;
const darwin = process.platform === "darwin";
class Refused extends Error {}
let native: ReturnType<typeof dlopen>;
function primitives() {
  if (!darwin && process.platform !== "linux") throw new Refused("atomic directory publication unsupported on this platform");
  native = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    // openat is variadic on Darwin arm64: use only its fixed read-only args.
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    rewinddir: { args: [FFIType.ptr], returns: FFIType.void },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    fchdir: { args: [FFIType.i32], returns: FFIType.i32 },
    mkstemp: { args: [FFIType.ptr], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
    [darwin ? "renameatx_np" : "renameat2"]: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
}
function errnoPtr() { return native.symbols[darwin ? "__error" : "__errno_location"]() as number; }
function errno() { return read.i32(errnoPtr()); }
function z(s: string) { return Buffer.from(s + "\0"); }
function openAt(parent: number, name: string, flags = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK): number {
  const fd = native.symbols.openat(parent, z(name), flags) as number;
  if (fd < 0) { const n = errno(); throw Object.assign(new Refused(`open ${name} failed (errno ${n})`), { errno: n }); }
  return fd;
}
function unlinkAt(parent: number, name: string, directory = false) {
  if (native.symbols.unlinkat(parent, z(name), directory ? (darwin ? 0x80 : 0x200) : 0)) {
    const n = errno(); throw Object.assign(new Refused(`remove ${name} failed (errno ${n})`), { errno: n });
  }
}
function id(fd: number) { const s = fs.fstatSync(fd, { bigint: true }); return `${s.dev}:${s.ino}`; }
function entries(fd: number): string[] {
  const copy = native.symbols.dup(fd) as number;
  if (copy < 0) throw new Refused("cannot duplicate directory descriptor");
  const dir = native.symbols.fdopendir(copy) as number;
  if (!dir) { fs.closeSync(copy); throw new Refused("cannot read directory descriptor"); }
  const names: string[] = [];
  native.symbols.rewinddir(dir);
  try {
    for (;;) {
      new Int32Array(toArrayBuffer(errnoPtr(), 0, 4))[0] = 0;
      const row = native.symbols.readdir(dir) as number;
      if (!row) { if (errno()) throw new Refused(`directory read failed (errno ${errno()})`); break; }
      // Platform dirent ABI: Darwin d_name offset21, Linux offset19.
      const name = new CString(row + (darwin ? 21 : 19)).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
    return names.sort();
  } finally { native.symbols.closedir(dir); }
}
function exactFiles(fd: number) { if (JSON.stringify(entries(fd)) !== JSON.stringify(FILES)) throw new Refused("entries must be exactly marker, pid, started"); }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || new Date(value).toISOString().replace(".000", "") !== value) throw new Refused("invalid start time");
  return value;
}
function validPid(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647; }
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { if (e.code === "EPERM") return true; if (e.code === "ESRCH") return false; throw e; }
}
function readFile(parent: number, name: string): [string, string] {
  const fd = openAt(parent, name);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 16384) throw new Refused(`${name} is not a bounded regular file`);
    const data = fs.readFileSync(fd);
    if (data.length > 16384) throw new Refused(`${name} grew while reading`);
    return [new TextDecoder("utf-8", { fatal: true }).decode(data), id(fd)];
  } finally { fs.closeSync(fd); }
}
type Marker = { pid: number; started: string; token: string | null };
type Snapshot = { identity: string; marker: Marker; members: Record<string, string> | null };
function inspect(parent: number, name: string): Snapshot {
  const fd = openAt(parent, name);
  try {
    const s = fs.fstatSync(fd);
    const identity = id(fd);
    if (s.isDirectory()) {
      exactFiles(fd);
      const [raw, markerId] = readFile(fd, MARKER);
      const m = JSON.parse(raw);
      if (!m || Array.isArray(m) || JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(["kind", "version", "pid", "hostname", "started", "token"].sort())) throw new Refused("invalid marker fields");
      if (m.kind !== MARKER || m.version !== 1 || !validPid(m.pid)) throw new Refused("invalid marker kind/version/pid");
      if (m.hostname !== HOST) throw new Refused("marker hostname is not this host");
      if (typeof m.token !== "string" || !/^[0-9a-f]{32}$/.test(m.token)) throw new Refused("invalid marker token");
      timestamp(m.started);
      const [pid, pidId] = readFile(fd, "pid"), [started, startedId] = readFile(fd, "started");
      if (pid !== `${m.pid}\n` || started !== `${m.started}\n`) throw new Refused("pid/started do not agree with marker");
      return { identity, marker: m, members: { [MARKER]: markerId, pid: pidId, started: startedId } };
    }
    if (!s.isFile()) throw new Refused("not a directory or legacy regular lock file");
    const [raw, fileId] = readFile(parent, name);
    if (fileId !== identity) throw new Refused("legacy file changed while reading");
    // Compatibility shape captured from the old atomic-file runner.
    const fields: Record<string, string> = {};
    const lines = raw.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      const at = line.indexOf("="), key = line.slice(0, at), value = line.slice(at + 1);
      if (at < 0 || !["pid", "started", "root", "pattern"].includes(key) || Object.hasOwn(fields, key)) throw new Refused("invalid legacy lock fields");
      fields[key] = value;
    }
    if (!/^[0-9]+$/.test(fields.pid ?? "") || !validPid(Number(fields.pid))) throw new Refused("legacy lock needs pid=<digits>");
    if (Object.hasOwn(fields, "started")) timestamp(fields.started);
    return { identity, marker: { pid: Number(fields.pid), started: fields.started ?? "", token: null }, members: null };
  } finally { fs.closeSync(fd); }
}
function removeValidated(parent: number, name: string, snapshot: Snapshot) {
  // All new transitions hold the parent-directory flock. No guard file and no
  // recursive deletion: a late extra entry makes rmdir fail, never deletes it.
  if (JSON.stringify(inspect(parent, name)) !== JSON.stringify(snapshot)) throw new Refused("lock changed before removal");
  if (!snapshot.members) { unlinkAt(parent, name); return; }
  const fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    if (id(fd) !== snapshot.identity) throw new Refused("directory identity changed before removal");
    for (const [member, expected] of Object.entries(snapshot.members)) {
      const f = openAt(fd, member);
      try { if (id(f) !== expected) throw new Refused(`${member} changed before removal`); }
      finally { fs.closeSync(f); }
    }
    exactFiles(fd);
    for (const member of Object.keys(snapshot.members)) unlinkAt(fd, member);
    const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { if (id(current) !== snapshot.identity) throw new Refused("directory name changed before removal"); }
    finally { fs.closeSync(current); }
    unlinkAt(parent, name, true);
  } finally { fs.closeSync(fd); }
}
function renameExclusive(parent: number, source: string, dest: string, destinationParent = parent) {
  const fn = native.symbols[darwin ? "renameatx_np" : "renameat2"];
  if (fn(parent, z(source), destinationParent, z(dest), darwin ? 4 : 1)) throw new Refused(`exclusive publish failed (errno ${errno()})`);
}
function publishDirectory(parent: number, name: string, members: [string, string][]) {
  const candidate = `.${name}.${randomUUID().replace(/-/g, "")}.new`;
  if (native.symbols.mkdirat(parent, z(candidate), 0o700)) throw new Refused(`candidate mkdir failed (errno ${errno()})`);
  const fd = openAt(parent, candidate, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  const candidateId = id(fd), written: Record<string, string> = {};
  try {
    // mkstemp is non-variadic and creates0600/exclusive, unlike a Darwin arm64
    // FFI call to openat(O_CREAT). CWD changes only in this private helper.
    if (native.symbols.fchdir(fd)) throw new Refused("cannot enter private candidate descriptor");
    for (const [member, content] of members) {
      const template = z(".member.XXXXXX"), out = native.symbols.mkstemp(template) as number;
      if (out < 0) throw new Refused("cannot create private member");
      const temporary = template.toString().split("\0")[0], fileId = id(out);
      written[temporary] = fileId;
      try {
        fs.writeFileSync(out, content);
        renameExclusive(fd, temporary, member);
        delete written[temporary]; written[member] = fileId;
      } finally { fs.closeSync(out); }
    }
    renameExclusive(parent, candidate, name);
    return candidateId;
  } finally {
    // Only this invocation's private candidate and recorded member identities.
    let current = -1;
    try { current = openAt(parent, candidate, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
    catch (e: any) { if (e.errno !== 2) throw e; }
    try {
      if (current >= 0 && id(current) === candidateId) {
        for (const [member, expected] of Object.entries(written)) {
          const f = openAt(fd, member);
          try { if (id(f) === expected) unlinkAt(fd, member); } finally { fs.closeSync(f); }
        }
        unlinkAt(parent, candidate, true);
      }
    } finally { if (current >= 0) fs.closeSync(current); fs.closeSync(fd); }
  }
}
function publish(parent: number, name: string, pid: number, token: string) {
  const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const marker = { kind: MARKER, version: 1, pid, hostname: HOST, started, token };
  return publishDirectory(parent, name, [["pid", `${pid}\n`], ["started", `${started}\n`], [MARKER, JSON.stringify(marker) + "\n"]]);
}

type Ticket = { name: string; identity: string; raw: string; pid: number; token: string; sequence: bigint };
function queueFd(parent: number, name: string, create: boolean): number | null {
  let fd: number;
  try { fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
  catch (e: any) {
    if (e.errno !== 2) throw e;
    if (!create) return null;
    publishDirectory(parent, name, [[QUEUE, JSON.stringify({ kind: QUEUE, version: 1, hostname: HOST }) + "\n"]]);
    fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  }
  try {
    const anchor = readFile(fd, QUEUE), marker = JSON.parse(anchor[0]);
    if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["hostname", "kind", "version"]) || marker.kind !== QUEUE || marker.version !== 1 || marker.hostname !== HOST) throw new Refused("invalid queue marker");
    queueMarkers.set(fd, anchor);
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}
function tickets(fd: number): Ticket[] {
  const result: Ticket[] = [];
  for (const name of entries(fd)) {
    if (name === QUEUE) continue;
    const match = /^([0-9]{20})\.([0-9a-f]{32})$/.exec(name);
    if (!match || BigInt(match[1]) === 0n) throw new Refused("unknown queue entry");
    const [raw, identity] = readFile(fd, name), m = JSON.parse(raw);
    if (!m || JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(["kind", "version", "pid", "hostname", "started", "token"].sort()) || m.kind !== WAITER || m.version !== 1 || m.hostname !== HOST || !validPid(m.pid) || m.token !== match[2]) throw new Refused("invalid waiter ownership record");
    timestamp(m.started);
    result.push({ name, identity, raw, pid: m.pid, token: m.token, sequence: BigInt(match[1]) });
  }
  if (new Set(result.map(t => String(t.sequence))).size !== result.length) throw new Refused("duplicate queue sequence");
  return result; // Fixed-width sequence names from entries() are arrival order.
}
function removeTicket(fd: number, ticket: Ticket) {
  const [raw, identity] = readFile(fd, ticket.name);
  if (raw !== ticket.raw || identity !== ticket.identity) throw new Refused("waiter changed before removal");
  unlinkAt(fd, ticket.name);
}
function enroll(parent: number, fd: number, current: Ticket[], pid: number, token: string): Ticket[] {
  const own = current.find(t => t.token === token);
  if (own) { if (own.pid !== pid) throw new Refused("waiter token belongs to another pid"); return current; }
  const sequence = (current.at(-1)?.sequence ?? 0n) + 1n, digits = String(sequence).padStart(20, "0");
  if (digits.length !== 20) throw new Refused("queue sequence exhausted");
  // Stage outside the visible queue, so a killed publisher cannot leave an
  // incomplete ticket blocking every live waiter. Publication is atomic.
  if (native.symbols.fchdir(parent)) throw new Refused("cannot enter queue parent descriptor");
  const template = z(`.sweep-waiter.${pid}.${token}.XXXXXX`), out = native.symbols.mkstemp(template) as number;
  if (out < 0) throw new Refused("cannot create private waiter record");
  const temporary = template.toString().split("\0")[0], temporaryId = id(out);
  try {
    fs.writeFileSync(out, JSON.stringify({ kind: WAITER, version: 1, pid, hostname: HOST, started: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), token }) + "\n");
    renameExclusive(parent, temporary, `${digits}.${token}`, fd);
  } finally {
    fs.closeSync(out);
    let leftover = -1;
    try { leftover = openAt(parent, temporary); if (id(leftover) === temporaryId) unlinkAt(parent, temporary); }
    catch (e: any) { if (e.errno !== 2) throw e; }
    finally { if (leftover >= 0) fs.closeSync(leftover); }
  }
  return tickets(fd);
}
function pruneTickets(fd: number): Ticket[] {
  // Validate the entire queue before deleting anything; malformed/foreign
  // entries fail closed. Only a definitive dead PID authorizes stale removal.
  const all = tickets(fd);
  for (const ticket of all) if (!alive(ticket.pid)) {
    removeTicket(fd, ticket);
    console.error(`selftest-sweep: reaped dead waiter pid=${ticket.pid}`);
  }
  return tickets(fd);
}
function removeEmptyQueue(parent: number, name: string, fd: number) {
  if (entries(fd).length !== 1 || entries(fd)[0] !== QUEUE) return;
  const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try { if (id(current) !== id(fd)) throw new Refused("queue identity changed"); }
  finally { fs.closeSync(current); }
  // Marker was validated by queueFd; recheck its inode/content before unlink.
  const again = readFile(fd, QUEUE), anchor = queueMarkers.get(fd);
  if (!anchor || anchor[0] !== again[0] || anchor[1] !== again[1]) throw new Refused("queue marker changed");
  unlinkAt(fd, QUEUE); unlinkAt(parent, name, true);
}

function parentFd(lock: string): number {
  // Shell resolves the physical parent once; reject subsequent ancestor links.
  let fd = fs.openSync("/", C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const part of path.dirname(lock).split("/").filter(Boolean)) {
      const next = openAt(fd, part, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}
function main(): number {
  const [op, lock, pidText, token, owned] = process.argv.slice(2);
  if (!["acquire", "release"].includes(op)) throw new Refused("unknown operation");
  const name = path.basename(lock), pid = Number(pidText);
  if (!path.isAbsolute(lock) || ["", ".", ".."].includes(name) || !validPid(pid) || !/^[0-9a-f]{32}$/.test(token)) throw new Refused("invalid lock path/pid/token");
  primitives();
  const parent = parentFd(lock);
  try {
    if (native.symbols.flock(parent, 2)) throw new Refused(`parent flock failed (errno ${errno()})`);
    const queueName = `${name}.queue`;
    if (op === "release") {
      if (owned) {
        let fd = -1;
        try { fd = openAt(parent, name); } catch {} // Never delete an unreadable replacement.
        if (fd >= 0) {
          let ours: boolean;
          try { ours = id(fd) === owned; } finally { fs.closeSync(fd); }
          if (ours) {
            const snapshot = inspect(parent, name);
            if (snapshot.marker.token !== token || snapshot.marker.pid !== pid) throw new Refused("owned lock marker changed");
            removeValidated(parent, name, snapshot);
          }
        }
      }
      const queue = queueFd(parent, queueName, false);
      if (queue !== null) try {
        for (const ticket of tickets(queue)) if (ticket.pid === pid && ticket.token === token) removeTicket(queue, ticket);
        removeEmptyQueue(parent, queueName, queue);
      } finally { fs.closeSync(queue); }
      return 0;
    }
    let snapshot: Snapshot | null;
    try { snapshot = inspect(parent, name); }
    catch (e: any) { if (e.errno !== 2) throw e; snapshot = null; }
    if (!alive(pid)) throw new Refused("cannot enroll a dead caller pid");
    const queue = queueFd(parent, queueName, true)!;
    try {
      const current = enroll(parent, queue, pruneTickets(queue), pid, token);
      if (snapshot && !alive(snapshot.marker.pid)) {
        console.error(`selftest-sweep: removing stale lock ${lock} held by dead pid ${snapshot.marker.pid}`);
        removeValidated(parent, name, snapshot); snapshot = null;
      }
      if (snapshot?.marker.pid === pid && snapshot.marker.token === token && current[0].token === token) {
        console.log(snapshot.identity); return 0; // Idempotent admission of this owner.
      }
      if (snapshot || current[0].token !== token) {
        const waiting = current.filter(t => !(snapshot && t.pid === snapshot.marker.pid && t.token === snapshot.marker.token));
        const position = waiting.findIndex(t => t.token === token) + 1;
        console.log(`queue_position=${position} holder=${snapshot ? `pid=${snapshot.marker.pid} started=${snapshot.marker.started}` : "none"} head_pid=${current[0].pid}`);
        return 75; // Validated queue wait; helper/runtime errors remain fatal.
      }
      console.log(publish(parent, name, pid, token));
      return 0;
    } finally { fs.closeSync(queue); }
  } finally { fs.closeSync(parent); }
}
try { process.exitCode = main(); }
catch (e: any) { console.error(`STOP: ${process.argv[3]} is not a selftest-sweep lock (${e.message})`); process.exitCode = 2; }
