# sg0z evidence

**Latest gate:** [after-1c/README.md](after-1c/README.md) records the rebase
onto main `1c63d01`, runtime `d7ec128`, and exact 49/49 PASS full sweep.
[bounce/README.md](bounce/README.md) retains the serial review comparisons.
The sections below are historical pinned 6cb9dc9/main and producer-overlay evidence.

## Candidate and scope

The main candidate was rebased onto `6cb9dc9c2208d8baabb129a1f88fa8f06fd0d5d9`.
Its tested runtime tip is `c4ee0de1d22ea590ddd5c0372fc217978e74f2a8`.
The final evidence commit must leave the `seats/` tree identical to that tip.

`selftest_isolate_git()` exports physical fixture and parent ceilings in the
parent shell. All 47 main fixture setups call it; the 48th suite,
`pid-ownership.selftest.sh`, is static and creates no fixture. The graph helper
also supplies a ceiling for its own Git initialization. Adapter stub bead text
has a valid dispatch contract instead of an empty JSON array.

## Safe reproduction and controls

- `actual-dispatch.log`: actual producer adapter refuses a contract-less bead
  before worktree creation (exit 1). Original `fgit reset` moves only the
  manufactured enclosing repository HEAD. Fixed reset exits 128 and preserves
  that repository; wrapper exits 0 after asserting both outcomes.
- `git-isolation.log`: the regression's fix-removal control exits 1 and moves
  only its disposable enclosing HEAD; fixed execution preserves it. Covers
  fixture root, plain subdirectory, nested repository, linked worktree, and
  subdirectories of the latter two.
- `audit-negative.log`: removing the adapter setup guard in an owned copy
  makes the boundary audit fail (exit 1).
- `git-call-inventory.txt`: original rollout inventory; `git-call-rg.txt` is
  the fresh `rg -n '\b(fgit|git)\b' seats/*.selftest.sh seats/selftest-lib.sh`
  capture. Fresh per-configuration inventories accompany the sweep receipts.

## Producer overlay

Producer base is `b8f0a8e50e2c0fbb160dae12a7bd78035a58db99`, with an older
common ancestor than main's reviewed-row prune API. The owned overlay combines
sg0z guards with yo4m's required fixture metrics and physical-TMPDIR fixes.
The prune selftest conflict preserves producer's existing API coverage; it
ports those prerequisites, not main's incompatible reviewed-row regressions. Its scratch commit is
`6a8e344cb12c4752e7f06e08f30b9b12e5ac3643`.
No assertion in producer's original test is removed or weakened.

`producer-extra-fixture-guards.patch` adds parent-shell guards to producer-only
contract, intake, and upgrade-contract-audit suites. It is not standalone:
apply the main sg0z helper/rollout first (commander plans to merge main into
producer), then apply this patch. The tested overlay includes 50 suites and
49 guarded fixture allocations; its remaining suite is the static ownership
check. `complete-producer-overlay.patch` reconstructs this exact overlay
from the producer base (zero context; use `git apply --unidiff-zero`).

## Safety and lock cutover

All hazard fixtures, test TMPDIRs, and overlay repositories are bead-owned
scratch. `check-run.py` compares the umbrella's complete reflog and tracked
HEAD diff before and after each gate; only `.beads/interactions.jsonl` is
excluded. Commander commits and fast-forward merges are permitted; unexpected
reset/checkout/rebase or same-HEAD tracked changes stop verification.

Both final gates use `bash seats/selftest-sweep.sh`. During muyl's lock-domain
cutover an outer invocation holds the legacy host lock and runs one owned
bridge suite. That bridge invokes the real full runner under its merged,
TMPDIR-independent lock. Count the inner committed suite inventory, not the
outer bridge, when validating full-sweep coverage. Commander authorized this
migration bridge. Canceled queued/partial attempts exited 143 and are not
passing gate evidence.

## Completed gates

- `main-full-green.log`: 48 START / 48 PASS / 0 FAIL, exactly the committed
  main inventory; inner and outer official runners exit 0.
- `producer-full-green.log`: 50 START / 50 PASS / 0 FAIL, exactly the overlay
  inventory; inner and outer official runners exit 0.
- Both wrappers: `umbrella safety: PASS (0 permitted new reflog entries);
  test exit=0`. Before/after captures are in `umbrella-safety.json`.
- `assert-sweep.py` independently validates every unique suite receipt plus
  both aggregate counts. `receipt-control.txt` records that deleting the real
  adapter PASS record from a copy makes this validator exit 1.
- `git-isolation-rebased.log` reruns the real reproducer and fix-removal
  control on the tested runtime tip; exit 0, safety PASS with zero new entries.

The producer gate is the explicitly described older-base overlay, not a claim
that every intervening main fix has already reached producer. Commander will
merge main into producer and apply the supplemental three guards; that future
integration has not been tested here.

Real-provider legs use the explicit `WHEELHOUSE_SKIP_REAL_PI=1` skip. Results
are native macOS/Git/Bun fixture evidence, not claims about Windows, network
filesystems, production seat operations, or real provider behavior.
