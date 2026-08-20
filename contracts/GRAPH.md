# The Work Graph

The graph is the single source of work state. Not the chat, not a seat's memory, not a summary someone wrote afterwards.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

- **One bead in flight per seat.** A seat working two things is a seat reporting on neither.
- **Beads carry their evidence as comments.** The decision trail has to survive the close, because the reason a thing was done outlives everyone's memory of doing it.
- **Work discovered mid-task becomes a bead, not a detour.** Report it, file it, stay on your own bead.
- **A bead's done is stated by its author and judged by the reviewer.** Neither the worker nor the reviewer gets to move it.

### Running the CLI

An errored command piped into a counter looks exactly like a clean zero. That has cost a seat a wrong conclusion and the report built on it, so check the exit status before you believe a count — and check what the exit status is worth on your build.

On the build stamped below, a command whose operations ALL fail exits non-zero, but one where some succeeded and some failed exits zero: the mixed-result batch is the one case measured on that build where a failure reads as success. A near neighbour worth knowing is `bd update <id>` with no update flags — it prints `No updates specified` and exits zero without ever validating the id, so a mistyped flag turns the command into a silent no-op against an id that need not exist. Older builds were worse still: an invalid status update printed its error and exited zero. Establish which you have instead of carrying this sentence forward on faith.

Where the CLI may be run from is build-dependent, and the answer is not simply "the root". bd 0.49.1 resolved the graph only from the project root. bd 1.2.2 resolves it from a plain subdirectory but still fails inside a NESTED GIT REPOSITORY — the workspace walk stops at the nested repo boundary, so a product repo checked out beneath the root gets `no beads database found` and exit 1. Measured 2026-08-20 from four places under one root: two plain subdirectories returned the graph at exit 0, two product repos carrying their own `.git` failed at exit 1. The discriminator is the nested repository, not the depth.

That is the layout this contract's own interview prescribes, so run-from-root still holds wherever the fleet actually edits code. The consolation is that this build fails honestly — a message and a non-zero exit, rather than the silent-looking zero the original rule was written against. Before deciding the rule has lapsed on your build, measure from inside a nested repo and not just from a subdirectory.

### The review queue

This bd build has no in_review status. Valid statuses are open, in_progress, blocked, deferred, closed, pinned, hooked (verified against bd 1.2.2 by attempting `bd list --status in_review` and reading the rejection). The needs-review LABEL is the review-queue signal: the worker adds it at done, closing drops it in the same breath. Re-verify this against your own bd version — it is a fact about a build, not about beads.

Two cautions when you re-verify. The probes disagree: `bd list --help` describes its `--status` filter as taking open, in_progress, blocked, deferred, closed — five — while both rejection messages name seven, adding pinned and hooked. Trust the rejection text over the help text. And the absence is a configurable default rather than a property: `bd config set status.custom in_review` is accepted, after which the status validates and beads render as IN_REVIEW. Either shape works; pick one and write it down here, because a fleet where half the seats use the label and half use a status is worse than either.

A closed bead still carrying `needs-review` renders as in-flight in the listing and misleads every seat that reads it.

> Version-stamped: every statement above is a fact about a particular CLI build, not an eternal truth. Verified against bd 1.2.2 on 2026-08-19. Correct this file if your build differs, and say so in your report rather than working around it quietly.

## This project

Generated at install.

### Priorities

<!-- What P0..P3 mean here, and what outranks what. -->
