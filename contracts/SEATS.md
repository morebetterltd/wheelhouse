# Fleet: Seats

A seat is a standing session that holds a role. This file is the contract every seat operates under; your project's roster goes in the generated section at the end.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

### What a seat is

A standing session pinned to its own subscription, with its own configuration directory, addressable by name. It idles between dispatches and holds context across them.

### Lifecycle

A seat's session context is a CACHE. Everything durable lives on the graph, in the contracts, in git, and in the ISA — which is why reports go on the bead. A seat that loses its context loses nothing the fleet needs: at most one in-flight bead, which the commander re-dispatches. The context a standing seat holds across dispatches is a warm cache, nothing more.

That the cache is disposable is what makes EPHEMERAL the default lifecycle: a fresh session per dispatched bead, discarded once the report lands on the bead. No lifecycle management exists in this mode, and none is needed — there is nothing to keep alive.

A standing seat — the terminal kept open, which the rest of this file describes — is a PROMOTION, not the starting shape; `wheelhouse/runbooks/PROMOTION.md` says when to take it. It buys continuity and dispatch latency, and the price is a manual reset ritual. Within a bead, the harness's auto-compaction carries the seat through. BETWEEN beads — the moment its context is worthless by construction, because everything the next bead needs is on the graph — the human runs `/clear` (the work graph's session hook re-primes the context) or restarts the CLI and pastes the standing prompt again, per the launch procedure below. Reset between beads, never mid-bead.

Nothing here supervises a seat. Automated launch, health-checking and restart are tooling a project brings if it wants them; this template does not promise or provide them. The launch procedure below is a human opening terminals, and that is the whole of it.

From the commander's side, seat health stays what the rules below say: probe once, nudge once — a dead seat and an idle seat look identical, which is why the probe exists. If both go unanswered, declare the seat dead, relaunch it per the launch procedure, and re-dispatch the in-flight bead. That is the entire recovery, because the cache was the only thing lost.

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

**A seat is a terminal you open and leave open.** Launching one is not running a
command that finishes and returns you to a prompt: the interactive session living
in that terminal IS the seat, and closing the terminal ends it. So every seat on
the roster gets its own terminal window or tab, opened by hand, and each stays
open for as long as that seat is meant to exist. Nothing in this fleet daemonizes
a seat or restarts one for you.

That is worth stating first because the rest of this procedure reads like setup
for a launcher that does not exist, and because the commander's dispatches are
addressed to sessions that somebody has to have started. Run these five steps
once per seat in the roster below, before the commander dispatches anything to
that seat.

**1. Check the tool this needs.** The install's own preflight (`BOOTSTRAP.md`
step 0) deliberately does not check for `claude`: a project may take no seats at
all, and the person running the install may never open a CLI session themselves.
This is the first moment anything actually runs it, so the check is here.

```bash
command -v claude || echo "MISSING claude — a seat IS a claude session, so there is nothing here to launch. Install it: https://claude.com/claude-code"
```

A MISSING line is a STOP for this seat, not something to work around: no other
program in this template starts a seat. The commander, the graph and the
contracts are all still fine — what you have is an install whose seats cannot be
occupied until the binary is on this machine's PATH.

**2. Open a new terminal, give the seat its own configuration directory, and
start it at the project root.** The configuration directory is per-seat because
that is what makes one seat one subscription; two seats sharing one directory
share a login, and the seat-accounting rule above stops being true of your fleet.
The `cd` matters as much: the commander is defined by the folder's `CLAUDE.md`
and every path in the contracts is written relative to the project root, so a
seat started anywhere else reads a different project or none.

```bash
export CLAUDE_CONFIG_DIR="$HOME/.claude-seats/<seat-name>"
cd /path/to/project-root
claude
```

Substitute the seat's name from the roster below and this project's real root —
`wheelhouse/STARTUP.md` carries both already filled in. A seat whose name does
not match its roster entry is a seat the commander cannot address, and that
failure looks exactly like an idle seat.

**3. On the first run only, log in — as this seat's own account.** The session
will ask. Use the account the roster pins to this seat and no other; an account
that already holds a seat cannot hold a second one. Later launches reuse the
login stored in that seat's configuration directory and go straight to a prompt.

**4. Paste the standing prompt as the seat's first message.** The text is in
"Standing prompt" directly below — that section is the source, and it is the same
text in every project. Two substitutions before you paste: put the roster's seat
name where `<seat-name>` is, and keep only the role brief the roster gives that
seat. Nothing else in it changes.

The seat is launched when it answers that prompt and then holds. It should not go
looking for work; a seat that starts claiming beads unprompted did not read the
prompt you pasted.

**5. Wire discovery, then verify you can reach it.** Per-seat configuration
directories also isolate each session's registry, so until you run
`wheelhouse/runbooks/SEAT_DISCOVERY.md` the commander cannot address the seat by
name — and an unreachable seat is indistinguishable from an idle one. Run that
runbook from the project root after launching or relaunching any seat, then have
the commander round-trip a message to the seat. A seat that does not answer is
not launched, whatever its terminal shows.

**What the seat does after that.** It idles. The commander sends it work by name,
per stage 1 of `wheelhouse/runbooks/RUNNING_THE_LOOP.md`; the seat then reads the
bead itself and follows the role brief named in its standing prompt —
`wheelhouse/fleet/WORKER.md` for a worker, which is what says to claim the bead,
isolate it in a worktree on `fleet/<bead-id>`, and report on the bead with
evidence before going idle again. The seat never self-assigns, and the standing
prompt is what holds it to that between dispatches.

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

<!-- One line per seat this project took: its name, which brief it reads, and which
     account it is pinned to. The commander is always here — it is the principal's
     own session and was never a question at install. -->

### Declined seats

<!-- One line per seat that was offered at install and refused: the seat, the
     principal's reason, and the date. A seat that was considered and declined
     looks exactly like a seat nobody raised once both are simply absent, and this
     is the only section that can tell them apart. Add a line here when a seat is
     dropped later, too. -->
