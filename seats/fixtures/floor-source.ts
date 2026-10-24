// Execute the actual floor suite with source-distinct, valid alternate subjects.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';

const [source, fixture, subject] = process.argv.slice(2);
assert(fs.statSync(fixture + '/.wheelhouse-selftest-fixture').isFile());
const realBun = Bun.which('bun'), realTmux = Bun.which('tmux');
assert(realBun && realTmux && Bun.which('expect'), 'native Bun/tmux/Expect required for every source leg');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = fs.readFileSync(source + '/seats/floor.ts', 'utf8');
const anchor = 'render();\nsetInterval(render, 500);';
assert.equal(original.split(anchor).length, 2, 'one-frame fault must change exactly the interactive producer');
const evidence = process.env.WHEELHOUSE_FLOOR_SOURCE_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
let failures = 0;

for (const fault of [false, true]) {
  const name = fault ? 'one-frame' : 'marked', root = fixture + '/' + name;
  for (const dir of ['runtime/seats', 'bin', 'home', 'tmp', 'alternate source']) fs.mkdirSync(root + '/' + dir, { recursive: true });
  for (const item of fs.readdirSync(source + '/seats', { withFileTypes: true })) {
    const from = source + '/seats/' + item.name, to = root + '/runtime/seats/' + item.name;
    if (item.isFile() && /\.(ts|sh)$/.test(item.name)) fs.copyFileSync(from, to);
    else if (item.isDirectory() && ['drivers', 'transports', 'fixtures'].includes(item.name)) fs.cpSync(from, to, { recursive: true });
  }
  const program = root + '/runtime/seats/floor.selftest.sh';
  fs.copyFileSync(subject, program);
  // RUN_PATH deliberately retains the Bun directory. Keep native tmux on that
  // same private directory, translating ONLY -L addresses to owned relative -S
  // endpoints: Darwin's absolute AF_UNIX path limit is shorter than task roots.
  fs.writeFileSync(root + '/bin/bun', '#!/usr/bin/env bash\nexec ' + JSON.stringify(realBun) + ' "$@"\n', { mode: 0o755 });
  fs.writeFileSync(root + '/bin/tmux', '#!/usr/bin/env bash\nif [ "${1:-}" = -L ]; then socket="$2"; shift 2; exec ' + JSON.stringify(realTmux) + ' -S "./$socket.sock" "$@"; fi\nexec ' + JSON.stringify(realTmux) + ' "$@"\n', { mode: 0o755 });
  const recordsFile = root + '/executions.jsonl';
  const prefix = `import { appendFileSync as recordSelectedSource, readFileSync as readSelectedSource } from 'node:fs';\nimport { createHash as hashSelectedSource } from 'node:crypto';\nimport { fileURLToPath as selectedSourcePath } from 'node:url';\nrecordSelectedSource(${JSON.stringify(recordsFile)}, JSON.stringify({marker:${JSON.stringify(name)},file:selectedSourcePath(import.meta.url),sha256:hashSelectedSource('sha256').update(readSelectedSource(new URL(import.meta.url))).digest('hex'),pid:process.pid,args:process.argv.slice(2),stdinTTY:!!process.stdin.isTTY,stdoutTTY:!!process.stdout.isTTY,tmux:process.env.TMUX||null})+'\\n');\n`;
  const selected = prefix + (fault ? original.replace(anchor, 'render();\nif (!process.stdin.isTTY) process.exit(0); // planted single-frame interactive product fault\nsetInterval(render, 500);') : original);
  const alternate = root + '/alternate source/requested floor.ts'; fs.writeFileSync(alternate, selected);
  // Absolute source and caller-relative source (both with spaces) are distinct
  // supported invocation configurations. No helper imports are stubbed/removed.
  const argument = fault ? 'alternate source/requested floor.ts' : alternate;
  // Native macOS Expect overflows its rcfile-path buffer for deeply nested
  // absolute HOME. A relative private home retains isolation without changing
  // any assertions, native program, startup flags or resource budgets.
  const env = { ...process.env, PATH: root + '/bin:' + process.env.PATH, HOME: 'home', XDG_CONFIG_HOME: root + '/home/.config', TMPDIR: root + '/tmp', SHELL: '/bin/bash' };
  delete env.TMUX; delete env.TMUX_PANE;
  const validityProgram = root + '/runtime/seats/selected-validity.ts';
  fs.writeFileSync(validityProgram, selected);
  const validity = completedCommand(realBun, [validityProgram, '--once'], { cwd: root, env });
  const validityExecutions = fs.existsSync(recordsFile) ? fs.readFileSync(recordsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  assert.equal(validity.status, 0, 'INCOMPLETE: alternate must import and render with the real runtime BEFORE source selection is measured');
  assert.equal(validity.signal, null); assert(!validity.error); assert.match(validity.stdout, /no seats/);
  assert.equal(validityExecutions.length, 1); assert.equal(validityExecutions[0].sha256, sha(selected));
  const preflight = { code: validity.status, signal: validity.signal, stdout: validity.stdout, stderr: validity.stderr, executions: validityExecutions };
  fs.unlinkSync(recordsFile); // the direct validity probe is NOT suite-selection evidence
  const out = fs.openSync(root + '/stdout', 'wx'), err = fs.openSync(root + '/stderr', 'wx');
  // Drain native pipes into original byte files. Child close observes stream
  // EOF too, including the suite's asynchronous write-time scrubbers.
  const child = spawn('bash', [program, argument], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (fd: number, bytes: Buffer) => { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); };
  child.stdout!.on('data', bytes => write(out, bytes));
  child.stderr!.on('data', bytes => write(err, bytes));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  fs.closeSync(out); fs.closeSync(err);
  const stdout = fs.readFileSync(root + '/stdout', 'utf8'), stderr = fs.readFileSync(root + '/stderr', 'utf8');
  const executions = fs.existsSync(recordsFile) ? fs.readFileSync(recordsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const expectedCanary = (needle: string) => sha(selected.split('\n').filter(line => !line.includes(needle)).join('\n'));
  let failure: string | null = null;
  const commands: any[] = [];
  try {
    assert.equal(exit.signal, null, 'source suite must exit natively, not containment');
    if (!executions.length) {
      assert.equal(exit.code, 0, 'INCOMPLETE: unmarked default world itself failed before selection could be judged');
      assert.match(stdout, /floor\.ts works on this machine\./);
    }
    assert(executions.length, 'REQUESTED_SOURCE_NOT_EXECUTED: suite ignored alternate source');
    assert(executions.every(row => row.marker === name), 'only the requested marker may produce records');
    const main = executions.filter(row => row.file.endsWith('/proj/seats/floor.ts'));
    const empty = executions.filter(row => row.file.endsWith('/empty/seats/floor.ts'));
    assert(main.some(row => row.args.includes('--once')), 'main one-frame renders select requested source');
    assert(empty.some(row => row.args.includes('--once')), 'EMPTY_SOURCE_NOT_EXECUTED');
    assert(main.some(row => !row.args.includes('--once') && !row.stdinTTY && !row.tmux), 'REPAINT_SOURCE_NOT_EXECUTED');
    assert(main.some(row => !row.args.includes('--once') && row.stdinTTY && !row.tmux), 'PTY_SOURCE_NOT_EXECUTED');
    assert(main.filter(row => row.stdinTTY && row.tmux).length >= 2, 'TMUX_SOURCE_NOT_EXECUTED: initial and repaired panes');
    for (const row of [...main, ...empty]) assert.equal(row.sha256, sha(selected), 'installed requested source bytes');
    for (const [file, needle] of [['floor-sab1.ts', 'PROCESS GONE'], ['floor-sab2.ts', 'no event log yet']]) {
      const rows = executions.filter(row => row.file.endsWith('/' + file));
      assert(rows.length, 'CANARY_SOURCE_NOT_EXECUTED ' + file);
      assert(rows.every(row => row.sha256 === expectedCanary(needle)), 'canary must derive selected source, with native dependencies');
    }
    assert(!/Cannot find module|ModuleNotFound|SyntaxError|error: Could not resolve/.test(stdout + stderr), 'missing-runtime/parser failures get no control credit');
    const beforeFault = stdout.split('phase 5: repaint')[0];
    assert(beforeFault.includes('phase 4: missing pieces'), 'healthy render and empty setup reached before fault');
    assert(!/  FAIL /.test(beforeFault), 'all pre-fault feature assertions healthy');
    assert.equal(exit.code, fault ? 1 : 0, fault ? 'ONE_FRAME_FAULT_NOT_REJECTED' : 'marked alternate preserves default behavior');
    if (fault) {
      assert.match(stdout, /FAIL\s+floor did not publish a second repaint before exit\/safety cap/);
      assert.match(stdout, /FAIL\s+multi-frame capture did not show repeated in-place repaint sequences \(count=1\)/);
    } else assert.match(stdout, /floor\.ts works on this machine\./);
  } catch (error) { failure = String(error); failures++; }
  finally {
    // These endpoints can only have been created beneath this new private cwd.
    // Never sweep a shared tmux directory or adopt an unknown replacement.
    const file = root + '/whfloor' + child.pid + '.sock';
    if (fs.existsSync(file)) {
      const state = fs.lstatSync(file); assert(state.isSocket() && !state.isSymbolicLink());
      assert.equal(state.uid, process.getuid!());
      const r = completedCommand(realTmux, ['-S', './whfloor' + child.pid + '.sock', 'kill-server'], { cwd: root });
      commands.push({ args: ['-S', './whfloor' + child.pid + '.sock', 'kill-server'], code: r.status, signal: r.signal, error: r.error ? String(r.error) : null, stdout: r.stdout, stderr: r.stderr });
      assert.equal(r.signal, null); assert(!r.error); assert(r.status === 0 || (r.status === 1 && /no server running/.test(r.stderr)));
      const current = fs.lstatSync(file); assert.equal(current.dev, state.dev); assert.equal(current.ino, state.ino);
      fs.unlinkSync(file);
    }
  }
  const result = { name, fault, argument, selectedSha256: sha(selected), executedSelftestSha256: sha(fs.readFileSync(program)), defaultFloorSha256: sha(original), preflight, exit, executions, stdout, stderr, failure, cleanupCommands: commands };
  fs.writeFileSync(root + '/result.json', JSON.stringify(result, null, 2));
  if (evidence) fs.writeFileSync(evidence + '/' + name + '.json', JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log((failure ? 'FAIL' : 'PASS') + ' floor-source ' + name + ': ' + (failure ?? 'native subject selection, runtime imports, all fixture legs and intended oracle verified'));
}
assert.equal(failures, 0, 'floor source-selection behavior failed');
