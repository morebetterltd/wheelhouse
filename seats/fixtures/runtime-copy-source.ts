// Exercise the real default source resolver, not a second full adapter run.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const [seats, fixture] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, '.wheelhouse-selftest-fixture')).isFile());
const cwd = path.join(fixture, 'unrelated-cwd');
fs.mkdirSync(cwd);
assert(!fs.existsSync(path.join(cwd, 'seats')));
const started = performance.now();
const result = spawnSync('bash', ['-c', String.raw`
set -eu
. "$1/selftest-lib.sh"
cd "$2"
[ ! -e seats ]
rc=0; git rev-parse --show-toplevel > "$3/discovery.out" 2> "$3/discovery.err" || rc=$?
[ "$rc" = 128 ] && [ ! -s "$3/discovery.out" ]
selftest_copy_seat_runtime "$3/empty-cwd-copy"
mkdir seats
printf 'caller-owned sentinel\n' > seats/caller-only.ts
selftest_copy_seat_runtime "$3/planted-cwd-copy"
`, 'runtime-source', seats, cwd, fixture], {encoding: 'utf8', timeout: 5000});
console.log('CAPTURE runtime source ' + JSON.stringify({exit: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr}));
assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
function inventory(root: string, relative = ''): string[] {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const file = path.join(relative, name), stat = fs.lstatSync(path.join(root, file));
    return stat.isDirectory() ? inventory(root, file) : [file];
  });
}
const expected = fs.readdirSync(seats).filter(name => /\.(ts|sh)$/.test(name) && !name.endsWith('.selftest.sh') && fs.statSync(path.join(seats, name)).isFile());
for (const dir of ['drivers', 'transports']) if (fs.existsSync(path.join(seats, dir))) expected.push(...inventory(seats, dir));
expected.sort(); assert(expected.length > 0); assert(expected.includes('adapter.ts'));
for (const name of ['empty-cwd-copy', 'planted-cwd-copy']) {
  const copied = path.join(fixture, name, 'seats');
  assert.deepEqual(inventory(copied), expected, name + ': complete runtime inventory');
  for (const file of expected) assert.deepEqual(fs.readFileSync(path.join(copied, file)), fs.readFileSync(path.join(seats, file)), file + ': exact bytes');
  assert(!fs.existsSync(path.join(copied, 'caller-only.ts')), name + ': caller sentinel never copied');
}
assert.equal(fs.readFileSync(path.join(cwd, 'seats/caller-only.ts'), 'utf8'), 'caller-owned sentinel\n');
const elapsed = performance.now() - started;
assert(elapsed < 5000, `runtime-source check exceeded five seconds: ${elapsed}ms`);
console.log(`runtime source independence: PASS (empty and planted cwd; ${expected.length} exact runtime files each; elapsed=${elapsed.toFixed(1)}ms < 5000ms)`);
