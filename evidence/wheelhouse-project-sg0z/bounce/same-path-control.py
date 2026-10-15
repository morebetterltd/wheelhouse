import os, pathlib, subprocess
base=pathlib.Path(__file__).resolve().parent
r=base.parent
source=base/'sg0z/source'
lib=source/'seats/selftest-lib.sh'
original=lib.read_text()
needle='  export GIT_CEILING_DIRECTORIES="$git_fixture:$(dirname "$git_fixture")${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}"\n'
assert original.count(needle)==1
for mode in ('off','on'):
    lib.write_text(original.replace(needle,'  return 0 # same-path boundary-export-only diagnostic control\n') if mode=='off' else original)
    name='bounce-adapter-same-path-'+mode
    env=dict(os.environ,TMPDIR=str(base/'sg0z/enclosing-tmp-repo/tmp'),GIT_CEILING_DIRECTORIES=str(base/'sg0z')+':'+str(base),WHEELHOUSE_SKIP_REAL_PI='1')
    print('START',name,flush=True)
    try:
        with (r/(name+'.log')).open('w') as log:
            p=subprocess.run(['python3',str(r/'check-run.py'),name,'python3',str(base/'bounded-run.py'),str(source/'seats/adapter.selftest.sh')],cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT)
        print('END',name,'exit='+str(p.returncode),flush=True)
        assert not (r/'STOP').exists()
    finally:
        lib.write_text(original)
