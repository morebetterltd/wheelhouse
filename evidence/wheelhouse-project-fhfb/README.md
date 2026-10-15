# Shared-host recovery selftest (fhfb)

For a current rerun, the controller is now TypeScript (twxf):
`bun seats/fixtures/recover-process-noise.ts <recover.selftest.sh> <existing-empty-case-dir>`.
The captures and original commands below remain historical evidence, not a
requirement to install their former interpreter. All case/TMPDIR paths must
remain in the invoking bead's scratch root.

Base: `origin/main a0bf61cfd3390bb54a3e1dd700181a2a264d5445`, default target
`main`. Runtime/test source pin: `f594fbc` (test files only). The following
commit adds evidence only, leaving the tested `seats/` tree unchanged.

## Done, individually

1. **Count owned fixture launches — PASS.** The fixture initializes
   `FIX/pi-starts.pids`; only its generated stub `BIN/pi` appends its PID.
   `pi_count()` reads that file, not host ps output. This counts launches,
   including ones that have already exited, rather than current machine
   population. Phase 5 requires a nonempty ledger after completed spawn/resume;
   missing/unreadable input exits nonzero. Its wording now says fixture stub
   launches. A new canary executes the fixture stub without an agent directory,
   waits for its expected exit, and requires exactly one new ledger entry.
2. **Physical unrelated-pi churn and fix-removed proof — PASS.** The whole
   selftest passes while an owned, unrelated Node process rewrites its native
   process title to exactly `pi`. A private Bun shim holds the existing phase-5
   recover call AFTER the before-count; the controller starts the dummy, checks
   its real ps title, then releases recover. It holds canary A AFTER the
   after-count, stops/reaps the dummy while the selftest is still active, then
   releases the canary. Dummy cwd/argv/files are outside FIX, no production
   process is signalled, and no production test hook is introduced.

Fixed complete selftest (`noise-fixed-final.log`), exit **0**:

```text
  ok    no pi spawned (fixture stub launches: 3 before, 3 after)
  ok    canary: launch counter catches a short-lived fixture pi after it has exited
recover.ts works on this machine.
umbrella safety: PASS (0 permitted new reflog entries); test exit=0
```

With ONLY `pi_count()` reverted to its exact original `a0bf61c` definition,
leaving all new tests and the same controller in place
(`noise-counter-reverted.log`), exit **1**, expected:

```text
  FAIL  fixture pi launch count changed: 7 -> 8
  FAIL  canary: own pi launch not detected (7 -> 7, exit 1): stub pi: no PI_CODING_AGENT_DIR
2 check(s) failed.
umbrella safety: PASS (0 permitted new reflog entries); test exit=1
```

`counter-only-reversion.patch` contains that single-function mutation. The
reverted file was byte-compared with fixed source plus only that replacement;
its replacement definition was compared with `git show a0bf61c`.
Both logs retain the controller's machine-readable result: actual selftest
exit, native ps exit/stdout/stderr, dummy PID and exit (-15), and assertions
that it started after before-count, stayed alive through after-count, stopped
while the suite was live, and was outside FIX. `native-ps.json` is the real
owned-dummy capture taken BEFORE constructing the controller's title check.

## Commands / isolation

From task worktree `W`, with `R` equal to
`<container>/.wheelhouse-runs/wheelhouse-project-fhfb`:

```sh
TMPDIR="$R/enclosing/tmp" WHEELHOUSE_SKIP_REAL_PI=1 PATH="$W/seats/bin:$PATH" \
  python3 "$R/check-run.py" noise-fixed-final \
  python3 "$W/seats/fixtures/recover-process-noise.py" \
  "$W/seats/recover.selftest.sh" "$R/fixed-noise-final"
# exit 0
# Same command/controller against R/counter-reverted/seats/recover.selftest.sh,
# own fresh R/reverted-noise case root: exit 1; both new legs fail.
```

The unchanged `check-run.py` used is copied here; place it in R to derive
its umbrella as R.parent.parent. It records reflog -3, reflog --format=%gs -5,
full reflog and tracked diff before/after. `umbrella-safety.json` retains the
snapshots: both gates had identical heads, full histories and tracked diffs,
excluding ONLY the permitted .beads/interactions.jsonl. TMPDIR is inside an
owned disposable enclosing Git repo. Logs are scrubbed with
`seats/evidence-scrub.sh`. The controller drains the scrubber's stdout pipe
before forwarding output, rather than assuming parent exit means flush.

Production `recover.ts` is unchanged. Native macOS ps/lsof, Node stub/dummy,
Bun fixture calls, the full recovery suite and existing/new canaries measured.
No real-pi/provider leg, full sweep, prune, production service/app, actual
other-fleet restart, Windows/Linux title semantics or arbitrary absolute-
binary launch coverage claimed. All created scratch is below R; only owned
Popen processes/groups are signalled by the controller.
