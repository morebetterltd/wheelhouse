// Fixture-only provider changes. The production APIs have no host-ID override.
// IOPlatformUUID property captured with /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice
// on 2026-10-19; only its identifying value was normalized in cleanup-host-ioreg.txt.
import * as fs from "node:fs";
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as ffi from "bun:ffi";
import { mock } from "bun:test";
const nativeFs = { ...fs }, nativeCp = { ...cp }, nativeOs = { ...os }, nativeFfi = { ...ffi };
const capture = fs.readFileSync(new URL("./cleanup-host-ioreg.txt", import.meta.url), "utf8");
const machine = process.env.CLEANUP_FIXTURE_MACHINE ?? "a";
const uuid = machine === "b" ? "20000000-0000-0000-0000-000000000002" : "10000000-0000-0000-0000-000000000001";
function unavailable(): never { throw Object.assign(new Error("fixture hardware identity unavailable"), { code: "ENOENT" }); }
const execFileSync = ((file: any, ...args: any[]) => {
  if (file === "/usr/sbin/ioreg") {
    if (machine === "unavailable") unavailable();
    const output = capture.replace("10000000-0000-0000-0000-000000000001", uuid);
    // Model the native command's stdio contract, not only its pipe return.
    // The production identity reader now captures into a private descriptor.
    const stdout = args[1]?.stdio?.[1];
    if (typeof stdout === "number") {
      nativeFs.writeSync(stdout, output);
      return null;
    }
    return output;
  }
  return (nativeCp.execFileSync as any)(file, ...args);
}) as typeof cp.execFileSync;
const readFileSync = ((file: any, ...args: any[]) => {
  if (file === "/etc/machine-id") {
    if (machine === "unavailable") unavailable();
    return (machine === "b" ? "2" : "1").repeat(32) + "\n";
  }
  return (nativeFs.readFileSync as any)(file, ...args);
}) as typeof fs.readFileSync;
// Fixture-only restart/mount observations. Inodes, modes, contents and actual
// filesystem operations are real; only the observed device fields change.
const shift = Number(process.env.CLEANUP_FIXTURE_DEVICE_SHIFT || "0");
if (!Number.isSafeInteger(shift) || shift < 0) throw new Error("invalid fixture device shift");
const other = process.env.CLEANUP_FIXTURE_OTHER_VOLUME;
const otherInodes = new Set<string>();
function inventory(file: string) {
  const st = nativeFs.lstatSync(file, { bigint: true }); otherInodes.add(String(st.ino));
  if (st.isDirectory()) for (const name of nativeFs.readdirSync(file)) inventory(path.join(file, name));
}
if (other) inventory(other);
function observed(st: any) {
  const change = shift + (otherInodes.has(String(st.ino)) ? 1 : 0);
  if (change) Object.defineProperty(st, "dev", { value: typeof st.dev === "bigint" ? st.dev + BigInt(change) : st.dev + change, enumerable: true, configurable: true });
  return st;
}
const lstatSync = ((...args: any[]) => observed((nativeFs.lstatSync as any)(...args))) as typeof fs.lstatSync;
const statSync = ((...args: any[]) => observed((nativeFs.statSync as any)(...args))) as typeof fs.statSync;
const fstatSync = ((...args: any[]) => observed((nativeFs.fstatSync as any)(...args))) as typeof fs.fstatSync;
const hostname = () => process.env.CLEANUP_FIXTURE_HOST ?? "network-after";
mock.module("node:child_process", () => ({ ...nativeCp, execFileSync, default: { ...nativeCp.default, execFileSync } }));
mock.module("node:fs", () => ({ ...nativeFs, readFileSync, lstatSync, statSync, fstatSync, default: { ...nativeFs.default, readFileSync, lstatSync, statSync, fstatSync } }));
mock.module("node:os", () => ({ ...nativeOs, hostname, default: { ...nativeOs.default, hostname } }));
if (process.env.CLEANUP_FIXTURE_FAIL_ADOPTION_LOGS === "1") {
  // Exercise a real FFI error/errno, not a fabricated CLI refusal. An invalid
  // directory descriptor makes only adoption's mkdirat("logs") fail EBADF.
  const dlopen = ((file: any, symbols: any) => {
    const library = nativeFfi.dlopen(file, symbols), mkdirat = library.symbols.mkdirat;
    if (!mkdirat) return library;
    return { ...library, symbols: { ...library.symbols, mkdirat(fd: number, name: Buffer, mode: number) {
      return (mkdirat as any)(name.toString() === "logs\0" ? -1 : fd, name, mode);
    } } };
  }) as typeof ffi.dlopen;
  mock.module("bun:ffi", () => ({ ...nativeFfi, dlopen }));
}
