# The Bench

A bench is an executable that answers one question a reviewer cannot answer by reading: does the built artifact actually do its job?

## Contract

Copied byte-for-byte into every project. Do not edit this section.

A bench must satisfy all eight of these. They are stack-agnostic on purpose — every one of them was learned from an artifact that passed a weaker check.

1. **One command, artifact in, exit code out.** `wheelhouse/crew/bench.sh <artifact> <output-dir>`, exit 0 for pass and non-zero for fail. A reviewer must be able to run it without reading it.

2. **It exercises the BUILT ARTIFACT.** Not the source, not a dev server, not a debug harness that reassembles the pieces differently. What ships is what gets tested.

   That obliges you to be able to say WHICH artifact you tested, which needs an identifier derived from the artifact's own contents — not a name someone can reassign. Where your toolchain supplies one, use it. Where it does not, a hash of the built file recorded when it is built, carried in whatever the bench receives, and re-computed by the bench before it runs anything, does the same job. The property to preserve is that the identifier changes when the bytes change and cannot be moved to different bytes; a version string, a branch name or a mutable tag has neither half, and a bench that accepts one is testing whatever that label points at today. This is the requirement most likely to have no ready-made answer on your stack — a compiled binary shipped by a deploy script has no registry to borrow one from — and inventing the analogue is part of writing the bench rather than a sign you are off the path.

3. **It starts from clean state, every run.** No snapshots, no reused state, no data left by the last run. Snapshots and leftover state hide install-state and first-run bugs, and they let one run inherit another's conclusion.

4. **Liveness is not success.** A live process proves a process is live. The bench must assert the artifact DID ITS JOB — served the real response, loaded its own assets, reached its first screen, produced the output. This is the clause that catches the failures worth catching: a server that boots with no routes, a CLI that starts and does nothing, an app that renders an empty screen.

5. **It retains evidence.** Whatever a non-author needs in order to believe the result — logs, captures, output — written to the output directory and referenced from the verdict.

6. **It always tears down.** On success, on failure, and on interrupt. A leaked environment costs the next run silently, and silent costs are the expensive kind.

7. **Measurements are not verdicts.** Any number the bench emits — a threshold, a heuristic, a similarity score — is reported as a measurement, and the doc states what it CANNOT distinguish. A check that prints a conclusion it did not establish is worse than no check, because it replaces a reviewer's judgment with a sentence.

8. **It is re-runnable by someone who did not write it**, on a fresh checkout, from documented prerequisites.

### The stub

A project without a bench yet ships `wheelhouse/crew/bench.sh` as a stub that exits non-zero. An unimplemented bench that passes is indistinguishable from a bench that works, and the reviewer contract leans on the bench being real.

### Worked examples

The template repository carries two, under `examples/`. Each is one project's implementation, not a spec, and they are there because reading a real bench beats reading criteria. Read the one whose shape is closer to yours, then write your own against the eight clauses above.

- a mobile app benched on an emulated device — installs an artifact, drives it, and asserts on what rendered
- an HTTP service with a separate background worker — starts a throwaway database per run, asserts across the seam between two deployables, and tears down on interrupt

The second is the one to read if your project ships more than one deployable, or if starting from clean state means standing up a dependency rather than wiping a device.

## This project

Generated at install.

### What the artifact is

<!--
The thing the bench receives: a binary, an image, a package, an installer.

If this project ships MORE THAN ONE deployable, name them all here and say what
single thing the bench takes as its argument — a manifest naming each, most
likely. One bench per deployable and none for the seam between them leaves the
failure they are most likely to have uncovered. See the HTTP-service example in
the template repository for one way to do it.

If a second deployable does not exist yet — a stub, a directory, an intention —
scope the bench to what is real and SAY SO HERE: which deployables it covers,
which it does not, and why. An honest gap beats an invented assertion, and an
unrecorded scope choice is indistinguishable from full coverage to everyone who
reads the verdict afterwards. The reviewer's contract carries the matching
half: an APPROVE touching a deployable no bench covers has to say so on the
verdict rather than pass as though it were covered.
-->

### What proves it did its job

<!--
The one observation that convinces the principal a build actually works.
If this is not yet answerable, say so here. An honest gap beats an invented
assertion, and the stub keeps the reviewer honest until it is filled.
-->

### What is set up and torn down around the assertion

<!--
The target, if it is long-running: a server, a virtual device, a container has
to be started and stopped around the assertion.

AND the fixtures, whether or not the target is long-running. A one-shot
artifact -- a CLI, a library, a batch job -- starts nothing, but it usually
still needs something created for it to act on and removed afterwards: a
throwaway directory, a scratch database, a copied input file. Those belong
here. They are what clause 3 means by clean state and what clause 6 means by
tearing down, and a bench that leaves them behind fails both while passing
every check that only asks whether the process exited.

Delete this section only if NOTHING is created for the run and nothing is left
after it -- which is rarer than it sounds. Filling it with "not applicable"
because the target is one-shot is the mistake this wording exists to prevent.
-->

### What the error scan looks for

### Prerequisites
