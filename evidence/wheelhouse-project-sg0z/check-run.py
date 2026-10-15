import subprocess, sys, pathlib, json, hashlib, os
root=pathlib.Path(__file__).parent
umbrella=root.parent.parent
name=sys.argv[1]
cmd=sys.argv[2:]
def git(*args):
 r=subprocess.run(['git','-C',str(umbrella),*args],capture_output=True,text=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
def snap(label):
 s={'head':git('rev-parse','HEAD').strip(),'reflog':git('reflog','--format=%gs','-5'),'last3':git('reflog','-3'),'full':git('reflog','--format=%H%x09%gs'),'diff':hashlib.sha256(git('diff','HEAD','--binary','--','.',':(exclude).beads/interactions.jsonl').encode()).hexdigest()}
 (root/f'{name}.{label}.json').write_text(json.dumps(s,indent=2))
 print(f'{label}: git -C <umbrella> reflog --format=%gs -5\n{s["reflog"]}',flush=True)
 return s
before=snap('before')
print('RUN '+repr(cmd),flush=True)
r=subprocess.run(cmd)
after=snap('after')
old=before['full'].splitlines(); new=after['full'].splitlines()
try: n=new.index(old[0])
except ValueError: n=len(new)
changes=new[:n]
unsafe=[s for s in changes if not ('\tcommit:' in s or ('\tmerge ' in s and 'Fast-forward' in s))]
if unsafe or (before['head']==after['head'] and before['diff']!=after['diff']):
 print('STOP unsafe umbrella mutation: '+repr(unsafe),flush=True)
 (root/'STOP').write_text(name)
 sys.exit(99)
print(f'umbrella safety: PASS ({len(changes)} permitted new reflog entries); test exit={r.returncode}',flush=True)
(root/f'{name}.exit').write_text(str(r.returncode)+'\n')
sys.exit(r.returncode)
