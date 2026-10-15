# Adapter state lock (su88)

Branch base, as dispatched: `fleet/wheelhouse-project-5tcl` at
`88e34b6eaa70b98b04b0030ccb0ea74fe224d153`, not main. Integrate that dependency
first. Runtime/tests: `12c081d9108c7444a0216f1f8184faf9c2ce13e4`.
The following evidence-only commit leaves the tested `seats/` tree unchanged.

## Done, individually

1. **Shared fixed lock — PASS.** `adapter.ts` now calls `acquirePidLock` and
   `releasePidLock` from `./lock`. The existing adapter deadline and 25ms retry
   loop remain. Publication, one-second incomplete-lock grace, native lsof
   no-open-handles requirement, live-PID refusal and inode-safe release are
   exactly the approved 5tcl implementation: `seats/lock.ts` is byte-unchanged
   from the dependency. `caller-inventory.txt` records all adapter state-file
   mutation sites and the three shared-lock callers. The native probe capture
   inherited at `evidence/wheelhouse-project-5tcl/native-lsof.txt` remains
   reachable with that unchanged implementation.
2. **Real caller selftest and fix-removed proof — PASS.** New phase 0a0 in
   `adapter.selftest.sh` runs `fixtures/adapter-state-lock.ts`. It copies the
   adapter runtime BEFORE invoking the actual CLI, creates only a pid-null
   fixture seat, and uses `stop worker-1` to commit a real state.json mutation.
   No provider, actual live seat, or original input adapter is launched.
   All six groups pass with the fix and fail against the original adapter:
   old closed empty/malformed locks recover; a fresh incomplete lock gets
   grace then recovers after aging; an old OPEN empty lock stays protected
   until close; a live PID is protected at acquisition AND against an old
   handle's release; injected PID-write failure publishes no empty public lock
   and leaves no candidate. The live-owner acquisition check already passed
   before the fix; its combined group fails the original's unsafe release of
   a deliberately replaced path. Grace uses a future mtime, then ages the same
   file by 60 seconds, avoiding dependence on scheduler speed.

## Commands and exits

`W` is this task worktree; `R` is
`<container>/.wheelhouse-runs/wheelhouse-project-su88`. The exact `check-run.py`
used is copied here; place it in R to derive the umbrella as R.parent.parent.
The original adapter was archived from the dependency before editing and
byte-compared with `88e34b6:seats/adapter.ts`.

```sh
# Initial real-CLI reproduction (only the copied original runtime):
TMPDIR="$R/native-tmp" WHEELHOUSE_STATE_LOCK_TIMEOUT_MS=150 \
  python3 "$R/check-run.py" baseline bun "$R/original/seats/adapter.ts" stop worker-1
# exit 1: STOP timed out; old empty state.lock and pending cwd mutation remain

TMPDIR="$R/native-tmp" python3 "$R/check-run.py" unit-fixed \
  bun "$W/seats/fixtures/adapter-state-lock.ts" "$W/seats/adapter.ts" "$R/fixed-cases"
# exit 0, all six PASS
TMPDIR="$R/native-tmp" python3 "$R/check-run.py" unit-original \
  bun "$W/seats/fixtures/adapter-state-lock.ts" "$R/original/seats/adapter.ts" "$R/original-cases"
# exit 1, all six FAIL; source differs only by removing this adapter fix
TMPDIR="$R/native-tmp" python3 "$R/check-run.py" shared-lock \
  bun "$W/seats/fixtures/lock-regression.ts" "$W/seats/lock.ts" "$R/shared-lock-cases"
# exit 0, five shared-lock groups PASS
TMPDIR="$R/enclosing/tmp" WHEELHOUSE_SKIP_REAL_PI=1 PATH="$W/seats/bin:$PATH" \
  python3 "$R/check-run.py" adapter-fixed bash seats/adapter.selftest.sh
# exit 0, full adapter suite including new phase and existing canaries
```

All case roots were created fresh below R. The adapter suite's TMPDIR was
inside an owned disposable enclosing Git repository. Each safety wrapper
captured umbrella `git reflog -3`, `git reflog --format=%gs -5`, full reflog,
and tracked diff, excluding ONLY `.beads/interactions.jsonl` as permitted.
`umbrella-safety.json` records unchanged before/after heads, full-history
hashes and diff hashes for every run; all had zero new reflog entries.
Logs are mechanically scrubbed with `seats/evidence-scrub.sh`; trailing line
whitespace is normalized in the original-module failure capture.

Covered: native macOS filesystem/lsof, default adapter suite settings and
150ms lock-contention fixtures, closed/open/fresh/malformed locks, live PID
without an open handle, forced path replacement while a real writer holds
its original handle, and injected synchronous PID-write failure. No
full-sweep/prune, real provider/pi leg, production service/app, power-loss,
Windows/network filesystem, exhaustive concurrency or missing-lsof/denied-
permission environment coverage claimed. No shared-lock policy changes.
