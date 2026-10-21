#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
# evidence-scrub.selftest.sh — proves the evidence scrubber redacts planted
# machine-shaped paths before a capture is written.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRUB="${1:-$HERE/evidence-scrub.sh}"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }

FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-evidence-scrub-selftest.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
OUT="$FIX/capture.txt"

USER_RAW="$(id -un 2>/dev/null || true)"
HOME_RAW="${HOME:-/Users/$USER_RAW}"
TMP_RAW="${TMPDIR:-/tmp}"

"$SCRUB" -o "$OUT" -- bash -c 'printf "tmp=%s\nvar=%s\nhome=%s\nuser=%s\n" "$1" "/var/folders/zz/planted/path/file.log" "$2/Library/planted" "$3"' _ "$TMP_RAW/wheelhouse.planted/file.log" "$HOME_RAW" "$USER_RAW"
RC=$?
if [ $RC -eq 0 ] && [ -s "$OUT" ]; then pass "capture command writes a non-empty scrubbed evidence file"
else fail "capture command failed or wrote no evidence (rc=$RC)"; fi

if grep -q '\[tmpdir\]' "$OUT" && grep -q '\[home\]' "$OUT" && grep -q '\[user\]' "$OUT"; then
  pass "planted tmp, home, and username values are redacted"
else
  fail "scrubbed capture is missing one or more placeholders: $(tr '\n' ' ' < "$OUT")"
fi

LEAKS=0
[ -n "$USER_RAW" ] && grep -qF "$USER_RAW" "$OUT" && LEAKS=$((LEAKS + 1))
grep -qF "$HOME_RAW" "$OUT" && LEAKS=$((LEAKS + 1))
grep -qF "/var/folders/zz/planted/path" "$OUT" && LEAKS=$((LEAKS + 1))
grep -qF "$TMP_RAW/wheelhouse.planted" "$OUT" && LEAKS=$((LEAKS + 1))
if [ $LEAKS -eq 0 ]; then pass "scrubbed capture contains none of the planted raw values"
else fail "scrubbed capture leaked $LEAKS planted raw value(s): $(tr '\n' ' ' < "$OUT")"; fi

# Keep the regression inline: installed-layout checks copy this suite alone.
if bun - "$SCRUB" "$FIX" <<'JS'
// Real scrubber entry points, owned HOME/TMPDIR, and adversarial basenames.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const [scrub,root]=process.argv.slice(2);
assert(fs.statSync(scrub).isFile());
assert(fs.statSync(path.join(root,'.wheelhouse-selftest-fixture')).isFile());
const user=spawnSync('id',['-un'],{encoding:'utf8'});assert.equal(user.status,0,user.stderr);const rawUser=user.stdout.trim();assert(rawUser);
let failures=0;
for(const base of ['home','tmpdir','user','h','x[ho','[home]']){
 const dir=path.join(root,'placeholders-'+base),home=path.join(dir,base),tmp=path.join(dir,'scratch');fs.mkdirSync(home,{recursive:true});fs.mkdirSync(tmp);
 const env={...process.env,HOME:home,TMPDIR:tmp};
 const input=`p0=${tmp}/planted.log\np1=${home}/Library/planted\np2=${rawUser}\np3=/var/folders/zz/planted/file.log\np4=x[home]|[tmpdir]|[home]|[user]\np5=${base}\n`;
 const expected='p0=[tmpdir]/planted.log\np1=[home]/Library/planted\np2=[user]\np3=[tmpdir]\np4=x[home]|[tmpdir]|[home]|[user]\np5='+(base==='[home]'?'[home]':'[user]')+'\n';
 function run(args,text){const r=spawnSync('bash',args,{env,input:text,encoding:'utf8'});assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout;}
 try{
  const first=run([scrub],input);fs.writeFileSync(path.join(dir,'first.txt'),first);assert.equal(first,expected,'stdin redaction or opaque tokens');
  const second=run([scrub],first);assert.equal(second,first,'second scrub changed placeholders');
  const sourced=run(['-c','. "$1"; scrub_evidence','source-scrubber',scrub],input);assert.equal(sourced,expected,'sourced API differs');
  const output=path.join(dir,'capture.txt');run([scrub,'-o',output,'--','bash','-c','printf "%s" "$1"','planted',input],'');assert.equal(fs.readFileSync(output,'utf8'),expected,'capture API differs');
  console.log(`PASS opaque placeholders HOME=${base}: stdin/source/capture match, raw values redacted, second pass byte-identical`);
 }catch(e){failures++;console.error(`FAIL opaque placeholders HOME=${base}: ${e.message}`);}
}
assert.equal(failures,0,`${failures} placeholder basename cases failed`);
JS
then
  pass "common HOME basenames preserve existing and emitted placeholders across all entry points"
else
  fail "opaque-placeholder regression"
fi

if [ $FAILED -eq 0 ]; then
  printf '\nevidence-scrub.selftest: PASS\n'
  exit 0
fi
printf '\nevidence-scrub.selftest: FAIL (%s)\n' "$FAILED"
exit 1
