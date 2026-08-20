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

On the build stamped below, a command whose operations ALL fail exits non-zero, but one where some succeeded and some failed exits zero: a mixed-result batch still reads as success. A subcommand invoked without its required argument prints usage and exits zero as well.

Whether the CLI resolves the graph from a subdirectory is also build-dependent — some builds find it only from the project root. Check rather than assume.

### The review queue

The build stamped below has no `in_review` among its built-in statuses, so the review queue is a LABEL:

- the worker adds `needs-review` when the work is done and the branch is ready;
- the reviewer reads it as the queue;
- closing a bead drops the label in the same breath.

A closed bead still carrying `needs-review` renders as in-flight in the listing and misleads every seat that reads it.

That is a default, not a limit: a build that accepts custom statuses can be given a real `in_review` instead. Either is fine; pick one and write it down here, because a fleet where half the seats use the label and half use a status is worse than either.

> Version-stamped: the statements above are facts about a particular CLI build, not eternal truths. The top-level `--help` cannot answer them — it lists commands, not status values. Attempting an invalid status is the better probe: the error names the built-in list. Verified against bd 1.2.2 on 2026-08-19. Correct this file if your build differs.

## This project

Generated at install.

### Priorities

<!-- What P0..P3 mean here, and what outranks what. -->
