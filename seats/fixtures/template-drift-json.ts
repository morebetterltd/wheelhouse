import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Reference outputs were captured from the original runtime before porting.
// Only the local fixture commit is substituted; JSON bytes/status/stderr are not.
const [script, root, reference] = process.argv.slice(2);
assert.ok(script && root && reference);
const expected = JSON.parse(fs.readFileSync(reference, 'utf8'));
const deny = path.join(root, 'deny-python');
fs.mkdirSync(deny, { recursive: true });
fs.writeFileSync(path.join(deny, 'python3'), '#!/usr/bin/env bash\nprintf "attempt\\n" >> "$PYTHON_ATTEMPTS"\nexit 127\n', { mode: 0o755 });
const env = { ...process.env, PATH: deny + ':' + process.env.PATH, PYTHON_ATTEMPTS: path.join(root, 'python-attempts') };
const src = path.join(root, 'source'), dst = path.join(root, 'install');
fs.mkdirSync(src, { recursive: true });
function git(...args: string[]) {
  const result = spawnSync('git', ['-C', src, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'fixture@invalid');
git('config', 'user.name', 'fixture');
// Pin the fixture's filename presentation, not the product's Git behavior.
git('config', 'core.quotepath', 'false');
for (const d of ['seats', 'runbooks', 'wheelhouse']) fs.mkdirSync(path.join(src, d));
fs.writeFileSync(path.join(src, 'seats/a.sh'), 'alpha\n');
fs.writeFileSync(path.join(src, 'seats/é😀.sh'), 'unicode\n');
fs.writeFileSync(path.join(src, 'runbooks/help.md'), 'help\n');
git('add', '.'); git('commit', '-qm', 'baseline');
const commit = git('rev-parse', 'HEAD');
fs.cpSync(src, dst, { recursive: true, filter: p => !p.includes('/.git') });
const metadata = path.join(dst, 'wheelhouse/.template-source');
fs.writeFileSync(metadata, `path=${src}\nsource=${src}\ncommit=${commit}\n`);
const records: { name: string; status: number | null; stdout: string; stderr: string; input?: string }[] = [];
function run(name: string) {
  const result = spawnSync('bash', [script, '--json', dst], { encoding: 'utf8', env });
  records.push({ name, status: result.status, stdout: result.stdout, stderr: result.stderr });
  for (const [suffix, data] of [['stdout', result.stdout], ['stderr', result.stderr], ['rc', String(result.status) + '\n']]) {
    fs.writeFileSync(path.join(root, name + '.' + suffix), data);
  }
}
run('clean');
fs.writeFileSync(path.join(dst, 'seats/a.sh'), 'changed\n');
fs.writeFileSync(path.join(dst, 'seats/é😀.sh'), 'changed\n');
fs.writeFileSync(path.join(dst, 'seats/local "q".sh'), 'local\n');
fs.rmSync(path.join(dst, 'runbooks/help.md'));
run('drift');
fs.writeFileSync(path.join(src, 'seats/next.sh'), 'next\n');
git('add', '.'); git('commit', '-qm', 'ahead');
run('ahead');
git('branch', '-m', 'seed');
run('null-ahead');
fs.rmSync(metadata);
run('missing-source');
fs.writeFileSync(metadata, `source=${src}\ncommit=é😀\n`);
run('unicode-error');
const escape = fs.readFileSync(script, 'utf8').split('\n').find(s => s.startsWith('json_escape()'));
assert.ok(escape, 'runtime scalar encoder exists');
const scalar = 'quote " slash \\ tab\t CR\r LF\n é😀\n\n';
const result = spawnSync('bash', ['-c', escape + '\njson_escape'], { input: scalar, encoding: 'utf8', env });
records.push({ name: 'scalar', input: scalar, status: result.status, stdout: result.stdout, stderr: result.stderr });
fs.writeFileSync(path.join(root, 'records.json'), JSON.stringify({ commit, records }, null, 2) + '\n');
assert.deepEqual(records, expected.records.map((r: typeof records[number]) => ({ ...r, stdout: r.stdout.replaceAll(expected.commit, commit) })));
assert.equal(fs.existsSync(env.PYTHON_ATTEMPTS), false, 'runtime attempted Python');
console.log('7 original JSON captures match stdout/stderr/status byte-for-byte; no Python attempts');
