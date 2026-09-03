# INTENT.md — ISA grammar

Wheelhouse's intent interface is the shape of `wheelhouse/ISA.md`. Any intent layer that reads and writes this grammar can drive a wheelhouse: it can tell the fleet which hill to climb, trace work back to direction, and keep claims tied to evidence. LifeOS is one example of such a layer, and a PAI-style setup is another; nothing in this template requires either.

The section headings are the interface. Frontmatter is optional machine-readable metadata, not required grammar.

## Required productions

### GOAL

`## Goal` holds the principal's words about the intended state.

Invariant: the initial goal is captured verbatim from the principal, never proposed or paraphrased by the installer, with attribution and date. Later goal evolutions are recorded the same way and supersede earlier goals without erasing them.

### CLAIMS

`## Claims` records established facts about the project.

Invariant: every claim is dated, cites evidence in a home `wheelhouse/GRAPH.md` accepts, and names what would falsify it or where that falsifier lives. Claims are never invented. Empty is the honest initial state; a pending proof remains pending until its falsifier closes.

### DECISIONS-BEFORE-WORK

`## Decisions` records direction before implementation work depends on it.

Invariant: principal direction lands as a dated, attributed decision before, or in the same breath as, the beads implementing it are dispatched. The decision entry is what those beads trace to.

### ANTI-CLAIMS

`## Anti-claims` records what the fleet is explicitly not doing.

Invariant: anti-claims are durable negative scope: they prevent the fleet from re-proposing work the principal already ruled out or the project already bounded away.

### EVIDENCE STUBS

A claim whose evidence is not yet in hand is marked as pending rather than promoted to an established claim.

Invariant: the stub names the pending evidence, the condition that will close it, and where the evidence will land. An honest gap is valid; an invented assertion is not.

### MERGE-APPENDS-CLAIM

A merge that changes what is true of the project updates the ISA.

Invariant: when a merge establishes or invalidates a project claim, the integration appends or amends the claim in `## Claims`, or records why the merge changes no claim. A claim closes on a verifier walk of the surface it names, or states that it has not been walked. The code line and the intent line move together.

## Optional frontmatter

An intent layer may add YAML frontmatter for machine-readable state. The reference install uses fields like:

```yaml
---
principal_stated_goal: "<verbatim goal with attribution and date>"
phase: <phase-name>
progress: <done>/<total>
slug: <short-project-slug>
iteration: <number>
---
```

These fields are optional. A valid ISA is valid because it speaks the section grammar above, not because it has frontmatter.

## Conformance

A conforming ISA can be verified from its file history. The verifier needs the repository history for `wheelhouse/ISA.md` and the graph's bead timestamps; it does not need the conversation that produced either.

### History-only test

Run from the install root:

```bash
git log --format='%H %cI %s' -- wheelhouse/ISA.md
git log -p -- wheelhouse/ISA.md
bd show <bead-id> --json
```

For a stage of work under test:

1. **DECISIONS-BEFORE-WORK.** Find the principal direction in a `## Decisions` diff. The entry must be dated and attributed, and the commit containing it must predate the `started_at` timestamp of each bead that traces to that direction, or be the same commit/turn that filed and dispatched those beads. The graph supplies the bead timestamps; the ISA history supplies the decision commit and date.
2. **MERGE-APPENDS-CLAIM.** For each merge that changes what is true of the project, find a `## Claims` diff that cites the merged tip and the evidence home accepted by `wheelhouse/GRAPH.md`. The claim commit must correlate with the merge it cites: same integration commit, or a corrective follow-up commit that names the corrected commit identifier. A merge that changes no claim must instead have the bead record the explicit `no claim moved, because ...` escape hatch.
3. **Limits.** This verifies presence, ordering, and citation shape, not truth. It cannot prove that the principal really said the attributed words, that the evidence home contains sufficient evidence, or that a `no claim moved` explanation is correct. Those remain reviewer/integrator judgments.

A nonconformity is recorded as a finding and corrected with a follow-up commit that names what it corrects. Do not rewrite history to make the old record look as if it had always conformed.
