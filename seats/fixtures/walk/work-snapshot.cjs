const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
exports.record = (cwd, dir) => {
  const head = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'work-snapshot.json'), JSON.stringify({ cwd, head: head.stdout, status: head.status, stderr: head.stderr }));
  fs.appendFileSync(path.join(dir, 'work-invocations.jsonl'), JSON.stringify({pid: process.pid})+'\n');
};
