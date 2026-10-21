// Native bd redirect protocol captured before this fixture was authored:
// bd where --json -> {path:<graph>/.beads, redirected_from:<repo>/.beads,
// database_path:<graph>/.beads/embeddeddolt, prefix:"private", schema_version:1}.
// Only claim text/model output are stubbed. Git, bd metrics/init/where/create,
// dispatcher scratch worktrees and the sweep runner are real and isolated.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const [root, bd] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(bd).isFile());
const original = fs.readFileSync(path.join(root, "runtime/seats/verify.ts"), "utf8");
const start = original.indexOf('    const sweepBeads = path.join(scratchCwd, ".beads");');
const end = original.indexOf('    const located = spawnSync(realBd, ["where", "--json"]', start);
assert(start > 0 && end > start, "exclusive graph exposure block exists");
const removed = original.slice(0, start) + '    fs.symlinkSync(graphDir, path.join(scratchCwd, ".beads"), "dir");\n' + original.slice(end);
const payload = `import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const cwd=process.cwd(),run=(bin,args,env=process.env,dir=cwd)=>execFileSync(bin,args,{encoding:'utf8',env,cwd:dir}).trim();
assert(fs.statSync('.git').isFile(),'real detached linked worktree');
assert.equal(process.env.BEADS_DIR,undefined,'no process-wide graph override');
assert.equal(process.env.BEADS_DB,undefined);
const graph=JSON.parse(run('bd',['where','--json'])).path;
assert.equal(fs.realpathSync(graph),fs.realpathSync(path.join(cwd,'.wheelhouse-sweep-graph/.beads')));
assert.equal(run('git',['diff','HEAD','--','.beads']),'','tracked graph bytes/modes unchanged during sweep');
const made=JSON.parse(run('bd',['create','private sweep subject','--json']));assert(made.id.startsWith('verify-sweep-'));
fs.mkdirSync('plain/subdir',{recursive:true});
assert.equal(JSON.parse(run('bd',['-C','plain/subdir','where','--json'])).path,graph);
const nested=path.join(cwd,'nested');fs.mkdirSync(nested);
run('git',['-C',nested,'init','-q','-b','main']);
// As in selftest_scratch_graph: bind initialization to its own primary repo,
// never let bd init borrow an ancestor graph before this fixture exists.
const nestedEnv={...process.env,PWD:nested};
run('bd',['init','--non-interactive','--skip-agents','-p','nested'],{...nestedEnv,BEADS_DIR:path.join(nested,'.beads')},nested);
const own=JSON.parse(run('bd',['where','--json'],nestedEnv,nested)).path;
assert.equal(fs.realpathSync(own),fs.realpathSync(path.join(nested,'.beads')),'nested graph not hijacked');
assert.equal(JSON.parse(run('bd',['where','--json'],{...process.env,BEADS_DIR:own})).path,own,'explicit fixture graph not hijacked');
run('bd',['create','nested subject','--json'],nestedEnv,nested);
assert.equal(JSON.parse(run('bd',['list','--json'])).length,1,'nested write did not reach sweep graph');
assert.equal(run('git',['diff','HEAD','--','.beads']),'');
fs.writeFileSync(process.env.GRAPH_CASE+'/payload.json',JSON.stringify({cwd,tip:run('git',['rev-parse','HEAD']),graph,nested:own,trackedClean:true}));
console.log('PASS native scratch graph: tracked bytes intact, private write, plain subdirectory, nested repo and explicit BEADS_DIR independent');
`;
for (const mode of ["absent", "tracked", "umbrella-cli", "removed-tracked", "removed-umbrella-cli"]) {
  const dir = path.join(root, mode), project = path.join(dir, "umbrella"), bin = path.join(dir, "bin"), tmp = path.join(dir, "tmp"), home = path.join(dir, "home");
  for (const d of [project, bin, tmp, home]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(root, "runtime/seats"), path.join(project, "seats"), { recursive: true });
  for (const f of fs.readdirSync(path.join(project, "seats"))) if (f.endsWith(".selftest.sh")) fs.unlinkSync(path.join(project, "seats", f));
  const verify = path.join(project, "seats/verify.ts");
  if (mode.startsWith("removed-")) fs.writeFileSync(verify, removed);
  fs.writeFileSync(path.join(project, "seats/graph-payload.ts"), payload);
  fs.writeFileSync(path.join(project, "seats/graph.selftest.sh"), '#!/usr/bin/env bash\nset -eu\nbun seats/graph-payload.ts\n');
  fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
 show) printf '## Done\\nUmbrella graph isolation works.\\n'; exit 0 ;;
 comments) printf '[]\\n'; exit 0 ;;
esac
exec ${JSON.stringify(bd)} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pi"), '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":"VERDICT: APPROVE\\nPUSH: NOT CONSIDERED\\n"}}\'\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: tmp, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GRAPH_CASE: dir, WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(dir, "fixture.lock"), WHEELHOUSE_SKIP_REAL_PI: "1" };
  for (const key of Object.keys(env)) if (/^(BEADS_|BD_|DOLT_|GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$)/.test(key)) delete env[key];
  delete env.WHEELHOUSE_SELFTEST_BD_ROOT; delete env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN;
  let sequence = 0;
  function cmd(bin: string, args: string[], cwd = project, expected = 0) {
    const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
    fs.writeFileSync(path.join(dir, `command-${++sequence}.json`), JSON.stringify({ bin, args, cwd, code: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }));
    if (r.status !== expected) {
      const logs = path.join(project, "seats/verdicts/sweeps");
      if (fs.existsSync(logs)) for (const f of fs.readdirSync(logs)) console.error("FAILED PAYLOAD " + mode + "\n" + fs.readFileSync(path.join(logs, f), "utf8").slice(-16000));
    }
    assert.equal(r.signal, null); assert(!r.error, String(r.error)); assert.equal(r.status, expected, r.stdout + r.stderr); return r;
  }
  const git = (...args: string[]) => cmd("git", args).stdout.trim();
  cmd(bd, ["metrics", "off"], dir);
  git("init", "-q", "-b", "main");
  // A real umbrella shape: configured product is a separate ignored repo;
  // --repo . must still review the umbrella, not that product's different tip.
  const product = path.join(project, "product"); fs.mkdirSync(product);
  cmd("git", ["init", "-q", "-b", "main"], product);
  cmd("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "independent product"], product);
  fs.writeFileSync(path.join(project, ".gitignore"), "product/\n");
  fs.mkdirSync(path.join(project, "wheelhouse")); fs.writeFileSync(path.join(project, "wheelhouse/.template-source"), "product-repo=product\n");
  const tracked: Record<string, string> = { ".beads/config.yaml": "issue-prefix: original\n", ".beads/README.md": "Tracked umbrella graph documentation.\n", ".beads/.gitignore": "dolt/\nembeddeddolt/\n", ".beads/hooks/pre-commit": "tracked hook sentinel\n" };
  if (mode !== "absent") for (const [f, s] of Object.entries(tracked)) { fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true }); fs.writeFileSync(path.join(project, f), s); }
  fs.mkdirSync(path.join(project, "contracts")); fs.writeFileSync(path.join(project, "contracts/REVIEWER.md"), "Scripted test reviewer; no real model.\n");
  const author = path.join(dir, "author"), reviewer = path.join(dir, "reviewer"); fs.mkdirSync(author); fs.mkdirSync(reviewer); fs.writeFileSync(path.join(reviewer, "auth.json"), '{"fixture":true}\n');
  fs.writeFileSync(path.join(project, "seats/seats.json"), JSON.stringify({ seats: { author: { role: "worker", account: { dir: author } }, reviewer: { role: "reviewer", harness: "pi", provider: "openai", model: "fixture", account: { dir: reviewer } } } }));
  git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "umbrella graph fixture");
  const tip = git("rev-parse", "HEAD"), before = git("status", "--porcelain=v1"), worktrees = git("worktree", "list", "--porcelain"); assert.equal(before, "");
  const driver = path.join(dir, "driver.ts");
  fs.writeFileSync(driver, `import {runDispatcherFullSweep} from ${JSON.stringify(verify)};const r=await runDispatcherFullSweep(${JSON.stringify(project)},${JSON.stringify(tip)},${JSON.stringify(path.join(bin, "bd"))},process.env.PATH!);console.log('RESULT '+JSON.stringify(r));process.exitCode=r.rc===0&&!r.error?0:1;`);
  const cli = mode.endsWith("umbrella-cli"), bad = mode.startsWith("removed-");
  const r = cmd("bun", cli ? [verify, "graph-fixture", "main", "author", "reviewer", "--repo", "."] : [driver], project, bad ? 1 : 0);
  const logs = fs.readdirSync(path.join(project, "seats/verdicts/sweeps")); assert.equal(logs.length, 1);
  const log = fs.readFileSync(path.join(project, "seats/verdicts/sweeps", logs[0]), "utf8");
  assert.equal(git("rev-parse", "HEAD"), tip); assert.equal(git("worktree", "list", "--porcelain"), worktrees);
  assert.equal(fs.readdirSync(tmp).length, 0, "both sweep and reviewer scratch are removed");
  assert.equal(git("diff", "HEAD", "--", ".beads"), "");
  if (mode !== "absent") for (const [f, s] of Object.entries(tracked)) assert.equal(fs.readFileSync(path.join(project, f), "utf8"), s);
  if (bad) {
    assert.match(log, /EEXIST: file already exists, symlink/); assert(!fs.existsSync(path.join(dir, "payload.json"))); assert(!fs.existsSync(path.join(project, "seats/verdicts/graph-fixture.md")));
    console.log(`PASS fix removed ${mode}: native1 EEXIST before payload; no completed review; tracked tree unchanged and scratch joined`);
  } else {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "payload.json"), "utf8")); assert.equal(data.tip, tip); assert(data.trackedClean);
    assert(log.includes(`preparedTip=${tip}\nscratchGraph=isolated nested repository\n`)); assert(log.includes(`finalTip=${tip}\n\nrc=0\n`)); assert.match(log, /selftest-sweep: PASS \(1 suite\(s\), [0-9]+s\)/);
    if (cli) { assert.match(r.stdout, /VERDICT: APPROVE/); const receipt = fs.readFileSync(path.join(project, "seats/verdicts/graph-fixture.md"), "utf8"); assert(receipt.includes(`- branch-repo: ${project}\n- tip: ${tip}`)); assert(receipt.includes(`## Dispatcher full-sweep result\n\n- tip: ${tip}\n- command: bash seats/selftest-sweep.sh\n- rc: 0\n- log: ${path.join(project, "seats/verdicts/sweeps", logs[0])}\n`)); }
    console.log(`PASS ${mode}: native0 pinned dispatcher sweep; tracked bytes/modes unchanged; private root/subdirectory graph, independent nested/explicit graphs; scratch removed${cli ? '; actual umbrella --repo . review receipt' : ''}`);
  }
}
