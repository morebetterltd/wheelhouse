# Notes verification map (illustrative example)

This adapted example shows the map's shape, not a shipped application or driver.
The fictional `notes` application and `control-notes` driver illustrate concrete
consumer actions; use commands and handles found in the real product instead.
See the [source and license notice](../../../NOTICE-pstack.md).

Read the index before driving, then use every relevant feature entry as a recipe.

## Baseline preconditions

- Start a run-owned Notes instance with a disposable data directory. These
  examples assume `http://127.0.0.1:4173`; if that port is occupied, choose an
  unused test endpoint and carry it through the app, driver and doctor check.
  Never stop an installed instance to claim this port.
- Set `NOTES_DATA_DIR` to the state directory under the caller's scratch root.
  Keep retained evidence in a separate named directory so teardown cannot erase it.
- Seed notes titled `Quarterly plan` and `Grocery list`.
- Put the fictional `control-notes` and `notes` commands on the driver's search path.
- Require `control-notes doctor` to report the expected endpoint, disposable data
  directory and build revision before driving. Never use a foreign instance.

## Driving conventions

Start each recipe from the baseline state unless its preconditions say otherwise.
Prefer accessible roles and names over position. Keep literal quoted names and
flags unchanged. Browser actions use `control-notes browser`; terminal actions
use `control-notes cli -- <command>`. Restore seeded data after mutation without
removing proof. Doctor again after a failed or surprising action.

## Proof and coverage

Capture actions and results, not only a final screen. Visual proof identifies
the app and its state; command proof keeps stdout, stderr and status distinct.
Mutation proof includes a second read-only view of the stored value. Name the
feature and entry point in the evidence. Report unreachable paths with the
attempt and unmet prerequisite, never as passes through another route. Inspect
retained evidence after cleanup.

## Feature entry contract

Each file has an H1 title and exactly these four H2s, in order:

1. `What it is`: consumer-visible behavior and its sub-features.
2. `How to get to it`: every consumer entry point.
3. `How to drive it`: preconditions and labelled action/command/result pairs.
4. `What proves it works`: observable end state, side effects, evidence and traps.

Describe consumer paths rather than implementation internals. If a prerequisite
is absent, report the failure instead of weakening the journey.

## Features

- [Create a note](./create-note.md): browser and command creation, cancellation,
  persistence, second-view proof and cleanup.
- [Search notes](./search.md): toolbar, keyboard and command search, including
  matching, empty and cleared states.
