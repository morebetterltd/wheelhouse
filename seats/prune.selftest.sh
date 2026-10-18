#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
# Hermetic selftest for seats/prune.ts. It builds a scratch wheelhouse
# container with a product repo, a closed merged worktree, a seat-anchored
# worktree, an orphaned checkout directory, bead-named scratch, fake simctl
# devices, an idle XCTestDevices set, and build caches.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
PRUNE="${1:-$HERE/prune.ts}"
SCRUB="$HERE/evidence-scrub.sh"
[ -f "$PRUNE" ] || { echo "selftest: not found: $PRUNE" >&2; exit 2; }
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "selftest: git is required" >&2; exit 2; }
command -v bd >/dev/null 2>&1 || { echo "selftest: bd is required" >&2; exit 2; }

# Evidence captures should pipe this script through seats/evidence-scrub.sh;
# self-scrubbing here leaves process-substitution readers behind on some shells.
FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-prune-selftest.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
export GIT_CEILING_DIRECTORIES="$FIX${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}"
TMP_SCRATCH=()
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; rm -rf ${TMP_SCRATCH[@]+"${TMP_SCRATCH[@]}"}; }
trap cleanup EXIT INT TERM
export HOME="$FIX/home"
mkdir -p "$HOME"
# bd init's hooks must not detach telemetry flushers into these worktrees.
selftest_disable_bd_metrics "$FIX" || exit 2
METRICS_CONFIG="$XDG_CONFIG_HOME/bd/config.yaml"
if [ -f "$METRICS_CONFIG" ] && grep -Eq '^[[:space:]]+disabled: true$' "$METRICS_CONFIG"; then
  pass 'fixture-owned bd metrics config disables detached telemetry flushers'
else
  fail 'fixture-owned bd metrics config does not disable detached telemetry flushers'
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
REVIEWED="$(selftest_make_fixture_dir "$FIX/reviewed.XXXXXX")" || exit 2
selftest_isolate_git "$REVIEWED" || exit 2
selftest_copy_seat_runtime "$REVIEWED" "$(dirname "$PRUNE")"
cp -f "$PRUNE" "$REVIEWED/seats/prune.ts"
cat > "$FIX/reviewed-rows.ts" <<'TS'
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const base = process.argv[2];
if (!fs.existsSync(path.join(base, '.wheelhouse-selftest-fixture'))) throw new Error('missing fresh fixture marker');
let failures = 0;
function check(ok: boolean, name: string, detail = '') { console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) failures++; }
function command(cmd: string, args: string[], cwd: string, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
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

reviewed_tsv_header(){ printf '# wheelhouse-prune-scan-v1\t["%s"]\ncategory\tsafe\trepo\tpath\tbranch\tsize_bytes\tsize_human\taction\treason\n' "$1"; }

if [ "${WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK:-0}" != 1 ]; then
  phase 'preflight: TMPDIR inside another git repo is not touched'
  OUTER="$FIX/enclosing-tmp-repo"
  mkdir -p "$OUTER/tmp"
  git -C "$OUTER" init -q -b main
  git -C "$OUTER" config user.email selftest@example.invalid
  git -C "$OUTER" config user.name selftest
  printf 'outer\n' > "$OUTER/outer.txt"
  git -C "$OUTER" add outer.txt
  git -C "$OUTER" commit -q -m outer
  OUTER_HEAD_BEFORE="$(git -C "$OUTER" rev-parse HEAD)"
  if TMPDIR="$OUTER/tmp" WHEELHOUSE_PRUNE_NESTED_GIT_LEAK_CHECK=1 with_timeout 900 bash "$0" "$PRUNE" > "$FIX/nested-prune.out" 2>&1; then
    OUTER_HEAD_AFTER="$(git -C "$OUTER" rev-parse HEAD)"
    OUTER_STATUS="$(git -C "$OUTER" status --porcelain --untracked-files=all)"
    if [ "$OUTER_HEAD_AFTER" = "$OUTER_HEAD_BEFORE" ] && [ -z "$OUTER_STATUS" ]; then
      pass 'prune.selftest with TMPDIR inside a scratch git repo leaves that repo HEAD and index unchanged'
    else
      fail "nested TMPDIR repo changed: before=$OUTER_HEAD_BEFORE after=$OUTER_HEAD_AFTER status=$OUTER_STATUS"
    fi
  else
    fail "nested TMPDIR prune.selftest failed: $(tail -80 "$FIX/nested-prune.out" 2>/dev/null)"
  fi
fi

ROOT="$FIX/container"
PROD="$ROOT/product"
WTS="$ROOT/.wheelhouse-worktrees"
mkdir -p "$PROD" "$WTS" "$ROOT/seats"
selftest_copy_seat_runtime "$ROOT" "$(dirname "$PRUNE")"
chmod +x "$ROOT/seats/prune.ts"

git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email selftest@example.invalid
git -C "$ROOT" config user.name selftest

git -C "$PROD" init -q -b main
git -C "$PROD" config user.email selftest@example.invalid
git -C "$PROD" config user.name selftest
printf 'base\n' > "$PROD/app.txt"
git -C "$PROD" add app.txt
git -C "$PROD" commit -q -m base
BARE="$FIX/origin.git"
git -C "$PROD" init --bare -q "$BARE"
git -C "$PROD" remote add origin "$BARE"
git -C "$PROD" push -q -u origin main

( cd "$ROOT" && bd init --non-interactive --skip-agents -p prune >/dev/null 2>&1 ) || { echo "selftest: bd init failed" >&2; exit 2; }
CLOSED_ID=$(cd "$ROOT" && bd create 'closed merged worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
OPEN_ID=$(cd "$ROOT" && bd create 'seat anchored worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
OPEN_LIVE_ID=$(cd "$ROOT" && bd create 'open live cwd anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
LIVE_ID=$(cd "$ROOT" && bd create 'closed live cwd anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
CLOSED_LIVE_ID=$(cd "$ROOT" && bd create 'closed live cwd needs-review' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
HIST_ID=$(cd "$ROOT" && bd create 'closed session history anchor' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
STALE_ID=$(cd "$ROOT" && bd create 'closed stale branch no worktree' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
UNMERGED_ID=$(cd "$ROOT" && bd create 'closed unmerged branch must survive' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
GOAL_CHILD_ID=$(cd "$ROOT" && bd create 'closed child merged only to goal branch' --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
cd "$ROOT" && bd close "$CLOSED_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$LIVE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$CLOSED_LIVE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$HIST_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$STALE_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$UNMERGED_ID" >/dev/null 2>&1
cd "$ROOT" && bd close "$GOAL_CHILD_ID" >/dev/null 2>&1

make_closed_worktree(){
  local id="$1" msg="$2"
  git -C "$PROD" worktree add -q -b "fleet/$id" "$WTS/$id" main
  printf '%s\n' "$msg" >> "$WTS/$id/app.txt"
  git -C "$WTS/$id" add app.txt
  git -C "$WTS/$id" commit -q -m "$msg"
  git -C "$PROD" checkout -q main
  git -C "$PROD" merge -q --no-ff "fleet/$id" -m "merge $msg"
  git -C "$PROD" push -q origin main
}
make_closed_worktree "$CLOSED_ID" "closed work"
git -C "$PROD" push -q origin "fleet/$CLOSED_ID"
make_closed_worktree "$LIVE_ID" "live cwd work"
make_closed_worktree "$CLOSED_LIVE_ID" "closed live cwd work"
make_closed_worktree "$HIST_ID" "history cwd work"
make_closed_worktree "$STALE_ID" "stale branch work"
git -C "$PROD" worktree remove --force "$WTS/$STALE_ID"
git -C "$PROD" push -q origin "fleet/$STALE_ID"
STALE_SHA="$(git -C "$PROD" rev-parse "fleet/$STALE_ID")"

git -C "$PROD" worktree add -q -b "fleet/$UNMERGED_ID" "$WTS/$UNMERGED_ID" main
printf 'unmerged work\n' >> "$WTS/$UNMERGED_ID/app.txt"
git -C "$WTS/$UNMERGED_ID" add app.txt
git -C "$WTS/$UNMERGED_ID" commit -q -m 'unmerged work'
git -C "$PROD" push -q origin "fleet/$UNMERGED_ID"

git -C "$PROD" checkout -q -b fleet/goal-x main
git -C "$PROD" push -q -u origin fleet/goal-x
git -C "$PROD" checkout -q main
git -C "$PROD" worktree add -q -b "fleet/$GOAL_CHILD_ID" "$WTS/$GOAL_CHILD_ID" main
printf 'goal child work\n' >> "$WTS/$GOAL_CHILD_ID/app.txt"
git -C "$WTS/$GOAL_CHILD_ID" add app.txt
git -C "$WTS/$GOAL_CHILD_ID" commit -q -m 'goal child work'
git -C "$PROD" checkout -q fleet/goal-x
git -C "$PROD" merge -q --no-ff "fleet/$GOAL_CHILD_ID" -m 'merge goal child work'
git -C "$PROD" push -q origin fleet/goal-x
git -C "$PROD" push -q origin "fleet/$GOAL_CHILD_ID"
git -C "$PROD" checkout -q main

git -C "$PROD" worktree add -q -b "fleet/$OPEN_ID" "$WTS/$OPEN_ID" main
git -C "$PROD" worktree add -q -b "fleet/$OPEN_LIVE_ID" "$WTS/$OPEN_LIVE_ID" main
mkdir -p "$ROOT/seats/logs" "$ROOT/seats/sessions"
SESSION_HISTORY="$ROOT/seats/sessions/history.jsonl"
printf '{"type":"session-start","cwd":"%s"}\n' "$WTS/$HIST_ID" > "$SESSION_HISTORY"
( cd "$WTS/$LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
LIVE_PID=$!
( cd "$WTS/$OPEN_LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
OPEN_LIVE_PID=$!
( cd "$WTS/$CLOSED_LIVE_ID" && sleep 1000 ) >/dev/null 2>&1 &
CLOSED_LIVE_PID=$!
TMP_SCRATCH+=()
cleanup_live(){ kill "$LIVE_PID" "$OPEN_LIVE_PID" "$CLOSED_LIVE_PID" >/dev/null 2>&1 || true; }
cleanup_prune(){ cleanup_live; cleanup; }
trap cleanup_prune EXIT INT TERM
printf '{"seats":{"worker-1":{"pid":999999,"cwd":"%s"},"worker-live":{"pid":%s,"cwd":"%s"},"worker-history":{"pid":999998,"cwd":"%s","sessionFile":"%s"}}}\n' "$WTS/$OPEN_ID" "$LIVE_PID" "$WTS/$OPEN_ID" "$WTS/$OPEN_ID" "$SESSION_HISTORY" > "$ROOT/seats/state.json"
printf '{"seats":{"worker-rostered":{}}}\n' > "$ROOT/seats/seats.json"
mkdir -p "$WTS/worker-rostered"

mkdir -p "$WTS/orphaned-checkout" "$PROD/.wheelhouse-build" "$PROD/obj" "$PROD/dist" "$PROD/node_modules/pkg/dist" "$PROD/node_modules/.bin" "$ROOT/.wheelhouse-bench.lock.stale.12345"
printf 'orphan\n' > "$WTS/orphaned-checkout/file.txt"
printf 'cache\n' > "$PROD/.wheelhouse-build/cache.txt"
printf 'obj-cache\n' > "$PROD/obj/cache.txt"
printf 'root-dist\n' > "$PROD/dist/app.js"
printf 'package-dist\n' > "$PROD/node_modules/pkg/dist/index.js"
printf 'package-bin\n' > "$PROD/node_modules/.bin/tool"
printf 'stale-lock\n' > "$ROOT/.wheelhouse-bench.lock.stale.12345/pid"

mkdir -p "$ROOT/.wheelhouse-runs/$CLOSED_ID-build" "$ROOT/.wheelhouse-runs/$OPEN_ID-build"
printf 'closed runs scratch\n' > "$ROOT/.wheelhouse-runs/$CLOSED_ID-build/file.txt"
printf 'open runs scratch\n' > "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt"
TMP_ROOT="${TMPDIR:-/private/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
mkdir -p "$TMP_ROOT"
# The scanner records physical paths, even if inherited TMPDIR is an alias.
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
CLOSED_TMP="$TMP_ROOT/$CLOSED_ID-derivedData"
OPEN_TMP="$TMP_ROOT/$OPEN_ID-derivedData"
mkdir -p "$CLOSED_TMP" "$OPEN_TMP"
printf 'closed tmp scratch\n' > "$CLOSED_TMP/file.txt"
printf 'open tmp scratch\n' > "$OPEN_TMP/file.txt"
TMP_SCRATCH+=("$CLOSED_TMP" "$OPEN_TMP")
OPEN_RUNS_BEFORE=$(shasum -a 256 "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" | awk '{print $1}')
OPEN_TMP_BEFORE=$(shasum -a 256 "$OPEN_TMP/file.txt" | awk '{print $1}')

FAKEBIN="$FIX/fakebin"
SIMDATA_CLOSED="$FIX/simdata-closed"
SIMDATA_OPEN="$FIX/simdata-open"
mkdir -p "$FAKEBIN" "$SIMDATA_CLOSED" "$SIMDATA_OPEN" "$HOME/Library/Developer/XCTestDevices"
printf 'closed simulator bytes\n' > "$SIMDATA_CLOSED/payload"
printf 'open simulator bytes\n' > "$SIMDATA_OPEN/payload"
printf 'xctest device bytes\n' > "$HOME/Library/Developer/XCTestDevices/payload"
cat > "$FAKEBIN/pgrep" <<'SH'
#!/usr/bin/env bash
[ "$1" = "-x" ] && [ "$2" = "xcodebuild" ] && exit 1
exit 1
SH
cat > "$FAKEBIN/xcrun" <<SH
#!/usr/bin/env bash
set -eu
LOG="$FIX/xcrun.log"
if [ "\${1:-}" != simctl ]; then exit 2; fi
shift
if [ "\${1:-}" = help ]; then echo help; exit 0; fi
if [ "\${1:-}" = list ] && [ "\${2:-}" = devices ]; then
cat <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"$CLOSED_ID-walk","udid":"11111111-1111-1111-1111-111111111111","state":"Shutdown","dataPath":"$SIMDATA_CLOSED"},{"name":"$OPEN_ID-walk","udid":"22222222-2222-2222-2222-222222222222","state":"Shutdown","dataPath":"$SIMDATA_OPEN"}]}}
JSON
exit 0
fi
if [ "\${1:-}" = --set ] && [ "\${3:-}" = list ]; then
cat <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"XCTest clone","udid":"XCTEST-UDID","state":"Shutdown"}]}}
JSON
exit 0
fi
if [ "\${1:-}" = delete ]; then echo "delete \${2:-}" >> "\$LOG"; exit 0; fi
if [ "\${1:-}" = --set ] && [ "\${3:-}" = delete ] && [ "\${4:-}" = all ]; then echo "set-delete \${2:-} all" >> "\$LOG"; rm -rf "\${2:-}"; exit 0; fi
exit 2
SH
chmod +x "$FAKEBIN/pgrep" "$FAKEBIN/xcrun"
export PATH="$FAKEBIN:$PATH"

BUSY="$FIX/busy-container"
mkdir -p "$BUSY/seats" "$BUSY/.wheelhouse-bench.lock" "$BUSY/product/.wheelhouse-build"
git -C "$BUSY" init -q -b main
printf '{"seats":{}}\n' > "$BUSY/seats/state.json"
selftest_copy_seat_runtime "$BUSY" "$(dirname "$PRUNE")"
chmod +x "$BUSY/seats/prune.ts"
printf 'active-lock\n' > "$BUSY/.wheelhouse-bench.lock/pid"
printf 'busy-cache\n' > "$BUSY/product/.wheelhouse-build/cache.txt"

phase 'categories verb'
CATS=$(cd "$ROOT" && bun seats/prune.ts categories 2>&1)
if printf '%s\n' "$CATS" | grep >/dev/null 'merged-worktree' && printf '%s\n' "$CATS" | grep >/dev/null 'seat-anchor' && printf '%s\n' "$CATS" | grep >/dev/null 'bench-junk' && printf '%s\n' "$CATS" | grep >/dev/null 'run-scratch' && printf '%s\n' "$CATS" | grep >/dev/null 'bead-tmp' && printf '%s\n' "$CATS" | grep >/dev/null 'bead-simulator' && printf '%s\n' "$CATS" | grep >/dev/null 'xctest-devices'; then pass 'categories names worktree, bench-junk, scratch, simulator, xctest, and seat safety categories'; else fail "categories output missing expected categories: $CATS"; fi

phase 'scan classifies fixture rows'
SCAN="$FIX/scan.tsv"
( cd "$ROOT" && bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan failed" >&2; exit 2; }
if awk -F '\t' -v p="$WTS/$CLOSED_ID" '$1=="merged-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed merged clean worktree is safe merged-worktree'; else fail "closed merged worktree row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v b="fleet/$STALE_ID" '$1=="stale-branch" && $2=="1" && $5==b && $6=="0" && $7=="0.0B" {found=1} END{exit found?0:1}' "$SCAN"; then pass 'safe stale-branch reports zero reclaimed size'; else fail "stale-branch zero-size row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$UNMERGED_ID" '$1=="needs-review" && $2=="0" && $4==p && $5 ~ /^fleet\// && $9 ~ /not merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed but unmerged fleet worktree is needs-review'; else fail "unmerged branch guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$GOAL_CHILD_ID" '$1=="needs-review" && $2=="0" && $4==p && $5 ~ /^fleet\// && $9 ~ /not merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'goal-branch child is needs-review before integration-refs.txt exists'; else fail "goal child before integration-refs row missing:\n$(cat "$SCAN")"; fi
cat > "$ROOT/seats/integration-refs.txt" <<'EOF'
# extra integration branches for this install

fleet/goal-x
fleet/never-created
EOF
( cd "$ROOT" && bun seats/prune.ts scan > "$SCAN" ) || { echo "selftest: scan with integration-refs failed" >&2; exit 2; }
if awk -F '\t' -v p="$WTS/$GOAL_CHILD_ID" '$1=="merged-worktree" && $2=="1" && $4==p && $5 ~ /^fleet\// {found=1} END{exit found?0:1}' "$SCAN"; then pass 'goal-branch child becomes safe merged-worktree when its goal branch is listed'; else fail "goal child merged-worktree row missing after integration-refs:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v b="fleet/goal-x" '$1=="needs-review" && $2=="0" && $5==b && $9 ~ /listed integration ref/ {found=1} $1=="stale-branch" && $5==b {bad=1} END{exit found && !bad ? 0 : 1}' "$SCAN"; then pass 'listed goal branch is needs-review, never stale-branch'; else fail "listed goal branch guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$UNMERGED_ID" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /not merged/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'listed goal ref does not widen matching to unrelated fleet branches'; else fail "unrelated unmerged branch was widened by integration-refs:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$OPEN_ID" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /recorded cwd/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'current recorded seat cwd is classified as non-prunable seat-anchor'; else fail "recorded cwd seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/worker-rostered" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /worktree of rostered seat worker-rostered/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'rostered .wheelhouse-worktrees/<seat> directory is classified as non-prunable seat-anchor'; else fail "rostered seat worktree anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$LIVE_ID" '$1=="seat-anchor" && $2=="0" && $4==p && $9 ~ /live cwd/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'live lsof cwd beats stale state.json cwd and is a seat-anchor'; else fail "live cwd seat-anchor row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$CLOSED_LIVE_ID" -v id="$CLOSED_LIVE_ID" '$1=="needs-review" && $2=="0" && $4==p && $9 == "live process has its cwd here; worktree belongs to closed bead " id {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead live-cwd worktree reason includes exact closed-bead wording'; else fail "closed bead live-cwd reason missing exact wording:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$OPEN_LIVE_ID" -v id="$OPEN_LIVE_ID" '$1=="needs-review" && $2=="0" && $4==p && $9 == "live process has its cwd here; worktree belongs to open bead " id {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead live-cwd worktree reason includes exact open-bead wording'; else fail "open bead live-cwd reason missing exact wording:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/$HIST_ID" '$1=="merged-worktree" && $2=="1" && $4==p {found=1} $1=="seat-anchor" && $4==p {bad=1} END{exit found && !bad ? 0 : 1}' "$SCAN"; then pass 'session history cwd is scanned by normal closed-bead worktree rules, not as a seat-anchor'; else fail "session history worktree did not become a safe merged-worktree:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$WTS/orphaned-checkout" '$1=="orphaned-worktree" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'orphaned checkout is safe orphaned-worktree'; else fail "orphaned row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/.wheelhouse-build" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'build cache is safe build-cache'; else fail "build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/obj" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass '.NET obj cache is safe build-cache'; else fail "obj build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/dist" '$1=="build-cache" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'root dist is safe build-cache'; else fail "root dist build-cache row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/node_modules/pkg/dist" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /dependency/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'node_modules package dist is needs-review, not safe build-cache'; else fail "node_modules dist guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$PROD/node_modules/.bin" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /dependency/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'node_modules .bin is needs-review, not safe build-cache'; else fail "node_modules .bin guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$4 ~ /\/node_modules\// && $2=="1" {bad=1} END{exit bad?1:0}' "$SCAN"; then pass 'no safe scan rows appear under node_modules'; else fail "safe node_modules row present:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-bench.lock.stale.12345" '$1=="bench-junk" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'stale bench lock is safe bench-junk'; else fail "bench-junk row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-runs/$CLOSED_ID-build" '$1=="run-scratch" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead .wheelhouse-runs scratch is safe run-scratch'; else fail "closed bead-runs row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$ROOT/.wheelhouse-runs/$OPEN_ID-build" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead .wheelhouse-runs scratch is needs-review'; else fail "open bead-runs guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$CLOSED_TMP" '$1=="bead-tmp" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead tmp scratch is safe bead-tmp'; else fail "closed bead-tmp row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$OPEN_TMP" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead tmp scratch is needs-review'; else fail "open bead-tmp guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$1=="bead-simulator" && $2=="1" && $4=="simctl:11111111-1111-1111-1111-111111111111" {found=1} END{exit found?0:1}' "$SCAN"; then pass 'closed bead simctl device is safe bead-simulator'; else fail "closed bead-simulator row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' '$1=="needs-review" && $2=="0" && $4=="simctl:22222222-2222-2222-2222-222222222222" && $9 ~ /which is open/ {found=1} END{exit found?0:1}' "$SCAN"; then pass 'open bead simctl device is needs-review'; else fail "open bead-simulator guard row missing:\n$(cat "$SCAN")"; fi
if awk -F '\t' -v p="$HOME/Library/Developer/XCTestDevices" '$1=="xctest-devices" && $2=="1" && $4==p {found=1} END{exit found?0:1}' "$SCAN"; then pass 'idle XCTestDevices set is safe xctest-devices'; else fail "xctest-devices row missing:\n$(cat "$SCAN")"; fi

phase 'active bench lock makes caches review-only'
BUSY_SCAN="$FIX/busy-scan.tsv"
( cd "$BUSY" && bun seats/prune.ts scan > "$BUSY_SCAN" ) || { echo "selftest: busy scan failed" >&2; exit 2; }
if awk -F '\t' -v p="$BUSY/product/.wheelhouse-build" '$1=="needs-review" && $2=="0" && $4==p && $9 ~ /bench lock present/ {found=1} END{exit found?0:1}' "$BUSY_SCAN"; then pass 'active bench lock reclassifies cache as needs-review'; else fail "busy cache was not guarded:\n$(cat "$BUSY_SCAN")"; fi
( cd "$BUSY" && bun seats/prune.ts prune --from-file "$BUSY_SCAN" --yes --categories build-cache,needs-review > "$FIX/busy-prune.out" )
[ -d "$BUSY/product/.wheelhouse-build" ] && pass 'active-bench cache remains after prune --yes' || fail 'active-bench cache was removed'

phase 'dry-run does not touch rows'
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --categories merged-worktree,orphaned-worktree,build-cache,bench-junk,bead-runs,bead-tmp,bead-simulator,xctest-devices > "$FIX/prune-dry.out" )
if [ -d "$WTS/$CLOSED_ID" ] && [ -d "$WTS/orphaned-checkout" ] && [ -d "$PROD/.wheelhouse-build" ] && [ -d "$PROD/dist" ] && [ -d "$PROD/node_modules/pkg/dist" ] && [ -d "$PROD/node_modules/.bin" ] && [ -d "$ROOT/.wheelhouse-bench.lock.stale.12345" ] && [ -d "$ROOT/.wheelhouse-runs/$CLOSED_ID-build" ] && [ -d "$CLOSED_TMP" ] && [ -d "$HOME/Library/Developer/XCTestDevices" ]; then pass 'prune without --yes is dry-run only'; else fail 'dry-run removed a fixture path'; fi
( cd "$ROOT" && bun seats/prune.ts prune --from-file "$SCAN" --categories stale-branch > "$FIX/stale-branch-dry.out" )
if grep -q 'DRY-RUN branch stale-branch' "$FIX/stale-branch-dry.out" && grep -q 'reclaimed_bytes=0 reclaimed_human=0.0B' "$FIX/stale-branch-dry.out"; then pass 'stale-branch dry-run contributes zero reclaimed bytes'; else fail "stale-branch dry-run reclaimed bytes unexpectedly: $(cat "$FIX/stale-branch-dry.out")"; fi

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
if git -C "$PROD" branch --list "fleet/$CLOSED_ID" | grep >/dev/null . && git -C "$PROD" log -1 --format=%s "fleet/$CLOSED_ID" >/dev/null && ! grep -q 'PRUNED branch' "$FIX/prune.out"; then pass 'safe merged worktree prune keeps its merged branch ref'; else fail "merged worktree branch was deleted or PRUNED branch was logged: branch=$(git -C "$PROD" branch --list "fleet/$CLOSED_ID") output=$(cat "$FIX/prune.out")"; fi
if [ ! -e "$WTS/$GOAL_CHILD_ID" ] && git -C "$PROD" branch --list "fleet/$GOAL_CHILD_ID" | grep >/dev/null . && git -C "$PROD" log -1 --format=%s "fleet/$GOAL_CHILD_ID" >/dev/null && ! grep -q 'PRUNED branch' "$FIX/prune.out" && git -C "$PROD" branch --list fleet/goal-x | grep >/dev/null .; then pass 'goal-branch merged worktree prunes worktree while child and listed goal branches survive'; else fail "goal-branch prune outcome wrong: child_dir=$([ -e "$WTS/$GOAL_CHILD_ID" ] && echo present || echo gone) child_branch=$(git -C "$PROD" branch --list "fleet/$GOAL_CHILD_ID") goal_branch=$(git -C "$PROD" branch --list fleet/goal-x) output=$(cat "$FIX/prune.out")"; fi
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
if ! grep -q 'delete 22222222-2222-2222-2222-222222222222' "$FIX/xcrun.log"; then pass 'open bead simulator is not deleted'; else fail "open bead simulator was deleted: $(cat "$FIX/xcrun.log")"; fi
if grep -q 'prune summary: touched=11' "$FIX/prune.out" && grep -q 'reclaimed_bytes=' "$FIX/prune.out" && grep -q "SKIPPED merged-worktree $WTS/$HIST_ID reason=path no longer exists" "$FIX/prune.out"; then pass 'prune summary reports eleven touched rows; already-removed history row counts as skipped'; else fail "unexpected prune summary: $(cat "$FIX/prune.out")"; fi

phase 'host-budget auto_prune uses the real scanner and reviewed prune parser'
CAP_REAL="$FIX/actual-auto-prune"
mkdir -p "$CAP_REAL/seats/logs" "$CAP_REAL/seats/run" "$CAP_REAL/.wheelhouse-worktrees"
selftest_copy_seat_runtime "$CAP_REAL" "$(dirname "$PRUNE")"
git -C "$CAP_REAL" init -q -b main
git -C "$CAP_REAL" config user.email selftest@example.invalid
git -C "$CAP_REAL" config user.name selftest
printf 'owned cap fixture\n' > "$CAP_REAL/base.txt"
git -C "$CAP_REAL" add base.txt && git -C "$CAP_REAL" commit -q -m base
( cd "$CAP_REAL" && bd init --non-interactive --skip-agents -p cap >/dev/null 2>&1 ) || { echo 'selftest: cap graph init failed' >&2; exit 2; }
CAP_IDS=()
for n in 1 2; do
  id=$(cd "$CAP_REAL" && bd create "real auto-prune $n" --json | bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)')
  [ -n "$id" ] || { echo 'selftest: cap bead missing' >&2; exit 2; }
  CAP_IDS+=("$id")
  wt="$CAP_REAL/.wheelhouse-worktrees/$id"
  git -C "$CAP_REAL" worktree add -q -b "fleet/$id" "$wt" main
  printf 'work\n' > "$wt/$id.txt"
  git -C "$wt" add "$id.txt" && git -C "$wt" commit -q -m "work $id"
  git -C "$CAP_REAL" merge -q --no-ff "fleet/$id" -m "merge $id"
  ( cd "$CAP_REAL" && bd close "$id" >/dev/null 2>&1 )
done
printf '{"seats":{}}\n' > "$CAP_REAL/seats/seats.json"
printf '{"type":"agent_end"}\n' > "$CAP_REAL/seats/logs/fixture-status.jsonl"
printf '{"seats":{"fixture-status":{"pid":null,"role":"worker","log":"%s","fifo":"%s"}}}\n' "$CAP_REAL/seats/logs/fixture-status.jsonl" "$CAP_REAL/seats/run/fixture-status.stdin" > "$CAP_REAL/seats/state.json"
printf '{"enabled":true,"max_worktrees":1,"auto_prune":true}\n' > "$CAP_REAL/seats/host-budget.json"
CAP_BEFORE=$(git -C "$CAP_REAL" worktree list --porcelain | grep -c '^worktree ')
[ "$CAP_BEFORE" -eq 3 ] || { echo 'selftest: real cap subjects absent' >&2; exit 2; }
set +e
( cd "$CAP_REAL" && bun seats/adapter.ts status ) > "$FIX/cap-real.out" 2> "$FIX/cap-real.err"; CAP_REAL_RC=$?
set -e
printf 'MEASUREMENT real-auto-prune rc=%s\n' "$CAP_REAL_RC"
while IFS= read -r line; do printf '  adapter stdout: %s\n' "$line"; done < "$FIX/cap-real.out"
while IFS= read -r line; do printf '  adapter stderr: %s\n' "$line"; done < "$FIX/cap-real.err"
if [ "$CAP_REAL_RC" -eq 0 ] && grep -q 'HOST-BUDGET worktree cap exceeded' "$FIX/cap-real.out" && grep -q 'prune summary: touched=2' "$FIX/cap-real.out" && ! grep -q 'auto_prune failed' "$FIX/cap-real.out" && [ "$(git -C "$CAP_REAL" worktree list --porcelain | grep -c '^worktree ')" -eq 1 ] && [ ! -e "$CAP_REAL/.wheelhouse-worktrees/${CAP_IDS[0]}" ] && [ ! -e "$CAP_REAL/.wheelhouse-worktrees/${CAP_IDS[1]}" ] && grep -q '"kind": "wheelhouse-prune-scan"' "$CAP_REAL/seats/logs/prune-worktree-cap-scan.json"; then
  pass 'actual adapter auto_prune consumes bound JSON and removes two clean merged worktrees'
else fail "actual adapter auto_prune failed rc=$CAP_REAL_RC"; fi

# ---------------------------------------------------------------------------
# cleanup phases. One empty install proves the fresh-install case; every other
# phase seeds its own beads and paths in one shared install ($EXT) and scopes
# its cleanup with --bead, so phases never act on each other's rows.
# ---------------------------------------------------------------------------
set +e   # the phase above left -e on; these phases inspect exit codes themselves
json_id(){ bun -e 'let s=""; for await (const c of Bun.stdin.stream()) s+=Buffer.from(c).toString(); console.log(JSON.parse(s).id)'; }
EXT_PIDS=()
cleanup_ext(){ for p in ${EXT_PIDS[@]+"${EXT_PIDS[@]}"}; do kill "$p" >/dev/null 2>&1 || true; done; cleanup_prune; }
trap cleanup_ext EXIT INT TERM
mk_install(){ # $1 root: container git repo, nested product repo with a bare origin at $1.origin.git, prune.ts in place
  mkdir -p "$1/product" "$1/seats"
  selftest_copy_seat_runtime "$1" "$(dirname "$PRUNE")"
  git -C "$1" init -q -b main
  git -C "$1/product" init -q -b main
  git -C "$1/product" config user.email selftest@example.invalid
  git -C "$1/product" config user.name selftest
  printf 'base\n' > "$1/product/app.txt"
  git -C "$1/product" add app.txt; git -C "$1/product" commit -q -m base
  git -C "$1/product" init --bare -q "$1.origin.git"
  git -C "$1/product" remote add origin "$1.origin.git"
  git -C "$1/product" push -q -u origin main
}

phase 'ISC-71 fresh install with zero worktrees'
FRESH="$FIX/fresh"; mk_install "$FRESH"; mkdir -p "$FIX/fresh-home"
FRESH_SCAN=$(cd "$FRESH" && HOME="$FIX/fresh-home" bun seats/prune.ts scan --format jsonl 2>&1); FRESH_RC=$?
[ "$FRESH_RC" -eq 0 ] && [ "$(printf '%s\n' "$FRESH_SCAN" | grep -c .)" -eq 1 ] && printf '%s\n' "$FRESH_SCAN" | grep >/dev/null '"kind":"wheelhouse-prune-scan"' && pass 'scan on a fresh install prints root metadata only and exits 0' || fail "fresh scan rc=$FRESH_RC output: $FRESH_SCAN"
FRESH_OUT=$(cd "$FRESH" && HOME="$FIX/fresh-home" bun seats/prune.ts cleanup 2>&1); FRESH_RC=$?
[ "$FRESH_RC" -eq 0 ] && [ "$(printf '%s\n' "$FRESH_OUT" | grep -c .)" -eq 1 ] && printf '%s\n' "$FRESH_OUT" | grep >/dev/null 'Z cleanup done removed=0 kept=0 bytes=0$' && pass 'cleanup on a fresh install prints only "cleanup done removed=0 kept=0 bytes=0" and exits 0' || fail "fresh cleanup rc=$FRESH_RC output: $FRESH_OUT"

EXT="$FIX/ext"; EPROD="$EXT/product"; EWTS="$EXT/.wheelhouse-worktrees"; ERUNS="$EXT/.wheelhouse-runs"; ELOG="$EXT/seats/logs/cleanup.log"
mk_install "$EXT"; mkdir -p "$EWTS" "$ERUNS"
( cd "$EXT" && bd init --non-interactive --skip-agents -p ext >/dev/null 2>&1 ) || { echo "selftest: bd init failed in $EXT" >&2; exit 2; }
ext_bead(){ local id; id=$(cd "$EXT" && bd create "$1" --json | json_id); [ "${2:-closed}" = closed ] && ( cd "$EXT" && bd close "$id" >/dev/null 2>&1 ); printf '%s\n' "$id"; }
ext_wt(){ # $1 bead id, $2 optional dir: worktree on fleet/<id> with one commit touching <id>.txt
  local dir="${2:-$EWTS/$1}"
  git -C "$EPROD" worktree add -q -b "fleet/$1" "$dir" main || { fail "worktree add failed for $dir"; return 1; }
  [ -e "$dir/.git" ] || { fail "worktree $dir has no .git after git worktree add; refusing to commit"; return 1; }
  printf '%s\n' "$1" > "$dir/$1.txt"; git -C "$dir" add "$1.txt" && git -C "$dir" commit -q -m "work $1"
}
ext_merge(){ git -C "$EPROD" checkout -q main; git -C "$EPROD" merge -q --no-ff "fleet/$1" -m "merge $1"; git -C "$EPROD" push -q origin main; git -C "$EPROD" push -q origin "fleet/$1"; }
ext_scan(){ ( cd "$EXT" && bun seats/prune.ts scan --format jsonl > "$FIX/ext-scan.jsonl" 2>/dev/null ); }
ext_row(){ grep -F "\"path\":\"$1\"" "$FIX/ext-scan.jsonl"; }
ext_registered(){ git -C "$EPROD" worktree list --porcelain | grep -xF >/dev/null "worktree $1"; }
ext_cleanup(){ ( cd "$EXT" && bun seats/prune.ts cleanup "$@" 2>&1 ); }
ext_record_run(){
  ( cd "$EXT" && bun -e 'import {recordCleanupScratch} from "./seats/cleanup-identity.ts"; recordCleanupScratch(process.argv[1],process.argv[2],process.argv[3]);' "$EXT" "$1" "$2" ) || exit 2
}

phase 'install policy cleanup=off/report is honored by direct prune cleanup'
mkdir -p "$EXT/wheelhouse"
OFF_ID=$(ext_bead 'cleanup off direct')
mkdir -p "$ERUNS/$OFF_ID-run"
printf 'keep\n' > "$ERUNS/$OFF_ID-run/file.txt"
ext_record_run "$ERUNS/$OFF_ID-run" "$OFF_ID"
printf 'cleanup=off\n' > "$EXT/wheelhouse/.template-source"
OUT=$(ext_cleanup --bead "$OFF_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -e "$ERUNS/$OFF_ID-run/file.txt" ] && printf '%s\n' "$OUT" | grep >/dev/null 'cleanup skipped cleanup=off in wheelhouse/.template-source' && ! printf '%s\n' "$OUT" | grep >/dev/null 'removed run-scratch' && pass 'cleanup=off direct cleanup exits without deleting closed-bead scratch' || fail "cleanup=off direct rc=$RC out=$OUT exists=$([ -e "$ERUNS/$OFF_ID-run/file.txt" ] && echo yes || echo no)"
REPORT_ID=$(ext_bead 'cleanup report direct')
mkdir -p "$ERUNS/$REPORT_ID-run"
printf 'report\n' > "$ERUNS/$REPORT_ID-run/file.txt"
ext_record_run "$ERUNS/$REPORT_ID-run" "$REPORT_ID"
printf 'cleanup=report\n' > "$EXT/wheelhouse/.template-source"
OUT=$(ext_cleanup --bead "$REPORT_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -e "$ERUNS/$REPORT_ID-run/file.txt" ] && printf '%s\n' "$OUT" | grep >/dev/null "dry-run would remove run-scratch $ERUNS/$REPORT_ID-run " && grep -q "dry-run would remove run-scratch $ERUNS/$REPORT_ID-run " "$ELOG" && pass 'cleanup=report direct cleanup writes a would-remove report and deletes nothing' || fail "cleanup=report direct rc=$RC out=$OUT log=$(grep -F "$REPORT_ID" "$ELOG" 2>/dev/null) exists=$([ -e "$ERUNS/$REPORT_ID-run/file.txt" ] && echo yes || echo no)"
rm -rf "$ERUNS/$OFF_ID-run" "$ERUNS/$REPORT_ID-run"
printf 'cleanup=on\n' > "$EXT/wheelhouse/.template-source"

phase 'ISC-42 squash-merge and ISC-117 mayline/main integration ref'
git -C "$EPROD" init --bare -q "$FIX/ext-mayline.git"; git -C "$EPROD" remote add mayline "$FIX/ext-mayline.git"
MAY_ID=$(ext_bead 'merged only on mayline'); ext_wt "$MAY_ID"
git -C "$EPROD" checkout -q -b tmp-mayline main; git -C "$EPROD" merge -q --no-ff "fleet/$MAY_ID" -m "mayline merge"; git -C "$EPROD" push -q mayline tmp-mayline:main; git -C "$EPROD" checkout -q main; git -C "$EPROD" branch -q -D tmp-mayline
SQ_ID=$(ext_bead 'squash merged, never pushed'); ext_wt "$SQ_ID"
printf 'more\n' > "$EWTS/$SQ_ID/$SQ_ID-2.txt"; git -C "$EWTS/$SQ_ID" add "$SQ_ID-2.txt"; git -C "$EWTS/$SQ_ID" commit -q -m "work $SQ_ID part 2"
SQ_TIP=$(git -C "$EWTS/$SQ_ID" rev-parse HEAD)
git -C "$EPROD" merge -q --squash "fleet/$SQ_ID" >/dev/null 2>&1 && git -C "$EPROD" commit -q -m "squash $SQ_ID"; git -C "$EPROD" push -q origin main
ext_scan
ext_row "$EWTS/$MAY_ID" | grep >/dev/null '"category":"merged-worktree".*"reason":"[^"]*mayline/main' && pass 'branch merged only on mayline/main is merged-worktree naming mayline/main (ISC-117)' || fail "mayline row: $(ext_row "$EWTS/$MAY_ID")"
ext_row "$EWTS/$SQ_ID" | grep >/dev/null '"category":"merged-worktree".*"reason":"[^"]*squash-merged as [0-9a-f]\{12\} on [^"]*archive tag before removal' && pass 'squash-merged unpushed branch is merged-worktree naming the squash commit (ISC-42)' || fail "squash row: $(ext_row "$EWTS/$SQ_ID")"
OUT=$(ext_cleanup --bead "$MAY_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$MAY_ID" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed merged-worktree $EWTS/$MAY_ID " && pass 'mayline-merged worktree removed by cleanup' || fail "mayline cleanup rc=$RC: $OUT"
OUT=$(ext_cleanup --bead "$SQ_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$SQ_ID" ] && [ "$(git -C "$EPROD" rev-parse --verify --quiet "refs/tags/archive/$SQ_ID^{commit}")" = "$SQ_TIP" ] && git -C "$EPROD" branch --list "fleet/$SQ_ID" | grep >/dev/null . && pass 'squash-merged worktree removed after archive/<name> tag; branch ref kept (ISC-52/53)' || fail "squash cleanup rc=$RC tags=$(git -C "$EPROD" tag --list 'archive/*'): $OUT"

phase 'ISC-43 bead landed on origin/fleet/ootb-agent'
OOTB_ID=$(ext_bead 'landed on ootb-agent'); ext_wt "$OOTB_ID"
git -C "$EPROD" checkout -q -b fleet/ootb-agent main; git -C "$EPROD" merge -q --no-ff "fleet/$OOTB_ID" -m 'ootb merge'; git -C "$EPROD" push -q origin fleet/ootb-agent; git -C "$EPROD" checkout -q main; git -C "$EPROD" branch -q -D fleet/ootb-agent
ext_scan
ext_row "$EWTS/$OOTB_ID" | grep >/dev/null '"category":"merged-worktree".*"reason":"[^"]*fleet/ootb-agent' && pass 'bead merged only to origin/fleet/ootb-agent is merged-worktree naming that ref' || fail "ootb row: $(ext_row "$EWTS/$OOTB_ID")"
OUT=$(ext_cleanup --bead "$OOTB_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$OOTB_ID" ] && pass 'ootb-agent-merged worktree removed by cleanup' || fail "ootb cleanup rc=$RC: $OUT"

phase 'ISC-44 open bead with zero commits and no seat'
ZERO_ID=$(ext_bead 'open zero-commit bead' open)
git -C "$EPROD" worktree add -q -b "fleet/$ZERO_ID" "$EWTS/$ZERO_ID" main
ext_scan
ext_row "$EWTS/$ZERO_ID" | grep >/dev/null '"category":"zero-commit-worktree".*"reason":"[^"]*zero commits [^"]* no seat' && pass 'open bead at its base tip is zero-commit-worktree with a "zero commits ... no seat" reason' || fail "zero-commit row: $(ext_row "$EWTS/$ZERO_ID")"
OUT=$(ext_cleanup --bead "$ZERO_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$ZERO_ID" ] && git -C "$EPROD" branch --list "fleet/$ZERO_ID" | grep >/dev/null . && pass 'zero-commit worktree removed; its branch ref still exists' || fail "zero-commit cleanup rc=$RC branch=$(git -C "$EPROD" branch --list "fleet/$ZERO_ID"): $OUT"

phase 'ISC-45/56 run folder kept while a live process has its cwd inside'
RUN_ID=$(ext_bead 'closed bead with occupied run folder'); mkdir -p "$ERUNS/$RUN_ID-x"; printf 'scratch\n' > "$ERUNS/$RUN_ID-x/file.txt"
ext_record_run "$ERUNS/$RUN_ID-x" "$RUN_ID"
( cd "$ERUNS/$RUN_ID-x" && exec sleep 1000 ) >/dev/null 2>&1 & RUN_PID=$!; EXT_PIDS+=("$RUN_PID")
OUT=$(ext_cleanup --bead "$RUN_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$ERUNS/$RUN_ID-x" ] \
  && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $ERUNS/$RUN_ID-x reason=live process has its cwd" \
  && printf '%s\n' "$OUT" | grep >/dev/null "pid $RUN_PID" \
  && printf '%s\n' "$OUT" | grep >/dev/null "command sleep" \
  && printf '%s\n' "$OUT" | grep >/dev/null "cwd $ERUNS/$RUN_ID-x" \
  && pass 'run folder kept with holder pid, command, and cwd while occupied' || fail "occupied run folder did not name holder rc=$RC: $OUT"
kill "$RUN_PID" >/dev/null 2>&1; wait "$RUN_PID" 2>/dev/null
OUT=$(ext_cleanup --bead "$RUN_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$ERUNS/$RUN_ID-x" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed run-scratch $ERUNS/$RUN_ID-x " && pass 'run folder removed on the next cleanup once the process is gone' || fail "freed run folder rc=$RC: $OUT"
RO_ID=$(ext_bead 'closed bead with read-only scratch'); mkdir -p "$ERUNS/$RO_ID-run/.wheelhouse-verify-sources/allowed-sibling"
printf 'readonly\n' > "$ERUNS/$RO_ID-run/.wheelhouse-verify-sources/allowed-sibling/file.txt"
chmod -R a-w "$ERUNS/$RO_ID-run/.wheelhouse-verify-sources"
ext_record_run "$ERUNS/$RO_ID-run" "$RO_ID"
OUT=$(ext_cleanup --bead "$RO_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$ERUNS/$RO_ID-run" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed run-scratch $ERUNS/$RO_ID-run " && pass 'cleanup removes closed-bead scratch containing a read-only source snapshot subtree' || { chmod -R u+w "$ERUNS/$RO_ID-run" 2>/dev/null || true; fail "read-only scratch cleanup rc=$RC: $OUT"; }

phase 'ISC-46/138 concurrent cleanups, lock refusal, and a race with another remover'
CA_ID=$(ext_bead 'concurrent close A'); CB_ID=$(ext_bead 'concurrent close B')
mkdir -p "$ERUNS/$CA_ID-run" "$ERUNS/$CB_ID-run"; printf 'a\n' > "$ERUNS/$CA_ID-run/f"; printf 'b\n' > "$ERUNS/$CB_ID-run/f"
ext_record_run "$ERUNS/$CA_ID-run" "$CA_ID"; ext_record_run "$ERUNS/$CB_ID-run" "$CB_ID"
ext_cleanup --bead "$CA_ID" --wait 30 > "$FIX/ext-ca.out" & CA_PID=$!
ext_cleanup --bead "$CB_ID" --wait 30 > "$FIX/ext-cb.out" & CB_PID=$!
wait "$CA_PID"; CA_RC=$?; wait "$CB_PID"; CB_RC=$?
[ "$CA_RC" -eq 0 ] && [ "$CB_RC" -eq 0 ] && [ ! -e "$ERUNS/$CA_ID-run" ] && [ ! -e "$ERUNS/$CB_ID-run" ] && pass 'two parallel bead-scoped cleanups both exit 0 and both run folders are gone' || fail "parallel cleanups rc=$CA_RC/$CB_RC: $(cat "$FIX/ext-ca.out" "$FIX/ext-cb.out")"
[ "$(grep -c "removed run-scratch $ERUNS/$CA_ID-run " "$ELOG")" -eq 1 ] && [ "$(grep -c "removed run-scratch $ERUNS/$CB_ID-run " "$ELOG")" -eq 1 ] && pass 'cleanup log has exactly one removed line per bead (ISC-46)' || fail "log lines for A/B: $(grep -E "$CA_ID-run|$CB_ID-run" "$ELOG")"
grep -q 'already running' "$FIX/ext-ca.out" "$FIX/ext-cb.out" && fail 'a --wait cleanup gave up with "already running"' || pass 'neither waiting cleanup gave up on the lock'
mkdir -p "$EXT/seats/run/cleanup.lock"; printf '%s\n' "$$" > "$EXT/seats/run/cleanup.lock/pid"
T0=$(date +%s); OUT=$(ext_cleanup); RC=$?; T1=$(date +%s)
[ "$RC" -eq 0 ] && [ "$OUT" = "already running" ] && [ $((T1-T0)) -le 3 ] && pass 'a cleanup while another holds the lock prints only "already running", exits 0, within ~1 s' || fail "lock refusal rc=$RC after $((T1-T0))s: $OUT"
rm -rf "$EXT/seats/run/cleanup.lock"
RACE_ID=$(ext_bead 'removed by another actor between scan and act'); mkdir -p "$ERUNS/$RACE_ID-run"; printf 'r\n' > "$ERUNS/$RACE_ID-run/f"
ext_record_run "$ERUNS/$RACE_ID-run" "$RACE_ID"
OUT=$(ext_cleanup --dry-run --bead "$RACE_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$ERUNS/$RACE_ID-run" ] && printf '%s\n' "$OUT" | grep >/dev/null "dry-run would remove run-scratch $ERUNS/$RACE_ID-run " && pass 'dry-run lists the run folder and leaves it in place' || fail "race dry-run rc=$RC: $OUT"
# The scan's lsof pass is call 1; the per-row re-verification right before acting is call 2. Removing the
# path there is exactly "another actor got there first" between scan and act.
RACE_LSOF="$FIX/race-lsof.sh"; RACE_COUNT="$FIX/race-lsof.count"; rm -f "$RACE_COUNT"
cat > "$RACE_LSOF" <<SH
#!/usr/bin/env bash
n=\$(cat "$RACE_COUNT" 2>/dev/null || echo 0); n=\$((n+1)); printf '%s\n' "\$n" > "$RACE_COUNT"
[ "\$n" -eq 2 ] && rm -rf "$ERUNS/$RACE_ID-run"
exec /usr/sbin/lsof "\$@"
SH
chmod +x "$RACE_LSOF"
OUT=$(WHEELHOUSE_LSOF="$RACE_LSOF" ext_cleanup --bead "$RACE_ID"); RC=$?
[ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep >/dev/null "already removed $ERUNS/$RACE_ID-run$" && ! printf '%s\n' "$OUT" | grep >/dev/null "^[^ ]* removed run-scratch $ERUNS/$RACE_ID-run " && pass 'a row removed between scan and act logs "already removed", no removed line, exit 0 (ISC-138)' || fail "race cleanup rc=$RC count=$(cat "$RACE_COUNT" 2>/dev/null): $OUT"
[ -z "$(git -C "$EPROD" worktree prune --dry-run 2>&1)" ] && pass 'worktree registry needs no prune after the race' || fail "registry inconsistent: $(git -C "$EPROD" worktree prune --dry-run 2>&1)"

phase 'ISC-50 bead closed while its seat is mid-push'
PUSH_ID=$(ext_bead 'closed mid-push'); ext_wt "$PUSH_ID"; ext_merge "$PUSH_ID"
( cd "$FIX" && exec sleep 1000 ) >/dev/null 2>&1 & PUSH_PID=$!; EXT_PIDS+=("$PUSH_PID")
mkdir -p "$EXT/seats/run"; printf '{"seat":"worker-1","branch":"fleet/%s","worktree":"%s","pid":%s}\n' "$PUSH_ID" "$EWTS/$PUSH_ID" "$PUSH_PID" > "$EXT/seats/run/push.worker-1.json"
OUT=$(ext_cleanup --bead "$PUSH_ID"); RC=$?
[ "$RC" -eq 0 ] && [ -d "$EWTS/$PUSH_ID" ] && printf '%s\n' "$OUT" | grep >/dev/null "kept needs-review $EWTS/$PUSH_ID reason=deferred: push in progress" && pass 'worktree kept with "deferred: push in progress" while the push marker names a live pid' || fail "mid-push rc=$RC: $OUT"
rm -f "$EXT/seats/run/push.worker-1.json"; kill "$PUSH_PID" >/dev/null 2>&1; wait "$PUSH_PID" 2>/dev/null
OUT=$(ext_cleanup --bead "$PUSH_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$PUSH_ID" ] && printf '%s\n' "$OUT" | grep >/dev/null "removed merged-worktree $EWTS/$PUSH_ID " && pass 'worktree removed once the push has ended' || fail "post-push rc=$RC: $OUT"

phase 'ISC-51 oversized worktree follows the same rules'
BIG_ID=$(ext_bead 'oversized build output'); ext_wt "$BIG_ID"
printf 'target/\n' > "$EWTS/$BIG_ID/.gitignore"; git -C "$EWTS/$BIG_ID" add .gitignore; git -C "$EWTS/$BIG_ID" commit -q -m 'ignore target'; ext_merge "$BIG_ID"
mkdir -p "$EWTS/$BIG_ID/target"
if command -v mkfile >/dev/null 2>&1; then mkfile -n 21g "$EWTS/$BIG_ID/target/big"; else dd if=/dev/zero of="$EWTS/$BIG_ID/target/big" bs=1 count=0 seek=21g 2>/dev/null; fi
BIG_APPARENT=$(stat -f %z "$EWTS/$BIG_ID/target/big" 2>/dev/null || stat -c %s "$EWTS/$BIG_ID/target/big"); BIG_ALLOC_K=$(du -sk "$EWTS/$BIG_ID/target/big" | awk '{print $1}')
[ "$BIG_APPARENT" -ge 22000000000 ] && [ "$BIG_ALLOC_K" -lt 1048576 ] && pass "21 GB sparse build file allocates only ${BIG_ALLOC_K}K" || fail "sparse file apparent=$BIG_APPARENT allocated=${BIG_ALLOC_K}K"
[ -z "$(git -C "$EWTS/$BIG_ID" status --porcelain --untracked-files=all)" ] && pass 'ignored build output leaves the tree clean' || fail 'tree not clean with ignored target/'
ext_scan
ext_row "$EWTS/$BIG_ID" | grep >/dev/null '"category":"merged-worktree"' && pass 'oversized merged worktree is still merged-worktree; size never changes the category' || fail "oversized row: $(ext_row "$EWTS/$BIG_ID")"
OUT=$(ext_cleanup --bead "$BIG_ID"); RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$EWTS/$BIG_ID" ] && ! ext_registered "$EWTS/$BIG_ID" && pass 'oversized worktree removed by cleanup' || fail "oversized cleanup rc=$RC: $OUT"

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
! grep -E "^[^ ]+ removed [^ ]+ ($EWTS/$LINK_ID|$EWTS/linked-orphan|$FIX/elsewhere)" "$ELOG" | grep >/dev/null . && pass 'no removed line names a symlinked or out-of-container path' || fail "removed line for a symlinked path: $(grep -F elsewhere "$ELOG")"
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
  echo 'prune.selftest: PASS'
  exit 0
fi
echo "prune.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
