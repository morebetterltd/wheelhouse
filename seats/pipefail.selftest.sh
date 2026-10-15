#!/usr/bin/env bash
# Exercise the shipped reader expressions, not a hand-written replacement.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-pipefail.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Alternate source directory is for removed-fix checks; no adapter is executed.
SOURCE="${1:-$HERE}"
bun - "$SOURCE" "$FIX" <<'JS'
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const [source,fix]=process.argv.slice(2);
const adapter=fs.readFileSync(path.join(source,'adapter.selftest.sh'),'utf8').split('\n');
const herald=fs.readFileSync(path.join(source,'herald.selftest.sh'),'utf8').split('\n');
const checks=adapter.filter(s=>s.startsWith('if [ $RC -eq 0 ] && ')&&s.includes("'PRUNED worktree merged-worktree'"));
assert.equal(checks.length,1,'adapter auto_prune check must exist exactly once');
const grep=checks[0].slice(checks[0].indexOf(' && ')+4).split(' && [ ! -e ')[0];
const heads=adapter.filter(s=>s.startsWith('CLEAN_PID="$('));
assert.equal(heads.length,1,'adapter first-pid check must exist exactly once');
const awks=herald.filter(s=>s.includes('found="$(printf'));
assert.equal(awks.length,1,'herald first-pane check must exist exactly once');
const inner=s=>s.slice(s.indexOf('"$(')+3,s.lastIndexOf(')"'));
const pad='padding line '+'x'.repeat(100)+'\n', match='PRUNED worktree merged-worktree fixture\n';
for(const [name,data] of Object.entries({
  'grep-early':match+pad.repeat(40000), 'grep-late':pad.repeat(40000)+match,
  'grep-absent':pad.repeat(40000), 'head-early':'spawned pid 123\n'.repeat(300000),
  'awk-early':'%77\t/fixture\n'.repeat(350000)
})) fs.writeFileSync(path.join(fix,name),data);
const before=['set -uo pipefail','OUT="$(< "$1")"','FAKE_TMUX_PANE_PATHS="$OUT"','target=%77',
  'if [ "${PRODUCER_FAIL:-0}" = 1 ]; then','  printf(){ builtin printf "$@"; return 7; }','fi',''].join('\n');
const after=['','rc=$? stages=("${PIPESTATUS[@]}")',
  'builtin printf \'pipeline=%s stages=%s\\n\' "$rc" "${stages[*]}" >&2','exit "$rc"',''].join('\n');
for(const [name,check] of [['grep',grep],['head',inner(heads[0])],['awk',inner(awks[0])]]) {
  fs.writeFileSync(path.join(fix,name+'.sh'),before+check+after);
  console.log(name+' shipped expression: '+check);
}
for(const name of ['grep-early','grep-late','grep-absent','head-early','awk-early']) {
  const size=fs.statSync(path.join(fix,name)).size; assert.ok(size>=4*1024*1024);
  console.log(name+' bytes='+size);
}
JS
[ "$?" = 0 ] || exit 2
FAILED=0
for name in grep head awk; do
  bad=0
  for round in {1..16}; do
    rc=0
    bash "$FIX/$name.sh" "$FIX/$name-early" > "$FIX/result.out" 2> "$FIX/result.err" || rc=$?
    [ "$rc" = 0 ] || bad=$((bad+1))
  done
  if [ "$bad" = 0 ]; then echo "PASS $name: first-line match in >4 MiB passes 16/16 under pipefail"
  else echo "FAIL $name: $bad/16 false failures; last exit=$rc"; grep 'pipeline=' "$FIX/result.err"; FAILED=$((FAILED+1)); fi
  if [ "$name" = head ] && [ "$(< "$FIX/result.out")" != 123 ]; then echo 'FAIL head: first pid changed'; FAILED=$((FAILED+1)); fi
  if [ "$name" = awk ] && [ "$(< "$FIX/result.out")" != /fixture ]; then echo 'FAIL awk: first pane changed'; FAILED=$((FAILED+1)); fi
 done
rc=0
bash "$FIX/grep.sh" "$FIX/grep-late" > "$FIX/late.out" 2> "$FIX/late.err" || rc=$?
[ "$rc" = 0 ] && [ ! -s "$FIX/late.out" ] && echo 'PASS grep: late match passes with quiet stdout' || { echo "FAIL grep: late match exit=$rc"; FAILED=$((FAILED+1)); }
rc=0
bash "$FIX/grep.sh" "$FIX/grep-absent" > "$FIX/absent.out" 2> "$FIX/absent.err" || rc=$?
[ "$rc" = 1 ] && grep -Fx 'pipeline=1 stages=0 1' "$FIX/absent.err" >/dev/null && [ ! -s "$FIX/absent.out" ] && echo 'PASS grep: no match is exit 1 with producer=0' || { echo "FAIL grep: no match exit=$rc"; FAILED=$((FAILED+1)); }
rc=0
PRODUCER_FAIL=1 bash "$FIX/grep.sh" "$FIX/grep-early" > "$FIX/failure.out" 2> "$FIX/failure.err" || rc=$?
[ "$rc" = 7 ] && grep -Fx 'pipeline=7 stages=7 0' "$FIX/failure.err" >/dev/null && echo 'PASS grep: actual producer error is preserved, not hidden by matching output' || { echo "FAIL grep: producer error exit=$rc"; FAILED=$((FAILED+1)); }
[ "$FAILED" = 0 ] && { echo 'pipefail.selftest: PASS (6 checks; 48 early-match trials)'; exit 0; }
echo "pipefail.selftest: FAIL ($FAILED checks)"; exit 1
