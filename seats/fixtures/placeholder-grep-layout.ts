// Exercise the same readers as placeholder-grep in real, isolated git roots.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolveRoleBrief } from '../briefs.ts';
import { checkWorkerEvidence, checkVerificationSkills } from './verification-skills.ts';

const [source, scratch] = process.argv.slice(2);
assert(fs.statSync(source).isDirectory());
assert(fs.statSync(path.join(path.dirname(scratch), '.wheelhouse-selftest-fixture')).isFile());
fs.mkdirSync(scratch);
const worker = fs.readFileSync(resolveRoleBrief(source, 'worker'), 'utf8');
const names = ['create-verification', 'maintain-verification'];
function git(root: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr);
}
let serial = 0;
function seed(layout: 'installed' | 'template') {
  const root = path.join(scratch, `${++serial}-${layout}`);
  const brief = path.join(root, layout === 'installed' ? 'wheelhouse/fleet/WORKER.md' : 'contracts/WORKER.md');
  fs.mkdirSync(path.dirname(brief), { recursive: true }); fs.writeFileSync(brief, worker);
  if (layout === 'installed') fs.mkdirSync(path.join(root, 'wheelhouse/crew'));
  fs.mkdirSync(path.join(root, '.agents/skills'), { recursive: true });
  for (const name of names) fs.cpSync(path.join(source, '.agents/skills', name), path.join(root, '.agents/skills', name), { recursive: true });
  fs.copyFileSync(path.join(source, '.agents/skills/NOTICE-pstack.md'), path.join(root, '.agents/skills/NOTICE-pstack.md'));
  if (layout === 'template') {
    fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true });
    for (const name of names) fs.symlinkSync(`../../.agents/skills/${name}`, path.join(root, '.claude/skills', name));
  }
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A');
  return { root, brief };
}
function ok(label: string, check: () => void) { check(); console.log(`  ok    ${label}`); }
ok('installed layout: worker and verification skills pass without contracts or compatibility links', () => {
  const { root } = seed('installed');
  assert(!fs.existsSync(path.join(root, 'contracts'))); assert(!fs.existsSync(path.join(root, '.claude')));
  assert.deepEqual(checkWorkerEvidence(root), []); assert.deepEqual(checkVerificationSkills(root), []);
});
for (const sentence of [
  "When code reads an outside tool's output, capture the real output first, record the command, and build the fixture from that capture.",
  'Every new test leg must be shown to fail with the fix removed; say how in the report.',
  "Report only checks you actually ran, and include each check's exit code.",
]) ok(`installed worker rejects missing sentence ${sentence.split(' ').slice(0, 4).join(' ')}`, () => {
  const { root, brief } = seed('installed'); assert(worker.includes(sentence));
  fs.writeFileSync(brief, worker.replace(sentence, ''));
  assert.deepEqual(checkWorkerEvidence(root), ['WORKER.md is missing one of the required evidence-discipline sentences']);
});
ok('installed brief takes precedence over template fallback', () => {
  const { root } = seed('installed'); fs.mkdirSync(path.join(root, 'contracts'));
  fs.writeFileSync(path.join(root, 'contracts/WORKER.md'), 'not the installed brief');
  assert.deepEqual(checkWorkerEvidence(root), []); assert.deepEqual(checkVerificationSkills(root), []);
});
const skill = '.agents/skills/create-verification/SKILL.md';
function edit(root: string, file: string, before: string | RegExp, after: string) {
  const target = path.join(root, file), text = fs.readFileSync(target, 'utf8'), changed = text.replace(before, after);
  assert.notEqual(changed, text, `mutation must change ${file}`); fs.writeFileSync(target, changed);
}
const defects: [string, (root: string) => void, string[]][] = [
  ['missing version', r => edit(r, skill, /^version:.*\n/m, ''), ['create-verification: semantic version missing']],
  ['wrong name', r => edit(r, skill, /^name:.*$/m, 'name: wrong'), ['create-verification: frontmatter name differs']],
  ['missing description', r => edit(r, skill, /^description:.*$/m, 'description: ""'), ['create-verification: description missing']],
  ['missing frontmatter', r => edit(r, skill, /^---\n[\s\S]*?\n---\n/, ''), ['create-verification: frontmatter missing']],
  ['missing SKILL.md', r => fs.unlinkSync(path.join(r, skill)), ['create-verification: SKILL.md missing']],
  ['missing skill directory', r => fs.rmSync(path.join(r, '.agents/skills/create-verification'), { recursive: true }), ['create-verification: skill directory missing or not a real directory']],
  ['missing opening notice', r => edit(r, skill, 'Adapted under MIT;', 'No opening pointer;'), ['create-verification: opening notice pointer missing']],
  ['non-neutral nested text', r => { fs.mkdirSync(path.join(r, '.agents/skills/create-verification/nested')); fs.writeFileSync(path.join(r, '.agents/skills/create-verification/nested/extra.md'), 'claude'); }, ['.agents/skills/create-verification/nested/extra.md: forbidden tool/dependency name']],
  ['missing notice', r => fs.unlinkSync(path.join(r, '.agents/skills/NOTICE-pstack.md')), ['adaptation notice missing']],
  ['missing copyright', r => edit(r, '.agents/skills/NOTICE-pstack.md', 'Copyright (c) 2026 Lauren Tan', 'Lauren Tan'), ['adaptation copyright missing']],
  ['unpinned source notice', r => edit(r, '.agents/skills/NOTICE-pstack.md', /[0-9a-f]{40}/g, 'unpinned'), ['adaptation source URL lacks pinned commit']],
];
for (const [label, mutate, expected] of defects) ok(`installed skills reject ${label}`, () => {
  const { root } = seed('installed'); mutate(root); assert.deepEqual(checkVerificationSkills(root), expected);
});
ok('template worker and both indexed relative skill links pass', () => {
  const { root } = seed('template'); assert.deepEqual(checkWorkerEvidence(root), []); assert.deepEqual(checkVerificationSkills(root), []);
});
for (const name of names) {
  ok(`template skills reject missing ${name} compatibility link`, () => {
    const { root } = seed('template'); fs.unlinkSync(path.join(root, '.claude/skills', name));
    assert.deepEqual(checkVerificationSkills(root), [`${name}: compatibility link missing, dangling or not a symlink`]);
  });
  ok(`template skills reject unindexed ${name} compatibility link`, () => {
    const { root } = seed('template'); git(root, 'rm', '--cached', '--', `.claude/skills/${name}`);
    assert.deepEqual(checkVerificationSkills(root), [`${name}: compatibility link is not indexed once as mode 120000`]);
  });
}
ok('worker missing from both layouts refuses and names both paths', () => {
  const { root, brief } = seed('installed'); fs.unlinkSync(brief);
  const errors = checkWorkerEvidence(root); assert.equal(errors.length, 1);
  for (const file of ['wheelhouse/fleet/WORKER.md', 'contracts/WORKER.md']) assert(errors[0].includes(path.join(root, file)), errors[0]);
});
// Run each actual fixture's setup in a source root with no role briefs. A bd
// tripwire prevents even a broken preflight from reaching an enclosing graph.
for (const fixture of ['verify-manual-scope.ts', 'verify-batch.ts']) ok(`${fixture} refuses missing reviewer and names both layouts before graph writes`, () => {
  const root = path.join(scratch, `missing-reviewer-${fixture}`), seats = path.join(root, 'seats'), bin = path.join(root, 'bin'), touched = path.join(root, 'bd-called');
  fs.mkdirSync(path.join(seats, 'fixtures'), { recursive: true }); fs.mkdirSync(bin);
  for (const file of fs.readdirSync(path.join(source, 'seats'))) if (file.endsWith('.ts')) fs.copyFileSync(path.join(source, 'seats', file), path.join(seats, file));
  fs.copyFileSync(path.join(source, 'seats/fixtures', fixture), path.join(seats, 'fixtures', fixture));
  fs.mkdirSync(path.join(seats, 'fixtures/verify-real'));
  fs.copyFileSync(path.join(source, 'seats/fixtures/verify-real/pi-v3-message-end.jsonl'), path.join(seats, 'fixtures/verify-real/pi-v3-message-end.jsonl'));
  fs.writeFileSync(path.join(bin, 'bd'), '#!/usr/bin/env bash\nprintf called > "$MISSING_BRIEF_BD_TRIPWIRE"\nexit 97\n', { mode: 0o755 });
  const args = fixture === 'verify-manual-scope.ts' ? [path.join(seats, 'verify.ts'), path.join(root, 'run')] : [seats, path.dirname(scratch), path.join(seats, 'verify.ts')];
  const r = spawnSync('bun', [path.join(seats, 'fixtures', fixture), ...args], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MISSING_BRIEF_BD_TRIPWIRE: touched } });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 1, r.stderr);
  assert(r.stderr.includes('no crew brief for role "reviewer"'), r.stderr);
  for (const file of ['wheelhouse/crew/REVIEWER.md', 'contracts/REVIEWER.md']) assert(r.stderr.includes(path.join(root, file)), r.stderr);
  assert(!fs.existsSync(touched));
  console.log(`    refusal: ${r.stderr.split('\n').find(line => line.includes('error: no crew brief'))?.trim()}`);
});
