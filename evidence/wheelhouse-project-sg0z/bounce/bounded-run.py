import os, signal, subprocess, sys
from pathlib import Path
script = Path(sys.argv[1]).resolve()
assert script.is_file() and '/.wheelhouse-runs/wheelhouse-project-sg0z/bounce-comparison/' in str(script)
child = subprocess.Popen(['bash', str(script)], start_new_session=True)
try:
    rc = child.wait(timeout=900)
except subprocess.TimeoutExpired:
    assert os.getpgid(child.pid) == child.pid
    print('INCOMPLETE: owned standalone suite exceeded 900s; interrupting only its process group', flush=True)
    os.killpg(child.pid, signal.SIGTERM)
    try: child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    rc = 124
sys.exit(rc if rc >= 0 else 128 - rc)
