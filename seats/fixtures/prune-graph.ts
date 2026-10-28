// Prune's test-only graph provenance. Reject restored raw writers BEFORE they
// can mutate anything; success still requires the real helper wrapper and data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from './fixture-command.cjs';

export function rejectRawWriter(file: string, label: string) {
  const text = fs.readFileSync(file, 'utf8');
  const ranges: Record<string, [string, string]> = {
    'reviewed fixture': ['prune_fixture_reviewed(){', '\n# Safety needs'],
    'extended fixture': ['prune_fixture_ext(){', ''],
    'auto-prune': ["phase 'host-budget auto_prune uses the real scanner and reviewed prune parser'", '\nprune_fixture_cleanup_helpers'],
    'tmp-alias': ["const f = fixture('tmp-parent-alias')", '\nconsole.log(`reviewed-row regression'],
    waitcase: ['', ''],
  };
  assert(label in ranges, 'known graph writer');
  const [start, end] = ranges[label];
  const begin = start ? text.indexOf(start) : 0, finish = end ? text.indexOf(end, begin) : text.length;
  assert(begin >= 0 && finish > begin, 'graph writer source range must exist');
  const body = text.slice(begin, finish);
  assert(!/\bbd\s+init\b|command\(\s*["']bd["']\s*,\s*\[\s*["']init["']/.test(body), 'raw graph initialization restored; refused before any mutation');
}
export function assertGraph(root: string, graph: string, expected: [string, string][], env: NodeJS.ProcessEnv = process.env) {
  assert.equal(env.WHEELHOUSE_SELFTEST_BD_ROOT, graph, 'install must receive its own helper exports');
  const beads = path.join(graph, '.beads'), wrapper = path.join(graph, 'bin/bd');
  assert(fs.statSync(path.join(graph, '.git')).isDirectory());
  assert(fs.lstatSync(path.join(root, '.beads')).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(root, '.beads')), fs.realpathSync(beads));
  function command(bin: string, args: string[]) {
    const r = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0, `${bin}: ${r.stderr}`);
    return r.stdout;
  }
  assert.equal(command('bash', ['-c', 'command -v bd']).trim(), wrapper, 'resolved bd must be the helper wrapper');
  assert(fs.statSync(wrapper).isFile(), 'helper wrapper must exist as a real file');
  const where = JSON.parse(command('bd', ['where', '--json']));
  assert.equal(fs.realpathSync(where.path), fs.realpathSync(beads), 'native bd must resolve this graph');
  const rows = JSON.parse(command('bd', ['list', '--all', '--json', '--limit', '0']));
  assert(Array.isArray(rows), 'native graph rows must be an array');
  for (const [id, status] of expected) {
    assert(id, 'a created task id must exist');
    assert(rows.some(row => row.id === id && row.status === status), `task ${id}:${status} absent from its helper graph`);
  }
  return { graph, wrapper, tasks: expected.map(([id, status]) => ({ id, status })), count: rows.length };
}
if (import.meta.main) {
  const [mode, label, ...args] = process.argv.slice(2);
  try {
    if (mode === 'guard') rejectRawWriter(args[0], label);
    else {
      assert.equal(mode, 'assert');
      const [root, graph, ...tasks] = args;
      const expected = tasks.map(task => { const colon = task.lastIndexOf(':'); assert(colon > 0); return [task.slice(0, colon), task.slice(colon + 1)] as [string, string]; });
      console.log('MEASUREMENT prune graph ' + label + ' ' + JSON.stringify(assertGraph(root, graph, expected)));
    }
  } catch (error) {
    console.log(`  FAIL  ${label} tasks were written to the selftest scratch graph only: ${error}`);
    process.exitCode = 1;
  }
}
