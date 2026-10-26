// Seven checker legs, with real CLI exits and isolated copied manuals.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';
const [checker, fixture, reference] = process.argv.slice(2);
assert(fs.lstatSync(fixture + '/.wheelhouse-selftest-fixture').isFile());
const relativeManual = '.agents/skills/verify-five-features';
const alias = '.claude/skills/verify-five-features';
const slugs = ['home', 'health', 'echo', 'counter', 'about'];
const evidence = process.env.WHEELHOUSE_MANUAL_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const results: any[] = []; let sequence = 0;
function run(args: string[], repo: string | null = reference, env = process.env) {
  const r = completedCommand('bun', [checker, ...args, ...(repo === null ? [] : ['--repo', repo])], { env });
  const row = { args, repo, code: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr };
  const name = String(++sequence).padStart(3, '0') + '.json'; fs.writeFileSync(fixture + '/' + name, JSON.stringify(row, null, 2));
  if (evidence) fs.writeFileSync(evidence + '/' + name, JSON.stringify(row, null, 2), { flag: 'wx' });
  assert.equal(row.error, null); assert.equal(row.signal, null);
  assert(!/Cannot find module|ModuleNotFound|SyntaxError/.test(row.stderr), 'INCOMPLETE: CLI setup/parser failure');
  return row;
}
function copy(label: string) {
  const repo = path.join(fixture, label); fs.cpSync(reference, repo, { recursive: true, verbatimSymlinks: true });
  assert.equal(fs.readlinkSync(repo + '/' + alias), '../../.agents/skills/verify-five-features');
  return repo;
}
async function leg(name: string, body: () => void | Promise<void>) {
  let failure: string | null = null;
  try { await body(); } catch (e: any) { failure = String(e.message ?? e); }
  results.push({ name, failure }); console.log((failure ? 'FAIL ' : 'PASS ') + name + (failure ? ': ' + failure : ''));
}
await leg('reference manual', () => {
  const r = run(['check']); assert.equal(r.code, 0); assert.equal(r.stdout, 'manual ok: 5 features\n'); assert.equal(r.stderr, '');
  const empty = path.join(fixture, 'missing'); fs.mkdirSync(empty);
  const missing = run(['check'], empty); assert.equal(missing.code, 2); assert.match(missing.stderr, /no verification manual; run the create-verification skill/);
  const envRoot = run(['check'], null, { ...process.env, WHEELHOUSE_MANUAL_ROOT: reference }); assert.equal(envRoot.code, 0);
  const envMissing = run(['check'], null, { ...process.env, WHEELHOUSE_MANUAL_ROOT: empty }); assert.equal(envMissing.code, 2);
  const explicit = run(['check'], reference, { ...process.env, WHEELHOUSE_MANUAL_ROOT: empty }); assert.equal(explicit.code, 0);
  const ambiguous = copy('ambiguous'), from = ambiguous + '/' + relativeManual, to = ambiguous + '/.agents/skills/verify-other';
  fs.cpSync(from, to, { recursive: true });
  const many = run(['check'], ambiguous); assert.equal(many.code, 2); assert.match(many.stderr, /multiple verification manuals.*--project/);
  const chosen = run(['check', '--project', 'five-features'], ambiguous); assert.equal(chosen.code, 0);
  const malformed = copy('frontmatter'), file = malformed + '/' + relativeManual + '/SKILL.md';
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('version: 1.0.0', 'version: not-a-version'));
  const bad = run(['check'], malformed); assert.equal(bad.code, 2); assert.match(bad.stderr, /SKILL\.md:\d+:.*version/);
  const reserved = run(['lint-contract', '--file', path.join(fixture, 'not-read')], empty); assert.equal(reserved.code, 2); assert.equal(reserved.stderr, 'not yet\n');
});
await leg('missing Doctor refused', () => {
  const repo = copy('missing-doctor'), file = repo + '/' + relativeManual + '/SKILL.md';
  const text = fs.readFileSync(file, 'utf8'); assert.equal(text.split('## Doctor').length, 2); fs.writeFileSync(file, text.replace('## Doctor', 'Doctor section removed'));
  const r = run(['check'], repo); assert.equal(r.code, 2); assert.match(r.stderr, /SKILL\.md:\d+:.*Doctor/);
  // Examples at the actual missing position still cannot supply a section.
  for (const fake of ['```text\n## Doctor\nnot a section\n```', '<!--\n## Doctor\nnot a section\n-->']) {
    fs.writeFileSync(file, text.replace('## Doctor', fake));
    const example = run(['check'], repo); assert.equal(example.code, 2); assert.match(example.stderr, /Doctor/);
  }
});
await leg('missing feature proof refused', () => {
  const repo = copy('missing-proof'), file = repo + '/' + relativeManual + '/features/counter.md';
  const text = fs.readFileSync(file, 'utf8'); assert.equal(text.split('## What proves it works').length, 2); fs.writeFileSync(file, text.replace('## What proves it works', 'Proof section removed'));
  const r = run(['check'], repo); assert.equal(r.code, 2); assert.match(r.stderr, /counter\.md:\d+:.*What proves it works/);
  const inventory = copy('inventory'), index = inventory + '/' + relativeManual + '/features/README.md';
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/^- \[Counter\].*\n/m, ''));
  const unlisted = run(['check'], inventory); assert.equal(unlisted.code, 2); assert.match(unlisted.stderr, /README\.md:\d+:.*not listed.*counter/);
  fs.appendFileSync(index, '\n- [Absent](./absent.md)\n');
  const absent = run(['check'], inventory); assert.equal(absent.code, 2); assert.match(absent.stderr, /README\.md:\d+:.*does not exist.*absent/);
});
await leg('dangling compatibility link refused', () => {
  const repo = copy('dangling'), link = repo + '/' + alias;
  fs.unlinkSync(link); fs.symlinkSync('../../missing', link);
  const r = run(['check'], repo); assert.equal(r.code, 2); assert.match(r.stderr, /:\d+:.*dangling compatibility symlink/);
  fs.unlinkSync(link); fs.mkdirSync(repo + '/elsewhere'); fs.symlinkSync('../../elsewhere', link);
  const wrong = run(['check'], repo); assert.equal(wrong.code, 2); assert.match(wrong.stderr, /different manual/);
});
await leg('no-surface manual', () => {
  const repo = copy('no-surface'), dir = repo + '/' + relativeManual;
  fs.writeFileSync(dir + '/SKILL.md', '---\nname: verify-five-features\ndescription: No runnable surface.\nversion: 1.0.0\nsurface: none\n---\nThis repository has no runnable consumer surface. No live journey can be driven yet.\n');
  for (const slug of slugs) fs.unlinkSync(dir + '/features/' + slug + '.md'); fs.writeFileSync(dir + '/features/README.md', '# Features\n\nNo entries yet.\n');
  const r = run(['check'], repo); assert.equal(r.code, 0); assert.equal(r.stdout, 'manual ok: 0 features\n');
  const listed = run(['features', '--json'], repo); assert.equal(listed.code, 0); assert.deepEqual(JSON.parse(listed.stdout), []);
  fs.copyFileSync(reference + '/' + relativeManual + '/features/counter.md', dir + '/features/counter.md'); fs.appendFileSync(dir + '/features/README.md', '\n- [Counter](./counter.md)\n');
  const invalid = run(['check'], repo); assert.equal(invalid.code, 2); assert.match(invalid.stderr, /surface: none requires an empty feature map/);
});
await leg('five feature slugs', async () => {
  const r = run(['features', '--json']); assert.equal(r.code, 0); const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map((f: any) => f.slug), slugs); assert.equal(new Set(rows.map((f: any) => f.slug)).size, 5);
  for (const f of rows) { assert(f.title.trim()); assert(f.howToGetToIt.trim()); assert(f.whatProvesItWorks.trim()); }
  assert.match(rows.find((f: any) => f.slug === 'counter').whatProvesItWorks, /Counter = 2/);
  const api = await import(checker); const parsed = api.readManual(reference); assert.equal(parsed.features.length, 5); assert.equal(parsed.project, 'five-features');
});
await leg('evidence empty refused and regular file accepted', () => {
  const retained = path.join(fixture, 'retained'); fs.mkdirSync(retained + '/counter', { recursive: true });
  const empty = run(['evidence', 'counter', '--dir', retained]); assert.equal(empty.code, 2); assert.match(empty.stderr, /no regular evidence file/);
  fs.symlinkSync(reference + '/' + relativeManual + '/features/counter.md', retained + '/counter/link');
  const link = run(['evidence', 'counter', '--dir', retained]); assert.equal(link.code, 2); assert.match(link.stderr, /no regular evidence file/);
  fs.writeFileSync(retained + '/counter/response.html', '<output id="count">2</output>\n');
  const present = run(['evidence', 'counter', '--dir', retained]); assert.equal(present.code, 0); assert.match(present.stdout, /evidence ok:/);
  const unknown = run(['evidence', '../outside', '--dir', retained]); assert.equal(unknown.code, 2); assert.match(unknown.stderr, /unknown feature/);
});
const facts = { checkerSha256: createHash('sha256').update(fs.readFileSync(checker)).digest('hex'), legs: results, nativeCommands: sequence };
fs.writeFileSync(fixture + '/results.json', JSON.stringify(facts, null, 2)); if (evidence) fs.writeFileSync(evidence + '/results.json', JSON.stringify(facts, null, 2), { flag: 'wx' });
if (results.some(row => row.failure)) process.exitCode = 1;
