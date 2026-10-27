// Focused real scan/cleanup with a read-only graph protocol fixture. The
// bd list --status=closed --json --limit 1 capture used to build it was an
// issue array with string id/status fields. No bd writes or Dolt server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {completedCommand} from '../completed-command';
const [root] = process.argv.slice(2);
assert(fs.statSync(root).isDirectory());
const id = 'prefix-fixture.1', bin = path.join(root, 'fixture-bin');
fs.mkdirSync(bin); fs.mkdirSync(path.join(root, '.beads'));
const trace = path.join(root, 'bd-calls.jsonl');
fs.writeFileSync(path.join(bin, 'bd'), `#!/usr/bin/env bun
import fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');
if(args[0]!=='list')throw Error('read-only fixture rejects '+args[0]);
const status=args.find(a=>a.startsWith('--status='));
if(!status)throw Error('expected explicit status read');
if(status==='--status=open'){console.error('fixture: open status list unavailable');process.exit(23);}
console.log(JSON.stringify(status==='--status=closed'?[{id:${JSON.stringify(id)},status:'closed'}]:[]));
`, {mode:0o700});
const env = {...process.env, PATH:bin+path.delimiter+process.env.PATH};
const api = await import(path.join(root, 'seats/cleanup-identity.ts'));
const containers = ['.wheelhouse-runs', '.wheelhouse-build'];
const valid = [id, id+'-build', id+'_x'];
const unknown = [id+'1', id+'.11', id+'a', id+'.pre-reboot'];
for (const container of containers) {
  for (const name of [...valid,...unknown]) {
    const dir=path.join(root,container,name);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'KEEP'),'owned scratch\n');
    api.recordCleanupScratch(root,dir,valid.includes(name)?id:name);
  }
}
function run(label:string,args:string[]) {
  const result=completedCommand('bun',[path.join(root,'seats/prune.ts'),...args],{cwd:root,env,timeout:30000} as any);
  fs.writeFileSync(path.join(root,label+'.json'),JSON.stringify(result));
  console.log(label+' exit='+result.status);
  if(result.stderr)console.log(label+' stderr:\n'+result.stderr);
  assert(!result.error&&!result.signal,String(result.error));assert.equal(result.status,0,result.stderr);
  return result;
}
const scan=run('scan',['scan','--root',root,'--format','json']);
const rows=JSON.parse(scan.stdout);assert(Array.isArray(rows));
assert(scan.stderr.includes('UNVERIFIED bead statuses open')&&scan.stderr.includes('fixture: open status list unavailable'));
for (const container of containers) {
  for (const name of unknown) {
    const dir=path.join(root,container,name);assert(fs.statSync(dir).isDirectory());
    const hits=rows.filter(r=>r.path===dir);
    console.log(JSON.stringify({folder:container+'/'+name,rows:hits}));
    assert(!hits.some(r=>r.category==='run-scratch'&&r.safe===1),'longer id must not become safe scratch of shorter closed id');
    assert(!hits.some(r=>r.reason===`scratch belongs to closed bead ${id}`),'longer id must not be attributed to shorter closed id');
  }
  for (const name of valid) {
    const dir=path.join(root,container,name),row=rows.find(r=>r.path===dir);
    assert(row,'closed-task scratch row must exist');
    console.log(JSON.stringify({folder:container+'/'+name,category:row.category,safe:row.safe,reason:row.reason}));
    assert.equal(row.category,'run-scratch');assert.equal(row.safe,1);assert.equal(row.reason,`scratch belongs to closed bead ${id}`);
  }
}
console.log('PASS prefix-overlap: a longer task id is not attributed to a shorter closed one');
const cleanup=run('cleanup',['cleanup','--root',root,'--bead',id]);
console.log('cleanup stdout:\n'+cleanup.stdout);
for(const container of containers) {
  for(const name of valid)assert(!fs.existsSync(path.join(root,container,name)),'closed-task exact/dash/underscore scratch must be removed');
  for(const name of unknown)assert.equal(fs.readFileSync(path.join(root,container,name,'KEEP'),'utf8'),'owned scratch\n');
}
const calls=fs.readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));
assert(calls.length&&calls.every(args=>args[0]==='list'),'only graph reads performed');
assert(calls.some(args=>args.includes('--status=open'))&&calls.some(args=>args.includes('--status=closed')));
console.log('PASS prefix-compatibility: exact, dash and underscore scratch scanned safe and automatically removed; unrelated scratch kept');
