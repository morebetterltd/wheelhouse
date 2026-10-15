# Frozen full-sweep launcher record

Recorded from the actual 2026-10-15 tool invocation (not a second launch).
Working directory: the worker-3 TEMPLATE worktree; source `c0cba8bd1209e51ffc7f086491e62b3c649fdcf9`.

`R=<container>/.wheelhouse-runs/wheelhouse-project-0qba`

The launcher asserted a clean named branch, final source and no existing `full-frozen.stdout`, then set:

- `QUEUE_GATE_ROOT=$PWD`
- `WHEELHOUSE_SKIP_REAL_PI=1`
- `WHEELHOUSE_SELFTEST_SWEEP_PATTERN=$R/bridge.selftest.sh`
- `WHEELHOUSE_SELFTEST_SWEEP_LOCK=${original TMPDIR}/wheelhouse-selftest-sweep.lock`
- `PATH=$PWD/seats/bin:$PATH` (no host-budget.json in the worktree or umbrella install)
- `TMPDIR=$R/tmp`
- `GIT_CEILING_DIRECTORIES=$R/tmp:$R` plus any inherited ceilings
- `BEADS_ACTOR=worker-3` inherited unchanged, printed before launch

Actual command:

```sh
perl -MPOSIX=setsid -e 'setsid or die; exec @ARGV or die' \
  node "$R/check-run.cjs" full-frozen bash seats/selftest-sweep.sh \
  > "$R/full-frozen.stdout" 2> "$R/full-frozen.stderr" < /dev/null &
```

Actual launcher output:

```text
Prediction: frozen c0cba8b full gate50 suites; keep worker BEADS_ACTOR=worker-3 and retain actual failure rows including known digest actor exception.
frozen full wrapper pid=48260; result pending
local=08:48:54 EDT
```

The outer official runner holds the legacy native-TMPDIR domain while the bridge unsets its inherited pattern and executes the same official runner at the canonical `/tmp/wheelhouse-selftest-sweep.lock`. Inner receipts must be counted separately from the one bridge receipt. Neither canceled earlier attempt is reused as this run's result.

No new Python was added or used for ad-hoc checks. The requested full sweep runs the existing tracked suites unchanged, including their pre-existing tool dependencies. New Bun code uses ESM imports; the copied `check-run.cjs` is explicitly a Node provenance/protection utility, never executed by Bun.
