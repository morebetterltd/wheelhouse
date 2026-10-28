// Failure-only retention diagnostics. Never delete, retry or repair the subject.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Containment for a stalled observer on a loaded host, not a startup SLA.
export const RESIDUAL_CAPTURE_CONTAINMENT_MS = 30_000;

const errorRecord = (error: any) => ({ code: error?.code ?? null, message: String(error) });
export function identity(file: string) {
  try {
    const s = fs.lstatSync(file, { bigint: true });
    return { device: String(s.dev), inode: String(s.ino), error: null };
  } catch (error) { return { device: null, inode: null, error: errorRecord(error) }; }
}
function tree(root: string) {
  const entries: any[] = [], errors: any[] = [], pending = ['.'];
  while (pending.length) {
    const relative = pending.pop()!, file = path.join(root, relative);
    try {
      const s = fs.lstatSync(file), type = s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : s.isFIFO() ? 'fifo' : s.isSocket() ? 'socket' : 'other';
      entries.push({ path: relative, type, size: s.size, mtimeMs: s.mtimeMs });
      // lstat, never follow a link into unrelated state.
      if (s.isDirectory()) {
        try { for (const name of fs.readdirSync(file).sort().reverse()) pending.push(path.join(relative, name)); }
        catch (error) { errors.push({ path: relative, error: errorRecord(error) }); }
      }
    } catch (error) {
      entries.push({ path: relative, type: 'unavailable', size: null, mtimeMs: null });
      errors.push({ path: relative, error: errorRecord(error) });
    }
  }
  return { entries, errors };
}
// Native lsof -F0pcftn capture, not its terminal table. NUL preserves filenames;
// the newline between process/file records is a separator, not part of a field.
export function parseLsof(stdout: string) {
  const processes: { pid: number; command: string; files: { fd: string; type: string; path: string }[] }[] = [];
  let process: typeof processes[number] | undefined, file: typeof processes[number]['files'][number] | undefined;
  for (const field of stdout.split('\0')) {
    const value = field.replace(/^\n/, ''), key = value[0], body = value.slice(1);
    if (key === 'p' && /^[1-9][0-9]*$/.test(body)) { process = { pid: Number(body), command: '', files: [] }; processes.push(process); file = undefined; }
    else if (key === 'c' && process) process.command = body;
    else if (key === 'f' && process) { file = { fd: body, type: '', path: '' }; process.files.push(file); }
    else if (key === 't' && file) file.type = body;
    else if (key === 'n' && file) file.path = body;
  }
  return processes;
}
export function parsePs(stdout: string) {
  const rows: { pid: number; ppid: number; pgid: number; command: string }[] = [], errors: string[] = [];
  for (const line of stdout.split('\n').filter(s => s.trim())) {
    const m = line.match(/^\s*([1-9][0-9]*)\s+(\d+)\s+([1-9][0-9]*)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
    else errors.push(line);
  }
  return { rows, errors };
}
// Regular descriptors retain both streams without a pipe-size ceiling. A fresh
// group belongs only to this capture; containment never kills a holder.
async function capture(command: string, args: string[], proof: string, name: string) {
  const record: any = { command: [command, ...args], timeoutMs: RESIDUAL_CAPTURE_CONTAINMENT_MS, timedOut: false, code: null, signal: null, error: null, stdout: '', stderr: '' };
  const stdout = path.join(proof, `residual-${name}.stdout`), stderr = path.join(proof, `residual-${name}.stderr`);
  const fds: number[] = [], created = new Set<string>();
  try {
    fds.push(fs.openSync(stdout, 'wx', 0o600)); created.add(stdout);
    fds.push(fs.openSync(stderr, 'wx', 0o600)); created.add(stderr);
    const child = spawn(command, args, { stdio: ['ignore', fds[0], fds[1]], detached: true });
    const timer = setTimeout(() => {
      record.timedOut = true;
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') record.killError = errorRecord(error); }
    }, record.timeoutMs);
    try {
      await new Promise<void>(resolve => {
        child.once('error', error => { record.error = errorRecord(error); });
        child.once('close', (code, signal) => { record.code = record.error ? null : code; record.signal = signal; resolve(); });
      });
    } finally { clearTimeout(timer); }
  } catch (error) { record.error = errorRecord(error); }
  finally {
    for (const fd of fds) fs.closeSync(fd);
    for (const [field, file] of [['stdout', stdout], ['stderr', stderr]]) {
      if (!created.has(file)) continue; // Never substitute an earlier capture.
      try { record[field] = fs.readFileSync(file, 'utf8'); }
      catch (error) { record[`${field}ReadError`] = errorRecord(error); }
    }
  }
  return record;
}
export async function residual(root: string, before: ReturnType<typeof identity>, proof: string) {
  const after = identity(root), listing = tree(root);
  const lsof = await capture('lsof', ['-nP', '-F0pcftn', '+D', root], proof, 'lsof');
  const holders = parseLsof(lsof.stdout), pids = [...new Set(holders.map(p => p.pid))];
  // If lsof could not name a holder, retain a native observer row rather than
  // presenting an unexamined full-host census as evidence of no writers.
  const ps = await capture('ps', ['-ww', '-p', (pids.length ? pids : [process.pid]).join(','), '-o', 'pid=,ppid=,pgid=,command='], proof, 'ps');
  const parsed = parsePs(ps.stdout);
  return {
    before, after, sameInode: before.error || after.error ? null : before.device === after.device && before.inode === after.inode,
    entries: listing.entries, enumerationErrors: listing.errors,
    captures: { lsof, ps }, psScope: pids.length ? 'lsof holder pids' : 'observer only; lsof named no holders',
    censusComplete: !lsof.error && !lsof.timedOut && lsof.code === 0 && !ps.error && !ps.timedOut && ps.code === 0 && parsed.errors.length === 0 && holders.every(p => parsed.rows.some(row => row.pid === p.pid)),
    psParseErrors: parsed.errors,
    processes: holders.map(holder => {
      const row = parsed.rows.find(row => row.pid === holder.pid);
      return { ...holder, ppid: row?.ppid ?? null, pgid: row?.pgid ?? null, command: row?.command ?? holder.command, psMatched: !!row };
    }),
  };
}
