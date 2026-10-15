const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = __dirname, umbrella = path.resolve(root, '../..');
const [name, command, ...args] = process.argv.slice(2);
if (!name || !command || !fs.existsSync(path.join(umbrella, '.git'))) throw new Error('missing umbrella/command');
function git(...args) {
  const r = spawnSync('git', ['-C', umbrella, ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
}
function snapshot(side) {
  const data = { head: git('rev-parse', 'HEAD').toString().trim(),
    full: git('reflog', '--format=%H%x09%gs').toString(),
    diff: crypto.createHash('sha256').update(git('diff', 'HEAD', '--binary', '--', '.', ':(exclude).beads/interactions.jsonl')).digest('hex') };
  fs.writeFileSync(path.join(root, `${name}.${side}.json`), JSON.stringify(data, null, 2)+'\n');
  console.log(side + ' umbrella HEAD=' + data.head);
  return data;
}
const before = snapshot('before');
console.log('RUN ' + JSON.stringify([command, ...args]));
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error); process.exitCode = 98; });
child.on('close', (code, signal) => {
  const after = snapshot('after');
  const old = before.full.trimEnd().split('\n'), now = after.full.trimEnd().split('\n');
  const pos = now.indexOf(old[0]);
  const changes = pos < 0 ? now : now.slice(0, pos);
  const unsafe = changes.filter(row => !/\tcommit:/.test(row) && !/\tmerge .*Fast-forward/.test(row));
  const rc = code ?? 128;
  fs.writeFileSync(path.join(root, name+'.exit'), String(rc)+'\n');
  if (pos < 0 || unsafe.length || (before.head === after.head && before.diff !== after.diff)) {
    fs.writeFileSync(path.join(root, 'STOP'), name+'\n');
    console.error('STOP unsafe umbrella mutation '+JSON.stringify(unsafe)); process.exitCode = 99;
  } else {
    console.log(`umbrella safety: PASS (${changes.length} permitted new reflog entries); test exit=${rc}; signal=${signal}`);
    process.exitCode = rc;
  }
});
