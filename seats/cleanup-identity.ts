// Identity proofs for automatic cleanup. No recursive lock removal.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { dlopen, FFIType, read, CString, toArrayBuffer } from "bun:ffi";
import { stableHostIdentity, legacyHostnameMatches } from "./selftest-sweep-lock";

export class CleanupRefused extends Error {}
const C = fs.constants, darwin = process.platform === "darwin";
const LOCK_MARKER = "wheelhouse-cleanup-lock";
export const SCRATCH_MARKER = ".wheelhouse-cleanup-scratch.json";
const HOST = os.hostname();
let native: ReturnType<typeof dlopen>;
function primitives() {
  if (native) return;
  if (!darwin && process.platform !== "linux") throw new CleanupRefused("cleanup identity primitives unsupported on this platform");
  native = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    // Darwin arm64 openat is variadic: use only fixed read-only arguments.
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    rewinddir: { args: [FFIType.ptr], returns: FFIType.void },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    fchdir: { args: [FFIType.i32], returns: FFIType.i32 },
    mkstemp: { args: [FFIType.ptr], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
    [darwin ? "renameatx_np" : "renameat2"]: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
}
const z = (s: string) => Buffer.from(s + "\0");
function errnoPtr() { return native.symbols[darwin ? "__error" : "__errno_location"]() as number; }
function errno() { return read.i32(errnoPtr()); }
function fail(op: string): never { throw Object.assign(new CleanupRefused(`${op} failed (errno ${errno()})`), { errno: errno() }); }
function openAt(fd: number, name: string, directory = false) {
  const f = native.symbols.openat(fd, z(name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | (directory ? C.O_DIRECTORY : 0)) as number;
  if (f < 0) fail(`open ${name}`);
  return f;
}
function id(fd: number) { const s = fs.fstatSync(fd, { bigint: true }); return `${s.dev}:${s.ino}`; }
function unlinkAt(fd: number, name: string, directory = false) {
  if (native.symbols.unlinkat(fd, z(name), directory ? (darwin ? 0x80 : 0x200) : 0)) fail(`remove ${name}`);
}
function renameExclusive(fd: number, from: string, to: string) {
  if (native.symbols[darwin ? "renameatx_np" : "renameat2"](fd, z(from), fd, z(to), darwin ? 4 : 1)) fail(`publish ${to}`);
}
function entries(fd: number): string[] {
  const copy = native.symbols.dup(fd) as number;
  if (copy < 0) fail("dup");
  const dir = native.symbols.fdopendir(copy) as number;
  if (!dir) { fs.closeSync(copy); fail("fdopendir"); }
  native.symbols.rewinddir(dir);
  const names: string[] = [];
  try {
    for (;;) {
      new Int32Array(toArrayBuffer(errnoPtr(), 0, 4))[0] = 0;
      const row = native.symbols.readdir(dir) as number;
      if (!row) { if (errno()) fail("readdir"); break; }
      const name = new CString(row + (darwin ? 21 : 19)).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
    return names.sort();
  } finally { native.symbols.closedir(dir); }
}
function readMember(fd: number, name: string) {
  const f = openAt(fd, name);
  try {
    const st = fs.fstatSync(f);
    if (!st.isFile() || st.size > 16384) throw new CleanupRefused(`${name} is not a bounded regular file`);
    const raw = fs.readFileSync(f);
    if (raw.length > 16384) throw new CleanupRefused(`${name} grew during inspection`);
    return { identity: id(f), raw: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
  } finally { fs.closeSync(f); }
}
function validPid(p: unknown): p is number { return Number.isInteger(p) && Number(p) > 0 && Number(p) <= 2147483647; }
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { if (e.code === "EPERM") return true; if (e.code === "ESRCH") return false; throw new CleanupRefused(`cannot verify pid ${pid}: ${e.message}`); }
}
function requireStableHost() {
  const identity = stableHostIdentity();
  if (identity.source === "hostname") throw new CleanupRefused("stable cleanup host identity unavailable; hardware/machine ID is required to record ownership");
  return identity;
}
function markerHostMatches(m: any): boolean {
  try {
    if (m.version === 2) {
      const identity = stableHostIdentity();
      return identity.source !== "hostname" && typeof m.hostId === "string" && /^[0-9a-f]{64}$/.test(m.hostId) && m.hostId === identity.hostId;
    }
    return legacyHostnameMatches(m.hostname);
  } catch (e: any) { throw new CleanupRefused(`cannot prove cleanup marker host identity: ${e.message}`); }
}
function validRecordFields(m: any, kind: string) {
  return m && !Array.isArray(m) && m.kind === kind && [1, 2].includes(m.version) && validPid(m.pid)
    && typeof m.hostname === "string" && m.hostname.length > 0 && !/[\r\n\0]/.test(m.hostname)
    && typeof m.token === "string" && /^[0-9a-f]{32}$/.test(m.token)
    && typeof m.started === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(m.started) && Number.isFinite(Date.parse(m.started))
    && new Date(m.started).toISOString().replace(".000Z", "Z") === m.started
    && JSON.stringify(Object.keys(m).sort()) === JSON.stringify(["kind", "version", "root", "identity", "pid", "hostname", "token", "started", ...(m.version === 2 ? ["hostId"] : []), ...(kind === "wheelhouse-cleanup-scratch" ? ["target", "bead"] : [])].sort());
}
function validRecord(m: any, kind: string) { return validRecordFields(m, kind) && markerHostMatches(m); }
function record(kind: string, root: string, identity: string) {
  const host = requireStableHost();
  return { kind, version: 2, root, identity, pid: process.pid, hostname: HOST, hostId: host.hostId, token: randomUUID().replaceAll("-", ""), started: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
}
export function cleanupPathIdentity(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) throw new CleanupRefused(`outside cleanup root: ${target}`);
  const chain: { path: string; identity: string }[] = [];
  let current = root;
  for (const part of ["", ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    const st = fs.lstatSync(current, { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory()) throw new CleanupRefused(`symlink or non-directory component: ${current}`);
    chain.push({ path: current, identity: `${st.dev}:${st.ino}` });
  }
  const real = fs.realpathSync(target);
  if (real !== target) throw new CleanupRefused(`path mismatch: ${target} resolves to ${real}`);
  return { real, chain };
}
export type CleanupPathIdentity = ReturnType<typeof cleanupPathIdentity>;
export function cleanupPathUnchanged(root: string, target: string, expected: CleanupPathIdentity): boolean {
  try { return JSON.stringify(cleanupPathIdentity(root, target)) === JSON.stringify(expected); } catch { return false; }
}
function runtime(root: string) {
  primitives();
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new CleanupRefused(`unproven cleanup root: ${root}`);
  let fd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    let current = root;
    for (const name of ["seats", "run"]) {
      current = path.join(current, name);
      try {
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new CleanupRefused(`symlink or non-directory component: ${current}`);
      } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (native.symbols.mkdirat(fd, z(name), 0o700) && errno() !== 17) fail(`mkdir ${name}`);
      const next = openAt(fd, name, true); fs.closeSync(fd); fd = next;
    }
    const proof = cleanupPathIdentity(root, path.join(root, "seats", "run"));
    if (proof.chain.at(-1)!.identity !== id(fd)) throw new CleanupRefused("seats/run changed during inspection");
    return { fd, proof };
  } catch (e: any) { fs.closeSync(fd); throw new CleanupRefused(`${root}/seats/run: ${e.message}`); }
}
export function prepareCleanupRuntime(root: string) { const r = runtime(root); fs.closeSync(r.fd); }
function inspectLock(parent: number, root: string) {
  const fd = openAt(parent, "cleanup.lock", true);
  try {
    const names = entries(fd), legacy = JSON.stringify(names) === '["pid"]';
    if (!legacy && JSON.stringify(names) !== JSON.stringify(["pid", LOCK_MARKER].sort())) throw new CleanupRefused("cleanup.lock entries must be exactly pid (legacy), or pid and ownership marker");
    const pid = readMember(fd, "pid");
    if (!/^[0-9]+\n?$/.test(pid.raw) || !validPid(Number(pid.raw.trim()))) throw new CleanupRefused("cleanup.lock pid must be numeric");
    const owner = Number(pid.raw.trim()), members: Record<string, ReturnType<typeof readMember>> = { pid };
    let token: string | null = null;
    if (!legacy) {
      const marker = readMember(fd, LOCK_MARKER); members[LOCK_MARKER] = marker;
      const m = JSON.parse(marker.raw);
      if (!validRecord(m, LOCK_MARKER) || m.root !== root || m.identity !== id(fd) || m.pid !== owner) throw new CleanupRefused("cleanup.lock ownership marker does not match root/inode/pid");
      token = m.token;
    }
    return { identity: id(fd), owner, token, members };
  } finally { fs.closeSync(fd); }
}
type Lock = ReturnType<typeof inspectLock>;
function removeLock(parent: number, root: string, expected: Lock) {
  if (JSON.stringify(inspectLock(parent, root)) !== JSON.stringify(expected)) throw new CleanupRefused("cleanup.lock identity/content changed before removal");
  const fd = openAt(parent, "cleanup.lock", true);
  try {
    if (id(fd) !== expected.identity) throw new CleanupRefused("cleanup.lock directory changed");
    for (const [name, member] of Object.entries(expected.members)) {
      if (JSON.stringify(readMember(fd, name)) !== JSON.stringify(member)) throw new CleanupRefused(`cleanup.lock ${name} changed`);
    }
    if (JSON.stringify(entries(fd)) !== JSON.stringify(Object.keys(expected.members).sort())) throw new CleanupRefused("cleanup.lock entries changed");
    for (const name of Object.keys(expected.members)) unlinkAt(fd, name);
    const current = openAt(parent, "cleanup.lock", true);
    try { if (id(current) !== expected.identity) throw new CleanupRefused("cleanup.lock name changed"); } finally { fs.closeSync(current); }
    unlinkAt(parent, "cleanup.lock", true);
  } finally { fs.closeSync(fd); }
}
function publishLock(parent: number, root: string) {
  const name = `.cleanup.lock.${randomUUID()}.new`;
  if (native.symbols.mkdirat(parent, z(name), 0o700)) fail("mkdir cleanup candidate");
  const fd = openAt(parent, name, true), identity = id(fd), written: Record<string, string> = {};
  const cwd = fs.openSync(".", C.O_RDONLY | C.O_DIRECTORY);
  try {
    const m = record(LOCK_MARKER, root, identity);
    if (native.symbols.fchdir(fd)) fail("enter cleanup candidate");
    for (const [member, raw] of [["pid", `${m.pid}\n`], [LOCK_MARKER, JSON.stringify(m) + "\n"]]) {
      const template = z(".member.XXXXXX"), f = native.symbols.mkstemp(template) as number;
      if (f < 0) fail("create cleanup member");
      const temporary = template.toString().split("\0")[0]; written[temporary] = id(f);
      try { fs.writeFileSync(f, raw); renameExclusive(fd, temporary, member); written[member] = written[temporary]; delete written[temporary]; }
      finally { fs.closeSync(f); }
    }
    renameExclusive(parent, name, "cleanup.lock");
    return inspectLock(parent, root);
  } finally {
    if (native.symbols.fchdir(cwd)) fail("restore cleanup cwd");
    fs.closeSync(cwd);
    try {
      let current = -1;
      try { current = openAt(parent, name, true); } catch (e: any) { if (e.errno !== 2) throw e; }
      try {
        if (current >= 0) {
          if (id(current) !== identity) throw new CleanupRefused(`private candidate changed: ${name}`);
          for (const [member, expected] of Object.entries(written)) {
            const f = openAt(fd, member);
            try { if (id(f) !== expected) throw new CleanupRefused(`private member changed: ${member}`); } finally { fs.closeSync(f); }
            unlinkAt(fd, member);
          }
          unlinkAt(parent, name, true);
        }
      } finally { if (current >= 0) fs.closeSync(current); }
    } finally { fs.closeSync(fd); }
  }
}
export function acquireCleanupLock(root: string, waitSeconds: number): (() => void) | null {
  const r = runtime(root), dir = path.join(root, "seats", "run", "cleanup.lock"), until = Date.now() + waitSeconds * 1000;
  let transferred = false;
  const unchanged = () => { if (!cleanupPathUnchanged(root, path.dirname(dir), r.proof)) throw new CleanupRefused(`${dir}: path changed during check`); };
  try {
    for (;;) {
      if (native.symbols.flock(r.fd, 2)) fail("lock runtime transition");
      try {
        unchanged();
        let existing: Lock | null = null;
        try { existing = inspectLock(r.fd, root); } catch (e: any) { if (e.errno !== 2) throw e; }
        if (existing && !alive(existing.owner)) { unchanged(); removeLock(r.fd, root, existing); existing = null; }
        if (!existing) {
          const owned = publishLock(r.fd, root)!;
          unchanged(); transferred = true;
          return () => {
            try {
              if (native.symbols.flock(r.fd, 2)) fail("lock release transition");
              unchanged(); const current = inspectLock(r.fd, root);
              if (current.owner !== process.pid || current.token !== owned.token || JSON.stringify(current) !== JSON.stringify(owned)) throw new CleanupRefused(`${dir}: owner token/pid or identity changed; kept lock`);
              removeLock(r.fd, root, owned);
            } finally { native.symbols.flock(r.fd, 8); fs.closeSync(r.fd); }
          };
        }
      } finally { native.symbols.flock(r.fd, 8); }
      if (Date.now() >= until) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  } catch (e: any) { throw new CleanupRefused(`${dir}: ${e.message}`); }
  finally { if (!transferred) fs.closeSync(r.fd); }
}

/** Explicitly record an owned run at creation; never infer ownership from name. */
export function recordCleanupScratch(root: string, target: string, bead: string, createdIdentity?: string) {
  root = fs.realpathSync(root); target = path.resolve(target);
  const proof = cleanupPathIdentity(root, target);
  if (createdIdentity !== undefined && proof.chain.at(-1)!.identity !== createdIdentity) throw new CleanupRefused(`created scratch changed before recording: ${target}`);
  if (![".wheelhouse-runs", ".wheelhouse-build", ".wheelhouse-worktrees"].some(c => path.dirname(target) === path.join(root, c))) throw new CleanupRefused(`not a direct cleanup scratch child: ${target}`);
  if (!bead || ![bead, `${bead}-`, `${bead}_`].some(p => path.basename(target) === p || (p !== bead && path.basename(target).startsWith(p)))) throw new CleanupRefused(`scratch name does not match bead ${bead}: ${target}`);
  const m = { ...record("wheelhouse-cleanup-scratch", root, proof.chain.at(-1)!.identity), target, bead };
  if (!cleanupPathUnchanged(root, target, proof)) throw new CleanupRefused(`scratch changed before recording: ${target}`);
  primitives();
  const fd = fs.openSync(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  const cwd = fs.openSync(".", C.O_RDONLY | C.O_DIRECTORY);
  let temporary = "", temporaryId = "";
  try {
    if (id(fd) !== m.identity) throw new CleanupRefused(`scratch changed before recording: ${target}`);
    if (native.symbols.fchdir(fd)) fail("enter scratch descriptor");
    const template = z(".scratch-member.XXXXXX"), out = native.symbols.mkstemp(template) as number;
    if (out < 0) fail("create scratch marker");
    temporary = template.toString().split("\0")[0]; temporaryId = id(out);
    try { fs.writeFileSync(out, JSON.stringify(m) + "\n"); renameExclusive(fd, temporary, SCRATCH_MARKER); temporary = ""; }
    finally { fs.closeSync(out); }
    if (!cleanupPathUnchanged(root, target, proof)) throw new CleanupRefused(`scratch changed while recording: ${target}`);
  } finally {
    if (native.symbols.fchdir(cwd)) fail("restore scratch cwd");
    fs.closeSync(cwd);
    try {
      if (temporary) {
        const f = openAt(fd, temporary);
        try { if (id(f) !== temporaryId) throw new CleanupRefused("private scratch marker changed"); } finally { fs.closeSync(f); }
        unlinkAt(fd, temporary);
      }
    } finally { fs.closeSync(fd); }
  }
}
/** Dispatch creates canonical task scratch; never adopt an existing unmarked run.
 * Publish a private empty directory exclusively, retaining its descriptor so
 * recordCleanupScratch cannot accidentally claim a replacement at that name. */
export function prepareTaskScratch(root: string, bead: string) {
  if (!bead || bead === "." || bead === ".." || /[/\\\s'"`]/.test(bead)) throw new CleanupRefused(`invalid scratch bead: ${JSON.stringify(bead)}`);
  root = fs.realpathSync(root);
  const target = path.join(root, ".wheelhouse-runs", bead), r = runtime(root);
  let rootFd = -1, parent = -1, candidate = -1, temporary = "";
  try {
    if (native.symbols.flock(r.fd, 2)) fail("lock scratch creation");
    rootFd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    if (native.symbols.mkdirat(rootFd, z(".wheelhouse-runs"), 0o700) && errno() !== 17) fail("mkdir .wheelhouse-runs");
    parent = openAt(rootFd, ".wheelhouse-runs", true);
    const proof = cleanupPathIdentity(root, path.dirname(target));
    if (proof.chain.at(-1)!.identity !== id(parent)) throw new CleanupRefused("scratch parent changed during creation");
    const unchanged = () => { if (!cleanupPathUnchanged(root, path.dirname(target), proof)) throw new CleanupRefused("scratch parent changed during creation"); };
    // An existing marker is validated, not replaced. Missing markers remain
    // missing, including legacy empty directories; only the creator can claim.
    const existing = () => {
      unchanged();
      try { scratchOwnership(root, target, bead); return { target, owned: true }; }
      catch (e: any) { if (e.errno === 2) return { target, owned: false }; throw e; }
    };
    let present = -1;
    try { present = openAt(parent, bead, true); }
    catch (e: any) { if (e.errno !== 2) throw e; }
    if (present >= 0) { fs.closeSync(present); return existing(); }
    requireStableHost(); // Do not publish an unmarked task if identity lookup failed.
    temporary = `.scratch-create-${randomUUID()}`;
    if (native.symbols.mkdirat(parent, z(temporary), 0o700)) fail("mkdir scratch candidate");
    candidate = openAt(parent, temporary, true);
    unchanged();
    try { renameExclusive(parent, temporary, bead); }
    catch (e: any) { if (e.errno === 17 || e.errno === 39 || e.errno === 66) return existing(); throw e; }
    temporary = "";
    unchanged();
    recordCleanupScratch(root, target, bead, id(candidate));
    return { target, owned: true };
  } finally {
    try {
      if (temporary && candidate >= 0) {
        const current = openAt(parent, temporary, true);
        try { if (id(current) !== id(candidate) || entries(candidate).length) throw new CleanupRefused("private scratch candidate changed; kept"); }
        finally { fs.closeSync(current); }
        unlinkAt(parent, temporary, true);
      }
    } finally {
      if (candidate >= 0) fs.closeSync(candidate);
      if (parent >= 0) fs.closeSync(parent);
      if (rootFd >= 0) fs.closeSync(rootFd);
      native.symbols.flock(r.fd, 8); fs.closeSync(r.fd);
    }
  }
}
function scratchContextMatches(m: any, root: string, target: string, identity: string, bead?: string) {
  return m.root === root && m.target === target && m.identity === identity
    && typeof m.bead === "string" && m.bead.length > 0 && (bead === undefined || m.bead === bead)
    && (path.basename(target) === m.bead || path.basename(target).startsWith(m.bead + "-") || path.basename(target).startsWith(m.bead + "_"));
}
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function legacyAdoptionHint(root: string, target: string, bead: string) {
  return `legacy v1 scratch host cannot be proven: ${target}; explicit operator recovery: bun seats/cleanup-identity.ts adopt-v1 --root ${shellQuote(root)} --target ${shellQuote(target)} --bead ${shellQuote(bead)}; see seats/README.md: Explicit legacy scratch host adoption`;
}
export function scratchOwnership(root: string, target: string, bead?: string) {
  const proof = cleanupPathIdentity(root, target);
  const fd = fs.openSync(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    primitives();
    if (id(fd) !== proof.chain.at(-1)!.identity) throw new CleanupRefused(`scratch identity changed: ${target}`);
    const member = readMember(fd, SCRATCH_MARKER), m = JSON.parse(member.raw);
    if (!validRecordFields(m, "wheelhouse-cleanup-scratch") || !scratchContextMatches(m, root, target, id(fd), bead)) throw new CleanupRefused(`scratch ownership marker does not match root/path/inode/bead: ${target}`);
    let ours: boolean;
    try { ours = markerHostMatches(m); }
    catch (e) { if (m.version === 1) throw new CleanupRefused(legacyAdoptionHint(root, target, m.bead)); throw e; }
    if (!ours) throw new CleanupRefused(m.version === 1 ? legacyAdoptionHint(root, target, m.bead) : `scratch ownership marker does not match root/path/inode/bead: ${target}`);
    return member;
  } finally { fs.closeSync(fd); }
}

const ADOPTION_LOG = "cleanup-adoptions.jsonl";
function adoptionAudit(root: string, rootIdentity: string) {
  const rootFd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  let seats = -1, logs = -1, out = -1, cwd = -1;
  try {
    if (id(rootFd) !== rootIdentity) throw new CleanupRefused("adoption root changed");
    seats = openAt(rootFd, "seats", true);
    if (native.symbols.mkdirat(seats, z("logs"), 0o700) !== 0 && errno() !== 17) throw error("mkdir adoption logs");
    logs = openAt(seats, "logs", true);
    const directory = path.join(root, "seats", "logs"), proof = cleanupPathIdentity(root, directory);
    if (id(logs) !== proof.chain.at(-1)!.identity || proof.chain[0].identity !== rootIdentity) throw new CleanupRefused("adoption log directory changed");
    cwd = fs.openSync(".", C.O_RDONLY | C.O_DIRECTORY);
    if (native.symbols.fchdir(logs) !== 0) throw error("enter adoption logs");
    out = fs.openSync(ADOPTION_LOG, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
    const output = out, directoryFd = logs;
    const append = (event: object) => {
      if (!cleanupPathUnchanged(root, directory, proof)) throw new CleanupRefused("adoption log path changed");
      const current = openAt(directoryFd, ADOPTION_LOG);
      try {
        const st = fs.fstatSync(output);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || id(current) !== id(output)) throw new CleanupRefused("unsafe adoption audit file");
      } finally { fs.closeSync(current); }
      fs.writeFileSync(output, JSON.stringify(event) + "\n"); fs.fsyncSync(output);
    };
    // Validate before any marker change (also refuses preexisting hardlinks).
    const st = fs.fstatSync(output);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!()) throw new CleanupRefused("unsafe adoption audit file");
    out = -1; logs = -1;
    return { append, close() { fs.closeSync(output); fs.closeSync(directoryFd); }, file: path.join(directory, ADOPTION_LOG) };
  } finally {
    if (cwd >= 0) { native.symbols.fchdir(cwd); fs.closeSync(cwd); }
    if (out >= 0) fs.closeSync(out);
    if (logs >= 0) fs.closeSync(logs);
    if (seats >= 0) fs.closeSync(seats);
    fs.closeSync(rootFd);
  }
}

// Explicit operator authority only. Dispatch and cleanup must never call this.
function adoptLegacyScratch(root: string, target: string, bead: string) {
  if (!bead || bead === "." || bead === ".." || /[/\\\s'"`]/.test(bead)) throw new CleanupRefused("invalid adoption bead");
  const parent = path.dirname(target), allowed = [".wheelhouse-runs", ".wheelhouse-builds", ".wheelhouse-worktrees"];
  if (path.dirname(parent) !== root || !allowed.includes(path.basename(parent))) throw new CleanupRefused("adoption target must be a direct scratch child of this root");
  const proof = cleanupPathIdentity(root, target), r = runtime(root);
  let fd = -1, temporary = "", audit: ReturnType<typeof adoptionAudit> | undefined, committed = false;
  try {
    if (native.symbols.flock(r.fd, 2) !== 0) throw error("lock adoption transition");
    // Do not race a cleanup scan, even one with a dead or unprovable lease.
    let lease = -1;
    try { lease = openAt(r.fd, "cleanup.lock", true); }
    catch (e: any) { if (e.errno !== 2) throw e; }
    if (lease >= 0) { fs.closeSync(lease); throw new CleanupRefused("adoption requires cleanup idle and no cleanup.lock; resolve its owner separately"); }
    if (!cleanupPathUnchanged(root, target, proof) || !cleanupPathUnchanged(root, r.dir, r.proof)) throw new CleanupRefused("adoption path changed");
    fd = fs.openSync(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const before = readMember(fd, SCRATCH_MARKER), m = JSON.parse(before.raw);
    if (m.version !== 1 || !validRecordFields(m, "wheelhouse-cleanup-scratch") || !scratchContextMatches(m, root, target, id(fd), bead)) throw new CleanupRefused("adoption requires a valid v1 marker matching root, target path, inode and bead; unmarked folders and v2 markers cannot be adopted");
    const next = { ...record("wheelhouse-cleanup-scratch", root, id(fd)), target, bead }, raw = JSON.stringify(next) + "\n";
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const event = { adoptionId: randomUUID(), at: new Date().toISOString(), root, target, bead, identity: id(fd), previousHostname: m.hostname, previousMarkerSha256: digest(before.raw), newMarkerSha256: digest(raw), hostId: next.hostId };
    audit = adoptionAudit(root, proof.chain[0].identity);
    audit.append({ event: "adopt-v1-intent", ...event });
    const cwd = fs.openSync(".", C.O_RDONLY | C.O_DIRECTORY);
    try {
      if (native.symbols.fchdir(fd) !== 0) throw error("enter adoption target");
      const template = Buffer.from(".adopt-member.XXXXXX\0"), out = native.symbols.mkstemp(template);
      if (out < 0) throw error("create adopted marker");
      temporary = template.toString().replace(/\0.*$/, "");
      try { fs.writeFileSync(out, raw); fs.fsyncSync(out); }
      finally { fs.closeSync(out); }
      if (!cleanupPathUnchanged(root, target, proof) || JSON.stringify(readMember(fd, SCRATCH_MARKER)) !== JSON.stringify(before)) throw new CleanupRefused("legacy marker changed during adoption");
      const replace = darwin ? native.symbols.renameatx_np : native.symbols.renameat2;
      if (replace(fd, z(temporary), fd, z(SCRATCH_MARKER), 0) !== 0) throw error("publish adopted marker");
      temporary = ""; committed = true;
      fs.fsyncSync(fd);
      if (!cleanupPathUnchanged(root, target, proof) || readMember(fd, SCRATCH_MARKER).raw !== raw) throw new CleanupRefused("adopted marker/path changed during commit");
      audit.append({ event: "adopted-v1", ...event });
      return { event: "adopted-v1", root, target, bead, hostId: next.hostId, audit: audit.file };
    } finally { native.symbols.fchdir(cwd); fs.closeSync(cwd); }
  } catch (e: any) {
    if (committed) throw new CleanupRefused(`v2 marker was committed but adoption verification/audit failed: ${e.message}; inspect cleanup-adoptions.jsonl and the marker before retrying`);
    throw e;
  } finally {
    if (temporary && fd >= 0) native.symbols.unlinkat(fd, z(temporary), 0);
    if (fd >= 0) fs.closeSync(fd);
    audit?.close();
    fs.closeSync(r.fd);
  }
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2), options = new Map<string, string>();
    if (command !== "adopt-v1" || args.length !== 6) throw new CleanupRefused("usage: bun seats/cleanup-identity.ts adopt-v1 --root <install-root> --target <scratch-path> --bead <bead>");
    for (let i = 0; i < args.length; i += 2) {
      if (!["--root", "--target", "--bead"].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new CleanupRefused("adopt-v1 requires exactly --root, --target and --bead");
      options.set(args[i], args[i + 1]);
    }
    console.log(JSON.stringify(adoptLegacyScratch(path.resolve(options.get("--root")!), path.resolve(options.get("--target")!), options.get("--bead")!)));
  } catch (e: any) { console.error(`STOP: ${e.message}; see seats/README.md: Explicit legacy scratch host adoption`); process.exitCode = 2; }
}
