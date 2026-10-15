# BOUNCE comparison: adapter and prune, one owned suite at a time

Commander requested exact-tip comparisons of adapter/prune at sg0z
`9f4055dcc058b7754c709c1d9782f1a61aa0e5ce` and main
`6cb9dc9c2208d8baabb129a1f88fa8f06fd0d5d9`. No product code changed.

## Requested comparisons

| Suite | sg0z 9f4055d | main 6cb9dc9 |
|---|---|---|
| adapter | exit 0 (`bounce-adapter-sg0z-restored.log`) | exit 0 (`bounce-adapter-main.log`) |
| prune | exit 0 (`bounce-prune-sg0z.log`) | exit 0 (`bounce-prune-main.log`) |

Both adapter captures include all five PASS assertions in the disputed leg 2a:
answering idle seat, WEDGED diagnosis, stop/resume healing, session retention,
and delivery of the retried prompt. Both prune captures include successful
nested-TMPDIR preflight, parallel bead-scoped cleanup and no `already running`
refusal. Their four safety wrappers exit 0 with zero new umbrella reflog entries.

`comparison-results.json` records exact refs/exit codes. Before the restored
sg0z run and again after all comparisons, every archived seats/ blob (including
symlink targets) was compared to its pinned Git tree. Manufactured enclosing
repositories retain their original HEAD, tracked index and KEEP sentinel.

## Interrupted and failed attempts are retained, not counted green

- First sg0z adapter stalled in phase 0b (Claude-stub dispatch), before 2a.
  Native `sample 39016 1 1 -file .../bun-dispatch-stall.sample.txt` exited 0;
  main thread was blocked in `__openat_nocancel`. Fixture seat PID 38921 was
  absent in native ps, while dispatch PID 39016 remained. Only the verified
  owned shell/dispatch descendants were KILL'd after about nine minutes.
  Suite signal exit -9; safety wrapper shell exit 247; umbrella safety PASS
  with one permitted commander commit. This is INCONCLUSIVE, not a regression.
- Two later unchanged sg0z runs (`sg0z-retry`, `sg0z-final`) each exited 1:
  leg 2a passed, but leg 2b pinned-cwd fallback timed out after 20,000 ms waiting
  for launch get_state, producing three failed assertions. Neither is hidden
  or counted passing.
- A ceiling-export-only control passed, but that alone did not establish
  causality. The follow-up OFF/ON pair used identical source/temporary-root
  paths, retained every original assertion, and added only after-assertion
  dumps of pinned-cwd fixture logs/commands/stderr. **Both full suites exited
  0**, with all three get_state requests and responses in each dump. Thus
  there is no consistent ceiling-dependent failure demonstrated here.
- Diagnostics and control edits were then removed; every seats/ blob was
  restored byte-for-byte to 9f4055d before the final unmodified adapter suite.
  That final suite exited 0. No timeout/expectation was weakened in the product.

## New-main hang check

The full unmodified adapter suite at
`1c63d01bbe6d811a548ffbfb9b222a897ad6a144` exited 0
(`bounce-adapter-main-1c.log`). The dead-seat openat hang did not reproduce in
this run, so commander's conditional instruction to file that separate bug
has not been triggered. This does **not** prove the race absent. The native
sample is retained if it reproduces later. No exact FIFO pathname/causal
mechanism was identified from the sample.

## Commands, isolation and limits

Archive commands: `git archive <exact-ref> -- . ':!evidence' | tar -xf - -C
<owned-source>`. Each source lives under the bead's `.wheelhouse-runs/`;
TMPDIR is `<owned-enclosing-git-repo>/tmp`. Inherited Git ceilings stop at that
owned enclosure's parent; sg0z adds its actual fixture/parent boundaries.

Actual command in each source cwd:

```
WHEELHOUSE_SKIP_REAL_PI=1 TMPDIR=<owned-enclosure>/tmp \
GIT_CEILING_DIRECTORIES=<owned-parent>:<comparison-root> \
python3 <bead-run-root>/check-run.py <capture-name> \
  bash <owned-source>/seats/{adapter,prune}.selftest.sh
```

Later adapter attempts used `bounded-run.py` between the safety wrapper and
bash: identical suite with a 900-second external deadline, not an altered
protocol timeout. None of the passing attempts hit that deadline. Controllers
and snapshots are retained as provenance; reconstruct them under the bead's
scratch root before executing, since `check-run.py` derives umbrella location
from its own path. Evidence captures redact home paths and strip terminal
trailing padding; raw captures remain in owned scratch until cleanup.

Each owned suite ran serially; other installs/jobs were not stopped. Host load
was not measured and is not established as the cause. Real provider legs skip
explicitly. No live verifier, installed seats, service definitions or production
processes were changed. No new full sweep is claimed: the dispatcher BOUNCE
still needs a fresh successful gate. Commander requested rebase to main
1c63d01 before the next full sweep; these comparisons remain pinned to the
older refs deliberately, and do not cover that future rebased runtime.
