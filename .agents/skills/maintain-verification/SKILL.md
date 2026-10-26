---
name: maintain-verification
description: 'Audit a project verification manual and feature map against source and live consumer journeys, reporting drift, unmapped features and breakage without editing files.'
version: 1.0.0
---

Adapted under MIT; see the [source and license notice](../NOTICE-pstack.md).

# Maintain a verification manual

Keep the manual honest as the product changes. The unit of rigor is the
consumer feature: read every feature entry against source and drive every
mapped feature live. A source reading alone does not verify behavior.

This is a findings-only, single-process pass: one reader loop followed by one
live pass. Do not delegate parallel readers. Never edit product code, the
manual, the feature map or their helpers. Never create branches, submit pull
requests or commit changes. Report needed corrections for later work instead. Runtime
state and evidence belong in the run's isolated scratch and retention locations,
not in product edits. Do not change the journeys to manufacture a pass.

### Locate the manual and bound the pass

Find `.agents/skills/verify-<project>/SKILL.md` in the product repository;
`<project>` is that repository's directory basename. Read it and
`features/README.md`, then enumerate every feature file beside the index. If
there is no matching manual or the target is ambiguous, report a `break` naming
the path and stop rather than inventing instructions or choosing silently.

Record the product revision, the manual version and the exact recent change
range you inspect. State any unavailable source or missing baseline as a
finding; an empty search over missing input is not evidence of completeness.
If the manual declares `surface: none`, verify that the current source still
has no runnable consumer surface. A newly present surface is `unmapped` and
needs a real manual; do not turn the no-surface declaration into a live pass.

### One reader loop

Read the index, every feature entry and the relevant source in this process.
Check missing, duplicate, dead or unindexed entries without changing them.
For each feature, explain its consumer behavior from concrete source paths,
compare its preconditions, entry points and results with the entry, and note
a concise live recipe. Preserve distinct entry points even if recipes overlap.
Use the four entry headings: What it is, How to get to it, How to drive it,
What proves it works.

Read the recorded recent changes for user-facing behavior absent from the map.
Require a concrete source path before calling a feature unmapped. A map that
covers its own entries can still omit a newly added command or route. Merge
compatible recipes into as few application states as practical, but never
remove a feature or entry point merely to make the pass shorter.

### One live pass

Use the manual's own Launch, Doctor, Drive, Evidence and Cleanup instructions.
Require isolated state and a non-production endpoint; never stop, replace or
reconfigure an installed instance or service to make room. If safe isolation
is unavailable, record a `break` and do not touch the shared instance.

Drive every mapped feature and its named entry points. A long-lived instance
may serve several serial drives when the manual says so; short-lived commands
need fresh isolated sessions. Hold these invariants even when a journey fails:

- Doctor before the first drive, on each fresh session and after a failed or
  surprising action. A healthy process with a wedged interface needs a safe
  reset or relaunch, not hopeful continuation.
- Capture the consumer action, resulting state and independently readable side
  effects. Retain stdout, stderr and status distinctly where applicable. A
  ready signal or an internal state setter does not prove the consumer journey.
- Clean failed-attempt residue before proceeding. Remove only resources whose
  ownership this run can confirm; never kill by process name or remove a
  shared instance. Preserve and inspect evidence after each cleanup.

A doctor or driver instruction that disagrees with the source is `drift`;
a functioning feature that its recipe cannot drive is also `drift`. Do not
repair either during this pass. Broken product behavior or an unmet live
prerequisite is `break`. Name the attempted route and exact prerequisite for
an unreachable feature; do not count it verified through a different route.
If the entry omitted that prerequisite, also record the documentation drift.

Finish teardown after the last drive, including failed ones. Verify that the
captured evidence still exists and says what the result claims. Record any
unfinished cleanup without expanding signal or deletion scope. If time or
access prevents full coverage, name the uncovered feature as `break`; do not
report a partial pass as clean. Keep run notes and evidence outside the product
tree. The pass makes no source, manual, map or helper corrections.

### Return findings only

End with a plain-text block and no surrounding code fence. Use one line per
finding, with a concrete feature or path and one sentence. Classify wrong or
missing instructions, index faults and driver gaps as `drift`; a concrete
unmapped consumer surface as `unmapped`; product failure, unavailable coverage
or blocked prerequisites as `break`. Describe the evidence or attempted path
in that sentence; do not include a proposed patch or claim an unperformed drive.

The format is:

```text
FINDINGS:
- drift|unmapped|break — <feature or path> — <one sentence>
```

If and only if all applicable source and live coverage completed with no
findings, the entire output is:

```text
FINDINGS: none
```
