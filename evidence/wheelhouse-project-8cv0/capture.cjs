// Run from this bead's scratch root; committed copy is provenance only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = __dirname, worktree = process.cwd(), runtime = fs.readFileSync(path.join(root, 'runtime-tip.txt'), 'utf8').trim();
const dest = path.join(worktree, 'evidence/wheelhouse-project-8cv0');
fs.mkdirSync(dest, { recursive: true });
const replacements = [[root, '<bead-run>'], [worktree, '<task-worktree>'], [path.resolve(root, '../..'), '<container>'], [os.homedir(), '<HOME>']].sort((a,b)=>b[0].length-a[0].length);
const scrub = text => replacements.reduce((s,[from,to])=>s.split(from).join(to), text);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = [];
function retain(from, to = from) {
  fs.mkdirSync(path.dirname(path.join(dest, to)), { recursive: true });
  const file = path.join(root, from); if (!fs.statSync(file).isFile()) throw new Error('missing input '+file);
  const raw = fs.readFileSync(file), text = scrub(raw.toString());
  fs.writeFileSync(path.join(dest, to), text);
  manifest.push({ file: to, rawBytes: raw.length, rawSha256: sha(raw), retainedSha256: sha(Buffer.from(text)) });
}
for (const mode of ['standalone-clean', 'final-removed-hold', 'final-removed-diagnostics']) {
  for (const ext of ['stdout', 'stderr', 'exit', 'before.json', 'after.json']) retain(`${mode}.${ext}`);
}
for (const file of ['runtime-tip.txt', 'runtime-seats-tree.txt', 'suite-inventory.txt', 'check-run.cjs', 'assert-sweep.cjs', 'bridge.selftest.sh', 'capture.cjs']) retain(file);
function git(...args) {
  const r = spawnSync('git', args); if (r.status !== 0) throw new Error(String(r.stderr)); return r.stdout;
}
const entries = git('ls-tree', '-rz', runtime, 'seats').toString().split('\0').filter(Boolean).map(row => {
  const [info,file] = row.split('\t'); return { file, mode: info.split(' ')[0], oid: info.split(' ')[2] };
});
const controls = {};
for (const [mode, expected] of [['final-removed-hold', 'seats/concurrency.selftest.sh'], ['final-removed-diagnostics', 'seats/fixtures/concurrency-stub-supervisor.cjs']]) {
  const changed = [];
  for (const entry of entries) {
    const file = path.join(root, mode, entry.file);
    const bytes = entry.mode === '120000' ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    const hash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (hash !== entry.oid) changed.push(entry.file);
  }
  if (JSON.stringify(changed) !== JSON.stringify([expected])) throw new Error('unexpected control changes '+JSON.stringify(changed));
  const baseline = git('show', `${runtime}:${expected}`), before = path.join(root, mode+'.baseline');
  fs.writeFileSync(before, baseline);
  fs.chmodSync(before, fs.statSync(path.join(root, mode, expected)).mode & 0o777);
  const diff = spawnSync('git', ['diff', '--no-index', '--unified=0', '--', before, path.join(root, mode, expected)]);
  if (diff.status !== 1 || diff.stderr.length) throw new Error('missing/diagnostic control patch: '+String(diff.stderr));
  const patch = diff.stdout.toString().split('\n').map(line =>
    line.startsWith('diff --git ') ? `diff --git a/${expected} b/${expected}` :
    line.startsWith('--- ') ? `--- a/${expected}` : line.startsWith('+++ ') ? `+++ b/${expected}` : line).join('\n');
  fs.writeFileSync(path.join(dest, mode+'.patch'), scrub(patch));
  controls[mode] = { sourceRuntime: runtime, changed, exit: Number(fs.readFileSync(path.join(root,mode+'.exit'),'utf8').trim()) };
}
fs.writeFileSync(path.join(dest, 'control-source-check.json'), JSON.stringify(controls, null, 2)+'\n');
const comments = JSON.parse(fs.readFileSync(path.join(root, 'comments-latest.json')));
const ruling = comments.find(row => row.id === '01a13d36-01ec-7376-a20c-806ee6cbb5d2');
if (!ruling) throw new Error('missing commander ruling');
fs.writeFileSync(path.join(dest, 'commander-ruling.json'), JSON.stringify({ id:ruling.id, text:ruling.text, created_at:ruling.created_at },null,2)+'\n');
if (fs.existsSync(path.join(root, 'lock-diagnosis/results.json'))) {
  for (const ext of ['stdout', 'stderr', 'exit', 'before.json', 'after.json']) retain('lock-diagnosis.'+ext);
  for (const file of ['run.cjs', 'results.json', 'git-show.stderr']) retain('lock-diagnosis/'+file);
  const legacy = fs.readFileSync(path.join(root, 'lock-diagnosis/pre-su88-adapter.ts'), 'utf8');
  const start = legacy.indexOf('function acquireStateLock(): number {'), end = legacy.indexOf('function writeState(state: State): void {');
  if (start < 0 || end <= start) throw new Error('missing legacy lock functions');
  fs.writeFileSync(path.join(dest, 'lock-diagnosis/pre-su88-lock-functions.txt'), legacy.slice(start,end).trimEnd()+'\n');
  fs.writeFileSync(path.join(dest, 'lock-diagnosis/source.json'), JSON.stringify({ legacyCapture: 'git show 88e34b6eaa70b98b04b0030ccb0ea74fe224d153:seats/adapter.ts', legacySha256: sha(Buffer.from(legacy)), currentAdapter: runtime+':seats/adapter.ts', comparison: 'only lock functions substituted, then identical FIFO hold hook inside writeState; real adapter stop CLI, not stub protocol', naturalWorker1Cause: 'UNKNOWN' }, null, 2)+'\n');
}
if (fs.existsSync(path.join(root, 'full.exit'))) {
  for (const ext of ['stdout', 'stderr', 'exit', 'before.json', 'after.json']) retain('full.'+ext);
  for (const file of ['inventory-check.json', 'receipt-control.json', 'receipt-control.stderr']) retain(file);
}
fs.writeFileSync(path.join(dest, 'capture-manifest.json'), JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({ runtime, retained: manifest.length, controls }));
