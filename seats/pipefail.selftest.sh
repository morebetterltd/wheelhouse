#!/usr/bin/env bash
# Exercise the shipped reader expressions, not a hand-written replacement.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-pipefail.XXXXXX")" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Alternate source directory is for removed-fix checks; no adapter is executed.
SOURCE="${1:-$HERE}"
python3 - "$SOURCE" "$FIX" <<'PY'
from pathlib import Path
import sys
source,fix=map(Path,sys.argv[1:])
adapter=(source/'adapter.selftest.sh').read_text().splitlines()
herald=(source/'herald.selftest.sh').read_text().splitlines()
checks=[line for line in adapter if line.startswith('if [ $RC -eq 0 ] && ') and "'PRUNED worktree merged-worktree'" in line]
assert len(checks)==1, 'adapter auto_prune check must exist exactly once'
grep=checks[0].split(' && ',1)[1].split(' && [ ! -e ',1)[0]
heads=[line for line in adapter if line.startswith('CLEAN_PID="$(')]
assert len(heads)==1, 'adapter first-pid check must exist exactly once'
head=heads[0].split('"$(',1)[1].rsplit(')"',1)[0]
awks=[line for line in herald if 'found="$(printf' in line]
assert len(awks)==1, 'herald first-pane check must exist exactly once'
awk=awks[0].split('"$(',1)[1].rsplit(')"',1)[0]
# At least 4 MiB, including many matching records after the first. The old
# readers close before those bytes are written; the fix must drain them all.
pad='padding line '+('x'*100)+'\n'
match='PRUNED worktree merged-worktree fixture\n'
(fix/'grep-early').write_text(match+pad*40000)
(fix/'grep-late').write_text(pad*40000+match)
(fix/'grep-absent').write_text(pad*40000)
(fix/'head-early').write_text('spawned pid 123\n'*300000)
(fix/'awk-early').write_text('%77\t/fixture\n'*350000)
for name,check in [('grep',grep),('head',head),('awk',awk)]:
    (fix/(name+'.sh')).write_text('''set -uo pipefail
OUT="$(< "$1")"
FAKE_TMUX_PANE_PATHS="$OUT"
target=%77
if [ "${PRODUCER_FAIL:-0}" = 1 ]; then
  printf(){ builtin printf "$@"; return 7; }
fi
'''+check+'''
rc=$? stages=("${PIPESTATUS[@]}")
builtin printf 'pipeline=%s stages=%s\n' "$rc" "${stages[*]}" >&2
exit "$rc"
''')
    print(name+' shipped expression: '+check)
for name in ['grep-early','grep-late','grep-absent','head-early','awk-early']:
    assert (fix/name).stat().st_size>=4*1024*1024
    print(name+' bytes='+str((fix/name).stat().st_size))
PY
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
