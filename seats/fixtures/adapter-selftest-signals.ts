// Lifecycle ownership: kernel file/exit events, explicit actor release, and
// native fd/title reconciliation without an elapsed correctness deadline.
// The admitted suite supplies named outer containment (default3600s); pending
// observations are printed before blocking so expiry retains what was seen.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command.ts";
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
function wait(mode: string, file: string, needle: string, offset: number, pid: number, count = 1): void {
  validatePid(pid);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid byte offset");
  if (mode === "count" && (!needle || !Number.isSafeInteger(count) || count < 1)) throw new Error("invalid event count");
  let lastSeen: any;
  const match = () => {
    if (!regular(file)) { lastSeen = { file, present: false }; return false; }
    if (mode === "exists") return true;
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) return false;
      const bytes = Buffer.alloc(size - offset);
      fs.readSync(fd, bytes, 0, bytes.length, offset);
      const text = bytes.toString("utf8");
      lastSeen = { file, size, offset, matches: mode === "count" ? text.split(needle).length - 1 : undefined };
      return mode === "count" ? lastSeen.matches >= count : mode === "regex" ? new RegExp(needle).test(text) : text.includes(needle);
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
      console.error("WAIT lifecycle event " + JSON.stringify({ mode, needle, count, producer: pid, lastSeen, outer: "admitted suite containment (default3600s)" }));
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
async function ownershipCheck(root: string): Promise<void> {
  fs.mkdirSync(root, { recursive: true });
  const helper = process.env.LIFECYCLE_TEST_HELPER || import.meta.path;
  const actors: any[] = [], record: any = { platform: process.platform, arch: process.arch, outer: "admitted suite containment (default3600s)", cases: [], failures: [] };
  const own = (argv: string[]) => {
    const child = spawn("bun", argv, { cwd: root, stdio: "inherit" });
    const a: any = { child, ended: false };
    a.closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { a.ended = true; a.native = { code, signal }; resolve(); }); });
    actors.push(a); return a;
  };
  const release = path.join(root, "holder.release"), published = path.join(root, "holder.ready"), fifo = path.join(root, "holder.stdin");
  const mk = completedCommand("mkfifo", [fifo]);
  console.error("CAPTURE lifecycle mkfifo " + JSON.stringify(mk)); assert.equal(mk.status, 0);
  const holder = own([helper, "hold", release, published, fifo]);
  try {
    while (!fs.existsSync(published) && !holder.ended) await Bun.sleep(50);
    assert(fs.existsSync(published), "owned holder must publish ready");
    assert.equal(Number(fs.readFileSync(published, "utf8")), holder.child.pid);
    record.holder = { pid: holder.child.pid, ready: true };
    if (holder.ended) throw new Error("published holder exited before owner release");
    const fd = completedCommand("lsof", ["-Fn", "-p", String(holder.child.pid)]);
    record.fd = fd;
    console.error("CAPTURE lifecycle ready FIFO native " + JSON.stringify({ pid: holder.child.pid, expected: fifo, native: fd }));
    assert.equal(fd.status, 0, "ready holder native fd observation must be available");
    assert(fd.stdout.split("\n").includes("n" + fifo), "published ready holder must actually hold its FIFO");
    for (const kind of ["text", "count"]) {
      const file = path.join(root, kind + ".data"), needle = kind === "text" ? "LIFECYCLE_READY" : "FRAME";
      fs.writeFileSync(file, kind === "count" ? "FRAME\n" : "");
      // Delay is controlled INPUT, not a deadline or pass-on-elapsed assertion.
      const producer = own(["-e", 'const fs=require("node:fs");await Bun.sleep(16000);fs.appendFileSync(process.argv[1],process.argv[2]);', file, kind === "text" ? "LIFECYCLE_READY\n" : "FRAME\n"]);
      const native = completedCommand("bun", [helper, kind, file, needle, "0", String(holder.child.pid), "2"]);
      const text = fs.readFileSync(file, "utf8"), delivered = kind === "text" ? text.includes(needle) : text.split(needle).length - 1 >= 2;
      record.cases.push({ kind, input: { file, needle, count: 2 }, native, deliveredAtReturn: delivered, holderAlive: alive(holder.child.pid) });
      console.error("CAPTURE lifecycle return " + JSON.stringify(record.cases.at(-1)));
      if (!delivered || native.status !== 0) record.failures.push(kind + " wait returned without delivered input/native success");
      if (!delivered && !producer.ended) producer.child.kill("SIGTERM"); // containment AFTER forbidden early return is recorded
      await producer.closed;
    }
    const dead = own(["-e", "process.exit(37)"]); await dead.closed;
    const rejected = completedCommand("bun", [helper, "text", path.join(root, "never.data"), "never", "0", String(dead.child.pid)]);
    record.deadProducer = { input: dead.native, pid: dead.child.pid, native: rejected };
    assert.equal(dead.native.code, 37);
    if (rejected.status === 0 || !rejected.stderr.includes("producer exited")) record.failures.push("dead producer did not reject missing input");
    assert(!holder.ended && alive(holder.child.pid), "published holder exited before owner release");
    fs.writeFileSync(release, "explicit owner release\n"); await holder.closed;
    record.holder.released = true; record.holder.native = holder.native;
    assert.equal(holder.native.code, 0); assert.equal(holder.native.signal, null);
  } catch (error) { record.failures.push(String(error)); }
  finally {
    for (const a of actors) if (!a.ended) a.child.kill("SIGTERM");
    await Promise.all(actors.map(a => a.closed));
    record.actorResults = actors.map(a => ({ pid: a.child.pid, ...a.native }));
    const out = process.env.WHEELHOUSE_LIFECYCLE_EVIDENCE;
    if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(record, null, 2)); }
    console.error("CAPTURE lifecycle ownership " + JSON.stringify(record));
  }
  assert.equal(record.failures.length, 0, record.failures.join("; "));
  console.log("lifecycle ownership: PASS (explicit FIFO holder release, delayed text/count inputs, native37 producer rejection)");
}
try {
  if (mode === "text" || mode === "regex" || mode === "exists" || mode === "count") {
    wait(mode, path.resolve(args[0]), args[1] ?? "", Number(args[2] ?? 0), Number(args[3] ?? 0), Number(args[4] ?? 1));
  } else if (mode === "hold") {
    const [release, published, fifo] = args;
    const fd = fifo ? fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK) : null;
    try {
      fs.writeFileSync(published, String(process.pid) + "\n", { flag: "wx" });
      wait("exists", path.resolve(release), "", 0, 0);
    } finally { if (fd !== null) fs.closeSync(fd); }
  } else if (mode === "fd" || mode === "title") {
    const pid = Number(args[0]); validatePid(pid); if (!pid) throw new Error("observation needs a live producer");
    for (;;) {
      const native = mode === "fd" ? completedCommand("lsof", ["-Fn", "-p", String(pid)]) : completedCommand("ps", ["-p", String(pid), "-o", "command="]);
      console.error("CAPTURE lifecycle observation " + JSON.stringify({ mode, pid, expected: args[1], native }));
      if (native.error || native.signal || (native.status !== 0 && native.status !== 1)) throw new Error("UNVERIFIED native lifecycle observation");
      if (native.status === 0 && (mode === "fd" ? native.stdout.split("\n").includes("n" + args[1]) : native.stdout.trim() === args[1])) break;
      if (!alive(pid)) throw new Error("producer exited before " + mode + " observation");
      await Bun.sleep(50); // reconciliation cadence only; the admitted suite owns containment
    }
  } else if (mode === "selftest") {
    await ownershipCheck(path.resolve(args[0]));
  } else if (mode === "exit") {
    const pid = Number(args[0]); validatePid(pid);
    if (!pid) throw new Error("exit wait needs a producer pid");
    const w = watcher(null, pid);
    try {
      ready();
      if (!w.dead && alive(pid)) {
        console.error("WAIT lifecycle exit " + JSON.stringify({ pid, lastSeen: "live producer; kernel EXIT subscribed", outer: "admitted suite containment (default3600s)" }));
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
