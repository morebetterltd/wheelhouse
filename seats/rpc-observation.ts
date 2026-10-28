// Read-only RPC evidence. Missing tool/platform observations stay unknown;
// no command consumes FIFO bytes, signals a seat, or guesses death from age.
import fs from 'node:fs';
import { completedCommand } from './completed-command';

export function cpuTimeMs(pid: number | null): number | null {
  if (!pid) return null;
  const r = completedCommand('ps', ['-o', 'time=', '-p', String(pid)]);
  if (r.error || r.signal || r.status !== 0 || r.stderr.trim()) return null;
  // Darwin captured "0:00.00"; POSIX/Linux also use [days-]hh:mm:ss.
  const m = r.stdout.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return ((Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000) + Number('0.' + (m[5] || '0')) * 1000;
}
export function byteSize(file: string): number | null {
  try { return fs.statSync(file).size; } catch { return null; }
}
export async function fifoUnreadBytes(fifo: string): Promise<number | null> {
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  // Isolate the native ioctl from the adapter VM. Perl's core Fcntl/ioctl
  // needs no extension. The descriptor never calls read()/sysread().
  const probe = 'sysopen(my $f,$ARGV[0],O_RDONLY|O_NONBLOCK) or exit 2; my $n=pack("i",0); ioctl($f,0+$ARGV[1],$n) or exit 2; print unpack("i",$n),"\\n";';
  const r = completedCommand('perl', ['-MFcntl=O_RDONLY,O_NONBLOCK', '-e', probe, fifo, String(process.platform === 'darwin' ? 0x4004667f : 0x541b)]);
  if (r.error || r.signal || r.status !== 0 || r.stderr.trim() || !/^\d+\s*$/.test(r.stdout)) return null;
  const bytes = Number(r.stdout.trim());
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
export function rpcDescriptors(pid: number | null, fifo: string): { fd0: string; fd1: string } {
  const unknown = { fd0: 'unknown', fd1: 'unknown' };
  if (!pid) return unknown;
  for (const tool of ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof']) {
    const r = completedCommand(tool, ['-a', '-p', String(pid), '-d', '0,1', '-Fftn']);
    if (r.error?.code === 'ENOENT') continue;
    if (r.error || r.signal || r.status !== 0 || r.stderr.trim()) return unknown;
    // Capture: p<pid>, f0, tFIFO, n<path>, f1, tPIPE, n-><pipe>.
    const rows = new Map<string, { type?: string; name?: string }>();
    let fd = '', observedPid: number | null = null;
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') observedPid = Number(line.slice(1));
      if (line[0] === 'f') { fd = line.slice(1).replace(/[rwu]$/, ''); rows.set(fd, {}); }
      if (line[0] === 't' && rows.has(fd)) rows.get(fd)!.type = line.slice(1);
      if (line[0] === 'n' && rows.has(fd)) rows.get(fd)!.name = line.slice(1);
    }
    if (observedPid !== pid) return unknown;
    return {
      fd0: rows.get('0')?.type === 'FIFO' && rows.get('0')?.name === fifo ? `FIFO held by pid ${pid}` : 'not observed as seat FIFO',
      fd1: rows.get('1')?.type === 'PIPE' ? `pipe to seat-event-log held by pid ${pid}` : 'not observed as pipe (driver may log directly)',
    };
  }
  return unknown;
}
