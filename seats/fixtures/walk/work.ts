import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completedCommand } from '../../completed-command';
import { parseContract, validateContract } from '../../contract';
const [fleet, agent, fixture, reference, snapshotHelper] = process.argv.slice(2);
const evidence = process.env.WHEELHOUSE_WORK_WALK_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const records: any[] = [], legs: any[] = []; let serial = 0;
const save = (name: string, data: unknown) => { if (evidence) fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(data, null, 2), { flag: 'wx' }); };
function git(args: string[]) { const x = completedCommand('git', args, { cwd: fleet }); save('git-' + (++serial), { args, ...x }); assert.equal(x.status, 0, x.stderr); assert.equal(x.signal, null); assert.equal(x.error, undefined); return x.stdout.trim(); }
const product = path.join(fleet, 'product'); fs.cpSync(reference, product, { recursive: true, verbatimSymlinks: true });
fs.copyFileSync(fixture, path.join(fleet, 'contract-source.md'));
git(['add', '--', 'product', 'contract-source.md']); git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-qm', 'work fixture surfaces']);
const pin = git(['rev-parse', 'HEAD']), branch = 'fleet/BRANCH-NAME-SENTINEL'; git(['branch', branch]);
fs.writeFileSync(product + '/later-checkout.txt', 'not the reviewed tip\n'); git(['add', '--', 'product/later-checkout.txt']); git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-qm', 'later checkout']);
assert.notEqual(git(['rev-parse', 'HEAD']), pin);
const author = 'AUTHOR-SEAT-SENTINEL', rosterFile = path.join(fleet, 'seats/seats.json'), roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
const authorDir = path.join(path.dirname(agent), 'author'); fs.mkdirSync(authorDir); roster.seats[author] = { role: 'worker', account: { dir: authorDir } };
const originalVerifier = structuredClone(roster.seats.verifier); fs.writeFileSync(rosterFile, JSON.stringify(roster));
const ledger = path.join(agent, 'work-invocations.jsonl'); fs.writeFileSync(ledger, '');
const calls = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length;
const contract = parseContract(fs.readFileSync(fixture, 'utf8')); assert.deepEqual(validateContract(contract, { requireSignal: true }), []);
const passRows = ['OUTCOME: O1 PASS — GET /counter read back two', 'OUTCOME: O2 PASS — README names five features', 'OUTCOME: O3 PASS — GET /health returned {"ok":true}'];
const done = [...passRows, 'VERDICT: WALKED-DONE'].join('\n') + '\n';
const common = ['--work', 'fixture-work', '--branch', branch, '--author', author, '--repo', product];
function run(name: string, reply: string, args = common, contractFile = fixture, extraEnv: Record<string, string> = {}) {
  const out = path.join(fleet, 'out-work-' + name), cli = ['seats/walk.ts', ...args, '--out', out];
  const before = calls();
  const x = completedCommand('bun', cli, { cwd: fleet, env: { ...process.env, WHEELHOUSE_SKIP_BD: '1', WHEELHOUSE_CONTRACT_FIXTURE: contractFile,
    STUB_REPLY: reply, STUB_WORK_WALK_SNAPSHOT: snapshotHelper, ...extraEnv } });
  const row: any = { name, args: cli, status: x.status, signal: x.signal, error: x.error?.message ?? null, stdout: x.stdout, stderr: x.stderr, invoked: calls() - before };
  if (row.invoked) {
    row.prompt = fs.readFileSync(path.join(agent, 'prompt.txt'), 'utf8'); row.argv = JSON.parse(fs.readFileSync(path.join(agent, 'argv.json'), 'utf8'));
    row.snapshot = JSON.parse(fs.readFileSync(path.join(agent, 'work-snapshot.json'), 'utf8'));
  }
  if (fs.existsSync(out + '/walk.json')) row.metadata = JSON.parse(fs.readFileSync(out + '/walk.json', 'utf8'));
  records.push(row); save(name, row); assert.equal(row.error, null); assert.equal(row.signal, null);
  assert(!/Cannot find module|ModuleNotFound|SyntaxError/.test(row.stderr), 'INCOMPLETE: CLI module/parser setup'); return row;
}
function leg(name: string, fn: () => void) { let error: string | null = null; try { fn(); } catch (e: any) { error = String(e.message ?? e); } legs.push({ name, error }); console.log((error ? 'FAIL ' : 'PASS ') + name + (error ? ': ' + error : '')); }
function refused(row: any, code: number, text: RegExp, noSpawn = false) { assert.equal(row.status, code); assert.match(row.stderr, text); assert.equal(row.metadata, undefined, 'malformed/refused pass must not publish a verdict record'); if (noSpawn) assert.equal(row.invoked, 0); }
leg('work invalid contract refused before spawn', () => { const r = run('bad-contract', done, common, path.join(path.dirname(fixture), 'no-outcomes.md')); refused(r, 5, /not a contract.*fix: write Signal:, Intent: and Outcomes:/s, true); assert.match(r.stderr, /Outcomes: missing/); assert.equal(fs.existsSync(path.join(agent, 'cwd.txt')), false); });
leg('work same account directory refused before spawn', () => {
  const alias = path.join(path.dirname(agent), 'same-account-link'); fs.symlinkSync(agent, alias); roster.seats[author].account.dir = alias; fs.writeFileSync(rosterFile, JSON.stringify(roster));
  try { refused(run('same-account', done), 5, /SAME account directory/, true); } finally { roster.seats[author].account.dir = authorDir; fs.writeFileSync(rosterFile, JSON.stringify(roster)); }
});
leg('work without branch is usage', () => refused(run('missing-branch', done, ['--work', 'fixture-work', '--author', author]), 1, /usage:/, true));
leg('work without author is usage', () => refused(run('missing-author', done, ['--work', 'fixture-work', '--branch', branch]), 1, /usage:/, true));
leg('work mixed claim or surface is usage', () => { refused(run('mixed-claim', done, [...common, 'unexpected-claim']), 1, /usage:/, true); refused(run('mixed-surface', done, [...common, '--surface', 'product:fixture']), 1, /usage:/, true); });
let good: any;
leg('work prompt contains only Intent Outcomes and named surfaces', () => {
  good = run('all-pass', done); assert.equal(good.status, 0, good.stderr); assert.equal(good.invoked, 1);
  assert(good.prompt.includes(contract.intent)); for (const o of contract.outcomes) { assert(good.prompt.includes(`- ${o.id} ${o.claim}`)); assert(good.prompt.includes(`  surface: ${o.surface}`)); }
  assert(!/WORKER-REPORT-SENTINEL|^Trace:|^Signal:|^Integration:|^Skills:|bd show|contracts\/REVIEWER|wheelhouse\/ISA|seats\/logs|AUTHOR-SEAT-SENTINEL|BRANCH-NAME-SENTINEL/m.test(good.prompt));
  assert(good.prompt.includes('verify-five-features/SKILL.md')); assert(good.prompt.includes('# Counter')); assert(good.prompt.includes('## How to get to it'));
});
leg('work cwd pinned and verifier brief appended', () => { assert(good); assert.equal(good.snapshot.status, 0); assert.equal(good.snapshot.stderr, ''); assert.equal(good.snapshot.head.trim(), pin); assert.notEqual(good.snapshot.cwd, product); assert.equal(path.basename(good.snapshot.cwd), 'product'); assert(good.argv.includes('--append-system-prompt')); assert(good.argv.some((arg: string) => arg.endsWith('/contracts/VERIFIER.md'))); assert(!fs.existsSync(good.snapshot.cwd)); });
leg('work three PASS rows recorded', () => { assert.equal(good.metadata.mode, 'work'); assert.equal(good.metadata.tip, pin); assert.equal(good.metadata.branch, branch); assert.equal(good.metadata.outcomes.length, 3); assert.deepEqual(good.metadata.outcomes.map((x: any) => x.result), ['PASS', 'PASS', 'PASS']); assert(good.metadata.outcomes.every((x: any) => x.detail)); });
leg('work O2 FAIL recorded', () => { const r = run('fail', [passRows[0], 'OUTCOME: O2 FAIL — README omitted Echo', passRows[2], 'VERDICT: WALKED-NOT-DONE — O2: README omitted Echo'].join('\n')); assert.equal(r.status, 2); assert.equal(r.metadata.outcomes[1].result, 'FAIL'); assert.equal(r.metadata.verdict, 'WALKED-NOT-DONE'); });
leg('work missing O2 refused', () => refused(run('missing', [passRows[0], passRows[2], 'VERDICT: WALKED-DONE'].join('\n')), 4, /missing OUTCOME row O2/));
leg('work extra O4 refused', () => refused(run('extra', [...passRows, 'OUTCOME: O4 PASS — extra', 'VERDICT: WALKED-DONE'].join('\n')), 4, /extra OUTCOME row O4/));
leg('work duplicate O1 refused', () => { refused(run('duplicate', [passRows[0], 'OUTCOME: O1 PASS — different evidence', ...passRows.slice(1), 'VERDICT: WALKED-DONE'].join('\n')), 4, /duplicate OUTCOME row O1/); refused(run('identical-duplicate', [passRows[0], ...passRows, 'VERDICT: WALKED-DONE'].join('\n')), 4, /duplicate OUTCOME row O1/); });
leg('work FAIL under DONE refused', () => refused(run('inconsistent', [passRows[0], 'OUTCOME: O2 FAIL — README wrong', passRows[2], 'VERDICT: WALKED-DONE'].join('\n')), 4, /inconsistent VERDICT/));
leg('work UNREACHED without FAIL recorded', () => { const r = run('unreached', [...passRows.slice(0, 2), 'OUTCOME: O3 UNREACHED — credential missing', 'VERDICT: COULD-NOT-WALK — O3: credential missing'].join('\n')); assert.equal(r.status, 3); assert.equal(r.metadata.outcomes[2].result, 'UNREACHED'); });
leg('work evidence detail required', () => refused(run('no-detail', ['OUTCOME: O1 PASS', ...passRows.slice(1), 'VERDICT: WALKED-DONE'].join('\n')), 4, /O1 requires evidence detail/));
leg('work id order enforced', () => refused(run('order', [passRows[1], passRows[0], passRows[2], 'VERDICT: WALKED-DONE'].join('\n')), 4, /id order/));
leg('work first failing id required', () => refused(run('wrong-first-id', ['OUTCOME: O1 FAIL — first', 'OUTCOME: O2 FAIL — second', passRows[2], 'VERDICT: WALKED-NOT-DONE — O2: second'].join('\n')), 4, /inconsistent VERDICT.*O1:/));
leg('work FAIL takes precedence over UNREACHED', () => { const r = run('fail-precedence', ['OUTCOME: O1 UNREACHED — blocked', 'OUTCOME: O2 FAIL — bad page', passRows[2], 'VERDICT: WALKED-NOT-DONE — O2: bad page'].join('\n')); assert.equal(r.status, 2); });
leg('work full rows and paths reach inbox', () => {
  const long = 'read evidence '.repeat(180), r = run('long-inbox', [`OUTCOME: O1 PASS — ${long}END-EVIDENCE`, ...passRows.slice(1), 'VERDICT: WALKED-DONE'].join('\n')); assert.equal(r.status, 0);
  const rows = fs.readFileSync(path.join(fleet, 'seats/inbox.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)); const row = rows.at(-1); assert(row.detail.includes('END-EVIDENCE')); assert(row.detail.includes('OUTCOME: O3 PASS')); assert(row.detail.includes('metadata: ')); save('inbox', row);
});
leg('work structured rows on all harnesses', () => {
  for (const harness of ['pi', 'claude-code', 'codex']) {
    roster.seats.verifier = { ...structuredClone(originalVerifier), harness, provider: harness === 'claude-code' ? 'anthropic' : harness === 'codex' ? 'openai-codex' : 'openai' };
    roster.seats.verifier.account.authRoute = harness === 'claude-code' ? 'oauth' : harness === 'codex' ? 'env' : 'file'; fs.writeFileSync(rosterFile, JSON.stringify(roster));
    fs.writeFileSync(path.join(agent, '.claude.json'), '{"oauthAccount":{"accountUuid":"fixture"}}');
    const stream = path.join(fleet, 'stream-' + harness + '.jsonl'); const event = harness === 'pi' ? { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: done }] } } : harness === 'claude-code' ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: done }] } } : { type: 'item.completed', item: { type: 'agent_message', text: done } };
    fs.writeFileSync(stream, JSON.stringify({ type: 'tool_result', content: 'OUTCOME: O99 FAIL — stale tool text' })+'\n'+JSON.stringify(event)+'\n');
    const r = run('stream-' + harness, '', common, fixture, { STUB_STREAM_FILE: stream, OPENAI_CODEX_API_KEY: 'fixture-key' }); assert.equal(r.status, 0, r.stderr); assert.equal(r.metadata.outcomes.length, 3);
  }
});
save('results', { legs, records: records.map(({name,status,invoked}) => ({name,status,invoked})), pin, sourceSha256: createHash('sha256').update(fs.readFileSync(path.join(fleet, 'seats/walk.ts'))).digest('hex') });
if (legs.some(x => x.error)) process.exitCode = 1;
