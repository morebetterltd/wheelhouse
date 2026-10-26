#!/usr/bin/env bun
// Private lock transitions for selftest-sweep.sh; never recursively delete.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { completedSpawnSync as spawnSync } from "./native-command";
import { dlopen, FFIType, read, CString, toArrayBuffer } from "bun:ffi";

const MARKER = "wheelhouse-selftest-sweep";
const FILES = ["pid", "started", MARKER].sort();
const QUEUE = `${MARKER}-queue`;
const WAITER = `${MARKER}-waiter`;
const queueMarkers = new Map<number, [string, string]>();
const HOST = os.hostname(); // Diagnostic/legacy name only; networks may change it.
let hostId: string | null = null;
type IdentitySource = "darwin-ioplatformuuid" | "linux-machine-id" | "hostname";
let identitySource: IdentitySource = "hostname";
const identityFailures: { source: IdentitySource; reason: string }[] = [];
const descriptorPaths = new Map<number, string>();
const observed: object[] = [];
let diagnosed = false;
let hostNames = new Set([HOST]);
const HOST_RECORD = `${MARKER}-host`;
const C = fs.constants;
const darwin = process.platform === "darwin";
class Refused extends Error {}
/** Capture native bytes through regular descriptors, not Bun's synchronous
 * stdout pipe result: a successful fast command can return an empty string
 * there before its output has been observed. Keep the existing timeout and
 * bounded read, and remove the private hardware bytes on every path. */
export function readIdentityProvider(file: string, args: string[], options: { encoding: "utf8"; timeout: number; maxBuffer: number }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheelhouse-native-identity-"));
  const output = path.join(dir, "stdout"), errors = path.join(dir, "stderr");
  let out = -1, err = -1;
  try {
    out = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_RDWR, 0o600);
    err = fs.openSync(errors, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_RDWR, 0o600);
    execFileSync(file, args, { ...options, stdio: ["ignore", out, err] });
    const stat = fs.fstatSync(out), errorStat = fs.fstatSync(err);
    if (!stat.isFile() || !errorStat.isFile() || stat.size > options.maxBuffer || errorStat.size > options.maxBuffer) {
      throw Object.assign(new Error("native identity output exceeds capture limit"), { code: "ENOBUFS" });
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      // The child advanced the shared descriptor offset while writing.
      const count = fs.readSync(out, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Object.assign(new Error("native identity output shortened during capture"), { code: "EIO" });
      offset += count;
    }
    return bytes.toString("utf8");
  } finally {
    if (out >= 0) fs.closeSync(out);
    if (err >= 0) fs.closeSync(err);
    for (const name of [output, errors]) {
      try { fs.unlinkSync(name); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
    fs.rmdirSync(dir);
  }
}
function stableHostId(): string {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const unavailable = (source: IdentitySource, error: any) => identityFailures.push({ source,
    reason: typeof error?.code === "string" ? error.code : typeof error?.status === "number" ? `exit:${error.status}` : "unavailable" });
  if (darwin) {
    try {
      // System location, independent of a suite's deliberately minimal PATH.
      const raw = readIdentityProvider("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
      const match = /^\s*"IOPlatformUUID" = "([0-9A-Fa-f-]+)"\s*$/m.exec(raw);
      if (match && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(match[1]) && !/^0+$/.test(match[1].replaceAll("-", ""))) {
        identitySource = "darwin-ioplatformuuid";
        return digest(`darwin:${match[1].toLowerCase()}`);
      }
      identityFailures.push({ source: "darwin-ioplatformuuid", reason: "invalid-value" });
    } catch (error) { unavailable("darwin-ioplatformuuid", error); }
  } else if (process.platform === "linux") {
    try {
      const machine = fs.readFileSync("/etc/machine-id", "utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(machine) && !/^0+$/.test(machine)) {
        identitySource = "linux-machine-id";
        return digest(`linux:${machine.toLowerCase()}`);
      }
      identityFailures.push({ source: "linux-machine-id", reason: "invalid-value" });
    } catch (error) { unavailable("linux-machine-id", error); }
  }
  // Lookup failure must not turn an otherwise valid legacy lock into STOP.
  identitySource = "hostname";
  return digest(`hostname:${HOST}`);
}
/** Shared hardware identity for cleanup records. CLI fallback policy stays below. */
let sharedIdentity: Readonly<{ hostId: string; source: IdentitySource }> | undefined;
export function stableHostIdentity() {
  if (!sharedIdentity || sharedIdentity.source === "hostname") {
    const value = stableHostId();
    sharedIdentity = Object.freeze({ hostId: value, source: identitySource });
  }
  return sharedIdentity;
}
function hostMatches(marker: any): boolean {
  // Wire records stay byte-for-byte compatible in shape with older helpers.
  // The sibling stable-ID cache binds previously observed names to this host.
  return hostNames.has(marker.hostname);
}
function markerFields(marker: any, fields: string[]): boolean {
  return !!marker && typeof marker === "object" && !Array.isArray(marker) && typeof marker.hostname === "string" &&
    JSON.stringify(Object.keys(marker).sort()) === JSON.stringify(fields.sort());
}
function evidence(fd: number, file: string, data?: Buffer): object {
  const s = fs.fstatSync(fd, { bigint: true });
  return { path: file, device: String(s.dev), inode: String(s.ino), mtimeNs: String(s.mtimeNs), size: String(s.size),
    ...(data ? { contents: data.toString("utf8"), contentsBase64: data.toString("base64") } : {}) };
}
function diagnose(error: any, parent?: number, name?: string) {
  diagnosed = true;
  const snapshots: object[] = [];
  function capture(at: number, leaf: string, depth: number) {
    const file = path.join(descriptorPaths.get(at) ?? "[unknown descriptor]", leaf);
    let fd = -1;
    try {
      fd = openAt(at, leaf);
      const s = fs.fstatSync(fd);
      if (s.isDirectory()) {
        const names = entries(fd); snapshots.push({ ...evidence(fd, file), entries: names });
        if (depth) for (const member of names) capture(fd, member, depth - 1);
      } else if (s.isFile() && s.size <= 16384) {
        // Same bounded, no-follow, nonblocking read as validation. Full bytes
        // for every admissible marker; oversize/nonregular objects stay inert.
        const data = Buffer.alloc(16385), n = fs.readSync(fd, data, 0, data.length, 0);
        snapshots.push(n <= 16384 ? evidence(fd, file, data.subarray(0, n)) : { ...evidence(fd, file), contentsUnavailable: "grew beyond 16384 bytes" });
      } else snapshots.push({ ...evidence(fd, file), contentsUnavailable: "not a bounded regular marker (limit 16384 bytes)" });
    } catch (e: any) {
      // Metadata-only lstat is supplementary when no-follow open refuses a
      // symlink. Never read its target or use this path observation to delete.
      let metadata: object = {};
      try { const s = fs.lstatSync(file, { bigint: true }); metadata = { inode: String(s.ino), device: String(s.dev), mtimeNs: String(s.mtimeNs), metadataOnly: true }; } catch {}
      snapshots.push({ path: file, ...metadata, unavailable: e.message });
    }
    finally { if (fd >= 0) fs.closeSync(fd); }
  }
  if (parent !== undefined && name) { capture(parent, name, 1); capture(parent, `${name}.queue`, 1); capture(parent, `${name}.host`, 1); }
  console.error("SELFTEST_LOCK_REFUSAL " + JSON.stringify({ operation: process.argv[2], lock: process.argv[3], reason: error.message,
    host: { hostname: HOST, hostId, identitySource, identityFailures, knownHostnames: [...hostNames], platform: process.platform },
    ...(error.ancestryObservations ? { ancestryObservations: error.ancestryObservations } : {}), observed, snapshots }));
}
// Async supervisor failures may occur outside a transition's pinned parent.
// Reopen only for a diagnostic snapshot; never repair state from this path.
function diagnoseLock(error: any, lock: string) {
  let parent: number | undefined;
  try {
    if (!native) primitives();
    const canonical = canonicalLock(lock);
    parent = parentFd(canonical);
    if (native.symbols.flock(parent, 2)) throw new Refused(`diagnostic flock failed (errno ${errno()})`);
    diagnose(error, parent, path.basename(canonical));
  } catch {
    if (!diagnosed) diagnose(error);
  } finally { if (parent !== undefined) fs.closeSync(parent); }
}
let native: ReturnType<typeof dlopen>;
function primitives() {
  if (native) return;
  if (!darwin && process.platform !== "linux") throw new Refused("atomic directory publication unsupported on this platform");
  native = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    // openat is variadic on Darwin arm64: use only its fixed read-only args.
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    getppid: { args: [], returns: FFIType.i32 },
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
  descriptorPaths.set(fd, path.join(descriptorPaths.get(parent) ?? "[unknown descriptor]", name));
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
    observed.push(evidence(fd, descriptorPaths.get(fd)!, data));
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
      if (!markerFields(m, ["kind", "version", "pid", "hostname", "started", "token"])) throw new Refused("invalid marker fields");
      if (m.kind !== MARKER || m.version !== 1 || !validPid(m.pid)) throw new Refused("invalid marker kind/version/pid");
      if (!hostMatches(m)) throw new Refused("marker host identity is not this host");
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

// tmp_cleaner ignores live holders: atime alone is not protection on every
// filesystem. Renew all validated members, including old aliases and waiters.
// Pin every identity before changing metadata; never rewrite bytes or follow
// a replacement/symlink/hardlink into somebody else's file.
function renewFiles(directory: number, members: Record<string, string>) {
  const opened: number[] = [];
  try {
    for (const [name, identity] of Object.entries(members)) {
      const fd = openAt(directory, name); opened.push(fd);
      const st = fs.fstatSync(fd);
      if (id(fd) !== identity || !st.isFile() || st.nlink !== 1 || st.uid !== process.getuid()) throw new Refused(`cannot renew changed or foreign ${name}`);
    }
    const now = new Date();
    for (const fd of opened) fs.futimesSync(fd, now, now);
  } finally { for (const fd of opened) fs.closeSync(fd); }
}
function renewLock(parent: number, name: string, snapshot: Snapshot) {
  if (!snapshot.members) return; // Never modify legacy pid-only wire records.
  const fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    if (id(fd) !== snapshot.identity) throw new Refused("lock changed before renewal");
    renewFiles(fd, snapshot.members);
  } finally { fs.closeSync(fd); }
}
function cachedHostNames(fd: number, expectedId: string, members: Record<string, string> = {}): Set<string> {
  let anchor: [string, string];
  try { anchor = readFile(fd, HOST_RECORD); }
  catch (e: any) {
    if (e.errno !== 2) throw e;
    throw Object.assign(new Refused(`missing host record ${descriptorPaths.get(fd)}/${HOST_RECORD}; restore this file from a trusted same-machine backup (see seats/README.md: Missing sweep host record). Do not delete a live lock or recreate the anchor from unauthenticated aliases`), { errno: 2 });
  }
  const record = JSON.parse(anchor[0]);
  members[HOST_RECORD] = anchor[1];
  if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["hostId", "kind", "version"]) || record.kind !== HOST_RECORD || record.version !== 1 || record.hostId !== expectedId) throw new Refused("foreign or invalid stable host cache");
  const names = new Set<string>(), digest = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const member of entries(fd)) {
    if (member === HOST_RECORD) continue;
    const [raw, identity] = readFile(fd, member), hostname = raw.slice(0, -1);
    if (!/^[0-9a-f]{64}$/.test(member) || !hostname || raw !== hostname + "\n" || /[\r\n\0]/.test(hostname) || digest(hostname) !== member) throw new Refused("invalid cached hostname");
    names.add(hostname); members[member] = identity;
  }
  return names;
}
function hostCache(parent: number, lockName: string): Set<string> {
  // A weaker fallback cannot authenticate hardware-bound aliases. Do not
  // overwrite or reject a previous stable cache just because lookup failed.
  if (identitySource === "hostname") return new Set([HOST]);
  // Sibling, NOT a fourth lock member or queue entry. Older helpers inspect
  // only lockName and lockName.queue and leave this cache completely alone.
  const name = `${lockName}.host`, digest = (s: string) => createHash("sha256").update(s).digest("hex");
  let fd: number;
  try { fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
  catch (e: any) {
    if (e.errno !== 2) throw e;
    publishDirectory(parent, name, [[HOST_RECORD, JSON.stringify({ kind: HOST_RECORD, version: 1, hostId }) + "\n"], [digest(HOST), HOST + "\n"]]);
    fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  }
  try {
    const members: Record<string, string> = {}, names = cachedHostNames(fd, hostId!, members);
    if (!names.has(HOST)) {
      // Stage an alias outside the visible cache; atomic exclusive publication
      // under the same parent flock. Never overwrite a foreign cache member.
      if (native.symbols.fchdir(parent)) throw new Refused("cannot enter host cache parent");
      const template = z(".sweep-host.XXXXXX"), out = native.symbols.mkstemp(template) as number;
      if (out < 0) throw new Refused("cannot create hostname alias");
      const temporary = template.toString().split("\0")[0], identity = id(out);
      try { fs.writeFileSync(out, HOST + "\n"); renameExclusive(parent, temporary, digest(HOST), fd); members[digest(HOST)] = identity; }
      finally {
        fs.closeSync(out);
        let leftover = -1;
        try { leftover = openAt(parent, temporary); if (id(leftover) === identity) unlinkAt(parent, temporary); }
        catch (e: any) { if (e.errno !== 2) throw e; }
        finally { if (leftover >= 0) fs.closeSync(leftover); }
      }
      names.add(HOST);
    }
    renewFiles(fd, members);
    return names;
  } finally { fs.closeSync(fd); }
}

/** Read-only legacy proof. Never creates, repairs or adds to a host cache. */
export function legacyHostnameMatches(hostname: string): boolean {
  if (hostname === HOST) return true; // Preserve the original v1 current-name proof.
  const identity = stableHostIdentity();
  if (identity.source === "hostname") return false;
  primitives();
  const lock = canonicalLock(process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK || "/tmp/wheelhouse-selftest-sweep.lock");
  let parent = -1, fd = -1;
  try {
    parent = parentFd(lock);
    const name = path.basename(lock) + ".host";
    fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const anchor = readFile(fd, HOST_RECORD);
    const names = cachedHostNames(fd, identity.hostId);
    if (JSON.stringify(readFile(fd, HOST_RECORD)) !== JSON.stringify(anchor)) throw new Refused("stable host cache changed during inspection");
    const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { if (id(current) !== id(fd)) throw new Refused("stable host cache directory changed during inspection"); }
    finally { fs.closeSync(current); }
    return names.has(hostname);
  } catch (e: any) {
    if (e.errno === 2) return false; // Missing cache is not proof of an old name.
    throw e;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    if (parent >= 0) fs.closeSync(parent);
  }
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
    if (!markerFields(marker, ["hostname", "kind", "version"]) || marker.kind !== QUEUE || marker.version !== 1 || !hostMatches(marker)) throw new Refused("invalid queue marker");
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
    if (!markerFields(m, ["kind", "version", "pid", "hostname", "started", "token"]) || m.kind !== WAITER || m.version !== 1 || !hostMatches(m) || !validPid(m.pid) || m.token !== match[2]) throw new Refused("invalid waiter ownership record");
    timestamp(m.started);
    result.push({ name, identity, raw, pid: m.pid, token: m.token, sequence: BigInt(match[1]) });
  }
  if (new Set(result.map(t => String(t.sequence))).size !== result.length) throw new Refused("duplicate queue sequence");
  return result; // Fixed-width sequence names from entries() are arrival order.
}
function renewQueue(fd: number, current: Ticket[]) {
  const anchor = queueMarkers.get(fd), again = readFile(fd, QUEUE);
  if (!anchor || anchor[0] !== again[0] || anchor[1] !== again[1]) throw new Refused("queue marker changed before renewal");
  const members = { [QUEUE]: anchor[1] };
  for (const ticket of current) if (alive(ticket.pid)) members[ticket.name] = ticket.identity;
  renewFiles(fd, members);
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
  descriptorPaths.set(fd, "/");
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
  if (!["acquire", "release", "refresh"].includes(op)) throw new Refused("unknown operation");
  const name = path.basename(lock), pid = Number(pidText);
  if (!path.isAbsolute(lock) || ["", ".", ".."].includes(name) || !validPid(pid) || !/^[0-9a-f]{32}$/.test(token)) throw new Refused("invalid lock path/pid/token");
  primitives();
  const parent = parentFd(lock);
  try {
    if (native.symbols.flock(parent, 2)) throw new Refused(`parent flock failed (errno ${errno()})`);
    hostNames = hostCache(parent, name);
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
    if (op === "refresh") {
      const snapshot = inspect(parent, name);
      if (!owned || snapshot.identity !== owned || snapshot.marker.pid !== pid || snapshot.marker.token !== token || !alive(pid)) throw new Refused("cannot refresh a different lock owner");
      const queue = queueFd(parent, `${name}.queue`, false);
      if (queue === null) throw new Refused("cannot refresh without FIFO ownership");
      try {
        const current = tickets(queue);
        if (current[0]?.pid !== pid || current[0]?.token !== token) throw new Refused("cannot refresh a different FIFO head");
        renewQueue(queue, current); renewLock(parent, name, snapshot);
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
      renewQueue(queue, current);
      if (snapshot) renewLock(parent, name, snapshot);
      if (snapshot?.marker.pid === pid && snapshot.marker.token === token && current[0].token === token) {
        console.log(snapshot.identity); return 0; // Idempotent admission of this owner.
      }
      // The brake is admission-only. Never revoke a token already admitted,
      // including idempotent retries above or nested runs checked by ancestry.
      const pauseFile = process.env.WHEELHOUSE_HEAVY_TEST_PAUSE || path.join(import.meta.dir, "run", "host-guard-pause");
      let paused = false;
      try { fs.lstatSync(pauseFile); paused = true; }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (snapshot || current[0].token !== token || paused) {
        const waiting = current.filter(t => !(snapshot && t.pid === snapshot.marker.pid && t.token === snapshot.marker.token));
        const position = waiting.findIndex(t => t.token === token) + 1;
        console.log(`queue_position=${position} holder=${snapshot ? `pid=${snapshot.marker.pid} started=${snapshot.marker.started}` : "none"} head_pid=${current[0].pid}${paused ? ` paused_by=${pauseFile}` : ""}`);
        return 75; // Validated queue wait; helper/runtime errors remain fatal.
      }
      console.log(publish(parent, name, pid, token));
      return 0;
    } finally { fs.closeSync(queue); }
  } catch (e) { diagnose(e, parent, name); throw e; }
  finally { fs.closeSync(parent); }
}
function canonicalLock(input: string): string {
  const resolved = path.resolve(input);
  // Resolve the parent only, exactly as the sweep does. Never follow the leaf.
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}
function snapshotAncestorOwns(owner: number): boolean {
  // Preserve direct-child admission without requiring ps at all. Use the live
  // kernel parent, not a runtime-cached PPID; FIFO/token checks still follow.
  if (native.symbols.getppid() === owner) return alive(owner);
  const observations: object[] = [];
  // One table per attempt: an ancestor must not vanish between separate ps
  // queries. Start at our own kernel row, not a previously cached PPID. A
  // transient/incomplete observation gets a fresh bounded attempt; neither an
  // environment flag nor an unreadable process table is inherited admission.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const args = ["-axo", "pid=,ppid="];
    const result = spawnSync("ps", args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    try {
      if (result.error || result.signal || result.status !== 0 || result.stderr || !result.stdout.trim()) throw new Error("process table command incomplete");
      const parents = new Map<number, number>();
      for (const line of result.stdout.trim().split("\n")) {
        const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!row) throw new Error("malformed process table row");
        const pid = Number(row[1]), ppid = Number(row[2]);
        if (!validPid(pid) || !(ppid === 0 || validPid(ppid)) || parents.has(pid)) throw new Error("invalid or duplicate process table pid");
        parents.set(pid, ppid);
      }
      if (!parents.has(process.pid) || !parents.has(owner)) throw new Error("process table lacks helper or owner");
      let pid = parents.get(process.pid)!;
      const seen = new Set<number>();
      while (pid !== owner) {
        if (pid <= 1) return false; // A complete outsider chain is not a retry.
        if (seen.has(pid)) throw new Error("cyclic process ancestry");
        seen.add(pid);
        const next = parents.get(pid);
        if (next === undefined) throw new Error(`process table lacks ancestor ${pid}`);
        pid = next;
      }
      return alive(owner);
    } catch (error: any) {
      observations.push({ attempt, command: ["ps", ...args], helperPid: process.pid, ownerPid: owner,
        status: result.status, signal: result.signal, error: result.error?.message, reason: error.message,
        stdout: result.stdout?.slice(0, 4096), stderr: result.stderr?.slice(0, 4096),
        stdoutBytes: Buffer.byteLength(result.stdout ?? ""), stderrBytes: Buffer.byteLength(result.stderr ?? "") });
    }
  }
  throw Object.assign(new Refused("cannot verify suite ancestry after 3 process snapshots"), { ancestryObservations: observations });
}
function ancestorOwnsLock(lock: string): boolean {
  primitives();
  const parent = parentFd(lock);
  try {
    if (native.symbols.flock(parent, 2)) throw new Refused(`parent flock failed (errno ${errno()})`);
    hostNames = hostCache(parent, path.basename(lock));
    let snapshot: Snapshot;
    try { snapshot = inspect(parent, path.basename(lock)); }
    catch (e: any) { if (e.errno === 2) return false; throw e; }
    // A legacy pid-only claim or an exported environment flag is not proof of
    // inherited admission. Require the current token-owned lock AND FIFO head.
    if (!snapshot.marker.token || !alive(snapshot.marker.pid)) return false;
    if (!snapshotAncestorOwns(snapshot.marker.pid)) return false;
    const queue = queueFd(parent, `${path.basename(lock)}.queue`, false);
    if (queue === null) {
      // Every process reaches init, so a bare PID-1 claim is not inherited
      // admission. Queue behind it as a live holder. A genuine PID-1 runner
      // (e.g. a container entrypoint) can still prove its token/FIFO head.
      if (snapshot.marker.pid === 1) return false;
      throw new Refused("inherited lock has no FIFO ownership record");
    }
    try {
      const first = tickets(queue)[0];
      if (!first || first.pid !== snapshot.marker.pid || first.token !== snapshot.marker.token) throw new Refused("inherited lock does not match FIFO head");
      if (JSON.stringify(inspect(parent, path.basename(lock))) !== JSON.stringify(snapshot)) throw new Refused("inherited lock changed during ancestry check");
      renewQueue(queue, tickets(queue)); renewLock(parent, path.basename(lock), snapshot);
      return true;
    } finally { fs.closeSync(queue); }
  } catch (e) { diagnose(e, parent, path.basename(lock)); throw e; }
  finally { fs.closeSync(parent); }
}

/** Own release outside the suite's traps, but register the gated suite PID.
 * If this supervisor is killed, the actual live suite still owns admission. */
async function superviseSuite(lock: string, command: string[]): Promise<number> {
  if (!command.length) throw new Refused("missing suite command");
  const token = randomUUID().replace(/-/g, "");
  const pause = Number(process.env.WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS ?? 1);
  if (!Number.isFinite(pause) || pause <= 0) throw new Refused("suite lock poll interval must be positive");
  let owned = "", enrolled = false, interrupted: NodeJS.Signals | null = null, child: ChildProcess | undefined;
  const forward = (signal: NodeJS.Signals) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    // This group was created by this supervisor, not borrowed from the caller.
    try { process.kill(-child.pid, signal); }
    catch (e: any) { if (e.code !== "ESRCH") throw e; }
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    const handler = () => { console.error(`heavy-test: KILLED by signal ${os.constants.signals[signal]}`); interrupted = signal; forward(signal); };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  let code = 2, renewal: ReturnType<typeof setInterval> | undefined, renewalFailed = false;
  // fd3 gates exec, not the suite's stdin. Bash keeps this PID across exec.
  child = spawn(command[0], ["-c", 'IFS= read -r admission <&3 || exit 2; [ "$admission" = admitted ] || exit 2; exec 3<&-; exec "$@"', "selftest-admission-gate", ...command], { stdio: ["inherit", "inherit", "inherit", "pipe"], detached: true });
  const gate = child.stdio[3] as import("node:stream").Writable;
  let closed = false, spawnError: Error | undefined;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child!.once("error", error => { spawnError = error; });
    child!.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  gate?.on("error", () => {}); // Child exit/EPIPE is checked via native close.
  const transition = (op: string) => spawnSync("bun", [import.meta.path, op, lock, String(child!.pid), token, owned], { encoding: "utf8", detached: true });
  try {
    if (!child.pid || !gate) throw new Refused("cannot start gated suite process");
    let previous = "";
    while (!interrupted) {
      if (closed || spawnError) throw new Refused(`gated suite exited before admission: ${spawnError ?? "native close"}`);
      const result = transition("acquire");
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status === 0 || result.status === 75) {
        enrolled = true;
        if (result.status === 0) {
          owned = result.stdout.trim();
          if (!/^\d+:\d+$/.test(owned)) throw new Refused("missing suite lock identity");
        }
      }
      // Deliver pending signals after the synchronous descriptor transition.
      await Bun.sleep(0);
      if (interrupted) break;
      if (result.error || ![0, 75].includes(result.status!)) throw new Refused(`suite lock admission failed: ${result.error ?? `exit ${result.status} signal ${result.signal}`}`);
      if (owned) break;
      if (result.stdout !== previous) {
        console.error(`selftest-suite: waiting for host-wide lock ${lock} ${result.stdout.trim()}`);
        previous = result.stdout;
      }
      await Bun.sleep(pause * 1000);
    }
    if (!interrupted) {
      // One minute is well inside tmp_cleaner's three-day horizon, even for
      // one long payload with no nested admissions. No environment override.
      renewal = setInterval(() => {
        const result = transition("refresh");
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error || result.status !== 0 || result.signal) {
          renewalFailed = true; clearInterval(renewal);
          console.error("STOP: suite lock renewal failed");
        }
      }, 60_000);
      gate.end("admitted\n");
      const result = await done;
      if (spawnError) throw spawnError;
      code = renewalFailed ? 2 : result.code ?? (result.signal ? 128 + os.constants.signals[result.signal] : 2);
    }
  } finally {
    clearInterval(renewal);
    gate?.destroy();
    if (!closed) {
      // No payload was admitted: closing fd3 is the gate's exit instruction.
      // Join that original child instead of signaling its dying numeric group
      // during Darwin's post-EOF/pre-close EPERM window.
      if (!owned && !interrupted) await done;
      else { forward(interrupted ?? "SIGTERM"); await done; }
    }
    // Never release before the real suite/gate has closed, including custom
    // signal cleanup. SIGKILL of this supervisor leaves the live suite's PID
    // protecting the lock; the existing dead-owner protocol recovers it later.
    if (enrolled) {
      const result = transition("release");
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error || result.status !== 0) {
        diagnoseLock(new Refused(`suite lock release failed: ${result.error ?? `exit ${result.status} signal ${result.signal}`}`), lock);
        console.error("STOP: suite lock release failed"); code = 2; interrupted = null;
      }
    }
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return interrupted ? 128 + os.constants.signals[interrupted] : code;
}
if (import.meta.main) {
  try {
    const [operation, lock, ...command] = process.argv.slice(2);
    hostId = stableHostId();
    if (operation === "inherited") process.exitCode = ancestorOwnsLock(canonicalLock(lock)) ? 0 : 75;
    else if (operation === "supervise") process.exitCode = await superviseSuite(canonicalLock(lock), command);
    else process.exitCode = main();
  }
  catch (e: any) {
    if (!diagnosed) diagnoseLock(e, process.argv[3]);
    console.error(`STOP: ${process.argv[3]} is not a selftest-sweep lock (${e.message})`); process.exitCode = 2;
  }
}
