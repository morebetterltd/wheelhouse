import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
const [root,library,here]=process.argv.slice(2);
assert(root&&library&&here);
const parent=fs.realpathSync(path.dirname(root));
const outer=fs.readFileSync(path.join(parent,'.wheelhouse-selftest-fixture'),'utf8');
assert(outer.includes(`nonce=${process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE}\nroot=${parent}\n`));
fs.mkdirSync(root,{mode:0o700});
const suites=['adapter','verify','reset','legibility','isolation','concurrency'];
const body=String.raw`set -u
. "$LIB"
if [ -n "${'$'}{WHEELHOUSE_TEST_STALE_SWEEP_OVERRIDE:-}" ]; then . "$WHEELHOUSE_TEST_STALE_SWEEP_OVERRIDE"; fi
mkdir -p "$CASE_DIR/tmp"
export TMPDIR="$CASE_DIR/tmp"
marker() {
  printf 'prefix=%s\npid=%s\nstarted=2026-10-18T00:00:00Z\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nroot=%s\n' "$2" "$3" "${'$'}{4:-$1}" > "$1/.wheelhouse-selftest-fixture"
}
plant() { mkdir -p "$1"; printf 'KEEP\n' > "$1/KEEP"; }
A="$TMPDIR/$PREFIX.999999.unmarked"; B="$TMPDIR/$PREFIX.999999.foreign"; C="$TMPDIR/$PREFIX.$DEAD_PID.owned"
plant "$A"; plant "$B"; plant "$C"
[ -f "$A/KEEP" ] && [ -f "$B/KEEP" ] && [ -f "$C/KEEP" ] || exit 2
marker "$B" another-suite 999999
marker "$C" "$PREFIX" "$DEAD_PID"
# These additional marker checks use a valid dead pid too: otherwise Darwin's
# range error would mask a removed marker predicate.
for kind in foreign-dead bad-pid bad-root empty-marker marker-fifo marker-link trailing-marker; do plant "$TMPDIR/$PREFIX.$DEAD_PID.$kind"; done
marker "$TMPDIR/$PREFIX.$DEAD_PID.foreign-dead" another-suite "$DEAD_PID"
marker "$TMPDIR/$PREFIX.$DEAD_PID.bad-pid" "$PREFIX" 999999
marker "$TMPDIR/$PREFIX.$DEAD_PID.bad-root" "$PREFIX" "$DEAD_PID" "$A"
: > "$TMPDIR/$PREFIX.$DEAD_PID.empty-marker/.wheelhouse-selftest-fixture"
mkfifo "$TMPDIR/$PREFIX.$DEAD_PID.marker-fifo/.wheelhouse-selftest-fixture"
ln -s "$C/.wheelhouse-selftest-fixture" "$TMPDIR/$PREFIX.$DEAD_PID.marker-link/.wheelhouse-selftest-fixture"
marker "$TMPDIR/$PREFIX.$DEAD_PID.trailing-marker" "$PREFIX" "$DEAD_PID"
printf junk >> "$TMPDIR/$PREFIX.$DEAD_PID.trailing-marker/.wheelhouse-selftest-fixture"
LIVE="$TMPDIR/$PREFIX.1.live"; plant "$LIVE"; marker "$LIVE" "$PREFIX" 1
# Actual allocation tests the explicit suite-prefix API. Its owner is alive.
OWN="$(selftest_make_fixture_dir "$TMPDIR/$PREFIX.$$.allocated-XXXXXX" "$PREFIX")" || exit 2
selftest_isolate_git "$OWN" || exit 2
printf 'KEEP\n' > "$OWN/KEEP"
printf '%s\n' "$OWN" > "$CASE_DIR/allocated-path"
cp -f "$OWN/.wheelhouse-selftest-fixture" "$CASE_DIR/actual-marker"
# No nonzero signal may be sent by a refusal/removal-only fixture.
kill() { if [ "${'$'}{1:-}" = -0 ]; then builtin kill "$@"; else printf 'unexpected signal %s\n' "$*" >> "$CASE_DIR/signals"; return 2; fi; }
selftest_sweep_stale_fixtures "$PREFIX"
# A ps error is not absence, even when kill0 definitely observes ESRCH.
mkdir -p "$CASE_DIR/ps-error"
export TMPDIR="$CASE_DIR/ps-error"
D="$TMPDIR/$PREFIX.$DEAD_PID.unknown"; plant "$D"; marker "$D" "$PREFIX" "$DEAD_PID"
# Native Darwin capture: ps -p 999999 -o pid= exits1 with this diagnostic.
ps() { printf 'ps: process id too large: 999999\n' >&2; return 1; }
selftest_sweep_stale_fixtures "$PREFIX"
unset -f ps
`;
const rows=[];
for(const suite of suites){
 const prefix=`wheelhouse-${suite}-selftest`,dir=path.join(root,suite);fs.mkdirSync(dir,{mode:0o700});
 // Reap a real native child, not an out-of-range numeric placeholder. Darwin
 // ps rejects 999999 as too large; the two marker-refused cases keep that name.
 const reaper=spawn('bash',['-c',':'],{stdio:'ignore'});
 const reaped=await new Promise((resolve,reject)=>{reaper.once('error',reject);reaper.once('close',(code,signal)=>resolve({code,signal}));});
 const deadPid=reaper.pid;assert(Number.isInteger(deadPid)&&deadPid>1);assert.equal(reaped.code,0);assert.equal(reaped.signal,null);
 assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'},'reaped owner must still be absent');
 const ps=spawnSync('ps',['-p',String(deadPid),'-o','pid='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
 const absence={pid:deadPid,...reaped,psStatus:ps.status,psSignal:ps.signal,psStdout:ps.stdout,psStderr:ps.stderr};
 fs.writeFileSync(path.join(dir,'reaped.json'),JSON.stringify(absence,null,2)+'\n');console.log(JSON.stringify({nativeDeadOwner:absence}));
 assert.equal(ps.status,1);assert.equal(ps.signal,null);assert.equal(ps.stdout,'');assert.equal(ps.stderr,'');
 const source=fs.readFileSync(path.join(here,`${suite}.selftest.sh`),'utf8');
 assert(!source.includes('sweep_stale_fixtures() {'),'duplicate stale implementation removed');
 assert(source.includes('selftest_sweep_stale_fixtures "$FIX_PREFIX" || exit 2'));
 assert(source.includes('selftest_make_fixture_dir "${TMPDIR:-/tmp}/$FIX_PREFIX.$$.XXXXXX" "$FIX_PREFIX"'));
 const script=path.join(dir,'run.sh');fs.writeFileSync(script,body);
 const child=spawn('bash',[script],{env:{...process.env,CASE_DIR:dir,PREFIX:prefix,LIB:library,DEAD_PID:String(deadPid)},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',stdoutEOF=false,stderrEOF=false;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('end',()=>stdoutEOF=true);child.stderr.on('end',()=>stderrEOF=true);
 const native=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 fs.writeFileSync(path.join(dir,'stdout'),stdout);fs.writeFileSync(path.join(dir,'stderr'),stderr);
 const keep=(kind,pid=deadPid)=>{const file=path.join(dir,'tmp',`${prefix}.${pid}.${kind}`,'KEEP');return fs.existsSync(file)&&fs.readFileSync(file,'utf8')==='KEEP\n';};
 const state={unmarkedKeep:keep('unmarked',999999),foreignKeep:keep('foreign',999999),foreignDeadKeep:keep('foreign-dead'),ownedRemoved:!fs.existsSync(path.join(dir,'tmp',`${prefix}.${deadPid}.owned`)),badPidKeep:keep('bad-pid'),badRootKeep:keep('bad-root'),emptyMarkerKeep:keep('empty-marker'),fifoMarkerKeep:keep('marker-fifo'),symlinkMarkerKeep:keep('marker-link'),trailingMarkerKeep:keep('trailing-marker'),liveKeep:fs.existsSync(path.join(dir,'tmp',`${prefix}.1.live/KEEP`)),psUnknownKeep:fs.existsSync(path.join(dir,'ps-error',`${prefix}.${deadPid}.unknown/KEEP`)),signals:fs.existsSync(path.join(dir,'signals'))};
 let error=null;
 try{
  assert.equal(native.code,0);assert.equal(native.signal,null);assert(stdoutEOF&&stderrEOF);
  const allocation=fs.readFileSync(path.join(dir,'allocated-path'),'utf8').trim();assert(allocation&&fs.statSync(allocation).isDirectory(),'actual allocator subject exists');assert(fs.existsSync(path.join(allocation,'KEEP')),'live actual allocation spared');
  const marker=fs.readFileSync(path.join(dir,'actual-marker'),'utf8');assert(marker.startsWith(`prefix=${prefix}\npid=`),'explicit suite prefix metadata');
  for(const[key,value]of Object.entries(state))assert.equal(value,key==='signals'?false:true,key);
  for(const kind of ['unmarked','foreign'])assert(stdout.includes(`skipped: ${path.join(dir,'tmp',`${prefix}.999999.${kind}`)} (`),'skips name preserved targets');
  assert(stdout.includes(`swept: removed stale fixture ${path.join(dir,'tmp',`${prefix}.${deadPid}.owned`)}`));
 }catch(e){error=String(e);}
 process.stdout.write(`--- ${suite} child stdout ---\n${stdout}`);process.stderr.write(stderr);
 const row={suite,prefix,deadPid,...native,stdoutEOF,stderrEOF,state,passed:error===null,error};rows.push(row);console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(rows,null,2)+'\n');
const failed=rows.filter(row=>!row.passed).length;console.log(`stale fixture sweeps: ${rows.length} prefixes, ${failed} failures`);process.exitCode=failed?1:0;
