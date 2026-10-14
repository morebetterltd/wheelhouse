#!/usr/bin/env python3
"""Run a whole recovery selftest while an unrelated, owned bare-pi dummy churns.

No production hook: a private bun shim pauses existing phase-5/canary calls.
The input selftest may be fixed or original; return its actual exit status.
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time

source, root = map(lambda p: Path(p).resolve(), sys.argv[1:])
assert source.is_file() and root.is_dir()
bun, node = shutil.which("bun"), shutil.which("node")
assert bun and node
bin_dir = root / "bin"
bin_dir.mkdir()
q = shlex.quote
shim = bin_dir / "bun"
shim.write_text(f'''#!/usr/bin/env bash
set -eu
control={q(str(root))}
case "${{1:-}}" in
  */proj/seats/recover.ts)
    fixture="${{1%/proj/seats/recover.ts}}"
    if [ -f "$fixture/state.before" ]; then
      printf '%s\\n' "$1" > "$control/before.ready"
      until [ -f "$control/before.release" ]; do sleep 0.01; done
    fi ;;
  */can-a/seats/recover.ts)
    : > "$control/after.ready"
    until [ -f "$control/after.release" ]; do sleep 0.01; done ;;
esac
exec {q(bun)} "$@"
''')
shim.chmod(0o755)
dummy_script = root / "unrelated.js"
dummy_script.write_text('process.title = "pi"; setInterval(() => {}, 1000);\n')
env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "WHEELHOUSE_SKIP_REAL_PI": "1"}
test = dummy = None

def wait_for(file):
    deadline = time.monotonic() + 180
    while not file.exists():
        if test.poll() is not None:
            raise RuntimeError(f"selftest exited before {file.name}; inspect {root / 'selftest.log'}")
        if time.monotonic() >= deadline:
            raise RuntimeError(f"timed out at {file.name}")
        time.sleep(0.02)

try:
    with (root / "selftest.log").open("w") as log:
        test = subprocess.Popen(["bash", str(source)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        wait_for(root / "before.ready")
        fixture = Path((root / "before.ready").read_text().strip()).parents[2]
        assert (fixture / "state.before").is_file()
        assert not root.is_relative_to(fixture), "dummy must be unrelated to this FIX"
        # Launch only after phase 5 captured its before count. No fixture fd,
        # cwd, argv or launch-ledger entry; just the same native bare pi title.
        dummy = subprocess.Popen([node, str(dummy_script)], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        title = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            title = subprocess.run(["ps", "-p", str(dummy.pid), "-o", "command="], capture_output=True, text=True)
            if title.returncode == 0 and title.stdout.rstrip() == "pi" and not title.stderr:
                break
            if dummy.poll() is not None:
                raise RuntimeError("owned dummy exited before rewriting its title")
            time.sleep(0.02)
        assert title and title.returncode == 0 and title.stdout.rstrip() == "pi" and not title.stderr
        (root / "before.release").touch()
        # Canary A is after the after-count. Hold the suite there so the dummy
        # is also stopped while the selftest itself is definitely still live.
        wait_for(root / "after.ready")
        assert dummy.poll() is None and test.poll() is None
        dummy.terminate()
        dummy_exit = dummy.wait(timeout=10)
        assert test.poll() is None
        (root / "after.release").touch()
        output, _ = test.communicate(timeout=120)
        log.write(output)
        code = test.returncode
    result = {"selftest": str(source), "selftest_exit": code, "dummy_pid": dummy.pid,
              "native_ps": {"command": ["ps", "-p", str(dummy.pid), "-o", "command="], "exit": title.returncode, "stdout": title.stdout, "stderr": title.stderr},
              "dummy_started_after_before_count": True, "dummy_alive_through_after_count": True,
              "dummy_stopped_while_selftest_active": True, "dummy_exit": dummy_exit,
              "dummy_root_outside_FIX": True}
    (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), flush=True)
    print((root / "selftest.log").read_text(), flush=True)
    sys.exit(code)
finally:
    # Release both owned barriers before any termination; never signal a host
    # pi by name. Every PID/group here comes directly from our own Popen.
    for stage in ("before", "after"):
        (root / f"{stage}.release").touch()
    if dummy is not None and dummy.poll() is None:
        dummy.terminate()
        dummy.wait(timeout=10)
    if test is not None and test.poll() is None:
        os.killpg(test.pid, signal.SIGTERM)
        try:
            test.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(test.pid, signal.SIGKILL)
            test.wait(timeout=10)
    if test is not None and not (root / "selftest.log").stat().st_size:
        output, _ = test.communicate(timeout=10)
        (root / "selftest.log").write_text(output)
