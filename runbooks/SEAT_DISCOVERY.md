# Seat Discovery

Giving each seat its own `CLAUDE_CONFIG_DIR` is what lets one seat equal one subscription. It also isolates each seat's session registry, so by default the commander cannot see or message any seat, and no seat can reach the commander.

This runbook is the workaround. It has two halves, and skipping either one leaves a fleet that looks wired and is not: an operator copies the registrations, then the commander binds names to seats with a roll call.

> **Version-stamped, and read this before trusting it.** This procedure depends on where and how Claude Code writes session registrations and transcripts — internals that can change without notice. It was verified working in August 2026. If discovery does not work after following it, check the current layout before assuming you mis-followed the steps. `wire-seats.selftest.sh` in this directory is the fastest way to tell a broken script from a moved substrate: it builds a throwaway fleet in a temp directory and checks the script against it, touching none of your real registries.
>
> A workaround with no upstream report becomes permanent. If you install this, file the issue too.

## What it does

Copies each seat's session registration into the commander's registry, and the commander's into each seat's, so both directions resolve by name.

Both directions. The reverse leg is the one that gets dropped, because nothing visibly breaks without it: answering an inbound message needs no registry row, so a forward-only fleet passes every round-trip test you can think to run while no seat can INITIATE to the commander. What that silently breaks is report-before-idle — a seat that finishes work has no address to report to, and the failure surfaces as a seat that went quiet, which is also what a seat looks like when it is working.

Use plain `cp`. Symlinks are ignored by discovery.

## 1. Wire the registries — the operator runs this

```bash
cd /path/to/project-root
wheelhouse/runbooks/wire-seats.sh --dry-run    # read-only: prints the plan
wheelhouse/runbooks/wire-seats.sh
```

**Nothing to pass, and that is deliberate.** The script derives this project's
seat root from `namespace=` in `wheelhouse/.template-source` and prints which
root it used and where the value came from. `SEATS_ROOT` in the environment
overrides that derivation and is part of the interface, not a testing hook — it
is what a relocated seat tree or an install with no namespace recorded yet uses.
With no seat names the script wires every directory under whichever root it
settled on, so a root shared with a second wheelhouse puts that wheelhouse's
seats in scope. `wire-seats.sh --help` carries the full rationale.

**Two teeth, and only the second one bites.** The derived root narrows what is
in scope; the FOREIGN-SEAT PREFLIGHT refuses what is in scope and does not
belong. Before copying anything, the script reads the cwd recorded by every
in-scope seat's live sessions — a seat must be started at its project root, so
that cwd is which fleet it is in — and if any of them is not this project's, it
names the seat and the path and refuses the whole run, having written nothing.
There is no flag to force past it: the two things it tells you to do, scope the
root or name your seats, are the fix. It sees only RUNNING seats, because a
seat that is not running is skipped anyway and can do no harm.

Existing installs that predate the namespace go on working on the shared
fallback while they are the only fleet on their machine, and the preflight is
what protects them the day they are not — `UPGRADE.md`'s step 7 is the move.

**The commander cannot run this for you.** An agent writing into its own session registry is blocked by the permission classifier, so the fleet cannot wire itself — this is an operator step by construction, or a launcher's, and no amount of asking the commander nicely will change it.

Seat names come from the roster in `wheelhouse/fleet/SEATS.md`, which is the one authoritative list — the roster table, not the declined seats recorded beneath it, which are the seats this project does not have. Do not invent names here or copy them from an example: a seat whose name does not match its roster entry is a seat the commander cannot address, and the failure looks exactly like an idle seat. With no arguments the script wires every seat directory under the root it settled on, which is this project's seats and no other once a namespace is recorded. Naming them explicitly narrows it further, and is worth doing on an install still on the shared fallback:

```bash
wheelhouse/runbooks/wire-seats.sh {{SEAT_NAMES}}   # space-separated; from the roster in wheelhouse/fleet/SEATS.md
```

Registrations are per-process, so re-run this whenever a seat restarts. The script is idempotent — it reports `already current` for what is already in place — and stale copies of dead processes are harmless.

### What the script refuses to do

It will not wire a seat that belongs to another project, and it will not wire the ones that do belong while it refuses that one — the preflight above is all-or-nothing on purpose, because a refusal partway through the loop leaves half a fleet joined to a stranger. Note what the transcript-ownership rule below does NOT cover: a foreign seat sitting under a shared root has its transcript inside that root, so ownership reports it correctly owned. Only cwd separates the two fleets, which is why the preflight reads cwd and not ownership. (Credit for that finding and for this check: Releaf's seat-worker-2, 2026-08-22.)

It will not guess which session is the commander. Every seat runs from the same project root, so "the newest live session whose cwd is this project" picks whichever session started last: restart a seat after the commander and that seat becomes the fleet's commander, wiring every other seat to a peer. Instead the script asks which config directory owns each session, by finding the transcript that session writes — the one record the wiring itself does not copy. When ownership cannot be established, or when two sessions could both be the commander, it stops and asks for `--commander-pid` rather than picking one.

Liveness is `ps -p`, not `kill -0`: `kill -0` exits non-zero both for a pid that is gone (ESRCH) and for one that is alive but not signalable by this user (EPERM), and the exit status does not separate them, so a live commander running as another user would read as dead. `ps` reports processes it cannot signal. Measured: `kill -0 1` exits 1 while `ps -p 1` exits 0, and both exit 1 for a pid that does not exist.

## 2. Roll call — the commander's first act, before any dispatch

Copying makes seats reachable. It does not make them identifiable: registry rows carry auto-derived names like `myproject-4f`, never seat names, so a commander that has wired but not rolled sees a list of strangers and cannot tell the reviewer from a worker. **Reachable but anonymous is the normal state after wiring**, and dispatching from it means dispatching to whoever happens to answer.

The roll call is what binds name to seat. Ask every seat for three things:

1. its seat name, from the standing prompt it was given;
2. its `CLAUDE_CONFIG_DIR`;
3. whether it has work in flight.

Keep the resulting map — `myproject-4f = seat-reviewer` — in the commander's working context and dispatch by seat name from there.

**Then assert the map is unambiguous, before the first dispatch.** Every seat name in it must resolve to exactly one live row in the commander's registry, and every `CLAUDE_CONFIG_DIR` the roll call collected must sit under this project's `SEATS_ROOT`. The seat root is per-project; the commander's registry is not, so a machine hosting several wheelhouses can put two live rows behind one name, and a name with two rows dispatches to whichever answers:

```bash
ls ~/.claude/sessions/*.json | wc -l          # rows the commander can address
```

Read the roll call's answers against that, not the count alone: a config directory outside this project's seat root is another fleet's seat wired in by mistake, and a seat name that two rows both claim is a STOP. Unwire the stranger — delete the copied row from `~/.claude/sessions/` — and re-run step 1 with this project's `SEATS_ROOT` set, rather than dispatching and hoping. A dispatch that lands in another project is not visible from here: the bead goes quiet, which is what a working seat also looks like.

**The binding is per-launch.** A restarted seat comes back with a new pid and a new derived name, so it needs re-wiring AND re-rolling. A commander dispatching from yesterday's map is addressing a session that no longer exists, or worse, one that now belongs to a different seat.

## 3. Verify by making a seat SPEAK FIRST

Ask each seat to send the commander an unprompted message, addressed to the commander **by name**.

Do not verify with a round trip. The commander messages a seat, the seat answers, everything looks healthy — and that proves only the forward leg, because a reply travels back down the inbound connection without consulting the seat's registry at all. The reverse leg is only exercised when the seat has to look the commander up. A seat that can only reach the commander by quoting some raw address from a message it received is a seat whose registry is missing the commander's row: wire it again.

A seat that cannot be reached at all has not been wired — relaunch it and re-run step 1.

Verifying matters more here than elsewhere: a seat that cannot be reached looks identical to a seat that is idle, and the commander will wait on it indefinitely.
