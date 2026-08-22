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

This has a collision consequence worth stating before any wiring is discussed: two PROJECTS pointing at the same seat directory share that directory's login, so the rule above stops being true of your fleet before a single registry is copied. That failure is silent and it is upstream of everything the discovery runbook does.

How the subscriptions you hold get divided across several fleets on one machine is the operator's call, not this template's. The rule above says a seat is not shared; it says nothing about which wheelhouse a given seat belongs to, and that allocation is a decision about your own licences that no template is in a position to make for you.

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
It sits under a per-PROJECT root for a second reason: one machine can host more
than one wheelhouse, and these directories are the only thing keeping their
fleets apart on disk. The `cd` matters as much: the commander is defined by the
folder's `CLAUDE.md` and every path in the contracts is written relative to the
project root, so a seat started anywhere else reads a different project or none.

```bash
export CLAUDE_CONFIG_DIR="$HOME/.claude-seats-<namespace>/<seat-name>"

# This directory must be this seat's or nobody's. One that already holds
# sessions started somewhere else is another fleet's seat, and adopting it
# joins two projects at the login AND at the registry.
if [ -d "$CLAUDE_CONFIG_DIR/sessions" ]; then
  sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' "$CLAUDE_CONFIG_DIR"/sessions/*.json 2>/dev/null | sort -u
fi

cd /path/to/project-root
claude
```

Substitute the seat's name from the roster below, this project's namespace from
`### Seat namespace` below, and this project's real root —
`wheelhouse/STARTUP.md` carries all three already filled in. A seat whose name
does not match its roster entry is a seat the commander cannot address, and that
failure looks exactly like an idle seat.

**Read what that check prints before you run `claude`.** Nothing printed is the
ordinary answer: the directory is new, or it is this seat's and idle. This
project's own root printed is fine — that is this seat, previously run. **Any
other path is a STOP**, and it is not a permissions problem or a stale file: it
is another wheelhouse's seat, and the path printed names the project it serves.
Pick a directory this fleet owns rather than sharing that one. This check exists
because the collision it catches has been reached in practice and was caught by
a person being suspicious rather than by anything in this procedure (2026-08-22).

**The namespace is one recorded value with two consequences, and neither is
redundant with the other.** It names this project's seat root, and it is the
prefix every seat name on the roster carries. The ROOT is what the wiring reads:
`wheelhouse/runbooks/wire-seats.sh` enumerates it, so a scoped root is what stops
one fleet's wiring from sweeping up another fleet's seats. What the wiring WRITES
into is the commander's own session registry, and that is scoped by nothing —
two wheelhouses whose commanders both run under the principal's default
configuration directory deposit their seat rows in the same registry. Two seats
named `seat-worker-1` there are two rows the roll call cannot tell apart, and a
dispatch addressed to that name lands on whichever one answered, in whichever
project. The root separates the fleets on disk; the prefix separates them in the
registry they share. This was not hypothetical: a second wheelhouse installed on
a machine that already ran one found the first fleet's seat directories sitting
in the place it was about to use (reported 2026-08-22).

**And the crossing runs both ways, with the return leg the worse one.** The
obvious half is that the newcomer's wiring can reach the incumbent's seats. The
half that is missed is the reverse copy: the newcomer's COMMANDER is written
into the incumbent's seat registries, so a running fleet's workers become
addressable by — and report to — a commander from another project, without
anything in either fleet changing or announcing it. Reproduced against a
two-fleet fixture, 2026-08-22.

**Where the value actually lives.** `### Seat namespace` below is the human
record; the machine record is `namespace=` in `wheelhouse/.template-source`,
which is what `wire-seats.sh` reads so the operator has nothing to remember and
nothing to pass. The two must say the same string, and `.template-source` is the
one that decides — it is the copy a program acts on. That file already exists,
is already per-install, and is already read by other steps, which is why the
namespace went there rather than into a new file to keep in sync.

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

**5. Wire discovery, roll call, then verify the seat can speak first.** Per-seat
configuration directories also isolate each session's registry, so until you run
`wheelhouse/runbooks/SEAT_DISCOVERY.md` the commander cannot address the seat by
name and the seat cannot reach the commander at all — and an unreachable seat is
indistinguishable from an idle one. Run that runbook from the project root after
launching or relaunching any seat. It derives this project's seat root from the
recorded namespace itself, so there is nothing to pass and nothing to remember,
and it refuses the run outright if a seat in scope turns out to belong to
another project. You run it, not the commander: an agent cannot write into its
own session registry.

Wiring makes the seat reachable, not identifiable — registry rows carry derived
names — so the commander's next act, before it dispatches anything, is a roll
call that asks each seat its name and binds the map. The roll call also asserts
that no name in that map is ambiguous in the registry it just read: the seat root
is per-project but the commander's registry is not, so on a machine hosting
several wheelhouses one name can resolve to two live rows. Two rows for one name
is a STOP, not a warning. Then verify by asking the
seat to message the commander unprompted, addressing it by name. A round trip
does not test this: a reply travels back the way the message came without ever
consulting the seat's registry, so it passes while half the wiring is missing. A
seat that does not answer is not launched, whatever its terminal shows.

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

### Seat namespace

<!-- The one value the interview derives for seats. Two lines: the namespace
     itself (short, lowercase, filesystem-safe — usually this project's own
     name), and the seat root it names, $HOME/.claude-seats-<namespace>.
     The MACHINE record is namespace= in wheelhouse/.template-source, which is
     what wire-seats.sh reads; this section is the human one and must carry the
     same string. Every other seat-naming surface derives from it: the roster's
     seat names carry the namespace as a prefix, and wheelhouse/STARTUP.md's
     launch blocks name the root. A machine that hosts one wheelhouse today may
     host two next month, and the value costs nothing until it does. -->

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
