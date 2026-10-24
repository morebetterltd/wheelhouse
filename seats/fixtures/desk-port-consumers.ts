import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { completedCommand } from '../completed-command';
const [fixture, template] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, '.wheelhouse-selftest-fixture')).isFile());
const root = path.join(fixture, 'port-consumers'); fs.mkdirSync(root);
const fds = ['out', 'err'].map(x => fs.openSync(path.join(root, 'holder.' + x), 'wx', 0o600));
const holder = spawn('node', ['-e', 'console.log("READY");process.stdin.resume();'], { cwd: root, stdio: ['pipe', fds[0], fds[1]] });
let holderClosed = false; const joined = new Promise<any>((resolve, reject) => { holder.on('error', reject); holder.on('close', (code, signal) => { holderClosed = true; resolve({ code, signal }); }); });
while (!fs.readFileSync(path.join(root, 'holder.out'), 'utf8').includes('READY')) { assert(!holderClosed, 'owned native holder setup'); await Bun.sleep(25); }
const cases: [string, string | null][] = [['valid', 'http://127.0.0.1:65530/needs\n'], ['missing', null], ['empty', ''], ['partial', 'http://127.0.0.1:'], ['garbage', 'garbage\n'], ['scheme', 'ftp://127.0.0.1:65530/needs\n'], ['route', 'http://127.0.0.1:65530/need\n'], ['directory', null]];
const results: any[] = [];
try {
  for (const consumer of ['daemon-start', 'digest', 'cockpit']) {
    const project = path.join(root, consumer); fs.mkdirSync(project); fs.cpSync(path.join(template, 'seats'), path.join(project, 'seats'), { recursive: true });
    const run = path.join(project, 'seats/run'); fs.rmSync(run, { recursive: true, force: true }); fs.mkdirSync(run);
    fs.mkdirSync(path.join(project, 'bin')); fs.mkdirSync(path.join(project, 'wheelhouse')); fs.writeFileSync(path.join(project, 'wheelhouse/.template-source'), 'namespace=port-consumer\n');
    fs.writeFileSync(path.join(project, 'bin/bd'), '#!/usr/bin/env bash\nprintf "[]\\n"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(project, 'bin/tmux'), '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.TMUX_CALLS,JSON.stringify({args:process.argv.slice(2),desk:process.env.DESK_URL??null})+"\\n");process.exit(0);\n', { mode: 0o755 });
    for (const [name, raw] of cases) {
      const file = path.join(run, 'desk.port'), ledger = path.join(project, 'seats/needs.jsonl'), tmux = path.join(project, 'tmux.calls');
      fs.rmSync(file, { recursive: true, force: true }); fs.rmSync(tmux, { force: true });
      fs.rmSync(ledger, { force: true }); fs.rmSync(path.join(run, 'digest.last'), { force: true });
      if (name === 'directory') fs.mkdirSync(file); else if (raw !== null) fs.writeFileSync(file, raw);
      fs.writeFileSync(path.join(run, 'desk.pid'), String(holder.pid) + '\n');
      const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '';
      const env = { ...process.env, PATH: path.join(project, 'bin') + path.delimiter + process.env.PATH, WHEELHOUSE_COCKPIT_DAEMONS: '0', WHEELHOUSE_DIGEST_ROOT: project, WHEELHOUSE_NEEDS_ROOT: project, TMUX_CALLS: tmux };
      const command = consumer === 'daemon-start' ? [process.execPath, path.join(project, 'seats/daemon-start.ts'), project, 'desk'] : consumer === 'digest' ? [process.execPath, path.join(project, 'seats/digest.ts'), '--notify', '--since', '2026-09-21T00:00:00Z', '--until', '2026-09-22T00:00:00Z'] : ['bash', path.join(project, 'seats/cockpit.sh'), 'port-consumer'];
      const native = completedCommand(command[0], command.slice(1), { cwd: project, env });
      const result = { consumer, name, raw, command, code: native.status, signal: native.signal, error: native.error ? String(native.error) : null, stdout: native.stdout, stderr: native.stderr, ledgerBefore: before, ledgerAfter: fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '', tmux: fs.existsSync(tmux) ? fs.readFileSync(tmux, 'utf8') : '' };
      results.push(result); console.log('DESK_PORT_CONSUMER ' + JSON.stringify(result));
      assert.equal(result.error, null, 'native invocation setup'); assert.equal(result.signal, null, 'native consumer must complete');
      if (name === 'valid' || name === 'missing') {
        assert.equal(result.code, 0, consumer + ' accepts ' + name);
        if (consumer === 'daemon-start') assert(result.stdout.includes(name === 'valid' ? 'already running' : 'still starting'), 'readiness vs missing publication stays distinct');
        if (consumer === 'digest') { assert(result.ledgerAfter.length > before.length, 'real notify ledger append'); assert.equal(result.ledgerAfter.slice(before.length).includes('Full page: http://127.0.0.1:65530/digest'), name === 'valid'); }
        if (consumer === 'cockpit') { const calls = result.tmux.trim().split('\n').map(JSON.parse); assert(calls.length); assert(calls.every(x => x.desk === (raw?.trim() ?? '')), 'actual cockpit export preserves complete URL or genuine missing'); }
      } else {
        assert(result.code !== 0, consumer + ' must reject visible ' + name + ', never silently missing');
        assert(name === 'directory' ? result.stderr.includes('EISDIR') : result.stderr.includes('Invalid desk.port:'), 'exact malformed/read-error cause, not incidental failure');
        assert.equal(result.ledgerAfter, before, 'rejected reader must not notify'); assert.equal(result.tmux, '', 'rejected cockpit must not enter session');
      }
    }
  }
  console.log('desk-port-consumers: 24 native outcomes; valid/missing preserved, malformed/read failures rejected by all three readers');
} finally {
  holder.stdin!.end(); const native = await joined; fds.forEach(fd => fs.closeSync(fd)); console.log('DESK_PORT_HOLDER_JOIN ' + JSON.stringify(native)); assert.equal(native.code, 0); assert.equal(native.signal, null);
  if (process.env.WHEELHOUSE_DESK_PORT_EVIDENCE) { fs.mkdirSync(process.env.WHEELHOUSE_DESK_PORT_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.WHEELHOUSE_DESK_PORT_EVIDENCE, 'consumers.json'), JSON.stringify(results, null, 2)); }
}
