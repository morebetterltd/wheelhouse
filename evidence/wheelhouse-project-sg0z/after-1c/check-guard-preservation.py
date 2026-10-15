import json, subprocess
from pathlib import Path
old='5c9b49902ba74c3d46b8bf6a3f2810e065acd6df'
def blob(ref,p): return subprocess.check_output(['git','show',ref+':'+p])
paths=['seats/selftest-lib.sh','seats/git-isolation.selftest.sh','evidence/wheelhouse-project-sg0z/producer-extra-fixture-guards.patch']
for p in paths: assert blob(old,p)==blob('HEAD',p),p
count=0
for p in subprocess.check_output(['git','ls-tree','-r','--name-only',old,'seats'],text=True).splitlines():
 if p.endswith('.selftest.sh'):
  before=[x for x in blob(old,p).decode().splitlines() if x.startswith('selftest_isolate_git ')]
  after=[x for x in blob('HEAD',p).decode().splitlines() if x.startswith('selftest_isolate_git ')]
  assert before==after,p
  count+=len(before)
def contract(s): return s.split('export WHEELHOUSE_CONTRACT_FIXTURE=',1)[1].split('\nHOME_FIX=',1)[0]
assert contract(blob(old,'seats/adapter.selftest.sh').decode())==contract(blob('HEAD','seats/adapter.selftest.sh').decode())
new=blob('HEAD','seats/pipefail.selftest.sh').decode()
assert 'selftest_isolate_git "$FIX" || exit 2\n' in new
print(json.dumps({'oldCandidate':old,'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'unchangedPaths':paths,'existingGuardCallsUnchanged':count,'adapterContractIdentical':True,'addedAllocationGuard':'seats/pipefail.selftest.sh'},sort_keys=True))
