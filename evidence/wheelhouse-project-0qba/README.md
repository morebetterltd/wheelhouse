# 0qba — FIFO sweep admission

Branch: `fleet/wheelhouse-project-0qba`.
Base: `main` at dispatch, `c43b08be360b8902dcc7df1978d444e4e4cc71ef`.
Final tested runtime: `7a6f85e00b7c00d4682b10be16e653f248f2347c`.
The evidence-only handoff tip must have the same `seats/` tree.

## Done, item by item

- **Arrival order:** the existing parent-directory flock linearizes enrollment. Complete same-host PID/token tickets publish atomically into a marked sibling `<lock>.queue`; only its oldest live ticket can admit. A younger caller cannot win by polling faster. Keeping the queue outside the active lock preserves pyvi's exact three-member ownership contract.
- **Dead ownership:** validated tickets are reaped only for definitive dead PIDs; live/EPERM owners remain protected. Ticket removal rechecks inode/content; cancellation removes only its own PID/token ticket. Empty queue removal rechecks directory and marker identities and never recursively deletes. Incomplete private publication candidates are outside the visible queue.
- **Wait output:** position, holder PID/start and head PID are printed and updated on changes. The existing diagnostic assertion now requires position 1 and the actual holder PID. Its readiness signal comes after the runner's diagnostic point, with B's queue ticket verified; neither a 200ms sample nor another timer decides that assertion. Early child exit also signals the observer.
- **Three waiters:** native FIFO/stream acknowledgements fix first/second/third enrollment. The oldest parks at an acknowledged retry barrier, with no helper/flock held; an explicit younger attempt must return 75 with no holder before that barrier releases. Actual suite entry/exit order and an exclusive active-file sentinel prove FIFO and non-overlap. A SIGKILLed queued child is reaped before its live successor admits. No controller sleep or elapsed-time ordering.
- **One at a time:** the active lock publication/ownership checks remain; the existing 26-check suite passes three times at the final runtime, including serialization, legacy locks, EPERM, replacements and process-group interruption.

## Actual worker checks

Every run has separate stdout, stderr (including empty files), exit and umbrella safety snapshots.

| Capture | Actual result |
| --- | --- |
| `handoff-sweep-{1,2,3}` | each exit **0**, **26 checks** |
| `handoff-queue` | exit **0**, FIFO/dead/cancel/integrity cases |
| `handoff-no-wait-line` | exit **1**; target assertion says `signal=ticket B.err= events=A start`; later serialization still passes |
| `frozen-negative-fifo` | exit **1** after removing only head eligibility: younger explicit admission returned 0 instead of 75 |
| `frozen-negative-dead` | exit **1** after disabling only reaping: live successor returned 75 instead of 0 |
| `frozen-negative-cancel` | exit **1** after restoring pre-acquisition cleanup omission: cancelled ticket remains |
| `frozen-negative-integrity{,-symlink,-foreign}` | each exit **1** against the captured pre-FIFO helper, which admits instead of refusing the selected queue shape |
| `digest-worker1` | exit **1**, **18 pass / 4 fail**; existing `seats do not open needs` identity guard |
| `digest-unset` | exit **0**, **22 legs**, `BEADS_ACTOR` unset |
| `digest-worker3` | exit **0**, **22 legs**, `BEADS_ACTOR=worker-3` |

`control-source-check.json` and `controls/*.patch` prove the exact one-edit removals. The two extra integrity controls only select an unchanged assertion group so the first failure cannot hide later cases. `covered-source-identity.json` proves all four source inputs used by the earlier six negative runs are byte-identical at the final runtime. The new wait-line removal ran against the final diagnostic test itself; it fails without relying on missing output for a timed interval. Other existing diagnostic assertions also reject the removed line.

**Brief clarification:** the known digest warning is roster-dependent, not universal for any `worker-*` value. Its fixture rosters `worker-1`, not `worker-3`. Both explicit worker values and unset were measured; other roster actors/aliases were not. No digest/needs production code was changed.

## Historical full run and remaining review gate

`full-frozen.*` ran runtime **`c0cba8bd1209e51ffc7f086491e62b3c649fdcf9`**, before the diagnostic repair:

```text
50 unique START / 49 PASS / 1 FAIL
failed suite: selftest-sweep.selftest.sh
bridge: 1 START / 1 FAIL
exit: 1
```

The new FIFO suite passed. The sole failure sampled B's empty stderr after a fixed 200ms; the subsequent A-before-B serialization assertion passed. `failed-sweep-section.txt` retains that exact section. The final runtime replaces that sampling step with the ticket-backed retry signal and a stricter queue-position/holder assertion. Final worker validation is the three standalone 26-check runs above. **No additional worker full sweep was run after the repair. A real dispatcher full sweep at the handoff tip remains the review gate; it is not worker-verified and must not be replaced by a conditional skip.**

The historical full retained `BEADS_ACTOR=worker-3`; digest passed 22 legs there too. `inventory-check.json` verifies the exact failed inventory, not a green gate. Removing only the actual new queue suite's PASS receipt makes the same validator exit **1** with aggregates unchanged (`receipt-control.*`).

```sh
node evidence/wheelhouse-project-0qba/assert-sweep.mjs \
  evidence/wheelhouse-project-0qba/full-frozen.stdout \
  evidence/wheelhouse-project-0qba/suite-inventory.txt \
  evidence/wheelhouse-project-0qba/full-frozen.exit \
  evidence/wheelhouse-project-0qba/full-frozen.stderr \
  '["selftest-sweep.selftest.sh"]'
```

Earlier `full.*` and `full-final.*` queued attempts each exited **143**, zero inner START, safety PASS. Fresh PID/parent/start/argv/cwd checks preceded TERM only to the owned outer runner, before tightening fixture early-exit handling and replacing the initial SIGSTOP control with a proper FIFO retry barrier. They are retained as incomplete, never green or priority restarts.

## Limits and cleanup

Native macOS/Bun 1.3.1 fixture coverage: private overrides, the real canonical default, different TMPDIRs, legacy file/directory holders, live/dead tickets, queued TERM and malformed/foreign/symlink refusal. No Linux, Windows, network-filesystem, real-provider or exhaustive signal/power-loss claims; a second upgraded installation was not separately exercised.

**Rollout:** all acquirers must use the upgraded runner/helper for FIFO. Legacy holders remain readable, but old acquirers do not enroll. The real waiting log captures one such bypass while this candidate was queued; this limit was routed before handoff. Synchronize the pair while the host lock is idle, as the existing ownership transition already requires. Installed/live runner code was not edited.

Full stderr retains courier trap warnings, fixture Git diagnostics and staffing-live `Directory not empty` warnings. Read-only cwd inspection found only this bead's two remaining fixture heralds, **16008** and **21881**. Fresh native PID/start/argv/cwd equality checks preceded TERM to only those two; post-stop `ps` exited **1** with empty stdout/stderr. This was **manual post-run cleanup**, not proof of automatic cleanup; the staffing/herald issue is routed to existing m4s6 scope, with no staffing/herald edits or foreign/production signals.

`capture-manifest.json` records raw/retained SHA256 and byte counts. Only owned run/worktree/container and HOME path prefixes are replaced; streams, empty stderr, native PIDs, signals, errors and receipt order remain. The `.cjs` protection utility runs with **Node**, never Bun; new Bun code uses ESM imports, with no new/ad-hoc Python. The requested historical full naturally executes existing suites' pre-existing dependencies.

Provenance utilities deriving locations from `import.meta.url`/`__dirname` must be restored under `<container>/.wheelhouse-runs/wheelhouse-project-0qba/` before replay, not executed in place as if the evidence directory were the scratch root. Regenerate one-edit controls from the explicit replacements in `check-controls.mjs` before replaying those source checks.
