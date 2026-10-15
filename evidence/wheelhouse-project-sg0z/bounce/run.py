import json, os, pathlib, subprocess
base = pathlib.Path(__file__).resolve().parent
runroot = base.parent
results = []
# The subject is identical captured source at each named ref. Run one suite
# at a time, never a dispatcher review or a production seat lifecycle.
for suite in ('adapter', 'prune'):
    for key in ('sg0z', 'main'):
        source = base / key / 'source'
        outer = base / key / 'enclosing-tmp-repo'
        script = source / 'seats' / (suite + '.selftest.sh')
        assert script.is_file() and (outer / 'KEEP').is_file()
        env = dict(os.environ, TMPDIR=str(outer / 'tmp'),
                   GIT_CEILING_DIRECTORIES=str(base / key) + ':' + str(base),
                   WHEELHOUSE_SKIP_REAL_PI='1')
        name = 'bounce-' + suite + '-' + key
        print('START', name, 'tip=' + (base / key / 'source-tip.txt').read_text().strip(), flush=True)
        with (runroot / (name + '.log')).open('w') as log:
            proc = subprocess.run(['python3', str(runroot / 'check-run.py'), name,
                                   'bash', str(script)], cwd=source, env=env,
                                  stdout=log, stderr=subprocess.STDOUT)
        before = (base / key / 'enclosing-head.before').read_text().strip()
        head = subprocess.check_output(['git', '-C', str(outer), 'rev-parse', 'HEAD'], text=True).strip()
        status = subprocess.check_output(['git', '-C', str(outer), 'status', '--porcelain', '--untracked-files=no'], text=True)
        assert head == before and not status and (outer / 'KEEP').is_file(), 'owned enclosing repository changed'
        results.append(dict(suite=suite, tree=key, exit=proc.returncode, enclosingUnchanged=True))
        (base / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print('END', name, 'exit=' + str(proc.returncode), 'enclosing repository unchanged', flush=True)
        if (runroot / 'STOP').exists():
            raise SystemExit('STOP from umbrella safety wrapper')
print('COMPLETED four standalone comparisons', flush=True)
