import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const [root, seats, here] = process.argv.slice(2);
const runner = path.join(seats, 'selftest-sweep.sh'), lib = path.join(seats, 'selftest-lib.sh');
const source = fs.readFileSync(runner, 'utf8'), library = fs.readFileSync(lib, 'utf8');
const replace = (text: string, old: string, value: string) => {
  assert.equal(text.split(old).length, 2, `mutation anchor changed: ${old}`);
  return text.replace(old, value);
};
const noCheck = replace(source, '  if signal_suite_tree CHECK "$CURRENT_SUITE_PID" "$SUITE_STATE"; then',
  '  SUITE_SURVIVORS=0\n  if true; then');
const variants = [
  { name: 'no-check-group', mode: 'group', runner: noCheck },
  { name: 'no-check-resistant', mode: 'term-resistant', runner: noCheck },
  { name: 'no-check-failed', mode: 'failed', runner: noCheck },
  { name: 'no-orphan-group', mode: 'group', runner: replace(source,
    'if [ "$g" = "$group" ]; then owned[i]=1; via[i]=group; fi',
    'if [ "$p" = "$root" ] && [ "$g" = "$group" ]; then owned[i]=1; via[i]=group; fi') },
  { name: 'no-scratch', mode: 'scratch', runner: replace(source,
    '        owned[i]=1; via[i]=scratch; break', '        : # scratch ownership removed') },
  { name: 'no-private-tmp', mode: 'scratch', runner: replace(source, 'TMPDIR="$SUITE_STATE/tmp" perl', 'perl') },
  { name: 'no-wait', mode: 'clean', lib: replace(library,
    '  for fixture_pid in $fixture_pids; do wait "$fixture_pid" 2>/dev/null || true; done', '  : # direct-child wait removed') },
  { name: 'empty-pre-cwd-ps-accepted', mode: 'bad-before-ps', runner: replace(source,
    '  [ "$ps_before_self" = 1 ] || { info \'STOP: suite pre-cwd process inventory omitted runner\'; return 2; }', '  : # pre-cwd identity inventory proof removed') },
  { name: 'empty-cwd-accepted', mode: 'bad-cwd', runner: replace(source,
    '  [ "$cwd_self" = 1 ] || { info \'STOP: suite cwd inventory omitted runner\'; return 2; }', '  : # inventory completeness proof removed') },
];
try {
  for (const v of variants) {
    fs.writeFileSync(runner, v.runner ?? source); fs.writeFileSync(lib, v.lib ?? library);
    const r = spawnSync('bun', [path.join(here, 'fixtures/sweep-survivors.ts'), root, seats, v.mode], {
      env: { ...process.env, WHEELHOUSE_SURVIVOR_TAG: v.name }, encoding: 'utf8', timeout: 60000,
    });
    fs.writeFileSync(path.join(root, `${v.name}.stdout`), r.stdout ?? '');
    fs.writeFileSync(path.join(root, `${v.name}.stderr`), r.stderr ?? '');
    assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 1, `${v.name}: removed fix did not fail`);
    assert.match(r.stderr, /AssertionError/); assert.match(r.stderr, /wrong runner result|child survived|missing named survivor|teardown did not wait/);
    console.log(`PASS removal ${v.name}: native exit=1, own assertion rejected removed fix`);
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  }
} finally {
  fs.writeFileSync(runner, source); fs.writeFileSync(lib, library);
}
