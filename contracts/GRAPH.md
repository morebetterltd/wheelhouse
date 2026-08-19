# The Work Graph

The graph is the single source of work state. Not the chat, not a seat's memory, not a summary someone wrote afterwards.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

- **One bead in flight per seat.** A seat working two things is a seat reporting on neither.
- **Beads carry their evidence as comments.** The decision trail has to survive the close, because the reason a thing was done outlives everyone's memory of doing it.
- **Work discovered mid-task becomes a bead, not a detour.** Report it, file it, stay on your own bead.
- **A bead's done is stated by its author and judged by the reviewer.** Neither the worker nor the reviewer gets to move it.

### Running the CLI

Run the graph CLI from the project root only. From a subdirectory it errors — and an errored command piped into a counter looks exactly like a clean zero. That has cost a seat a wrong conclusion and the report built on it.

### The review queue

This build of the CLI has no `in_review` status. The review queue is a LABEL:

- the worker adds `needs-review` when the work is done and the branch is ready;
- the reviewer reads it as the queue;
- closing a bead drops the label in the same breath.

A closed bead still carrying `needs-review` renders as in-flight in the listing and misleads every seat that reads it.

> Version-stamped: the two statements above are facts about a particular CLI build, not eternal truths. Check them against your own `bd --help` before trusting them, and correct this file if your build differs.

## This project

Generated at install.

### Priorities

<!-- What P0..P3 mean here, and what outranks what. -->
