// Floor selftest only: refuse unknown files; unlink one pinned native socket.
import fs from 'node:fs';
const [operation, file, expected] = process.argv.slice(2);
try {
  if (!file || !['absent', 'pin', 'check', 'unlink'].includes(operation)) throw Error('invalid socket operation');
  let s: fs.BigIntStats;
  try { s = fs.lstatSync(file, { bigint: true }); }
  catch (e: any) { if (e.code === 'ENOENT' && (operation === 'absent' || operation === 'unlink')) process.exit(0); throw e; }
  if (operation === 'absent') throw Error('floor selftest refuses preexisting tmux endpoint');
  if (!s.isSocket() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid!()) || s.nlink !== 1n) throw Error('refusing unowned or non-socket endpoint');
  const identity = JSON.stringify({ dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), mode: String(s.mode), nlink: String(s.nlink) });
  if (operation === 'pin') console.log(identity);
  else {
    if (!expected || identity !== expected) throw Error('floor socket identity changed; preserving replacement');
    if (operation === 'unlink') fs.unlinkSync(file);
  }
} catch (e: any) {
  console.error('STOP: ' + String(e.message ?? e) + ' (' + file + ')');
  process.exitCode = 2;
}
