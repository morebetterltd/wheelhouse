import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completedCommand } from '../../completed-command';
const [fleet, agent, reference] = process.argv.slice(2);
const product = path.join(fleet, 'product'), rel = '.agents/skills/verify-five-features';
const records = process.env.WHEELHOUSE_WALK_MANUAL_EVIDENCE;
if (records) fs.mkdirSync(records, { recursive: true });
let sequence = 0;
function save(name: string, data: unknown) { if (records) fs.writeFileSync(path.join(records, name + '.json'), JSON.stringify(data, null, 2), { flag: 'wx' }); }
function git(args: string[]) {
  const r = completedCommand('git', args, { cwd: fleet });
  save('git-' + (++sequence), { args, ...r }); assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
fs.cpSync(reference, product, { recursive: true, verbatimSymlinks: true });
const counterFile = path.join(product, rel, 'features/counter.md'), skillFile = path.join(product, rel, 'SKILL.md');
const originalCounter = fs.readFileSync(counterFile, 'utf8'), originalSkill = fs.readFileSync(skillFile, 'utf8');
git(['add', '--', 'product']); git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-qm', 'product oracle']);
const pin = git(['rev-parse', 'HEAD']);
// Dirty author checkout must not become the reviewed entry or manual.
fs.writeFileSync(counterFile, originalCounter.replaceAll('/counter', '/dirty-checkout-route'));
fs.appendFileSync(skillFile, '\nDIRTY_MANUAL_MUST_NOT_ENTER_WALK\n');
function walk(slug: string, reply: string, name: string, kind = 'manual', repo = product) {
  const out = path.join(fleet, 'out-' + name), args = ['seats/walk.ts', 'Counter reaches two after two increments', '--surface', kind + ':' + slug, '--repo', repo, '--out', out];
  const result = completedCommand('bun', args, { cwd: fleet, env: { ...process.env, STUB_WALK_MANUAL_SNAPSHOT: '1', STUB_REPLY: reply } });
  const row = { args, status: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr };
  save(name + '-native', row); assert.equal(row.error, null); assert.equal(row.signal, null);
  assert(!/Cannot find module|ModuleNotFound|SyntaxError/.test(result.stderr), 'INCOMPLETE: CLI module/parser setup failed');
  return { ...row, out };
}
function capture(name: string) {
  const prompt = fs.readFileSync(path.join(agent, 'prompt.txt'), 'utf8'), snapshot = JSON.parse(fs.readFileSync(path.join(agent, 'snapshot.json'), 'utf8'));
  save(name + '-prompt', { prompt, snapshot }); return { prompt, snapshot };
}
let failures = 0;
async function leg(name: string, fn: () => void) { try { fn(); console.log('PASS ' + name); } catch (e: any) { failures++; console.error('FAIL ' + name + ': ' + e.message); save(name.replaceAll(' ', '-') + '-failure', { error: e.message }); } }
await leg('manual prompt carries manual path and entry', () => {
  const r = walk('counter', 'VERDICT: WALKED-DONE\n', 'counter'); assert.equal(r.status, 0, r.stderr);
  const { prompt, snapshot } = capture('counter'); assert.equal(snapshot.status, 0); assert.equal(snapshot.stderr, ''); assert.equal(snapshot.head.trim(), pin);
  assert(snapshot.manualExists); assert.equal(snapshot.manualText, originalSkill); assert.notEqual(snapshot.cwd, product); assert.equal(path.basename(snapshot.cwd), 'product');
  assert(prompt.includes(path.join(snapshot.cwd, rel, 'SKILL.md'))); assert(prompt.includes(originalCounter)); assert(prompt.includes('## How to get to it'));
  assert(!prompt.includes('/dirty-checkout-route')); assert(!prompt.includes('DIRTY_MANUAL_MUST_NOT_ENTER_WALK'));
  assert(prompt.includes('WALKED-NOT-DONE quoting the step')); assert(prompt.includes('failed reach step is not permission')); assert(prompt.includes('do not replace it with navigation or another route'));
  assert.equal(snapshot.runDir, path.join(r.out, 'runtime')); assert.equal(snapshot.evidenceDir, path.join(r.out, 'evidence'));
  const metadata = JSON.parse(fs.readFileSync(path.join(r.out, 'walk.json'), 'utf8')); assert.equal(metadata.tip, pin); assert.equal(metadata.feature, 'counter'); assert.equal(metadata.productSubdirectory, 'product');
  assert(!fs.existsSync(snapshot.cwd), 'scratch product is removed after dispatcher exit');
  const home = walk('home', 'VERDICT: WALKED-DONE\n', 'home'); assert.equal(home.status, 0); const h = capture('home'); assert(h.prompt.includes('verify-five-features/SKILL.md')); assert(h.prompt.includes('# Home')); assert(h.prompt.includes('## How to get to it'));
  const p = walk('echo product', 'VERDICT: WALKED-DONE\n', 'product', 'product'); assert.equal(p.status, 0); assert(capture('product').prompt.includes('Verification manual (may be used):'));
  // A separate product Git root exercises the --repo case, not just a subdirectory.
  const standalone = path.join(fleet, 'standalone'); fs.cpSync(reference, standalone, { recursive: true, verbatimSymlinks: true });
  git(['-C', standalone, 'init', '-q', '-b', 'main']); git(['-C', standalone, 'add', '.']); git(['-C', standalone, '-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-qm', 'standalone oracle']);
  const standalonePin = git(['-C', standalone, 'rev-parse', 'HEAD']);
  const separate = walk('home', 'VERDICT: WALKED-DONE\n', 'standalone', 'manual', standalone); assert.equal(separate.status, 0); const c = capture('standalone'); assert.equal(c.snapshot.head.trim(), standalonePin); assert(c.snapshot.manualExists); assert.equal(path.basename(c.snapshot.cwd).startsWith('wheelhouse-review-'), true);
});
await leg('unknown manual slug refused', () => {
  const before = fs.readFileSync(path.join(agent, 'invocations.jsonl'), 'utf8');
  const r = walk('nope', 'VERDICT: WALKED-DONE\n', 'unknown'); assert.equal(r.status, 5); assert.match(r.stderr, /unknown manual feature slug "nope"/);
  assert.equal(fs.readFileSync(path.join(agent, 'invocations.jsonl'), 'utf8'), before, 'unknown slug must not spawn a walker');
});
await leg('wrong manual entry exits 2 and reaches inbox', () => {
  fs.writeFileSync(skillFile, originalSkill); assert(originalCounter.includes('open `GET /counter`'));
  const wrong = originalCounter.replace('open `GET /counter`', 'open `GET /countr`'); fs.writeFileSync(counterFile, wrong);
  git(['add', '--', 'product']); git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-qm', 'wrong reach entry']);
  const verdict = 'VERDICT: WALKED-NOT-DONE — step: GET /countr returned 404';
  const r = walk('counter', verdict + '\n', 'wrong'); assert.equal(r.status, 2, r.stderr); assert(r.stdout.includes(verdict));
  const c = capture('wrong'); assert(c.prompt.includes(wrong)); assert(c.prompt.includes('GET /countr')); assert(c.prompt.includes('not permission to try later or alternate routes'));
  const inbox = path.join(fleet, 'seats/inbox.jsonl'); assert(fs.existsSync(inbox), 'completed verdict must create an inbox row');
  const rows = fs.readFileSync(inbox, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const row = rows.find(row => row.source.type === 'verifier-walk' && row.detail.includes(verdict)); assert(row, 'inbox must carry full failed step'); save('wrong-inbox', row);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.out, 'walk.json'), 'utf8')).verdict, 'WALKED-NOT-DONE');
});
save('results', { failures, legs: 3, pin, fixtureSha256: createHash('sha256').update(originalCounter).digest('hex') });
if (failures) process.exitCode = 1;
