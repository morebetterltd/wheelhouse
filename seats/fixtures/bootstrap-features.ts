// Execute BOOTSTRAP's printed interview/map comparison against scratch repos.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { completedCommand } from '../completed-command';
const [template, fixture, bootstrap] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, '.wheelhouse-selftest-fixture')).isFile());
const doc = fs.readFileSync(bootstrap, 'utf8');
const survey = doc.split('## 3. Read, then interview')[1].split('### The interview')[0];
for (const term of ['user-facing features', 'routes, commands, screens, menus', 'before the interview']) assert(survey.includes(term), 'FEATURE_SURVEY: ' + term);
const question = doc.split('   e. **Features I found.**')[1]?.split('3. **First ideal state.**')[0];
assert(question, 'FEATURE_QUESTION: missing 2e');
for (const term of ['List is right', 'AskUserQuestion', 'Add or correct features', 'same interview turn', 'wheelhouse/interview/features.md', 'not skippable', "owner's words"]) assert(question.includes(term), 'FEATURE_QUESTION: ' + term);
const records = doc.split('### Record what the interview decided')[1].split('## 4.')[0];
for (const term of ['wheelhouse/interview/features.md', '[owner]', 'jsonl', 'commit this record', 'null']) assert(records.includes(term), 'FEATURE_RECORD: ' + term);
const manual = doc.split('### Write the verification manual')[1].split('### Verify')[0];
for (const term of ['wheelhouse/interview/features.md', 'map every feature', "owner's words", 'missing file']) assert(manual.includes(term), 'FEATURE_MANUAL: ' + term);
console.log('PASS survey, non-skippable 2e, machine record and map instructions');
const section = doc.split('- **Verification manual — repeat per product repo')[1].split('- **Check `GRAPH.md`')[0];
const script = section.split('```bash\n')[1]?.split('\n  ```')[0]?.replace(/^  /gm, '');
assert(script?.includes('wheelhouse/interview/features.md') && script.includes('seats/install-features.ts'), 'FEATURE_VERIFY: missing printed comparison');
const printed = path.join(fixture, 'verify.sh');
fs.writeFileSync(printed, 'set -eu\nrepo=$1\nproject=$(basename "$repo")\n' + script + '\n');
const install = path.join(fixture, 'install'); fs.mkdirSync(install);
fs.symlinkSync(path.join(template, 'seats'), path.join(install, 'seats'), 'dir');
fs.mkdirSync(path.join(install, 'wheelhouse/interview'), { recursive: true });
const recordFile = path.join(install, 'wheelhouse/interview/features.md');
const ownerReach = 'Launch with EXTRA_FEATURES=reports, then open /reports directly.';
function repo(name: string, slugs: string[]) {
  const dir = path.join(install, name), project = path.basename(dir);
  fs.mkdirSync(dir, { recursive: true });
  const init = completedCommand('git', ['init', '-q', '-b', 'main', dir]); assert.equal(init.status, 0, init.stderr);
  const map = path.join(dir, '.agents/skills/verify-' + project + '/features'); fs.mkdirSync(map, { recursive: true });
  fs.writeFileSync(path.dirname(map) + '/SKILL.md', '---\nname: verify-' + project + '\ndescription: Scratch fixture manual.\nversion: 1.0.0\n---\n' + ['Launch','Doctor','Drive','Evidence','Cleanup'].map(h => '\n## ' + h + '\n\nFixture instructions for ' + h + '.\n').join(''));
  fs.writeFileSync(map + '/README.md', '# Features\n\n' + slugs.map(s => '- [' + s + '](./' + s + '.md)').join('\n') + '\n');
  for (const slug of slugs) fs.writeFileSync(map + '/' + slug + '.md', '# ' + slug + '\n\n## What it is\n\n' + slug + '.\n\n## How to get to it\n\n' + (slug === 'reports' ? ownerReach : 'GET /' + slug) + '\n\n## How to drive it\n\nRequest its consumer endpoint.\n\n## What proves it works\n\nRetain the response and exit status.\n');
  fs.mkdirSync(dir + '/.claude/skills', { recursive: true });
  fs.symlinkSync('../../.agents/skills/verify-' + project, dir + '/.claude/skills/verify-' + project, 'dir');
  return dir;
}
const six = ['home','health','echo','counter','about','reports'];
const first = repo('five-features', six), second = repo('other repo', ['health']);
const rows = six.map(slug => ({ repo: 'five-features', slug, origin: slug === 'reports' ? '[owner]' : '[found]', name: slug, reach: slug === 'reports' ? ownerReach : 'GET /' + slug }));
const other = { repo: 'other repo', slug: 'health', origin: '[found]', name: 'Other health', reach: 'GET /health' };
function record(data: any[]) { fs.writeFileSync(recordFile, '# Interview features\n\nConfirmed repo: "five-features"\nConfirmed repo: "other repo"\n\n```jsonl\n' + data.map(row => JSON.stringify(row)).join('\n') + '\n```\n'); }
function run(file = printed, product = first) {
  const r = completedCommand('bash', [file, product], { cwd: install });
  assert.ifError(r.error); assert.equal(r.signal, null);
  assert(!/Cannot find module|SyntaxError|command not found/.test(r.stderr), 'INCOMPLETE printed block: ' + r.stderr);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
record([...rows, other]);
for (const [dir, count] of [[first, 6], [second, 1]] as const) {
  const r = run(printed, dir); assert.equal(r.code, 0, r.stderr); assert(r.stdout.includes('expected=' + count + ' mapped=' + count));
}
console.log('PASS printed Verify: six features, per-repo scoping, overlapping health slug and spaced repo path');
const empty = repo('no-surface', []);
fs.writeFileSync(empty + '/.agents/skills/verify-no-surface/SKILL.md', '---\nname: verify-no-surface\ndescription: No runnable surface.\nversion: 1.0.0\nsurface: none\n---\nThis repository has no runnable consumer surface. No live journey can be driven yet.\n');
record([]); fs.writeFileSync(recordFile, fs.readFileSync(recordFile,'utf8').replace('Confirmed repo: "five-features"','Confirmed repo: "no-surface"'));
const none = run(printed, empty); assert.equal(none.code, 0, none.stderr); assert(none.stdout.includes('expected=0 mapped=0'));
console.log('PASS confirmed no-surface repo retains honest zero-feature install');
const cases: [string, () => void, RegExp][] = [
  ['missing owner feature', () => record(rows.filter(r => r.slug !== 'reports')), /unrecorded feature reports/],
  ['same count wrong slug', () => record(rows.map(r => r.slug === 'reports' ? {...r, slug:'billing'} : r)), /missing feature billing/],
  ['unanswered owner reach', () => record(rows.map(r => r.slug === 'reports' ? {...r, reach:null} : r)), /feature reports is missing the owner-confirmed reach/],
  ['invented owner words', () => record(rows.map(r => r.slug === 'reports' ? {...r, reach:'Open the dashboard tab.'} : r)), /feature reports is missing the owner-confirmed reach/],
  ['duplicate feature', () => record([...rows, rows[0]]), /duplicate feature home/],
  ['malformed record', () => record([{...rows[0], origin:'guessed'}]), /malformed feature record/],
  ['missing repo confirmation', () => { record(rows); fs.writeFileSync(recordFile, fs.readFileSync(recordFile,'utf8').replace('Confirmed repo: "five-features"', 'Not confirmed')); }, /repo not confirmed/],
  ['missing record', () => { fs.rmSync(recordFile); }, /features.md:/],
];
// Removing the new comparison must turn every refusal oracle into a false pass.
const bypass = path.join(fixture, 'without-comparison.sh');
const comparator = script.indexOf("printf '%s\\n' \"$inventory\" | bun seats/install-features.ts"); assert(comparator > 0);
fs.writeFileSync(bypass, 'set -eu\nrepo=$1\nproject=$(basename "$repo")\n' + script.slice(0, comparator) + '\n');
for (const [name, setup, diagnostic] of cases) {
  record(rows); setup();
  const r = run(); assert.equal(r.code, 1, name + ': ' + r.stderr); assert.match(r.stderr, diagnostic);
  const removed = run(bypass); assert.equal(removed.code, 0, name + ': fix-removal control did not expose false pass');
  console.log('PASS ' + name + ': actual rc=1; comparison removed rc=0 (refusal oracle fails)');
}
// A complete interview with an omitted map entry fails naming that feature.
const omitted = repo('omitted-map', six.slice(0, 5));
record(rows.map(row => ({...row, repo:'omitted-map'})));
fs.writeFileSync(recordFile, fs.readFileSync(recordFile,'utf8').replace('Confirmed repo: "five-features"','Confirmed repo: "omitted-map"'));
const missingMap = run(printed, omitted); assert.equal(missingMap.code, 1); assert.match(missingMap.stderr, /missing feature reports/);
const bypassMap = run(bypass, omitted); assert.equal(bypassMap.code, 0);
console.log('PASS omitted reports map: actual rc=1; comparison removed rc=0 (refusal oracle fails)');
record(rows);
const reports = first + '/.agents/skills/verify-five-features/features/reports.md';
fs.unlinkSync(reports);
const absent = run(); assert.equal(absent.code, 1); assert.match(absent.stderr, /listed feature file does not exist: reports.md/);
console.log('PASS unanswered indexed feature without invented file fails manual.ts check naming reports.md');
