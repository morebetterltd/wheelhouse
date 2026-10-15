import json, os, pathlib, subprocess, time
base = pathlib.Path(__file__).resolve().parent
runroot = base.parent
# Do not overlap any of this seat's four original suite comparisons.
while True:
    results = base / 'results.json'
    if results.is_file() and len(json.loads(results.read_text())) == 4: break
    assert not (runroot / 'STOP').exists()
    time.sleep(2)
for key, name in [('sg0z','bounce-adapter-sg0z-retry'), ('main-1c','bounce-adapter-main-1c')]:
    source, outer = base/key/'source', base/key/'enclosing-tmp-repo'
    script = source/'seats/adapter.selftest.sh'
    assert script.is_file() and (outer/'KEEP').is_file()
    env = dict(os.environ, TMPDIR=str(outer/'tmp'), GIT_CEILING_DIRECTORIES=str(base/key)+':'+str(base), WHEELHOUSE_SKIP_REAL_PI='1')
    print('START', name, 'tip='+(base/key/'source-tip.txt').read_text().strip(), flush=True)
    with (runroot/(name+'.log')).open('w') as log:
        proc = subprocess.run(['python3',str(runroot/'check-run.py'),name,'python3',str(base/'bounded-run.py'),str(script)], cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT)
    head = subprocess.check_output(['git','-C',str(outer),'rev-parse','HEAD'],text=True).strip()
    status = subprocess.check_output(['git','-C',str(outer),'status','--porcelain','--untracked-files=no'],text=True)
    assert head == (base/key/'enclosing-head.before').read_text().strip() and not status and (outer/'KEEP').is_file()
    (base/(name+'.result.json')).write_text(json.dumps({'exit':proc.returncode,'enclosingUnchanged':True})+'\n')
    print('END',name,'exit='+str(proc.returncode),'enclosing repository unchanged',flush=True)
    assert not (runroot/'STOP').exists()
