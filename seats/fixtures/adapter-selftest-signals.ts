// Event-only adapter.selftest waits: no timer, polling sleep or elapsed budget.
import fs from "node:fs";
import path from "node:path";
import { dlopen, FFIType as T, ptr, toArrayBuffer } from "bun:ffi";

const darwin = process.platform === "darwin";
if (!darwin && process.platform !== "linux") throw new Error("event waits require Darwin kqueue or Linux inotify/pidfd");
const common = { flock: { args: [T.i32, T.i32], returns: T.i32 } };
const symbols: any = darwin ? {
  ...common,
  kqueue: { args: [], returns: T.i32 },
  kevent: { args: [T.i32, T.ptr, T.i32, T.ptr, T.i32, T.ptr], returns: T.i32 },
  __error: { args: [], returns: T.ptr },
} : {
  ...common,
  inotify_init1: { args: [T.i32], returns: T.i32 },
  inotify_add_watch: { args: [T.i32, T.ptr, T.u32], returns: T.i32 },
  syscall: { args: [T.i64, T.i32, T.u32], returns: T.i32 },
  poll: { args: [T.ptr, T.u64, T.i32], returns: T.i32 },
  __errno_location: { args: [], returns: T.ptr },
};
const lib = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", symbols);
const native: any = lib.symbols;
function errno(): number {
  return new Int32Array(toArrayBuffer(darwin ? native.__error() : native.__errno_location(), 0, 4))[0];
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { if (e.code === "ESRCH") return false; throw e; }
}
function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 0 || pid > 0x7fffffff) throw new Error("invalid producer pid");
}
function parentDir(file: string): string {
  let dir = path.dirname(file);
  for (;;) {
    try { if (fs.statSync(dir).isDirectory()) return dir; }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
    const next = path.dirname(dir);
    if (next === dir) throw new Error("no existing parent for " + file);
    dir = next;
  }
}
function regular(file: string): boolean {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("signal subject is not a regular file: " + file);
    return true;
  } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
}
function watcher(file: string | null, pid: number) {
  const fds: number[] = [];
  const open = (p: string) => { const fd = fs.openSync(p, "r"); fds.push(fd); return fd; };
  const close = () => { for (const fd of fds.splice(0)) try { fs.closeSync(fd); } catch {} };
  try {
    if (darwin) {
      const kq = native.kqueue();
      if (kq < 0) throw new Error("kqueue errno " + errno());
      fds.push(kq);
      const changes: Buffer[] = [];
      // Darwin's 64-bit struct kevent is 32 bytes: ident, filter/flags,
      // fflags, data, udata. EV_ADD|EV_CLEAR for vnode; ONESHOT for EXIT.
      function add(id: number, filter: number, flags: number, notes: number) {
        const b = Buffer.alloc(32);
        b.writeBigUInt64LE(BigInt(id), 0); b.writeInt16LE(filter, 8);
        b.writeUInt16LE(flags, 10); b.writeUInt32LE(notes >>> 0, 12);
        changes.push(b);
      }
      if (file) {
        add(open(parentDir(file)), -4, 0x21, 0x7f);
        if (regular(file)) add(open(file), -4, 0x21, 0x7f);
      }
      if (pid > 0) add(pid, -5, 0x15, 0x80000000); // EVFILT_PROC, NOTE_EXIT
      if (!changes.length) throw new Error("wait needs a file or producer pid");
      const buffer = Buffer.concat(changes);
      let result: number;
      do { result = native.kevent(kq, ptr(buffer), changes.length, null, 0, null); } while (result < 0 && errno() === 4);
      if (result < 0) {
        const e = errno(); close();
        if (e === 3 && pid > 0) return { dead: true, wait: () => "exit", close: () => {} };
        throw new Error("kevent registration errno " + e);
      }
      return {
        dead: false, close,
        wait() {
          const event = Buffer.alloc(32);
          let n: number;
          do { n = native.kevent(kq, null, 0, ptr(event), 1, null); } while (n < 0 && errno() === 4);
          if (n < 0) throw new Error("kevent wait errno " + errno());
          if (n !== 1) throw new Error("kevent returned without an event");
          const filter = event.readInt16LE(8), flags = event.readUInt16LE(10), data = Number(event.readBigInt64LE(16));
          if (flags & 0x4000) {
            if (filter === -5 && data === 3) return "exit";
            throw new Error("kevent event errno " + data);
          }
          if (filter === -5) return "exit";
          if (filter === -4) return "file";
          throw new Error("unexpected kevent filter " + filter);
        },
      };
    }
    const entries: { fd: number; kind: string }[] = [];
    let dead = false;
    if (file) {
      const fd = native.inotify_init1(0x800 | 0x80000); // NONBLOCK | CLOEXEC
      if (fd < 0) throw new Error("inotify errno " + errno());
      fds.push(fd);
      for (const target of [parentDir(file), ...(regular(file) ? [file] : [])]) {
        const name = Buffer.from(target + "\0");
        if (native.inotify_add_watch(fd, ptr(name), 0xfce) < 0) throw new Error("inotify watch errno " + errno());
      }
      entries.push({ fd, kind: "file" });
    }
    if (pid > 0) {
      // pidfd_open is syscall 434 on Linux x86_64 and aarch64.
      if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("unsupported pidfd syscall architecture");
      const fd = native.syscall(434, pid, 0);
      if (fd < 0) {
        if (!alive(pid)) dead = true;
        else throw new Error("pidfd_open requires a supporting Linux kernel (errno " + errno() + ")");
      } else { fds.push(fd); entries.push({ fd, kind: "exit" }); }
    }
    return {
      dead, close,
      wait() {
        const data = Buffer.alloc(entries.length * 8);
        entries.forEach((e, i) => { data.writeInt32LE(e.fd, i * 8); data.writeInt16LE(1, i * 8 + 4); });
        let n: number;
        do { n = native.poll(ptr(data), entries.length, -1); } while (n < 0 && errno() === 4);
        if (n < 0) throw new Error("poll errno " + errno());
        for (let i = 0; i < entries.length; i++) {
          const returned = data.readInt16LE(i * 8 + 6);
          if (returned & (8 | 32)) throw new Error("poll descriptor error " + returned);
          if (returned) return entries[i].kind;
        }
        throw new Error("poll returned without an event");
      },
    };
  } catch (error) { close(); throw error; }
}
function ready(): void {
  if (process.env.ADAPTER_WAIT_READY) {
    fs.writeFileSync(process.env.ADAPTER_WAIT_READY, "watching\n");
    delete process.env.ADAPTER_WAIT_READY;
  }
}
function wait(mode: string, file: string, needle: string, offset: number, pid: number): void {
  validatePid(pid);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid byte offset");
  const match = () => {
    if (!regular(file)) return false;
    if (mode === "exists") return true;
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) return false;
      const bytes = Buffer.alloc(size - offset);
      fs.readSync(fd, bytes, 0, bytes.length, offset);
      const text = bytes.toString("utf8");
      return mode === "regex" ? new RegExp(needle).test(text) : text.includes(needle);
    } finally { fs.closeSync(fd); }
  };
  for (;;) {
    // Subscribe BEFORE inspecting. Parent watches cover create/atomic rename;
    // inode watches cover writes, and producer EXIT makes missing data fail.
    const w = watcher(file, pid);
    try {
      if (match()) return;
      if (w.dead) throw new Error("producer exited before signal: " + file);
      ready();
      const event = w.wait();
      if (event !== "file" && event !== "exit") throw new Error("missing kernel wake event");
      if (match()) return;
      if (event === "exit") throw new Error("producer exited before signal: " + file);
    } finally { w.close(); }
  }
}
const [mode, ...args] = process.argv.slice(2);
if (process.env.ADAPTER_WAIT_AUDIT_DIR) {
  const file = path.join(process.env.ADAPTER_WAIT_AUDIT_DIR, `wait-${process.pid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, mode, args }));
  process.on("exit", () => { try { fs.rmSync(file); } catch {} });
}
try {
  if (mode === "text" || mode === "regex" || mode === "exists") {
    wait(mode, path.resolve(args[0]), args[1] ?? "", Number(args[2] ?? 0), Number(args[3] ?? 0));
  } else if (mode === "exit") {
    const pid = Number(args[0]); validatePid(pid);
    if (!pid) throw new Error("exit wait needs a producer pid");
    const w = watcher(null, pid);
    try {
      ready();
      if (!w.dead && alive(pid)) {
        const event = w.wait();
        if (event !== "exit") throw new Error("missing kernel EXIT event");
      }
    } finally { w.close(); }
  } else if (mode === "flock-busy") {
    const file = path.resolve(args[0]);
    if (!regular(file)) throw new Error("lock subject missing: " + file);
    const fd = fs.openSync(file, "r+");
    try {
      const result = native.flock(fd, 2 | 4), error = errno();
      if (result === 0) { native.flock(fd, 8); throw new Error("expected held flock, but it was free"); }
      if (error !== (darwin ? 35 : 11)) throw new Error("unexpected flock errno " + error);
      console.log("PASS native flock held");
    } finally { fs.closeSync(fd); }
  } else if (mode === "stamp") {
    if (!regular(args[0])) throw new Error("state subject missing");
    const st = fs.statSync(args[0], { bigint: true });
    if (typeof st.mtimeNs !== "bigint") throw new Error("nanosecond state timestamp unavailable");
    console.log(JSON.stringify({ dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime: String(st.mtimeNs), bytes: fs.readFileSync(args[0]).toString("base64") }));
  } else throw new Error("unknown signal helper mode " + mode);
} catch (error: any) { console.error("SIGNAL_WAIT: " + error.message); process.exitCode = 1; }
