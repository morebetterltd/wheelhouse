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

Invariant: when a merge establishes or invalidates a project claim, the integration appends or amends the claim in `## Claims`, or records why the merge changes no claim. The code line and the intent line move together.

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

A conforming ISA can be verified from its file history: goal text traces to principal words, decisions precede the work that implements them, pending evidence is distinguishable from established claims, and claim-changing merges move the claim record or explain why not. The acceptance bead for this intent layer fills in the history-only verification procedure.
