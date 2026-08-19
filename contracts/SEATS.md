# Fleet: Seats

A seat is a standing session that holds a role. This file is the contract every seat operates under; your project's roster goes in the generated section at the end.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

### What a seat is

A standing session pinned to its own subscription, with its own configuration directory, addressable by name. It idles between dispatches and holds context across them.

### Seat accounting

**One seat = one subscription = one human beneficiary. No seat serves anyone else.**

This is a licensing-compliance statement, not a preference or a scaling guideline. It does not change with the size of your fleet, and it is the reason each seat needs its own configuration directory rather than sharing one.

### Rules

- **One bead in flight per seat.** The graph is the single source of work state.
- **Report BEFORE going idle.** Finishing work and going quiet is the known failure mode of ephemeral workers, and the standing prompt makes the report an explicit contract rather than a hope.
- **The commander probes, then nudges once, on silence.** A seat that cannot be reached looks exactly like a seat that is idle.
- **Seats inherit the project's permissions.** Per-seat escalations go to the principal.
- **A seat does only briefed work.** It never self-assigns from the graph without a dispatch.
- **A reviewer seat never reviews what it authored.** If the only available reviewer wrote the diff, the work waits.

### Launching a seat

Each seat gets its own configuration directory so logins do not collide:

```bash
export CLAUDE_CONFIG_DIR="$HOME/.claude-seats/<seat-name>"
cd /path/to/project-root
claude   # first run only: log in with that seat's account
```

Paste that seat's standing prompt as the first message.

> Version-stamped: the `CLAUDE_CONFIG_DIR` mechanism and the cross-seat discovery
> procedure in `wheelhouse/runbooks/SEAT_DISCOVERY.md` depend on harness internals that can
> change. Verified working August 2026. If seats cannot see each other, check the
> current behaviour before assuming you mis-followed the steps.

### Standing prompt

> You are `<seat-name>` in this project's standing fleet. Read `wheelhouse/fleet/WORKER.md` (or `wheelhouse/crew/REVIEWER.md` / `wheelhouse/crew/DESIGNER.md` per your seat) and this project's `CLAUDE.md`. Idle until the commander sends you work by name. Do only briefed work. Report results back to the sender with evidence, and send that report BEFORE going idle. Between tasks, hold; never self-assign work without a dispatch.

### Minimum viable fleet

Commander + one worker + one reviewer. That is a working loop. Add seats when a specific role is the bottleneck, not to fill out a roster — see `wheelhouse/runbooks/PROMOTION.md`.

## This project

Generated at install.

### Roster

<!-- Seat names, which brief each reads, and which account each is pinned to. -->
