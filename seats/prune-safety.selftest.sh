#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/fixtures/prune-fixture.sh"

# Core tier. Owned phases (the union of both suites is the original list):
# - preflight: TMPDIR inside another git repo is not touched
# - D6/D7 automatic cleanup identity (fresh allocations only)
# - closed-task scratch inside seat worktrees (fresh allocations only)
# - reviewed-row deletion safety (fresh allocations only)
# - prune --yes refuses while a rostered seat is mid-turn
# - prune --yes restores write permission before rm action
# - prune --yes rechecks live seat anchors from reviewed scan files
# - prune acts only on safe selected rows
# - ISC-59/60 seat anchors and ISA-named worktrees are never removed
# - ISC-61 lsof unavailable removes nothing
# - ISC-64 symlinked entries and paths with spaces
# - ISC-62 interactive .worktrees/ checkouts are never touched

prune_fixture_start "$@"
selftest_install_cleanup_traps cleanup

if [ "${WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK:-0}" = 1 ]; then
  # No bd database, lsof inventory, cleanup corpus or second nested run here.
  mkdir -p "$FIX/uninitialized" || exit 2
  git -C "$FIX/uninitialized" rev-parse --show-toplevel > "$FIX/discovery.out" 2> "$FIX/discovery.err"
  DISCOVERY_RC=$?
  if [ "$DISCOVERY_RC" != 128 ] || [ -s "$FIX/discovery.out" ]; then
    fail "nested Git discovery escaped fixture boundary (rc=$DISCOVERY_RC)"; exit 1
  fi
  prune_init_git_fixture || exit 2
  [ -d "$ROOT/.git" ] && [ -d "$PROD/.git" ] || exit 2
  [ "$(git -C "$ROOT" rev-parse --show-toplevel)" = "$ROOT" ] || exit 2
  [ "$(git -C "$PROD" rev-parse --show-toplevel)" = "$PROD" ] || exit 2
  git -C "$PROD" rev-parse --verify HEAD >/dev/null || exit 2
  printf 'prune nested git leak subset: PASS\n'
  exit 0
fi

phase 'preflight: TMPDIR inside another git repo is not touched'
OUTER="$FIX/enclosing-tmp-repo"
mkdir -p "$OUTER/tmp"
git -C "$OUTER" init -q -b main
git -C "$OUTER" config user.email selftest@example.invalid
git -C "$OUTER" config user.name selftest
printf '/tmp/\n' > "$OUTER/.git/info/exclude"
printf 'outer\n' > "$OUTER/outer.txt"
git -C "$OUTER" add outer.txt
git -C "$OUTER" commit -q -m outer
# Preserve a nonempty index and dirty/untracked sentinels, not merely a clean
# checkout that an accidental reset could make appear unchanged.
printf 'staged\n' > "$OUTER/staged.txt"; git -C "$OUTER" add staged.txt
printf 'unstaged\n' >> "$OUTER/outer.txt"
printf 'untracked\n' > "$OUTER/untracked.txt"
OUTER_HEAD_BEFORE="$(git -C "$OUTER" rev-parse HEAD)" || exit 2
OUTER_STATUS_BEFORE="$(GIT_OPTIONAL_LOCKS=0 git -C "$OUTER" status --porcelain --untracked-files=all)" || exit 2
cp -f "$OUTER/.git/index" "$FIX/outer-index.before" || exit 2
NESTED_GIT_LEAK_TIMEOUT_S=60
NESTED_STARTED=$SECONDS
NESTED_RC=0
TMPDIR="$OUTER/tmp" WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK=1 with_timeout "$NESTED_GIT_LEAK_TIMEOUT_S" bash "$0" "$PRUNE" > "$FIX/nested-prune.out" 2>&1 || NESTED_RC=$?
NESTED_ELAPSED=$((SECONDS-NESTED_STARTED))
if [ "$NESTED_RC" = 0 ] && grep -Fqx 'prune nested git leak subset: PASS' "$FIX/nested-prune.out"; then
  OUTER_HEAD_AFTER="$(git -C "$OUTER" rev-parse HEAD)" || exit 2
  OUTER_INDEX_UNCHANGED=0
  cmp -s "$FIX/outer-index.before" "$OUTER/.git/index" && OUTER_INDEX_UNCHANGED=1
  OUTER_STATUS_AFTER="$(GIT_OPTIONAL_LOCKS=0 git -C "$OUTER" status --porcelain --untracked-files=all)" || exit 2
  if [ "$OUTER_HEAD_AFTER" = "$OUTER_HEAD_BEFORE" ] && [ "$OUTER_INDEX_UNCHANGED" = 1 ] && [ "$OUTER_STATUS_AFTER" = "$OUTER_STATUS_BEFORE" ]; then
    pass "nested TMPDIR bounded Git subset leaves enclosing HEAD and index bytes unchanged (elapsed=${NESTED_ELAPSED}s limit=${NESTED_GIT_LEAK_TIMEOUT_S}s)"
  else
    fail "nested TMPDIR repo changed: head_before=$OUTER_HEAD_BEFORE head_after=$OUTER_HEAD_AFTER index_unchanged=$OUTER_INDEX_UNCHANGED status_before=$OUTER_STATUS_BEFORE status_after=$OUTER_STATUS_AFTER"
  fi
else
  case "$NESTED_RC" in
    124|142) fail "nested TMPDIR Git leak check timed out after ${NESTED_GIT_LEAK_TIMEOUT_S}s (rc=$NESTED_RC elapsed=${NESTED_ELAPSED}s): $(tail -20 "$FIX/nested-prune.out")" ;;
    *) fail "nested TMPDIR Git leak subset failed (rc=$NESTED_RC elapsed=${NESTED_ELAPSED}s): $(tail -20 "$FIX/nested-prune.out")" ;;
  esac
fi
if [ "${WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK_ONLY:-0}" = 1 ]; then
  [ "$FAILED" -eq 0 ]; exit $?
fi
phase 'D6/D7 automatic cleanup identity (fresh allocations only)'
IDENTITY_SOURCE="$FIX/identity-source"
mkdir -p "$IDENTITY_SOURCE"
selftest_copy_seat_runtime "$IDENTITY_SOURCE" "$HERE" || exit 2
if bun "$HERE/fixtures/prune-cleanup-identity.ts" "$FIX/identity-cases" "$IDENTITY_SOURCE" "$PRUNE" "${WHEELHOUSE_PRUNE_CLEANUP_IDENTITY_MODE:-fixed}"; then
  pass 'automatic cleanup identity regressions'
else
  fail 'automatic cleanup identity regressions'
fi
if [ "${WHEELHOUSE_PRUNE_CLEANUP_IDENTITY_ONLY:-}" = 1 ]; then
  [ "$FAILED" -eq 0 ] || exit 1
  echo 'prune cleanup identity subset: PASS'
  exit 0
fi

phase 'closed-task scratch inside seat worktrees (fresh allocations only)'
if bun "$HERE/fixtures/prune-seat-scratch.ts" "$FIX/seat-scratch-cases" "$IDENTITY_SOURCE" "$PRUNE"; then
  pass 'nested seat scratch cleanup regressions'
else
  fail 'nested seat scratch cleanup regressions'
fi

phase 'reviewed-row deletion safety (fresh allocations only)'
REVIEWED="$FIX/reviewed"
mkdir -p "$REVIEWED"
selftest_copy_seat_runtime "$REVIEWED" "$(dirname "$PRUNE")"
cp -f "$PRUNE" "$REVIEWED/seats/prune.ts"
cat > "$FIX/reviewed-rows.ts" <<'TS'
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const base = process.argv[2];
if (!fs.existsSync(path.join(path.dirname(base), '.wheelhouse-selftest-fixture'))) throw new Error('missing fresh fixture marker');
let failures = 0;
function check(ok: boolean, name: string, detail = '') { console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) failures++; }
function command(cmd: string, args: string[], cwd: string, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (r.error || r.signal) throw new Error(`${cmd} did not complete: ${r.error ?? r.signal}`);
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(base, name + '-')), root = path.join(dir, 'install');
  fs.mkdirSync(root); fs.cpSync(path.join(base, 'seats'), path.join(root, 'seats'), { recursive: true });
  // Old prune walks upward looking for state. Stop that walk HERE, never at
  // the enclosing installed fleet's state/FIFOs during a negative control.
  fs.writeFileSync(path.join(root,'seats','state.json'), JSON.stringify({seats:{}}));
  for (const args of [['init','-q','-b','main'], ['config','user.email','selftest@example.invalid'], ['config','user.name','selftest']]) {
    const r = command('git', args, root); if (r.rc !== 0) throw new Error(r.err);
  }
  fs.writeFileSync(path.join(root, 'base.txt'), 'owned fixture\n');
  for (const args of [['add','base.txt'], ['commit','-q','-m','base']]) if (command('git', args, root).rc !== 0) throw new Error('fixture commit failed');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'xcrun.log'); fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'xcrun'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + log + '"\n', { mode: 0o755 });
  const lsof = path.join(bin, 'lsof'); fs.writeFileSync(lsof, '#!/bin/sh\nprintf "p1\\nn/\\n"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, WHEELHOUSE_LSOF: lsof };
  return { dir, root, log, env };
}
function meta(root: string) { return { kind:'wheelhouse-prune-scan', version:1, root, roots:[root], safe:0, repo:root, path:root }; }
function row(root: string, target: string, extra = {}) { return { category:'run-scratch', safe:1, repo:root, path:target, branch:'', size_bytes:1, size_human:'1.0B', action:'rm', reason:'fresh reviewed fixture', ...extra }; }
function keep(target: string) { fs.mkdirSync(target, { recursive:true }); fs.writeFileSync(path.join(target, 'KEEP'), 'unrelated fixture sentinel\n'); }
function invoke(f: ReturnType<typeof fixture>, rows: any[], header = meta(f.root), format = 'json') {
  const file = path.join(f.dir, 'reviewed.' + format);
  if (format === 'json') fs.writeFileSync(file, JSON.stringify([header,...rows]));
  else if (format === 'jsonl') fs.writeFileSync(file, [header,...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
  else {
    const cols = ['category','safe','repo','path','branch','size_bytes','size_human','action','reason'];
    fs.writeFileSync(file, '# wheelhouse-prune-scan-v1\t' + JSON.stringify(header.roots) + '\n' + cols.join('\t') + '\n' + rows.map(r => cols.map(c => String(r[c] ?? '')).join('\t')).join('\n') + '\n');
  }
  const r = command('bun', ['seats/prune.ts','prune','--from-file',file,'--yes'], f.root, f.env);
  console.log(`MEASUREMENT ${path.basename(f.dir)} rc=${r.rc} stdout=${JSON.stringify(r.out)} stderr=${JSON.stringify(r.err)}`);
  return r;
}
{
  const f = fixture('outside-rm'), victim = path.join(f.dir,'victim'); keep(victim);
  if (!fs.existsSync(path.join(victim,'KEEP'))) throw new Error('outside sentinel absent before prune');
  const r = invoke(f,[row(f.root,victim)]), present = fs.existsSync(path.join(victim,'KEEP'));
  console.log(`MEASUREMENT outside-rm KEEP_present=${Number(present)}`);
  check(r.rc === 0 && present && r.out.includes('SKIPPED run-scratch') && r.out.includes('outside allowed'), 'outside rm row keeps unrelated KEEP');
}
{
  const f = fixture('string-safe'), victim = path.join(f.dir,'victim'); keep(victim);
  const r = invoke(f,[row(f.root,victim,{safe:'0'})]);
  check(r.rc === 2 && fs.existsSync(path.join(victim,'KEEP')) && /row 2 field safe/.test(r.err), 'JSON safe string refuses whole file');
}
{
  const f = fixture('dirty-worktree'), wt = path.join(f.root,'.wheelhouse-worktrees','dirty');
  const created = command('git',['worktree','add','-q','-b','fleet/dirty',wt,'main'],f.root);
  if (created.rc !== 0 || !fs.existsSync(path.join(wt,'.git'))) throw new Error('worktree creation failed: '+created.err);
  const recorded = row(f.root,wt,{category:'merged-worktree',action:'worktree',branch:'fleet/dirty'});
  // Save the clean reviewed row, THEN let the tree change before prune acts.
  const file = path.join(f.dir,'clean-scan.json'); fs.writeFileSync(file,JSON.stringify([meta(f.root),recorded]));
  const before = command('git',['status','--porcelain','--untracked-files=all'],wt);
  if (before.rc !== 0 || before.out.trim()) throw new Error('subject was not a clean worktree when recorded');
  fs.writeFileSync(path.join(wt,'KEEP'),'new untracked work\n');
  const r = command('bun',['seats/prune.ts','prune','--from-file',file,'--yes'],f.root,f.env), present = fs.existsSync(path.join(wt,'KEEP'));
  console.log(`MEASUREMENT dirty-worktree rc=${r.rc} KEEP_present=${Number(present)} stdout=${JSON.stringify(r.out)} stderr=${JSON.stringify(r.err)}`);
  check(r.rc === 0 && present && r.out.includes('SKIPPED merged-worktree') && r.out.includes('uncommitted changes'), 'worktree dirtied after review keeps KEEP');
}
{
  const f = fixture('invalid-simctl');
  if (!fs.existsSync(f.log) || !fs.existsSync(path.join(f.dir,'bin','xcrun'))) throw new Error('stub/log subject absent');
  const r = invoke(f,[row(f.root,'simctl:../x',{category:'bead-simulator',action:'simctl'})]);
  check(r.rc === 0 && r.out.includes('SKIPPED bead-simulator') && r.out.includes('invalid simulator UDID') && fs.readFileSync(f.log,'utf8') === '', 'invalid UDID skipped with zero xcrun calls');
}
{
  const f = fixture('foreign-root'), other = fixture('other-install'), target = path.join(f.root,'.wheelhouse-runs','owned'); keep(target);
  const r = invoke(f,[row(f.root,target)],meta(other.root));
  check(r.rc === 2 && fs.existsSync(path.join(target,'KEEP')) && /row 1 field root/.test(r.err), 'foreign install scan refused');
}
for (const [field,value] of [['category','not-a-category'],['action','none'],['path','relative'],['repo','not-a-repository'],['safe',true],['size_bytes',-1]] as const) {
  const f = fixture('bad-'+field), first = path.join(f.root,'.wheelhouse-runs','first'), second = path.join(f.dir,'victim'); keep(first); keep(second);
  const r = invoke(f,[row(f.root,first),row(f.root,second,{[field]:value})]);
  check(r.rc === 2 && fs.existsSync(path.join(first,'KEEP')) && fs.existsSync(path.join(second,'KEEP')) && r.err.includes('row 3 field '+field), `bad ${field} validates whole file before first action`);
}
for (const format of ['jsonl','tsv']) {
  const f = fixture('bad-'+format), target = path.join(f.root,'.wheelhouse-runs','owned'); keep(target);
  const r = invoke(f,[row(f.root,target,{category:'bogus'})],meta(f.root),format);
  check(r.rc === 2 && fs.existsSync(path.join(target,'KEEP')) && r.err.includes('field category'), format+' validates rows too');
}
{
  const f = fixture('symlink'), outside = path.join(f.dir,'outside'); keep(path.join(outside,'owned'));
  fs.symlinkSync(outside,path.join(f.root,'.wheelhouse-runs'));
  const r = invoke(f,[row(f.root,path.join(f.root,'.wheelhouse-runs','owned'))]);
  check(r.rc === 0 && fs.existsSync(path.join(outside,'owned','KEEP')) && r.out.includes('path mismatch'), 'symlink ancestor cannot redirect rm');
}
{
  const f = fixture('cancelled-symlink'), runs = path.join(f.root,'.wheelhouse-runs'), outside = path.join(f.dir,'outside');
  keep(path.join(runs,'owned')); keep(path.join(outside,'owned')); fs.mkdirSync(path.join(outside,'inner'));
  fs.symlinkSync(path.join(outside,'inner'),path.join(runs,'link'));
  const target = runs + '/link/../owned'; // path.join would erase the dangerous spelling.
  const r = invoke(f,[row(f.root,target)]);
  check(r.rc === 0 && fs.existsSync(path.join(outside,'owned','KEEP')) && fs.existsSync(path.join(runs,'owned','KEEP')) && r.out.includes('path mismatch'), 'lexical dotdot cannot hide a symlink from validation');
}
{
  const f = fixture('missing'), target = path.join(f.root,'.wheelhouse-runs','missing');
  const r = invoke(f,[row(f.root,target)]);
  check(r.rc === 0 && r.out.includes('SKIPPED run-scratch') && r.out.includes('no longer exists') && r.out.includes('touched=0 skipped=1'), 'missing target skipped, not reported PRUNED');
}
{
  const f = fixture('xctest-outside'), target = path.join(f.dir,'unrelated-device-set'); keep(target);
  const r = invoke(f,[row(f.root,target,{category:'xctest-devices',action:'xctest-devices'})]);
  check(r.rc === 0 && fs.existsSync(path.join(target,'KEEP')) && r.out.includes('outside XCTestDevices') && fs.readFileSync(f.log,'utf8') === '', 'XCTest set outside scanner root cannot reach xcrun');
}
{
  const f = fixture('ancestor-swap'), parent = path.join(f.root,'.wheelhouse-runs'), outside = path.join(f.dir,'outside');
  keep(path.join(parent,'owned')); keep(path.join(outside,'owned'));
  fs.writeFileSync(f.env.WHEELHOUSE_LSOF, '#!/bin/sh\nmv -f "'+parent+'" "'+parent+'.original"\nln -s "'+outside+'" "'+parent+'"\nprintf "p1\\nn/\\n"\n');
  const r = invoke(f,[row(f.root,path.join(parent,'owned'))]);
  const original = fs.existsSync(path.join(parent+'.original','owned','KEEP'));
  check(r.rc === 0 && original && fs.existsSync(path.join(outside,'owned','KEEP')) && r.out.includes('path mismatch after validation'), 'ancestor swapped by last outside probe cannot redirect rm');
}
{
  const f = fixture('live-worktree'), wt = path.join(f.root,'.wheelhouse-worktrees','occupied');
  if (command('git',['worktree','add','-q','-b','fleet/occupied',wt,'main'],f.root).rc !== 0) throw new Error('live worktree absent');
  const file = path.join(f.dir,'before-live.json'); fs.writeFileSync(file,JSON.stringify([meta(f.root),row(f.root,wt,{category:'merged-worktree',action:'worktree',branch:'fleet/occupied'})]));
  const realLsof = command('which',['lsof'],base).out.trim(); if (!realLsof || !fs.existsSync(realLsof)) throw new Error('real lsof unavailable for live-cwd proof');
  const child = spawn('sleep',['1000'],{cwd:wt,stdio:'ignore'});
  try {
    if (!child.pid) throw new Error('owned sleep not started');
    command('sleep',['0.1'],f.dir);
    const cwd = command(realLsof,['-a','-p',String(child.pid),'-d','cwd','-Fn'],f.dir);
    if (!cwd.out.split('\n').includes('n'+wt)) throw new Error('owned live cwd not observed');
    console.log(`CAPTURE lsof -a -p <fixture-pid> -d cwd -Fn rc=${cwd.rc} stdout=${JSON.stringify(cwd.out)} stderr=${JSON.stringify(cwd.err)}`);
    const r = command('bun',['seats/prune.ts','prune','--from-file',file,'--yes'],f.root,{...f.env,WHEELHOUSE_LSOF:realLsof});
    console.log(`MEASUREMENT live-worktree rc=${r.rc} stdout=${JSON.stringify(r.out)} stderr=${JSON.stringify(r.err)}`);
    check(r.rc === 0 && fs.existsSync(path.join(wt,'.git')) && r.out.includes('SKIPPED merged-worktree') && r.out.includes('live process has its cwd'), 'live cwd acquired after review keeps unanchored worktree');
  } finally { child.kill('SIGTERM'); }
}
for (const format of ['jsonl','tsv']) {
  const f = fixture('first-bad-'+format), target = path.join(f.root,'.wheelhouse-runs','owned'); keep(target);
  // Earlier semantic error wins over a later record's decoding/coercion error.
  const file = path.join(f.dir,'first.'+format), bad = row(f.root,target,{category:'bogus'});
  if (format === 'jsonl') fs.writeFileSync(file,JSON.stringify(meta(f.root))+'\n'+JSON.stringify(bad)+'\n{not-json}\n');
  else { const cols = Object.keys(bad); fs.writeFileSync(file,'# wheelhouse-prune-scan-v1\t'+JSON.stringify([f.root])+'\n'+cols.join('\t')+'\n'+cols.map(c=>String(bad[c])).join('\t')+'\n'+cols.map(c=>c==='safe'?'not-a-number':String(bad[c])).join('\t')+'\n'); }
  const r = command('bun',['seats/prune.ts','prune','--from-file',file,'--yes'],f.root,f.env);
  check(r.rc === 2 && fs.existsSync(path.join(target,'KEEP')) && r.err.includes('row 2 field category'), format+' reports first bad row, not later syntax/coercion error');
}
{
  const f = fixture('tmp-parent-alias'), physical = path.join(f.dir,'physical-tmp'), alias = path.join(f.dir,'tmp-alias');
  fs.mkdirSync(physical); fs.symlinkSync(physical,alias);
  // Real bd output, not a hand-modeled scan row: producer and consumer must
  // agree when TMPDIR has a symlink ancestor (macOS /var -> /private/var).
  const init = command('bd',['init','--non-interactive','--skip-agents','-p','aliascase'],f.root,f.env);
  if (init.rc !== 0) throw new Error('alias fixture bd init failed: '+init.err);
  const made = command('bd',['create','--title','Owned tmp alias fixture','--json'],f.root,f.env);
  if (made.rc !== 0) throw new Error('alias bead create failed: '+made.err);
  const id = JSON.parse(made.out).id;
  if (!id || command('bd',['close',id],f.root,f.env).rc !== 0) throw new Error('alias closed bead absent');
  const target = path.join(physical,id+'-scratch'); keep(target);
  const aliasEnv = { ...f.env, TMPDIR: alias };
  const produced = command('bun',['seats/prune.ts','scan','--format','json'],f.root,aliasEnv);
  const rows = JSON.parse(produced.out), recorded = rows.find((r:any) => r.category === 'bead-tmp' && path.basename(r.path) === id+'-scratch');
  const file = path.join(f.dir,'tmp-alias-scan.json'); fs.writeFileSync(file,produced.out);
  const pruned = command('bun',['seats/prune.ts','prune','--from-file',file,'--yes','--categories','bead-tmp'],f.root,aliasEnv);
  console.log(`MEASUREMENT tmp-parent-alias scanRc=${produced.rc} pruneRc=${pruned.rc} recorded=${JSON.stringify(recorded)} stdout=${JSON.stringify(pruned.out)} stderr=${JSON.stringify(pruned.err)}`);
  check(produced.rc === 0 && recorded?.safe === 1 && recorded.path === target && pruned.rc === 0 && !fs.existsSync(target) && pruned.out.includes('PRUNED rm bead-tmp'), 'aliased TMPDIR producer records canonical target and reviewed consumer removes it');
}
console.log(`reviewed-row regression failures=${failures}`);
// Positive wire controls: actual producer -> saved file -> actual consumer,
// including a plain (non-Git) umbrella with a Git product repository.
for (const layout of ['single-repo','plain-umbrella']) for (const format of ['json','jsonl','tsv']) {
  const f = fixture('roundtrip-'+layout+'-'+format);
  if (layout === 'plain-umbrella') {
    if (command('git',['clone','-q',f.root,path.join(f.root,'product')],f.dir).rc !== 0) throw new Error('local product clone failed');
    fs.renameSync(path.join(f.root,'.git'),path.join(f.dir,'retired-fixture-git'));
  }
  const target = path.join(f.root,'.wheelhouse-worktrees','orphan'); keep(target);
  const produced = command('bun',['seats/prune.ts','scan','--format',format],f.root,f.env), file = path.join(f.dir,'actual-scan.'+format);
  fs.writeFileSync(file,produced.out);
  const scoped = format === 'tsv' ? produced.out.startsWith('# wheelhouse-prune-scan-v1\t') : produced.out.includes('"kind"') && produced.out.includes('wheelhouse-prune-scan');
  const pruned = command('bun',['seats/prune.ts','prune','--from-file',file,'--yes','--categories','orphaned-worktree'],f.root,f.env);
  check(produced.rc === 0 && scoped && pruned.rc === 0 && !fs.existsSync(target) && pruned.out.includes('PRUNED rm orphaned-worktree'), `${layout} ${format} bound producer/consumer roundtrip`);
}
process.exit(failures ? 1 : 0);
TS
if bun "$FIX/reviewed-rows.ts" "$REVIEWED"; then pass 'reviewed-row safety regressions'; else fail 'reviewed-row safety regressions'; fi
if [ "${WHEELHOUSE_PRUNE_REVIEWED_ONLY:-0}" = 1 ]; then
  [ "$FAILED" -eq 0 ] && { echo 'prune.reviewed.selftest: PASS'; exit 0; }
  echo 'prune.reviewed.selftest: FAIL' >&2; exit 1
fi

prune_fixture_reviewed
prune_fixture_scan
phase 'prune --yes refuses while a rostered seat is mid-turn'
MID="$FIX/midturn"
mkdir -p "$MID/seats" "$MID/product/.wheelhouse-build"
git -C "$MID" init -q -b main
selftest_copy_seat_runtime "$MID" "$(dirname "$PRUNE")"
chmod +x "$MID/seats/prune.ts"
MID_FIFO="$MID/seats/mid.stdin"
MID_LOG="$MID/seats/mid.jsonl"
mkfifo "$MID_FIFO"
touch "$MID_LOG"
(
  while IFS= read -r line; do
    id=$(printf '%s\n' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [ -n "$id" ] && printf '{"id":"%s","type":"response","success":true,"data":{"isStreaming":true}}\n' "$id" >> "$MID_LOG"
  done <>"$MID_FIFO"
) >/dev/null 2>&1 &
MID_PID=$!
printf '{"seats":{"worker-busy":{"pid":%s,"cwd":"%s","fifo":"%s","log":"%s"}}}\n' "$MID_PID" "$MID/product" "$MID_FIFO" "$MID_LOG" > "$MID/seats/state.json"
{ reviewed_tsv_header "$MID"; printf 'build-cache\t1\t%s\t%s\t\t1\t1.0B\trm\tfixture\n' "$MID" "$MID/product/.wheelhouse-build"; } > "$FIX/mid-scan.tsv"
( cd "$MID" && bun seats/prune.ts prune --from-file "$FIX/mid-scan.tsv" > "$FIX/mid-dry.out" )
[ -d "$MID/product/.wheelhouse-build" ] && pass 'mid-turn seat still allows dry-run scan/prune preview' || fail 'mid-turn dry-run removed cache'
set +e
MID_RC=0; MID_OUT=$(cd "$MID" && bun seats/prune.ts prune --from-file "$FIX/mid-scan.tsv" --yes 2>&1) || MID_RC=$?
set +e
if [ $MID_RC -eq 0 ] && printf '%s\n' "$MID_OUT" | grep >/dev/null 'SKIPPED build-cache' && printf '%s\n' "$MID_OUT" | grep >/dev/null 'worker-busy' && printf '%s\n' "$MID_OUT" | grep >/dev/null 'mid-turn'; then pass 'prune --yes skips naming the mid-turn seat'; else fail "mid-turn prune did not skip safely (exit $MID_RC): $MID_OUT"; fi
[ -d "$MID/product/.wheelhouse-build" ] && pass 'mid-turn guarded cache remains after refused prune --yes' || fail 'mid-turn guarded cache was removed'
kill "$MID_PID" >/dev/null 2>&1 || true

phase 'prune --yes restores write permission before rm action'
MANUAL_RO="$ROOT/.wheelhouse-runs/$CLOSED_ID-manual-readonly-rm"
mkdir -p "$MANUAL_RO/readonly-subdir"
printf 'locked\n' > "$MANUAL_RO/readonly-subdir/file.txt"
chmod 555 "$MANUAL_RO/readonly-subdir"
{ reviewed_tsv_header "$ROOT"; printf 'run-scratch\t1\t%s\t%s\t\t1\t1.0B\trm\tread-only fixture\n' "$ROOT" "$MANUAL_RO"; } > "$FIX/manual-readonly-scan.tsv"
set +e
MANUAL_RO_RC=0; MANUAL_RO_OUT=$(cd "$ROOT" && bun seats/prune.ts prune --from-file "$FIX/manual-readonly-scan.tsv" --yes --categories run-scratch 2>&1) || MANUAL_RO_RC=$?
set -e
if [ $MANUAL_RO_RC -eq 0 ] && [ ! -e "$MANUAL_RO" ] && printf '%s\n' "$MANUAL_RO_OUT" | grep >/dev/null "PRUNED rm run-scratch $MANUAL_RO"; then pass 'prune --yes removes an rm row containing a mode-555 subdirectory'; else chmod -R u+w "$MANUAL_RO" 2>/dev/null || true; fail "manual read-only rm row was not removed (exit $MANUAL_RO_RC): $MANUAL_RO_OUT"; fi

phase 'prune --yes rechecks live seat anchors from reviewed scan files'
{ reviewed_tsv_header "$ROOT"; printf 'orphaned-worktree\t1\t%s\t%s\t\t1\t1.0B\trm\tstale reviewed scan fixture\n' "$ROOT" "$WTS/$LIVE_ID"; } > "$FIX/stale-live-scan.tsv"
set +e
STALE_RC=0; STALE_OUT=$(cd "$ROOT" && bun seats/prune.ts prune --from-file "$FIX/stale-live-scan.tsv" --yes --categories orphaned-worktree 2>&1) || STALE_RC=$?
set +e
if [ $STALE_RC -eq 0 ] && printf '%s\n' "$STALE_OUT" | grep >/dev/null 'SKIPPED orphaned-worktree' && printf '%s\n' "$STALE_OUT" | grep >/dev/null 'worker-live' && printf '%s\n' "$STALE_OUT" | grep >/dev/null 'refusing to prune'; then pass 'prune --yes skips a stale safe row that is now a live seat cwd'; else fail "stale live-cwd row was not skipped (exit $STALE_RC): $STALE_OUT"; fi
[ -d "$WTS/$LIVE_ID" ] && pass 'stale-scan live seat cwd remains after refused prune --yes' || fail 'stale-scan live seat cwd was removed'
{ reviewed_tsv_header "$ROOT"; printf 'merged-worktree\t1\t%s\t%s\tfleet/%s\t1\t1.0B\tworktree\tstale reviewed scan fixture\n' "$PROD" "$WTS/$HIST_ID" "$HIST_ID"; } > "$FIX/stale-session-scan.tsv"
set +e
SESSION_STALE_RC=0; SESSION_STALE_OUT=$(cd "$ROOT" && bun seats/prune.ts prune --from-file "$FIX/stale-session-scan.tsv" --yes --categories merged-worktree 2>&1) || SESSION_STALE_RC=$?
set -e
if [ $SESSION_STALE_RC -eq 0 ] && printf '%s\n' "$SESSION_STALE_OUT" | grep >/dev/null "PRUNED worktree merged-worktree $WTS/$HIST_ID" && ! printf '%s\n' "$SESSION_STALE_OUT" | grep >/dev/null 'session history cwd'; then pass 'prune --yes removes a reviewed safe row that appears only in stored session history'; else fail "stale session-history row was not removed cleanly (exit $SESSION_STALE_RC): $SESSION_STALE_OUT"; fi
[ ! -d "$WTS/$HIST_ID" ] && pass 'stale-scan session-history worktree is removed by prune --yes' || fail 'stale-scan session-history worktree remains'

phase 'prune acts only on safe selected rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --yes --categories merged-worktree,orphaned-worktree,build-cache,bench-junk,bead-runs,bead-tmp,bead-simulator,xctest-devices > "$FIX/prune.out" )
if [ ! -e "$WTS/$CLOSED_ID" ] && ! git -C "$PROD" worktree list --porcelain | grep -F >/dev/null "$WTS/$CLOSED_ID"; then pass 'safe merged worktree removed by git worktree remove'; else fail 'safe merged worktree still exists or is registered'; fi
if git -C "$PROD" branch --list "fleet/$CLOSED_ID" | grep >/dev/null . && git -C "$PROD" log -1 --format=%s "fleet/$CLOSED_ID" >/dev/null && selftest_capture_lacks "$FIX/prune.out" -q -- 'PRUNED branch'; then pass 'safe merged worktree prune keeps its merged branch ref'; else fail "merged worktree branch was deleted or PRUNED branch was logged: branch=$(git -C "$PROD" branch --list "fleet/$CLOSED_ID") output=$(cat "$FIX/prune.out")"; fi
if [ ! -e "$WTS/$GOAL_CHILD_ID" ] && git -C "$PROD" branch --list "fleet/$GOAL_CHILD_ID" | grep >/dev/null . && git -C "$PROD" log -1 --format=%s "fleet/$GOAL_CHILD_ID" >/dev/null && selftest_capture_lacks "$FIX/prune.out" -q -- 'PRUNED branch' && git -C "$PROD" branch --list fleet/goal-x | grep >/dev/null .; then pass 'goal-branch merged worktree prunes worktree while child and listed goal branches survive'; else fail "goal-branch prune outcome wrong: child_dir=$([ -e "$WTS/$GOAL_CHILD_ID" ] && echo present || echo gone) child_branch=$(git -C "$PROD" branch --list "fleet/$GOAL_CHILD_ID") goal_branch=$(git -C "$PROD" branch --list fleet/goal-x) output=$(cat "$FIX/prune.out")"; fi
if git -C "$PROD" branch --list "fleet/$UNMERGED_ID" | grep >/dev/null .; then pass 'unmerged fleet branch is not deleted by merged-worktree prune path'; else fail 'unmerged fleet branch was deleted'; fi
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --yes --categories stale-branch > "$FIX/stale-branch-prune.out" )
if ! git -C "$PROD" branch --list "fleet/$STALE_ID" | grep >/dev/null . \
  && grep -q "TAGGED archive/$STALE_ID ${STALE_SHA:0:12} before deleting fleet/$STALE_ID" "$FIX/stale-branch-prune.out" \
  && [ "$(git -C "$PROD" rev-parse "archive/$STALE_ID^{commit}" 2>/dev/null)" = "$STALE_SHA" ]; then
  pass 'stale-branch prune archive-tags the branch tip before deleting the branch ref'
else
  fail "stale-branch prune did not archive-tag before delete: branch=$(git -C "$PROD" branch --list "fleet/$STALE_ID") tag=$(git -C "$PROD" rev-parse "archive/$STALE_ID^{commit}" 2>/dev/null) want=$STALE_SHA output=$(cat "$FIX/stale-branch-prune.out")"
fi
[ ! -e "$WTS/orphaned-checkout" ] && pass 'safe orphaned checkout removed' || fail 'orphaned checkout still exists'
[ ! -e "$PROD/.wheelhouse-build" ] && pass 'safe build cache removed' || fail 'build cache still exists'
[ ! -e "$PROD/obj" ] && pass 'safe .NET obj cache removed' || fail 'obj cache still exists'
[ ! -e "$PROD/dist" ] && pass 'safe root dist cache removed' || fail 'root dist cache still exists'
[ ! -e "$ROOT/.wheelhouse-bench.lock.stale.12345" ] && pass 'safe stale bench lock removed' || fail 'stale bench lock still exists'
[ ! -e "$ROOT/.wheelhouse-runs/$CLOSED_ID-build" ] && pass 'safe closed bead runs scratch removed' || fail 'closed bead runs scratch still exists'
[ ! -e "$CLOSED_TMP" ] && pass 'safe closed bead tmp scratch removed' || fail 'closed bead tmp scratch still exists'
grep -q 'delete 11111111-1111-1111-1111-111111111111' "$FIX/xcrun.log" && pass 'safe closed bead simulator deleted by simctl' || fail "closed bead simulator delete missing: $(cat "$FIX/xcrun.log" 2>/dev/null)"
grep -q "set-delete $HOME/Library/Developer/XCTestDevices all" "$FIX/xcrun.log" && [ ! -e "$HOME/Library/Developer/XCTestDevices" ] && pass 'idle XCTestDevices set deleted with simctl --set' || fail "XCTestDevices set delete missing: $(cat "$FIX/xcrun.log" 2>/dev/null)"
[ -d "$PROD/node_modules/pkg/dist" ] && pass 'node_modules package dist remains after prune --yes' || fail 'node_modules package dist was removed'
[ -d "$PROD/node_modules/.bin" ] && pass 'node_modules .bin remains after prune --yes' || fail 'node_modules .bin was removed'
[ -d "$WTS/$OPEN_ID" ] && pass 'recorded-cwd seat-anchor worktree remains' || fail 'recorded-cwd seat-anchor worktree was removed'
[ -d "$WTS/worker-rostered" ] && pass 'rostered seat worktree remains' || fail 'rostered seat worktree was removed'
[ -d "$WTS/$LIVE_ID" ] && pass 'live-cwd seat-anchor worktree remains' || fail 'live-cwd seat-anchor worktree was removed'
[ ! -d "$WTS/$HIST_ID" ] && pass 'session-history worktree was removed by normal pruning rules' || fail 'session-history worktree remains'
OPEN_RUNS_AFTER=$(shasum -a 256 "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" | awk '{print $1}')
OPEN_TMP_AFTER=$(shasum -a 256 "$OPEN_TMP/file.txt" | awk '{print $1}')
[ "$OPEN_RUNS_BEFORE" = "$OPEN_RUNS_AFTER" ] && pass 'open bead runs scratch remains byte-identical' || fail 'open bead runs scratch changed'
[ "$OPEN_TMP_BEFORE" = "$OPEN_TMP_AFTER" ] && pass 'open bead tmp scratch remains byte-identical' || fail 'open bead tmp scratch changed'
if selftest_capture_lacks "$FIX/xcrun.log" -q -- 'delete 22222222-2222-2222-2222-222222222222'; then pass 'open bead simulator is not deleted'; else fail "open bead simulator was deleted: $(cat "$FIX/xcrun.log")"; fi
if grep -q 'prune summary: touched=11' "$FIX/prune.out" && grep -q 'reclaimed_bytes=' "$FIX/prune.out" && grep -q "SKIPPED merged-worktree $WTS/$HIST_ID reason=path no longer exists" "$FIX/prune.out"; then pass 'prune summary reports eleven touched rows; already-removed history row counts as skipped'; else fail "unexpected prune summary: $(cat "$FIX/prune.out")"; fi

prune_fixture_cleanup_helpers
prune_fixture_ext
phase 'ISC-59/60 seat anchors and ISA-named worktrees are never removed'
SEAT_ID=$(ext_bead 'seat anchored merged worktree'); ext_wt "$SEAT_ID"; ext_merge "$SEAT_ID"
ISA_ID=$(ext_bead 'ISA named merged worktree'); ext_wt "$ISA_ID"; ext_merge "$ISA_ID"
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"}}}\n' "$EWTS/$SEAT_ID" > "$EXT/seats/state.json"
mkdir -p "$EXT/wheelhouse"; printf '# ISA\n\nIntegration worktree: `.wheelhouse-worktrees/%s` holds the goal branch.\n' "$ISA_ID" > "$EXT/wheelhouse/ISA.md"
ext_scan
ext_row "$EWTS/$SEAT_ID" | grep >/dev/null '"category":"seat-anchor"' && pass 'seats/state.json cwd is listed seat-anchor (ISC-59)' || fail "seat row: $(ext_row "$EWTS/$SEAT_ID")"
ext_row "$EWTS/$ISA_ID" | grep >/dev/null '"category":"needs-review".*"reason":"named by wheelhouse/ISA.md"' && pass 'worktree named in wheelhouse/ISA.md is needs-review "named by wheelhouse/ISA.md" (ISC-60)' || fail "ISA row: $(ext_row "$EWTS/$ISA_ID")"
OUT=$(ext_cleanup --bead "$SEAT_ID"; ext_cleanup --bead "$ISA_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EWTS/$SEAT_ID" ] && ext_registered "$EWTS/$SEAT_ID" && printf '%s\n' "$OUT" | grep >/dev/null "kept seat-anchor $EWTS/$SEAT_ID reason=seat-anchor" && pass 'seat-anchor worktree kept with "seat-anchor" and still registered' || fail "seat-anchor cleanup rc=$RC: $OUT"
[ -d "$EWTS/$ISA_ID" ] && ext_registered "$EWTS/$ISA_ID" && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $EWTS/$ISA_ID reason=named by wheelhouse/ISA.md" && pass 'ISA-named worktree kept with "named by wheelhouse/ISA.md" and still registered' || fail "ISA cleanup: $OUT"

phase 'ISC-61 lsof unavailable removes nothing'
LSOF_ID=$(ext_bead 'removable but unverifiable'); ext_wt "$LSOF_ID"; ext_merge "$LSOF_ID"
mkdir -p "$ERUNS/$LSOF_ID-run"; printf 'x\n' > "$ERUNS/$LSOF_ID-run/f"
ext_record_run "$ERUNS/$LSOF_ID-run" "$LSOF_ID"
OUT=$(WHEELHOUSE_LSOF=/nonexistent/lsof ext_cleanup); RC=$?
[ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $EWTS/$LSOF_ID reason=cannot verify: lsof unavailable" && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $ERUNS/$LSOF_ID-run reason=cannot verify: lsof unavailable" && pass 'otherwise-removable worktree and run folder are kept with "cannot verify: lsof unavailable"' || fail "no-lsof rc=$RC: $OUT"
! printf '%s\n' "$OUT" | grep >/dev/null '^[^ ]* removed ' && printf '%s\n' "$OUT" | tail -1 | grep >/dev/null 'cleanup done removed=0 ' && [ -d "$EWTS/$LSOF_ID" ] && [ -d "$ERUNS/$LSOF_ID-run" ] && pass 'nothing removed without lsof; exit 0' || fail "no-lsof removed something: $OUT"
OUT=$(ext_cleanup --bead "$LSOF_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$LSOF_ID" ] && [ ! -e "$ERUNS/$LSOF_ID-run" ] && pass 'the same rows are removed once lsof is available again' || fail "post-lsof rc=$RC: $OUT"

phase 'ISC-64 symlinked entries and paths with spaces'
LINK_ID=$(ext_bead 'worktree reached through a symlink'); mkdir -p "$FIX/elsewhere/$LINK_ID"
ext_wt "$LINK_ID" "$FIX/elsewhere/$LINK_ID"; ext_merge "$LINK_ID"; ln -s "$FIX/elsewhere/$LINK_ID" "$EWTS/$LINK_ID"
mkdir -p "$FIX/elsewhere/orphan-target"; printf 'keep me\n' > "$FIX/elsewhere/orphan-target/file.txt"; ln -s "$FIX/elsewhere/orphan-target" "$EWTS/linked-orphan"
SPACE_ID=$(ext_bead 'worktree path with a space'); ext_wt "$SPACE_ID" "$EWTS/$SPACE_ID with space"; ext_merge "$SPACE_ID"
ext_scan
ext_row "$FIX/elsewhere/$LINK_ID" | grep >/dev/null '"category":"needs-review".*"reason":"interactive checkout outside' && pass 'symlinked worktree registers at its real path and is needs-review (outside the container)' || fail "symlink worktree row: $(ext_row "$FIX/elsewhere/$LINK_ID") link-path row: $(ext_row "$EWTS/$LINK_ID")"
ext_row "$EWTS/linked-orphan" | grep >/dev/null '"category":"\(orphaned-worktree\|needs-review\)"' && pass 'orphaned symlink under .wheelhouse-worktrees/ is listed by scan' || fail "orphaned symlink has no scan row (scan skips symlinked entries): $(grep -F linked-orphan "$FIX/ext-scan.jsonl")"
OUT=$(ext_cleanup --bead "$LINK_ID"; ext_cleanup --bead "$SPACE_ID"; ext_cleanup); RC=$?
[ "$RC" -eq 0 ] && pass 'cleanup over symlinked entries exits 0' || fail "symlink cleanup rc=$RC: $OUT"
printf '%s\n' "$OUT" | grep >/dev/null "path mismatch" && pass 'cleanup logs "path mismatch" for a symlinked entry' || fail "no \"path mismatch\" line for a symlinked entry under .wheelhouse-worktrees/: $OUT"
[ -L "$EWTS/$LINK_ID" ] && [ -L "$EWTS/linked-orphan" ] && [ -f "$FIX/elsewhere/orphan-target/file.txt" ] && [ -f "$FIX/elsewhere/$LINK_ID/.git" ] && ext_registered "$FIX/elsewhere/$LINK_ID" && pass 'symlinks, their targets and the out-of-container worktree are untouched' || fail 'a symlink, its target, or the out-of-container worktree was touched'
selftest_capture_lacks "$ELOG" -Eq -- "^[^ ]+ removed [^ ]+ ($EWTS/$LINK_ID|$EWTS/linked-orphan|$FIX/elsewhere)" && pass 'no removed line names a symlinked or out-of-container path' || fail "removed line for a symlinked path: $(grep -F elsewhere "$ELOG")"
[ ! -e "$EWTS/$SPACE_ID with space" ] && ! ext_registered "$EWTS/$SPACE_ID with space" && grep -q "removed merged-worktree $EWTS/$SPACE_ID with space bytes=" "$ELOG" && pass 'merged worktree whose path has a space is resolved and removed' || fail "space path cleanup: $(grep -F "$SPACE_ID" "$ELOG")"

phase 'ISC-62 interactive .worktrees/ checkouts are never touched'
INT_ID=$(ext_bead 'interactive checkout, merged and closed'); mkdir -p "$EXT/.worktrees"
ext_wt "$INT_ID" "$EXT/.worktrees/$INT_ID"; ext_merge "$INT_ID"
ext_scan
ext_row "$EXT/.worktrees/$INT_ID" | grep >/dev/null '"category":"needs-review".*"reason":"interactive checkout' && pass 'interactive .worktrees/ checkout on a merged fleet branch is needs-review "interactive checkout"' || fail "interactive row: $(ext_row "$EXT/.worktrees/$INT_ID")"
OUT=$(ext_cleanup --bead "$INT_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EXT/.worktrees/$INT_ID" ] && ext_registered "$EXT/.worktrees/$INT_ID" && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $EXT/.worktrees/$INT_ID reason=interactive checkout" && pass 'interactive checkout kept and still registered after cleanup' || fail "interactive cleanup rc=$RC: $OUT"
! awk '$2=="removed"{print $4}' "$ELOG" | grep >/dev/null '/\.worktrees/' && pass 'no removed line in the cleanup log names a .worktrees/ path' || fail "removed .worktrees/ path: $(grep '/\.worktrees/' "$ELOG")"

if [ "$FAILED" -eq 0 ]; then
  echo 'prune-safety.selftest: PASS'
  exit 0
fi
echo "prune-safety.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
