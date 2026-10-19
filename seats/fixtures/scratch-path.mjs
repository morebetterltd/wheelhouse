import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [fixture, seatsArg] = process.argv.slice(2);
assert(fixture && seatsArg);
const top = fs.realpathSync(fixture), seats = fs.realpathSync(seatsArg);
assert(fs.statSync(path.join(top, '.wheelhouse-selftest-fixture')).isFile());
const root = path.join(top, 'parent', 'install'), product = path.join(root, 'product');
const sibling = path.join(top, 'parent', 'sibling-product'), bead = 'fixture-ik5b';
const expected = path.join(root, '.wheelhouse-runs', bead) + path.sep;
const bin = path.join(top, 'bin'), home = path.join(top, 'home'), account = path.join(home, 'verifier');
for (const dir of [root, product, sibling, bin, account, path.join(root, 'wheelhouse/crew'), path.join(root, '.beads')]) fs.mkdirSync(dir, { recursive: true });
fs.cpSync(seats, path.join(root, 'seats'), { recursive: true });
fs.writeFileSync(path.join(account, 'auth.json'), '{"fixture":"not-a-credential"}\n');
fs.writeFileSync(path.join(root, 'wheelhouse/crew/REVIEWER.md'), 'Static fixture prompt review.\n');
fs.writeFileSync(path.join(root, 'wheelhouse/.template-source'), 'product-repo=product\n');
fs.writeFileSync(path.join(root, 'seats/seats.json'), JSON.stringify({ seats: {
  author: { role: 'worker', provider: 'anthropic', model: 'fixture', account: { dir: path.join(home, 'author') } },
  verifier: { role: 'verifier', provider: 'openai', model: 'fixture', account: { dir: account } },
} }));
const writeTool = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bun\nexport {};\n' + body, { mode: 0o700 });
// bd list's id/status fields were captured from the actual CLI before this
// fixture was authored. All graph operations here are stubbed, not a real DB.
writeTool('bd', `import fs from 'node:fs'; import path from 'node:path'; const args=process.argv.slice(2); if(args[0]==='--readonly')args.shift(); if(args[0]==='list')console.log(JSON.stringify(args.includes('--status=closed')?[{id:'${bead}',status:'closed'}]:[])); else if(args[0]==='show')console.log('Done: static prompt path assertion.'); else if(args[0]==='comments')console.log('[]'); else if(args[0]==='metrics'&&args[1]==='off')process.exit(0); else if(args[0]==='init'){if(!fs.statSync('.git').isDirectory())throw Error('scratch graph must be primary');fs.mkdirSync('.beads');} else if(args[0]==='where')console.log(JSON.stringify({path:fs.realpathSync('.beads')})); else process.exit(1);`);
writeTool('lsof', 'process.exit(0);');
writeTool('xcrun', 'process.exit(1);');
writeTool('pi', `import fs from 'node:fs'; import path from 'node:path'; const prompt=process.argv.at(-1); if(!fs.existsSync(process.env.SCRATCH_PATH_SWEEP_LEDGER)||!fs.readFileSync(process.env.SCRATCH_PATH_SWEEP_LEDGER,'utf8').trim())throw Error('reviewer reached before fixture sweep completed'); fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'prompt.txt'),prompt); fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'env-root.txt'),process.env.WHEELHOUSE_ROOT||''); console.log('VERDICT: APPROVE — NOT BENCHED: static prompt fixture only\\nPUSH: NOT CONSIDERED');`);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, WHEELHOUSE_ROOT: path.join(top, 'wrong-inherited-root'), WHEELHOUSE_SKIP_REAL_PI: '1', WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(top, 'private-fixture-sweep.lock') };
const run = async (name, cmd, args, cwd = root) => {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', stdoutEOF = false, stderrEOF = false;
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  child.stdout.on('end', () => stdoutEOF = true); child.stderr.on('end', () => stderrEOF = true);
  const native = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  fs.writeFileSync(path.join(top, name + '.stdout'), out); fs.writeFileSync(path.join(top, name + '.stderr'), err);
  assert(stdoutEOF && stderrEOF && native.signal === null, name + ': normal close/EOF');
  return { ...native, stdoutEOF, stderrEOF, out, err };
};
for (const [i, repo] of [product, sibling].entries()) {
  // The dispatcher always sweeps the reviewed COMMIT, even for static claims.
  // Commit a real inert fixture suite, not an empty repo or a gate bypass.
  fs.mkdirSync(path.join(repo, 'seats'));
  fs.writeFileSync(path.join(repo, 'seats/prompt-fixture.selftest.sh'), '#!/usr/bin/env bash\nset -eu\ngit rev-parse HEAD >> "$SCRATCH_PATH_SWEEP_LEDGER"\nprintf "prompt fixture suite complete\\n"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(repo, 'seats/selftest-sweep.sh'), '#!/usr/bin/env bash\nset -eu\nexec bash "$(dirname "$0")/prompt-fixture.selftest.sh"\n', { mode: 0o700 });
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'seats'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], ['branch', 'fleet/fixture-ik5b']]) {
    const r = await run(`git-${i}-${args[0]}`, 'git', args, repo); assert.equal(r.code, 0, r.err);
  }
}
const rows = [];
const check = async (name, fn) => { try { const evidence = await fn(); rows.push({ test: name, passed: true, ...evidence }); } catch(e) { rows.push({ test: name, passed: false, error: String(e) }); } console.log(JSON.stringify(rows.at(-1))); };
for (const [name, repo, explicit] of [['umbrella-product', product, true], ['sibling-product', sibling, true], ['default-product', product, false]]) await check(name, async () => {
  const ledger = path.join(top, name + '.sweep-ledger');
  assert(!fs.existsSync(ledger), 'fresh case must not inherit another sweep completion');
  env.SCRATCH_PATH_SWEEP_LEDGER = ledger;
  fs.rmSync(path.join(account, 'prompt.txt'), { force: true });
  const r = await run(name, 'bun', [path.join(root, 'seats/verify.ts'), bead, 'fleet/fixture-ik5b', 'author', 'verifier', ...(explicit ? ['--repo', repo] : [])]);
  assert.equal(r.code, 0, r.err);
  const tip = await run(name + '-source-tip', 'git', ['rev-parse', 'HEAD'], repo); assert.equal(tip.code, 0, tip.err);
  assert.equal(fs.readFileSync(ledger, 'utf8'), tip.out, 'one completed fixture sweep at the exact reviewed tip');
  const file = path.join(account, 'prompt.txt'); assert(fs.existsSync(file), 'reviewer actually ran');
  const prompt = fs.readFileSync(file, 'utf8');
  assert(prompt.includes(`Branch repository: ${repo}`));
  assert.equal(fs.readFileSync(path.join(account, 'env-root.txt'), 'utf8'), root);
  const line = `Scratch root for bead ${bead}: ${expected}`;
  assert(prompt.split('\n').includes(line), `missing exact install scratch root: ${expected}`);
  assert(!prompt.includes(`Scratch root for bead ${bead}: ${path.join(path.dirname(root), '.wheelhouse-runs', bead)}/`));
  return { code: r.code, stdoutEOF: r.stdoutEOF, stderrEOF: r.stderrEOF, branchRepo: repo, installRoot: root, scratchLine: line, fixtureSweeps: 1, sweepTip: tip.out.trim() };
});
await check('worker-dispatch', async () => {
  const briefs = await import(pathToFileURL(path.join(root, 'seats/briefs.ts')).href);
  assert.equal(typeof briefs.workerDispatchPrompt, 'function', 'worker assembly must expose the exact install scratch root');
  const prompt = briefs.workerDispatchPrompt(root, bead, 'Fixture task payload.');
  assert(prompt.startsWith(`Bead ${bead}\n`)); assert(prompt.endsWith('Fixture task payload.'));
  assert(prompt.split('\n').includes(`Scratch root for bead ${bead}: ${expected}`));
  const adapter = fs.readFileSync(path.join(root, 'seats/adapter.ts'), 'utf8');
  assert(adapter.includes('const promptText = workerDispatchPrompt(ROOT, beadId, text);'), 'adapter must use the tested assembly with install ROOT, not product/cwd');
  return { scratchRoot: expected, installRoot: root };
});
for (const role of ['REVIEWER', 'WORKER', 'BENCH']) await check('contract-' + role, async () => {
  const text = fs.readFileSync(path.join(seats, '..', 'contracts', role + '.md'), 'utf8');
  assert(text.includes('$WHEELHOUSE_ROOT/.wheelhouse-runs/<bead-id>/...'), role + ': explicit install scratch root');
  assert(!text.includes('<container>/.wheelhouse-runs/<bead-id>'), role + ': no ambiguous container placeholder');
  return { contract: role };
});
const stray = path.join(path.dirname(root), '.wheelhouse-runs', bead), unrelated = path.join(path.dirname(root), '.wheelhouse-runs', 'other-install-bead');
const lookalike = path.join(path.dirname(root), '.wheelhouse-runs', bead + '2');
for (const dir of [stray, unrelated, lookalike]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'KEEP'), 'foreign KEEP\n'); }
await check('parent-scan-report', async () => {
  const r = await run('scan', 'bun', [path.join(root, 'seats/prune.ts'), 'scan', '--root', root, '--format', 'json']);
  assert.equal(r.code, 0, r.err);
  const rows = JSON.parse(r.out), report = rows.find(r => r.path === stray);
  assert(report, 'scan must report this install bead scratch in its parent');
  // The existing reviewed-scan wire assigns an operation kind even to unsafe
  // rows. safe=0 and the never-pruned category, not that kind, prohibit action.
  assert.equal(report.safe, 0); assert.equal(report.action, 'rm'); assert.equal(report.category, 'needs-review');
  assert(report.reason.includes('misplaced scratch outside install'));
  assert(!rows.some(r => r.path === unrelated || r.path === lookalike), 'other install bead/prefix lookalike must not be attributed here');
  const scanFile = path.join(top, 'parent-report.json');
  fs.writeFileSync(scanFile, JSON.stringify([rows[0], report]));
  const replay = await run('reviewed-parent-report', 'bun', [path.join(root, 'seats/prune.ts'), 'prune', '--from-file', scanFile, '--yes']);
  assert.equal(replay.code, 0, replay.err);
  assert(replay.out.includes('SKIPPED needs-review') && replay.out.includes(stray));
  for (const dir of [stray, unrelated, lookalike]) assert.equal(fs.readFileSync(path.join(dir, 'KEEP'), 'utf8'), 'foreign KEEP\n');
  return { code: r.code, reviewedPruneCode: replay.code, report };
});
await check('parent-cleanup-report', async () => {
  const r = await run('cleanup', 'bun', [path.join(root, 'seats/prune.ts'), 'cleanup', '--root', root, '--bead', bead]);
  assert.equal(r.code, 0, r.err);
  assert(r.out.includes(stray) && r.out.includes('misplaced scratch outside install'), 'cleanup must make stray scratch visible');
  for (const dir of [stray, unrelated, lookalike]) assert.equal(fs.readFileSync(path.join(dir, 'KEEP'), 'utf8'), 'foreign KEEP\n');
  assert(r.out.includes('removed=0'));
  return { code: r.code, outsideKept: true, stdout: r.out };
});
fs.writeFileSync(path.join(top, 'scratch-path-results.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(`scratch-path.selftest: ${rows.length} checks, ${rows.filter(r => !r.passed).length} failures`);
process.exitCode = rows.some(r => !r.passed) ? 1 : 0;
