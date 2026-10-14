#!/usr/bin/env bash
# Native daemon/signal regressions, isolated roots, no providers or installed services.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
. "$HERE/selftest-herald.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-herald-lifetime.XXXXXX")"
selftest_bind_herald_owner "$FIX"
trap 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Recorded child, but NOT a herald: a stale/unrelated PID must not be signaled.
sleep 60 & NON_HERALD=$!
selftest_stop_herald_child "$NON_HERALD"
if kill -0 "$NON_HERALD" 2>/dev/null; then
  echo 'ok - teardown refuses an unrelated direct child PID'
  kill "$NON_HERALD"; wait "$NON_HERALD" 2>/dev/null || true
else
  echo 'not ok - teardown signaled an unrelated direct child PID' >&2; exit 1
fi
cat > "$FIX/owner.sh" <<'SH'
#!/usr/bin/env bash
set -eu
HERE="$1"; BASE="$2"; MODE="$3"
. "$HERE/selftest-lib.sh"
. "$HERE/selftest-herald.sh"
OWN="$(selftest_make_fixture_dir "$BASE/owner-$MODE.XXXXXX")"
selftest_bind_herald_owner "$OWN"
PROJ="$OWN/project"; mkdir -p "$PROJ/seats/run" "$PROJ/seats/logs"
printf '%s\n' '{"logs":{},"seen":[],"alerts":{"lastCheckAt":"2999-01-01T00:00:00Z"},"staffing":{"lastCheckAt":"2999-01-01T00:00:00Z"}}' > "$PROJ/seats/herald.state.json"
(cd "$PROJ" && WHEELHOUSE_HERALD_ROOT="$PROJ" WHEELHOUSE_HERALD_INTERVAL_MS=50 exec bun "$HERE/herald.ts") > "$OWN/herald.out" 2> "$OWN/herald.err" & CHILD=$!
# KEEP the root in every leg: deletion must not make the SIGKILL proof pass.
trap 'selftest_stop_herald_child "$CHILD"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n%s\n' "$PROJ" "$CHILD" > "$BASE/$MODE.record"
while [ ! -e "$BASE/$MODE.go" ]; do sleep 0.05; done
[ "$MODE" != failure ] || exit 23
SH
python3 - "$HERE" "$FIX" <<'PY'
import json, os, pathlib, signal, subprocess, sys, time
here, base=map(pathlib.Path,sys.argv[1:]); failures=[]; children=[]; detached=[]
def check(ok, text):
    print(('ok - ' if ok else 'not ok - ')+text,flush=True)
    if not ok: failures.append(text)
def alive(pid):
    r=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
    return r.returncode==0 and bool(r.stdout.strip()) and not r.stdout.strip().startswith('Z')
def until(fn,seconds=4):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn(): return True
        time.sleep(.05)
    return fn()
def root(name):
    p=base/name; (p/'seats/run').mkdir(parents=True); (p/'seats/logs').mkdir()
    (p/'seats/herald.state.json').write_text(json.dumps({'logs':{},'seen':[], 'alerts':{'lastCheckAt':'2999-01-01T00:00:00Z'}, 'staffing':{'lastCheckAt':'2999-01-01T00:00:00Z'}}))
    return p
def launch(p):
    env=os.environ|{'WHEELHOUSE_HERALD_ROOT':str(p),'WHEELHOUSE_HERALD_INTERVAL_MS':'50'}
    log=open(base/(p.name+'.err'),'a'); c=subprocess.Popen(['bun',str(here/'herald.ts')],cwd=p,env=env,stdout=subprocess.DEVNULL,stderr=log); children.append(c)
    assert until(lambda:(p/'seats/run/herald.pid').exists() and (p/'seats/run/herald.pid').read_text().strip()==str(c.pid)), 'daemon did not publish its own PID'
    return c
try:
    p=root('singleton'); first=launch(p)
    env=os.environ|{'WHEELHOUSE_HERALD_ROOT':str(p),'WHEELHOUSE_HERALD_INTERVAL_MS':'50'}
    second=subprocess.Popen(['bun',str(here/'herald.ts')],cwd=p,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True); children.append(second)
    try: out,err=second.communicate(timeout=2); refused=second.returncode!=0 and not out and len(err.splitlines())==1 and 'herald already running' in err
    except subprocess.TimeoutExpired: refused=False; second.terminate(); out,err=second.communicate(timeout=3)
    print(f'singleton refusal: rc={second.returncode} stdout={out!r} stderr={err!r}',flush=True)
    check(refused and alive(first.pid) and (p/'seats/run/herald.pid').read_text().strip()==str(first.pid), 'second same-root daemon refuses in one line, leaves first and its PID intact')
    other=None
    try: other=launch(root('different-root'))
    except AssertionError: pass
    check(other is not None and alive(first.pid) and alive(other.pid), 'independent root can run its own herald')
    if other is not None: other.terminate(); other.wait(timeout=3)
    # Native launch helper, including a stale lock left by SIGKILL.
    first.kill(); first.wait(timeout=3)
    seats=p/'seats'; (seats/'herald.ts').symlink_to(here/'herald.ts')
    restart=subprocess.run(['bash','-c','source "$1"; start_herald','fixture',str(here/'daemons.sh')],cwd=p,env=os.environ|{'WHEELHOUSE_DAEMONS_ROOT':str(p),'WHEELHOUSE_HERALD_INTERVAL_MS':'50'},capture_output=True,text=True,timeout=8)
    new=int((seats/'run/herald.pid').read_text()); detached.append(new)
    print(f'dead restart: rc={restart.returncode} {restart.stdout.strip()}',flush=True)
    check(restart.returncode==0 and new!=first.pid and alive(new), 'daemons.sh restarts a dead herald with a stale singleton lock')
    os.kill(new,signal.SIGTERM); assert until(lambda:not alive(new))
    for mode, sig, expected in [('normal',None,0),('failure',None,23),('term',signal.SIGTERM,143),('int',signal.SIGINT,130),('kill',signal.SIGKILL,-9)]:
        owner=subprocess.Popen(['bash',str(base/'owner.sh'),str(here),str(base),mode],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True); children.append(owner)
        rec=base/(mode+'.record'); assert until(rec.exists), 'owner allocation record missing'
        proj,pid=rec.read_text().splitlines(); pid=int(pid); detached.append(pid)
        assert until(lambda:pathlib.Path(proj,'seats/run/herald.pid').exists()), 'owned herald never started'
        if sig: owner.send_signal(sig)
        else: (base/(mode+'.go')).touch()
        _,err=owner.communicate(timeout=5); stopped=until(lambda:not alive(pid),4)
        print(f'owner {mode}: rc={owner.returncode} heraldAlive={int(alive(pid))} rootExists={int(pathlib.Path(proj).exists())} stderr={err!r}',flush=True)
        check(owner.returncode==expected and stopped and pathlib.Path(proj).exists(), 'fixture herald stops after owner '+mode+' with root retained')
finally:
    for c in children:
        if c.poll() is None: c.terminate()
    for c in children:
        try: c.wait(timeout=3)
        except subprocess.TimeoutExpired: c.kill(); c.wait()
    # These PID records came only from this controller's fresh launches.
    for pid in detached:
        if alive(pid): os.kill(pid,signal.SIGTERM); until(lambda:not alive(pid))
if failures: print('herald-lifetime.selftest: FAIL ('+str(len(failures))+' checks)'); sys.exit(1)
print('herald-lifetime.selftest: PASS (9 checks)')
PY
