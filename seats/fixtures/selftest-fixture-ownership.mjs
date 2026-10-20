import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// The parent shell allocated this sandbox with the production helper. Every
// tested invocation below gets a different run nonce; its siblings simulate
// foreign allocations, even though the outer test owns the entire sandbox.
const [rootArg, libraryArg] = process.argv.slice(2);
assert(rootArg && libraryArg, 'usage: fixture-ownership <sandbox> <library>');
const root = path.resolve(rootArg), library = fs.realpathSync(libraryArg);
const parent = fs.realpathSync(path.dirname(root));
const parentMarker = path.join(parent, '.wheelhouse-selftest-fixture');
assert(fs.lstatSync(parentMarker).isFile() && !fs.lstatSync(parentMarker).isSymbolicLink());
const marker = fs.readFileSync(parentMarker, 'utf8');
assert(marker.includes(`nonce=${process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE}\n`));
assert(marker.includes(`root=${parent}\n`));
assert.equal(path.dirname(root), parent, 'sandbox parent must be physical');
fs.mkdirSync(root, { mode: 0o700 });

const common = String.raw`set -u
# Bash 3.2's signed-byte behavior was captured before building this fixture:
# decimal=-106 unmasked=ffffffffffffff96 masked=96 (native byte 0x96).
if [ "$FORCE_HIGH_BYTE_NONCE" = 1 ]; then
  read() { printf -v chunk '%b' '\226\226\226\226\226\226\226\226\226\226\226\226\226\226\226\226'; }
fi
. "$LIB"
if [ "$FORCE_HIGH_BYTE_NONCE" = 1 ]; then unset -f read; fi
printenv WHEELHOUSE_SELFTEST_FIXTURE_NONCE > "$CASE_DIR/source-nonce"
OWN_FIX="$(selftest_make_fixture_dir "$CASE_DIR/owned.XXXXXX")" || exit 2
selftest_isolate_git "$OWN_FIX" || exit 2
printf '%s\n' "$OWN_FIX" > "$CASE_DIR/owned-path"
cp -f "$OWN_FIX/.wheelhouse-selftest-fixture" "$CASE_DIR/allocated-marker"
foreign_marker() {
  local foreign_nonce=ffffffffffffffffffffffffffffffff
  [ "$(printenv WHEELHOUSE_SELFTEST_FIXTURE_NONCE)" != "$foreign_nonce" ] || foreign_nonce=00000000000000000000000000000000
  printf 'prefix=foreign\npid=1\nstarted=2026-10-15T00:00:00Z\nnonce=%s\nroot=%s\n' "$foreign_nonce" "$1" > "$1/.wheelhouse-selftest-fixture"
}
plant_runtime() {
  mkdir -p "$1/seats/drivers" "$1/seats/transports"
  printf 'KEEP\n' > "$1/seats/drivers/KEEP"
  printf 'KEEP\n' > "$1/seats/transports/KEEP"
}
# Instrument the dispatch boundary, never send a real signal or kill a server
# for a refusal control. Consumer standalones exercise the real owned teardown.
instrument_cleanup() {
  selftest_stop_fixture_adapters() { printf 'stop-adapters\n' >> "$CASE_DIR/effects"; }
  selftest_fixture_processes() { printf 'scan-processes\n' >> "$CASE_DIR/effects"; }
  tmux() { printf 'tmux\n' >> "$CASE_DIR/effects"; }
}
`;
const prepare = String.raw`TARGET="$CASE_DIR/victim"
mkdir -p "$TARGET"
printf 'KEEP\n' > "$TARGET/KEEP"
`;
const graph = String.raw`TARGET="$CASE_DIR/other/graph"
mkdir -p "$TARGET"
printf 'KEEP\n' > "$TARGET/KEEP"
`;
const cases = [
  { name: 'marker-metadata', body: ':', kind: 'metadata', rc: 0 },
  { name: 'marker-high-byte-metadata', body: ':', kind: 'metadata', rc: 0, highBytes: true },
  { name: 'remove-empty', body: prepare + ': > "$TARGET/.wheelhouse-selftest-fixture"\nselftest_remove_fixture_dir "$TARGET"', kind: 'remove-refusal', rc: 2 },
  { name: 'remove-foreign', body: prepare + 'foreign_marker "$TARGET"\nselftest_remove_fixture_dir "$TARGET"', kind: 'remove-refusal', rc: 2 },
  { name: 'remove-unmarked', body: prepare + 'selftest_remove_fixture_dir "$TARGET"', kind: 'remove-refusal', rc: 2 },
  { name: 'remove-unreadable', body: prepare + 'foreign_marker "$TARGET"\nchmod 000 "$TARGET"\nselftest_remove_fixture_dir "$TARGET"', kind: 'remove-refusal', rc: 2, unreadable: true },
  { name: 'remove-copied-marker', body: prepare + 'cp -f "$OWN_FIX/.wheelhouse-selftest-fixture" "$TARGET/.wheelhouse-selftest-fixture"\nselftest_remove_fixture_dir "$TARGET"', kind: 'remove-refusal', rc: 2 },
  { name: 'remove-symlink-marker', body: prepare + 'ln -s "$OWN_FIX/.wheelhouse-selftest-fixture" "$TARGET/.wheelhouse-selftest-fixture"\nselftest_remove_fixture_dir "$TARGET"', kind: 'remove-refusal', rc: 2 },
  { name: 'remove-own', body: 'selftest_remove_fixture_dir "$OWN_FIX"', kind: 'own-remove', rc: 0 },
  { name: 'inherited-run-remove', body: 'bash -c \'. "$1"; selftest_remove_fixture_dir "$2"\' _ "$LIB" "$OWN_FIX"', kind: 'own-remove', rc: 0 },
  { name: 'scratch-empty-ancestor', body: graph + ': > "$CASE_DIR/other/.wheelhouse-selftest-fixture"\nselftest_scratch_graph "$TARGET"', kind: 'graph-refusal', rc: 2 },
  { name: 'scratch-foreign-ancestor', body: graph + 'foreign_marker "$CASE_DIR/other"\nselftest_scratch_graph "$TARGET"', kind: 'graph-refusal', rc: 2 },
  { name: 'scratch-outside-run', body: graph + 'selftest_scratch_graph "$TARGET"', kind: 'graph-refusal', rc: 2 },
  { name: 'scratch-own', body: 'mkdir -p "$OWN_FIX/graph"\nprintf KEEP > "$OWN_FIX/graph/KEEP"\nselftest_scratch_graph "$OWN_FIX/graph"', kind: 'own-graph', rc: 0 },
  { name: 'copy-unmarked', body: 'TARGET="$CASE_DIR/victim"\nplant_runtime "$TARGET"\nselftest_copy_seat_runtime "$TARGET" "$SOURCE"', kind: 'copy-refusal', rc: 2 },
  { name: 'copy-foreign', body: 'TARGET="$CASE_DIR/victim"\nplant_runtime "$TARGET"\nforeign_marker "$TARGET"\nselftest_copy_seat_runtime "$TARGET" "$SOURCE"', kind: 'copy-refusal', rc: 2 },
  { name: 'copy-own', body: 'plant_runtime "$OWN_FIX/app"\nselftest_copy_seat_runtime "$OWN_FIX/app" "$SOURCE"', kind: 'own-copy', rc: 0 },
  { name: 'copy-symlink-escape', body: 'plant_runtime "$CASE_DIR/outside"\nmkdir -p "$OWN_FIX/app"\nln -s "$CASE_DIR/outside/seats" "$OWN_FIX/app/seats"\nselftest_copy_seat_runtime "$OWN_FIX/app" "$SOURCE"', kind: 'copy-escape', rc: 2 },
  { name: 'copy-path-swap', body: 'plant_runtime "$CASE_DIR/outside"\nplant_runtime "$OWN_FIX/app"\nfind() { mv -f "$OWN_FIX/app/seats" "$OWN_FIX/saved-seats"; ln -s "$CASE_DIR/outside/seats" "$OWN_FIX/app/seats"; }\nselftest_copy_seat_runtime "$OWN_FIX/app" "$SOURCE"', kind: 'copy-escape', rc: 2 },
  { name: 'cleanup-unmarked', body: prepare + 'instrument_cleanup\nselftest_cleanup_fixture_processes "$TARGET" fixture-ownership-test', kind: 'cleanup-refusal', rc: 2 },
  { name: 'cleanup-unreadable', body: prepare + 'foreign_marker "$TARGET"\ninstrument_cleanup\nchmod 000 "$TARGET"\nselftest_cleanup_fixture_processes "$TARGET" fixture-ownership-test', kind: 'cleanup-refusal', rc: 2, unreadable: true },
  { name: 'cleanup-foreign', body: prepare + 'foreign_marker "$TARGET"\ninstrument_cleanup\nselftest_cleanup_fixture_processes "$TARGET" fixture-ownership-test', kind: 'cleanup-refusal', rc: 2 },
  { name: 'cleanup-empty', body: prepare + ': > "$TARGET/.wheelhouse-selftest-fixture"\ninstrument_cleanup\nselftest_cleanup_fixture_processes "$TARGET" fixture-ownership-test', kind: 'cleanup-refusal', rc: 2 },
  { name: 'cleanup-own', body: 'instrument_cleanup\nselftest_cleanup_fixture_processes "$OWN_FIX" fixture-ownership-test', kind: 'own-cleanup', rc: 0 },
];
const rows = [];
for (const test of cases) {
  const dir = path.join(root, test.name);
  fs.mkdirSync(dir, { mode: 0o700 });
  const source = path.join(dir, 'source');
  for (const sub of ['', 'drivers', 'transports']) fs.mkdirSync(path.join(source, sub));
  fs.writeFileSync(path.join(source, 'module.ts'), 'export const fixtureModule = true;\n');
  for (const sub of ['drivers', 'transports']) fs.writeFileSync(path.join(source, sub, 'entry'), `${sub}\n`);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'bd'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$BD_CALLS"\nexit 0\n', { mode: 0o700 });
  const script = path.join(dir, 'run.sh');
  fs.writeFileSync(script, common + '\n' + test.body + '\n');
  const env = { ...process.env, LIB: library, CASE_DIR: dir, SOURCE: source, BD_CALLS: path.join(dir, 'bd-calls'), PATH: `${bin}:${process.env.PATH}` };
  // A separate invocation may not borrow the enclosing harness's allocation.
  delete env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE;
  env.FORCE_HIGH_BYTE_NONCE = test.highBytes ? '1' : '0';
  const child = spawn('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', stdoutEOF = false, stderrEOF = false;
  child.stdout.on('data', b => stdout += b);
  child.stderr.on('data', b => stderr += b);
  child.stdout.on('end', () => stdoutEOF = true);
  child.stderr.on('end', () => stderrEOF = true);
  const native = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  fs.writeFileSync(path.join(dir, 'stdout'), stdout);
  fs.writeFileSync(path.join(dir, 'stderr'), stderr);
  const ownFile = path.join(dir, 'owned-path');
  const own = fs.existsSync(ownFile) ? fs.readFileSync(ownFile, 'utf8').trim() : '';
  const victim = path.join(dir, 'victim'), graphRoot = path.join(dir, 'other/graph');
  // Restore only our simulated victim's mode AFTER the native operation, so
  // observations and enclosing-fixture teardown can inspect it even as nonroot.
  if (test.unreadable && fs.existsSync(victim)) fs.chmodSync(victim, 0o700);
  const runtimeRoot = test.kind === 'copy-escape' ? path.join(dir, 'outside') : victim;
  const state = {
    victimKeep: fs.existsSync(path.join(victim, 'KEEP')),
    graphKeep: fs.existsSync(path.join(graphRoot, 'KEEP')),
    driversKeep: fs.existsSync(path.join(runtimeRoot, 'seats/drivers/KEEP')),
    transportsKeep: fs.existsSync(path.join(runtimeRoot, 'seats/transports/KEEP')),
    cleanupEffects: fs.existsSync(path.join(dir, 'effects')),
    sourceNonceLength: fs.existsSync(path.join(dir, 'source-nonce')) ? fs.readFileSync(path.join(dir, 'source-nonce'), 'utf8').trim().length : null,
  };
  let error = null;
  try {
    assert(own, 'fixture setup must finish before measuring the operation');
    assert.equal(native.code, test.rc, 'native operation status');
    assert.equal(native.signal, null);
    assert(stdoutEOF && stderrEOF, 'both native streams must reach EOF');
    if (test.rc === 2) assert(stderr.includes('STOP:'), 'refusal must be visible');
    if (test.kind === 'metadata') {
      const nonce = fs.readFileSync(path.join(dir, 'source-nonce'), 'utf8').trim();
      const actual = fs.readFileSync(path.join(dir, 'allocated-marker'), 'utf8');
      assert.match(nonce, /^[0-9a-f]{32}$/, 'parent nonce exists BEFORE command substitution');
      if (test.highBytes) assert.equal(nonce, '96'.repeat(16), 'signed bytes serialize to exactly two hex digits');
      assert.notEqual(nonce, process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE);
      assert.match(actual, /^prefix=owned\.XXXXXX\npid=[1-9][0-9]*\nstarted=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\nnonce=[0-9a-f]{32}\nroot=.+\n$/);
      assert(actual.includes(`nonce=${nonce}\nroot=${own}\n`));
    } else if (test.kind === 'remove-refusal') {
      assert(state.victimKeep, 'foreign/unmarked/copy-marker KEEP must survive remove');
      assert.equal(fs.readFileSync(path.join(victim, 'KEEP'), 'utf8'), 'KEEP\n');
      assert(stderr.includes(victim), 'refusal must name the victim');
    } else if (test.kind === 'graph-refusal') {
      assert(state.graphKeep, 'foreign graph KEEP must survive reset');
      assert.equal(fs.readFileSync(path.join(graphRoot, 'KEEP'), 'utf8'), 'KEEP\n');
      assert(stderr.includes(graphRoot), 'refusal must name graph destination');
      assert(!fs.existsSync(path.join(dir, 'bd-calls')), 'refusal precedes bd init/metrics');
    } else if (test.kind === 'copy-refusal' || test.kind === 'copy-escape') {
      assert(state.driversKeep && state.transportsKeep, 'both foreign runtime KEEP files must survive');
      for (const sub of ['drivers', 'transports']) assert.equal(fs.readFileSync(path.join(runtimeRoot, 'seats', sub, 'KEEP'), 'utf8'), 'KEEP\n');
      assert(!fs.existsSync(path.join(runtimeRoot, 'seats/module.ts')), 'refusal precedes copying files');
    } else if (test.kind === 'cleanup-refusal') {
      assert(state.victimKeep && !state.cleanupEffects, 'refusal precedes adapters/tmux/scanner/signals');
      assert.equal(fs.readFileSync(path.join(victim, 'KEEP'), 'utf8'), 'KEEP\n');
      assert(stderr.includes(victim), 'cleanup refusal must name victim');
    } else if (test.kind === 'own-remove') {
      assert(!fs.existsSync(own), 'this run allocation still removes');
    } else if (test.kind === 'own-graph') {
      assert(!fs.existsSync(path.join(own, 'graph/KEEP')));
      assert(fs.existsSync(path.join(own, 'graph/bin/bd')));
    } else if (test.kind === 'own-copy') {
      for (const sub of ['drivers', 'transports']) {
        assert(!fs.existsSync(path.join(own, 'app/seats', sub, 'KEEP')));
        assert.equal(fs.readFileSync(path.join(own, 'app/seats', sub, 'entry'), 'utf8'), `${sub}\n`);
      }
      assert(fs.existsSync(path.join(own, 'app/seats/module.ts')));
    } else if (test.kind === 'own-cleanup') assert(state.cleanupEffects);
  } catch (e) { error = String(e); }
  const row = { test: test.name, ...native, stdoutEOF, stderrEOF, state, passed: error === null, error };
  rows.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2) + '\n');
const failed = rows.filter(r => !r.passed).length;
console.log(`fixture ownership: ${rows.length} cases, ${failed} failures`);
process.exitCode = failed ? 1 : 0;
