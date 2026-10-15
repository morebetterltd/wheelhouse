// Identity proofs for automatic cleanup. No recursive lock removal.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { dlopen, FFIType, read, CString, toArrayBuffer } from "bun:ffi";

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
function validRecord(m: any, kind: string) {
  return m && !Array.isArray(m) && m.kind === kind && m.version === 1 && validPid(m.pid) && m.hostname === HOST
    && typeof m.token === "string" && /^[0-9a-f]{32}$/.test(m.token)
    && typeof m.started === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(m.started) && Number.isFinite(Date.parse(m.started))
    && new Date(m.started).toISOString().replace(".000Z", "Z") === m.started
    && JSON.stringify(Object.keys(m).sort()) === JSON.stringify(["kind", "version", "root", "identity", "pid", "hostname", "token", "started", ...(kind === "wheelhouse-cleanup-scratch" ? ["target", "bead"] : [])].sort());
}
function record(kind: string, root: string, identity: string) {
  return { kind, version: 1, root, identity, pid: process.pid, hostname: HOST, token: randomUUID().replaceAll("-", ""), started: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
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
export function recordCleanupScratch(root: string, target: string, bead: string) {
  root = fs.realpathSync(root); target = path.resolve(target);
  const proof = cleanupPathIdentity(root, target);
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
export function scratchOwnership(root: string, target: string, bead?: string) {
  const proof = cleanupPathIdentity(root, target);
  const fd = fs.openSync(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    primitives();
    if (id(fd) !== proof.chain.at(-1)!.identity) throw new CleanupRefused(`scratch identity changed: ${target}`);
    const member = readMember(fd, SCRATCH_MARKER), m = JSON.parse(member.raw);
    if (!validRecord(m, "wheelhouse-cleanup-scratch") || m.root !== root || m.target !== target || m.identity !== id(fd)
      || typeof m.bead !== "string" || !m.bead || (bead !== undefined && m.bead !== bead)
      || !(path.basename(target) === m.bead || path.basename(target).startsWith(m.bead + "-") || path.basename(target).startsWith(m.bead + "_"))) throw new CleanupRefused(`scratch ownership marker does not match root/path/inode/bead: ${target}`);
    return member;
  } finally { fs.closeSync(fd); }
}
