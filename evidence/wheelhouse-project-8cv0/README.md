# 8cv0: controlled hermetic overlap

Base: `c8d156f5c61dc65784110902b4b8eb143c3944d1` (`origin/main` at dispatch).
Runtime: `34c1c34f04621fa4687de63ad24a8ba10617ae77`.
Branch: `fleet/wheelhouse-project-8cv0`; integration target: `main`.
Final evidence-only commits preserve the runtime's `seats/` tree.

## What is and is not fixed

The later missed-overlap failure is addressed: neither fixture turn can finish
until the controller observes both held turns and checks the original PID,
log and status assertions. Ordered FIFO probes acknowledge state after the
accepted prompts. Log-file watchers observe the probe receipts. Only then does
the shell create the release file. No elapsed duration determines overlap;
no production timeout or original assertion was increased, removed or weakened.

The negative canary actually serializes the producer: B's `agent_start` waits
for A's completion file. The same observer rejects A-held/B-queued, and the
failure path releases A so both owned seats can stop normally. The original
shared-log and lost-capacity-stamp canaries remain enabled.

**The original initial launch death is unexplained.** It is not conflated with
the missed-overlap failure, attributed to main/load, or claimed repaired.
A fixture-only Node supervisor now retains per-PID native child exit code,
signal and stderr; failed spawns print this evidence before fixture teardown.
The forced native exit-23 control verifies capture before cleanup. The exact
commander ruling accepting instrumentation and deferring follow-up until a
new instrumented occurrence is in `commander-ruling.json` (task comment
`01a13d36-01ec-7376-a20c-806ee6cbb5d2`). No follow-up bead was opened.

## Checks

All runs use owned scratch TMPDIRs, inherited fixture/parent Git ceilings,
`seats/bin` on PATH and `WHEELHOUSE_SKIP_REAL_PI=1`. Stdout, stderr and exits
are separate retained files, including empty stderr. The standalone and
controls use the official runner's asynchronous session form:

```sh
perl -MPOSIX=setsid -e 'setsid or die; exec @ARGV or die' \
  bash seats/concurrency.selftest.sh
```

- `standalone-clean.*`: exit **0**, all original checks and both new canaries.
- `final-removed-hold.*`: exit **1**. Replacing only the fixture's release-wait
  block with immediate completion fails both the new barrier proof and the
  original `could not observe both turns in flight simultaneously` assertion.
- `final-removed-diagnostics.*`: exit **1**. Making only supervisor record
  publication a no-op fails `launch exit diagnostics missing or wrong`.
- `control-source-check.json` checks every tracked `seats/` blob in each owned
  archived control against the runtime, including symlink target bytes. Each
  archive differs in exactly its one intentional file. The two `.patch` files
  are zero-context controls (`git apply --unidiff-zero`).

**Full official gate is INCOMPLETE, not green.** The official dual-lock bridge
was launched at 21:32 EDT. It remained queued behind canonical-lock owners;
no inner suite started. At 22:33, after the late-start cutoff, only the
validated owned outer runner was sent TERM. Exit **143**; actual inner
START/PASS/FAIL inventories are **0/0/0** of the expected 48. Umbrella safety
PASS with **three permitted commander reflog entries**. `full.*`,
`full-status.json` and `queued-stop.*` retain the outcome and ownership checks.
The explicit 23:00 guard subsequently reported completion and sent no signals.
Commander agreed to the cancellation and checkpoint for resumption after 06:00.
`needs-review` remains unset; see `RESUME.md`.

`assert-sweep.cjs` is prepared for exact tracked START/PASS inventory checks,
bridge receipts, aggregate consistency, exit and safety. It has **not** been
validated against a completed 8cv0 full capture; its positive/missing-PASS
control remains part of the resumed gate, not evidence claimed here.

The wrapper snapshots umbrella HEAD, complete reflog and the tracked HEAD diff
(excluding only `.beads/interactions.jsonl`). It accepts genuine commander
commits/fast-forward merges, rejects other new reflog actions and same-HEAD
tracked mutations. The three standalone/control runs each report safety PASS
with zero new reflog entries. Full-run snapshots are retained separately.

## Separate state-lock signature reported during this task

The commander reported a third signature: a phase-1b 300ms concurrent writer
failed to acquire `state.lock` (9/10), not an overlap failure. This patch does
not change `adapter.ts`, `lock.ts`, `seat-activity.ts`, the 10-run requirement
or the 300ms delay. The hold barrier does not cover that failure path.

`lock-diagnosis.*` and `lock-diagnosis/` retain a controlled real-CLI comparison
(wrapper exit **0**, umbrella safety PASS/zero new reflog entries):

| Lock functions | Waiter while owner held | Owner after release | Waiter retry |
| --- | --- | --- | --- |
| current shared implementation | 1, state.lock timeout | 0 | 0 |
| only pre-su88 acquire/release functions substituted | 1, same timeout | 0 | 0 |

The owner pauses inside the real `writeState` at a fixture-owned FIFO gate.
The controller releases it on the waiter's actual close event, not a sleep.
The production-default 5000ms deadline and 300ms write delay are unchanged.
The older lock functions came from captured `git show 88e34b6:seats/adapter.ts`;
all other current adapter code is retained with the identical test-only gate
hook. Both runs use null-PID fixture seats and the real adapter `stop` CLI.

This demonstrates an independent valid-live-owner contention path; it does
**not** reproduce worker-1's natural trigger, explain its hold duration, or
attribute a regression to su88. The incomplete-lock grace/lsof branch is not
exercised. Worker-1's actual cause remains UNKNOWN. Evidence was routed to the
commander, who split `wheelhouse-project-woq6`; the evidence was also posted
there. No state-lock runtime change, timeout inflation or assertion weakening
is part of 8cv0.

## Capture and scope

`capture-manifest.json` records original byte counts/raw SHA-256 and retained
SHA-256. Redaction replaces only owned/container/home path prefixes; native
PIDs, exit codes, signals, probe IDs and ordering are retained. `capture.cjs`
and `check-run.cjs` are provenance copies: replay requires placing them under
the bead's scratch root, not executing the copies in this evidence directory.
`assert-sweep.cjs` is directly runnable against the retained files.

Early development iterations are not gate evidence: one directory-watcher
trial needed an owned wakeup; another shared-log canary's owned helper was
terminated after its replies went to aliased/rotated logs. Watching the actual
log files and rejecting aliased endpoints fixed those harness issues before
the clean immutable-runtime runs. No interrupted or manually nudged run counts
as a pass. An initial mistaken 49-suite inventory assertion stopped before
launch; this branch's actual tracked inventory is 48 (unlike sg0z's extra suite).

Coverage is native macOS, Node/Bun/Git and fixture RPC providers. Real providers
are explicitly skipped; other operating systems and exhaustive signal/host
failure races are not claimed. No Python was added or used for ad-hoc checks.
Only owned fixture processes were stopped; production services and other
workers' processes were untouched. No push, merge or bead close.
