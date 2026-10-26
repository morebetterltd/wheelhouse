// Fixture-only return/throw adaptation. The shared helper owns ALL capture.
// Native completion decides; the containing sweep owns time containment.
// Bun is already a template prerequisite. Do not transitively require a new
// Node TypeScript loader when a fixture accidentally uses its old interpreter.
if (!process.versions.bun) throw Object.assign(new Error('fixture command callers must run under Bun'), { code: 'FIXTURE_REQUIRES_BUN' });
const { completedCommand } = require('../completed-command.ts');

function spawnSync(file, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args ?? {}; args = []; }
  if (typeof options === 'string') options = { encoding: options };
  const { encoding, stdio, maxBuffer, timeout, ...rest } = options;
  if (timeout) throw new Error('fixture command: use the containing sweep deadline, not a per-command timeout');
  if (stdio && stdio !== 'pipe' && !(Array.isArray(stdio) && ['ignore', 'pipe'].includes(stdio[0]) && stdio[1] === 'pipe' && stdio[2] === 'pipe')) {
    throw new Error('fixture command: inherited/ignored descriptors must use the native API explicitly');
  }
  if (maxBuffer !== undefined && (typeof maxBuffer !== 'number' || !(maxBuffer >= 0))) throw new RangeError('invalid explicit maxBuffer');
  // Request raw output even when the caller wants text. Preserve the caller's
  // encoding of string stdin before selecting the helper's binary result API.
  if (typeof rest.input === 'string' && encoding && encoding !== 'buffer') rest.input = Buffer.from(rest.input, encoding);
  const result = completedCommand(file, args, { ...rest, encoding: null });
  if (!Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)) {
    throw Object.assign(new Error('fixture command: raw descriptor capture did not return both buffers'), { result });
  }
  // Optional audit copies the returned native record; it does not capture or
  // spawn anything. The caller supplies an existing task-owned evidence dir.
  const evidence = process.env.WHEELHOUSE_FIXTURE_COMMAND_EVIDENCE;
  if (evidence) {
    try {
      const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
      if (!fs.statSync(evidence).isDirectory()) throw new Error('fixture command evidence directory missing');
      const id = `${process.pid}-${randomUUID()}`, prefix = path.join(evidence, id), write = (suffix, data) => fs.writeFileSync(prefix + suffix, data, { flag: 'wx', mode: 0o600 });
      write('.stdout', result.stdout); write('.stderr', result.stderr);
      let inputBytes = 0;
      if (rest.input !== undefined) {
        const v = rest.input, bytes = typeof v === 'string' ? Buffer.from(v) : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        write('.stdin', bytes); inputBytes = bytes.length;
      }
      write('.json', JSON.stringify({ id, runtime: { bun: process.versions.bun, execPath: process.execPath, entry: process.argv }, argv: [file, ...args], cwd: rest.cwd ?? process.cwd(), encoding: encoding ?? null, explicitMaxBuffer: maxBuffer ?? null, inputBytes, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, status: result.status, signal: result.signal ?? null, error: result.error ? { code: result.error.code, message: result.error.message } : null, caller: new Error().stack }));
    } catch (error) { throw Object.assign(error, { nativeResult: result }); }
  }
  // An explicit byte policy may refuse COMPLETE output, never discard it.
  if (maxBuffer !== undefined && (result.stdout.length > maxBuffer || result.stderr.length > maxBuffer)) {
    result.error ??= Object.assign(new Error(`fixture command: explicit maxBuffer ${maxBuffer} exceeded; complete output retained`), { code: 'ENOBUFS' });
  }
  const output = value => encoding && encoding !== 'buffer' ? value.toString(encoding) : value;
  const stdout = output(result.stdout), stderr = output(result.stderr);
  return { ...result, stdout, stderr, output: [null, stdout, stderr] };
}

function execFileSync(file, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args ?? {}; args = []; }
  const result = spawnSync(file, args, options);
  if (result.error || result.signal || result.status !== 0) {
    const { error: nativeError, ...details } = result;
    const error = nativeError ?? new Error(`Command failed: ${file} ${args.join(' ')}${result.stderr.length ? '\n' + result.stderr.toString() : ''}`);
    Object.assign(error, details, { cmd: [file, ...args].join(' ') });
    throw error;
  }
  return result.stdout;
}

exports.spawnSync = spawnSync;
exports.execFileSync = execFileSync;
