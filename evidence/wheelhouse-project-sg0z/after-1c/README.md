# Final sg0z gate after rebase onto main 1c63d01

Base: `1c63d01bbe6d811a548ffbfb9b222a897ad6a144` (`origin/main` at rebase).
Runtime: `d7ec1288a47fa09bbd2ce56a68d05f7dc62e86ff`.
Branch: `fleet/wheelhouse-project-sg0z`.

Rebase applied main's pipefail/SIGPIPE changes. The only additional hand edit
adds `selftest_isolate_git "$FIX" || exit 2` immediately after the new
pipefail fixture allocation. Existing shared boundary helper, Git-isolation
regression, supplemental producer patch and adapter valid-contract block are
unchanged; all existing guard calls are preserved (`guard-preservation.json`).
Some guard-bearing selftest files changed because of main's reader fixes;
this preservation claim is specifically about their guard calls, not whole
file byte equality. The new main-only pipefail allocation is additionally guarded.

## One official full gate

Actual launch from the seat worktree, with scratch beneath this bead:

```
SG0Z_GATE_ROOT=<seat-worktree> TMPDIR=<bead-run-root>/after-1c/tmp \
GIT_CEILING_DIRECTORIES=<tmp>:<after-1c>:<bead-run-root> \
WHEELHOUSE_SELFTEST_SWEEP_LOCK=<captured-legacy-host-lock> \
WHEELHOUSE_SELFTEST_SWEEP_PATTERN=<after-1c>/bridge.selftest.sh \
WHEELHOUSE_SKIP_REAL_PI=1 PATH=<worktree>/seats/bin:$PATH \
python3 <bead-run-root>/check-run.py main-after-1c-full \
  bash seats/selftest-sweep.sh
```

The outer official runner holds the legacy host lock. The bridge unsets the
pattern and execs the full official runner under `/tmp/wheelhouse-selftest-sweep.lock`.
It queued behind existing owners; no owner was stopped or lock bypassed.
The inner sweep completed before 20:57 EDT, well before the 23:00 local pause.

Independent exact committed inventory validation, exit 0:

```
{"bridgePass":1,"bridgeStart":1,"exit":0,"innerFail":0,"innerPass":49,"innerStart":49,"inventoryExact":true}
umbrella safety: PASS (1 permitted new reflog entries); test exit=0
```

All 49 inventory suites have exactly one START and PASS, no FAIL. The single
bridge leg and its aggregate are separate. This is one full gate, not a
partial attempt or an aggregate inferred from a few log lines. Main's new
pipefail suite, adapter disputed wedged/pinned-cwd legs, prune nested-TMPDIR
and parallel-cleanup legs, and containment regression all pass.

The one permitted umbrella entry is:

```
829e1a35bc1731e45ccfd525eb7bbb32468822ec commit: Sync template c8d156f: sweep runner removes only a lock it can prove it wrote (pyvi, H7)
```

`umbrella-safety.json` retains HEAD, full reflogs and tracked-diff hashes
before/after. Only `.beads/interactions.jsonl` is excluded by the safety wrapper.
The sync does not change the explicitly pinned runtime tested here.

## New guard and evidence controls

The allocation-audit body extracted unchanged from shipped
`git-isolation.selftest.sh` runs against all suite sources:

- Guard present: exit 0, `PASS fixture Git boundary audit (48 suite setups)`.
- Remove only pipefail's added call in an owned copy: exit 1,
  `AssertionError: pipefail.selftest.sh:6: missing git boundary`.

The full sweep separately exercises the original destructive Git negative
control inside its manufactured enclosing repository: the identical regression
fails with the helper removed, then passes with it present.

Receipt validator control removes only the real pipefail PASS receipt from a
copy of this capture. Despite its unchanged aggregate PASS lines and exit file,
the validator exits 1; the intact capture exits 0. Control streams are separate.

## Producer result retained, not silently broadened

As commander requested, retain the producer-overlay gate recorded with
candidate 9f4055d: producer base
`b8f0a8e50e2c0fbb160dae12a7bd78035a58db99`, owned overlay
`6a8e344cb12c4752e7f06e08f30b9b12e5ac3643`, **50 START / 50 PASS / 0 FAIL,
exit 0**, zero new umbrella reflog entries. Original captures/inventory/overlay
patch remain under `evidence/wheelhouse-project-sg0z/` and byte-for-byte unchanged.
The existing helper/producer supplemental guards were not altered by this
rebase; no second producer run was performed. That is historical pinned-overlay
coverage, not proof of a future main-to-producer merge or new producer tree.

Real provider legs explicitly skip. Native macOS/Git/Bun fixture behavior is
covered, not production providers, Windows/network filesystems or exhaustive
races. No live verifier, installed service or production state was changed.
No push, merge or bead close. `check-run.py` is retained in the parent evidence
directory as provenance; reconstruct it beneath the bead's scratch root before
execution because its umbrella lookup depends on its own path.
