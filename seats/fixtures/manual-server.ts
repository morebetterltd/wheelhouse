// Real HTTP consumer journeys against owned loopback-only fixture processes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';
const [source, fixture] = process.argv.slice(2);
assert(fs.lstatSync(fixture + '/.wheelhouse-selftest-fixture').isFile());
const evidence = process.env.WHEELHOUSE_MANUAL_SERVER_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const rows: any[] = [], actors: ReturnType<typeof start>[] = []; let sequence = 0;
function command(file: string, args: string[]) {
  const r = completedCommand(file, args, { cwd: fixture });
  const row = { file, args, code: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr };
  rows.push(row); const name = String(++sequence).padStart(3, '0') + '.json';
  fs.writeFileSync(fixture + '/' + name, JSON.stringify(row, null, 2)); if (evidence) fs.writeFileSync(evidence + '/' + name, JSON.stringify(row, null, 2), { flag: 'wx' });
  assert.equal(row.signal, null); assert.equal(row.error, null); return row;
}
function start(name: string, port: string, extra = '', broken = false) {
  const dir = path.join(fixture, name); fs.mkdirSync(dir); const program = dir + '/server.ts'; fs.copyFileSync(source, program);
  const out = fs.openSync(dir + '/stdout', 'wx'), err = fs.openSync(dir + '/stderr', 'wx');
  const child = spawn('bun', [program], { cwd: dir, env: { ...process.env, PORT: port, EXTRA_FEATURES: extra, BROKEN_LAUNCH: broken ? '1' : '0' }, stdio: ['ignore', out, err] });
  fs.closeSync(out); fs.closeSync(err); assert(child.pid && child.pid > 1);
  let closed: any = null; const done = new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = { code, signal }; resolve(closed); }); });
  const actor = { child, dir, program, done, base: '', identity: '', get closed() { return closed; } }; actors.push(actor); return actor;
}
type Actor = ReturnType<typeof start>;
function ownedIdentity(a: Actor) {
  const r = command('ps', ['-ww', '-p', String(a.child.pid), '-o', 'pid=,ppid=,uid=,lstart=,command=']);
  assert.equal(r.code, 0); assert.equal(r.stderr, ''); assert.match(r.stdout, new RegExp('^\\s*' + a.child.pid + '\\s+' + process.pid + '\\s+' + process.getuid!() + '\\s+'));
  assert(r.stdout.includes(a.program)); return r.stdout;
}
async function appeared(a: Actor) {
  while (!a.closed && !fs.readFileSync(a.dir + '/stdout', 'utf8').includes('\n')) await Bun.sleep(10);
  if (a.closed) return;
  const out = fs.readFileSync(a.dir + '/stdout', 'utf8'); assert.match(out, /^listening on http:\/\/127\.0\.0\.1:\d+\n$/);
  a.base = out.trim().slice('listening on '.length); a.identity = ownedIdentity(a);
}
async function stop(a: Actor) {
  if (!a.closed) { const identity = ownedIdentity(a); if (a.identity) assert.equal(identity, a.identity); assert.equal(ownedIdentity(a), identity); assert(a.child.kill('SIGTERM')); }
  return a.done;
}
function request(a: Actor, name: string, route: string, options: string[] = []) {
  assert(a.base && !a.closed, 'healthy native instance must exist before HTTP measurement');
  const prefix = a.dir + '/' + name, response = command('curl', ['-sS', '-D', prefix + '.headers', '-o', prefix + '.body', '-w', '%{http_code}', ...options, a.base + route]);
  assert.equal(response.code, 0); assert.match(response.stdout, /^\d{3}$/); assert.equal(response.stderr, '');
  const body = fs.readFileSync(prefix + '.body', 'utf8'), headers = fs.readFileSync(prefix + '.headers', 'utf8');
  const result = { name, route, code: Number(response.stdout), body, headers };
  if (evidence) fs.writeFileSync(evidence + '/' + path.basename(a.dir) + '-' + name + '.json', JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}
let failure: string | null = null;
const facts: any = { sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
try {
  const baseline = start('baseline', '0'); await appeared(baseline); assert(!baseline.closed, 'INCOMPLETE: baseline launch failed before readiness');
  facts.baselineIdentity = baseline.identity; facts.endpoint = baseline.base;
  const home = request(baseline, 'home', '/'); assert.equal(home.code, 200); assert.match(home.body, /<h1>Five features<\/h1>/);
  for (const route of ['/', '/health', '/echo', '/counter', '/about']) assert(home.body.includes('href="' + route + '"'), 'HOME_ENTRY_MISSING ' + route);
  const health = request(baseline, 'health', '/health'); assert.equal(health.code, 200); assert.equal(health.body, '{"ok":true}');
  const form = request(baseline, 'echo-form', '/echo'); assert.equal(form.code, 200); assert(form.body.includes('name="text"') && form.body.includes('method="post"'));
  const echo = request(baseline, 'echo-post', '/echo', ['--data-urlencode', 'text=Hello <reader> & friends']); assert.equal(echo.code, 200); assert(echo.body.includes('<output id="echo">Hello &lt;reader&gt; &amp; friends</output>'), 'ECHO_READBACK_WRONG');
  const count = (name: string, value: number) => { const x = request(baseline, name, '/counter'); assert.equal(x.code, 200); assert(x.body.includes(`<output id="count">${value}</output>`), 'COUNTER_READBACK_WRONG'); };
  count('counter-before', 0);
  for (const step of [1, 2]) { const x = request(baseline, 'increment-' + step, '/counter/increment', ['-X', 'POST']); assert.equal(x.code, 303); assert.match(x.headers, /^location: .*\/counter\r?$/im); count('counter-' + step, step); }
  count('counter-unchanged', 2);
  const about = request(baseline, 'about', '/about'); assert.equal(about.code, 200); assert.match(about.body, /A small verification fixture with five public features\./);
  const hidden = request(baseline, 'hidden', '/reports'); assert.equal(hidden.code, 404, 'EXTRA_FEATURE_VISIBLE_WITHOUT_ENABLE');
  console.log('PASS fixture five baseline features and counter end-state2');
  const port = new URL(baseline.base).port; facts.baselineExit = await stop(baseline);
  const extra = start('extra', port, 'reports'); await appeared(extra); assert(!extra.closed, 'INCOMPLETE: requested test port could not be rebound'); assert.equal(new URL(extra.base).port, port);
  const optional = request(extra, 'enabled', '/reports'); assert.equal(optional.code, 200, 'ENABLED_EXTRA_FEATURE_MISSING');
  facts.extraExit = await stop(extra); facts.extraStatuses = [hidden.code, optional.code]; console.log('PASS fixture hidden route404 and enabled route200 on requested port');
  const broken = start('broken', '0', '', true); await appeared(broken);
  if (!broken.closed) { facts.brokenIgnored = { ready: broken.base, exit: await stop(broken) }; assert.fail('BROKEN_LAUNCH_IGNORED: fixture listened instead of refusing'); }
  const exit = await broken.done; assert.deepEqual(exit, { code: 1, signal: null }); assert.equal(fs.readFileSync(broken.dir + '/stdout', 'utf8'), ''); assert.equal(fs.readFileSync(broken.dir + '/stderr', 'utf8'), 'fixture: launch broken on purpose\n');
  facts.brokenExit = exit; console.log('PASS fixture broken launch1 with exact diagnostic');
} catch (e: any) { failure = String(e.message ?? e); console.error('FAIL fixture: ' + failure); }
finally {
  for (const actor of actors) { const exit = await stop(actor); const data = { name: path.basename(actor.dir), exit, stdout: fs.readFileSync(actor.dir + '/stdout', 'utf8'), stderr: fs.readFileSync(actor.dir + '/stderr', 'utf8') }; if (evidence) fs.writeFileSync(evidence + '/' + data.name + '-exit.json', JSON.stringify(data, null, 2), { flag: 'wx' }); }
  const result = { ...facts, failure, joinedActors: actors.length, nativeCommands: sequence }; fs.writeFileSync(fixture + '/results.json', JSON.stringify(result, null, 2)); if (evidence) fs.writeFileSync(evidence + '/results.json', JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log('MANUAL_SERVER_RESULT ' + JSON.stringify(result));
}
if (failure) process.exitCode = 1;
