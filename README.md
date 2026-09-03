# Wheelhouse

A standing agent fleet, over a shared work graph, installable on any project.

The shape: a **commander** session where you argue direction, a **designer** that turns direction into implementable work, **workers** that implement one unit at a time on isolated branches, a **reviewer** that gates every diff with evidence and never reviews what it wrote, and an ephemeral **verifier** that turns a finished branch into a single verdict — never on the author's account. Work lives in a graph, not in chat. Nothing merges on a claim.

The commander is a Claude Code session — yours. Every other seat is a persistent [Pi](https://github.com/earendil-works/pi) process the commander owns: each pinned to one account of its own, on whichever provider that account is for — a Codex subscription, an Anthropic API key, another vendor entirely. The roster recording who runs on what is a JSON file; the roles are briefs injected at spawn.

This repo is the template. It ships the contracts those roles share, the seat machinery they run on, worked examples, and a bootstrap procedure that installs the whole thing into a project by interviewing you about that project.

Two paths:

- **Fresh project, no wheelhouse yet:** go to [Install](#install).
- **Existing wheelhouse, of any age:** go to [Upgrading](#upgrading). Pre-Pi installs with v1 Claude Code seats are covered there too.

## Prerequisites

- **a git repository you want the fleet to work on.** The wheelhouse installs into a project you already have; it does not start one for you.
- **[Claude Code](https://claude.com/claude-code), for the commander.** The commander seat is a Claude Code session, and the install is itself a Claude Code session — it is the one seat every install has.
- **[Pi](https://github.com/earendil-works/pi) and [Bun](https://bun.sh), for the seats.** `pi` is the seat runtime — every worker, reviewer, and verifier seat is a Pi process — and `bun` runs the adapter that spawns and dispatches them. `npm install -g @earendil-works/pi-coding-agent` and `brew install oven-sh/bun/bun`, or see their pages.
- **four more command-line tools on your PATH: `git`, `bd`, `bash`, `awk`.** Three of those ship with macOS and every Linux. `bd` is the work graph, and is the one you probably have to install: `brew install beads`, or see https://github.com/gastownhall/beads.

You do not have to check the seven by hand. The install opens with a dependency preflight that checks all of them, and for each one that is missing prints what the wheelhouse needs it for and how to install it, then stops before anything has been written.

## Install

Open a Claude Code session in your project root and paste the block below into that session.

**Paste the whole block into Claude; you run none of it yourself.** The block is addressed to Claude, and the shell command inside it is Claude's to execute — which is why it opens with a sentence rather than a command, and why pasting the block into a terminal fails on its first line.

```text
Install the wheelhouse in this repo.

Clone the template somewhere temporary and read its BOOTSTRAP.md, then follow it
exactly:

  TEMPLATE=$(mktemp -d) && \
    git clone --depth 1 https://github.com/morebetterltd/wheelhouse.git "$TEMPLATE" && \
    test -s "$TEMPLATE/BOOTSTRAP.md" || \
    { echo "TEMPLATE CLONE FAILED OR EMPTY - STOP" >&2; exit 1; }
  echo "template at: $TEMPLATE"

That command exits non-zero if anything went wrong, so do not judge it by its
output alone. An empty clone exits 0 and looks like success; installing from one
produces a wheelhouse with no contracts in it. If it fails, STOP and tell me.

Note the printed path. BOOTSTRAP has you record it in a file immediately, because
a shell variable does not survive between your tool calls.

BOOTSTRAP.md is the authoritative procedure — it tells you what to read before
asking me anything, what to ask, what to write, and how to verify the install.
Follow it in order and do not skip the verification step.

Two things before you start:
- This directory is the project root. Everything you create goes here or under
  wheelhouse/. Confirm with me if that looks wrong.
- If anything is already installed here, or a step cannot complete, STOP and tell
  me. Do not work around it, and do not overwrite anything I already have.
```

It will survey your repo, then interview you about the things it cannot derive: which repos the fleet changes, what proves a build actually works (that one is several questions), what is true when the first iteration is done, which actions stay yours alone, what authorizes a merge, and what your priorities mean. Then it walks your seat roster one seat at a time, and walks the seats you took a second time for their models — each seat taken gets a role and an account directory of its own, then its own provider, auth route, and a model pinned from a live `pi --list-models` listing rather than from anyone's memory, recorded in `seats/seats.json` (names and paths only; never a secret) — and declining every seat is a legitimate answer. Then it provisions the seats, writes the tree, verifies it, tells you what is stubbed, and closes the loop with a smoke dispatch through a real seat.

If you would rather read the template before installing anything, this is safe to paste into a terminal — it clones a copy you can browse and installs nothing:

```bash
git clone --depth 1 https://github.com/morebetterltd/wheelhouse.git
```

## What lands in your project

```
<project root>/
├── CLAUDE.md                    generated — makes this folder's sessions the commander
├── .beads/                      the work graph
├── seats/                       the seat machinery, at the root because every path it prints is root-relative
│   ├── seats.json               generated — the roster: role, provider, model, auth route, account dir per seat; never a secret
│   ├── seat-env.sh              provisions one seat's isolated account directory, once
│   ├── adapter.ts               runs the seats: spawn, dispatch, steer, status, stop, resume
│   ├── verify.ts                dispatches the ephemeral verifier pass on a finished branch
│   ├── cockpit.sh, floor.ts     the bridge: one tmux window — commander pane left, read-only floor right
│   ├── recover.ts               post-interruption triage: what survived, what to resume
│   └── README.md                documents every command above; selftests sit beside each piece
└── wheelhouse/
    ├── .template-source        where these contracts came from, and at which commit
    ├── ISA.md                   generated — your goal, your claims, your decisions
    ├── STARTUP.md               generated — cold start with your real namespace and seat names
    ├── GRAPH.md                 contract
    ├── INTEGRATOR.md            contract + your push authority
    ├── crew/
    │   ├── DESIGNER.md          contract + your project's territory
    │   ├── REVIEWER.md          contract + your branch conventions
    │   ├── VERIFIER.md          contract — the one-shot verdict pass, never on the author's account
    │   ├── BENCH.md             contract + what proves YOUR build works
    │   └── bench.sh             stub — exits non-zero until you implement it
    ├── fleet/
    │   ├── WORKER.md            contract + your repos, and your gotchas as you earn them
    │   └── SEATS.md             contract + your roster in human form, and the seats you declined
    └── runbooks/                running the loop, upgrading, and the graduations to take later
```

The seats are commander-owned processes, not terminals you keep open. `seats/seat-env.sh` gives each seat its own account directory — one seat, one login — and from then on the adapter does everything: `bun seats/adapter.ts spawn` starts a seat with its role brief injected, `dispatch` hands it a bead, and its session survives a stop, so `resume` brings the context back warm. There is nothing to paste into a seat. To watch the fleet, `seats/cockpit.sh` builds one tmux window per project: your commander session in the left pane, and on the right the floor — a read-only view that spotlights one seat's stream and shows every seat's attention cues in a rail. Cockpit also starts/verifies/restarts the Dispatch Office herald, printing `herald started: pid ...` or the already-running/restart line; a no-cockpit `spawn`/`status` path starts seats, not that wake daemon. `seats/README.md` documents all of it.

## Contract, and this project

Every brief has two sections.

`## Contract` is copied byte-for-byte into every project and never edited per-project. `## This project` is written at install and accreted afterwards, as review earns scars worth recording.

That split is the whole design. It means a project's specifics never get tangled with the shared rules, upgrading the contract later is a file replace rather than a merge, and the answer to "is this line universal or ours?" is visible at a glance forever.

## What is in this repo

| | |
|---|---|
| `contracts/` | the briefs, copied verbatim at install |
| `seats/` | the seat machinery, copied verbatim to the install root: provisioning, the adapter, the verifier dispatcher, the bridge, recovery, and a selftest for each |
| `generated/` | specimens of what the interview writes — never copied, and drawn from an invented project so they cannot be mistaken for a starting point |
| `runbooks/` | how to run the loop, the upgrade procedure, and the graduations to take once the loop has proven itself |
| `examples/` | worked benches, each labelled as one project's implementation: `android-cordova/` from a real project, `http-service/` for a service-and-worker shape |
| `BOOTSTRAP.md` | the procedure the install session follows |
| `MAINTAINING.md` | this repo's convention for revising its own prose — where reasoning lives and how a reader finds the revise-class part; deliberately not a contract |

## Two things worth knowing before you start

**The bench is the load-bearing part.** `contracts/BENCH.md` defines what a bench must satisfy; the eight clauses are stack-agnostic and every one was learned from an artifact that passed a weaker check. The one that earns the file is clause 4: *liveness is not success*. A live process proves a process is live. A server can boot with no routes, a CLI can start and do nothing, an app can render an empty screen — and all three pass any check that only asks whether it is running.

Your install ships a bench stub that exits non-zero. Until you implement it, no APPROVE may claim your software runs. That is deliberate.

**The default is all the way, bounded by your recorded authority.** The install asks how far the fleet takes reviewed work, writes that answer in `wheelhouse/INTEGRATOR.md`, and defaults to merge, push, PR, and automated deploy where the project grants those surfaces. `runbooks/PROMOTION.md` documents project-specific narrowings — for example principal-confirmed local merges or per-push gates — and the evidence that graduates them back toward the shipped default. A behavioral APPROVE over a stub bench is still an approval over nothing.

## Seat accounting

A seat is a standing session pinned to **one subscription, serving one human beneficiary**. No seat serves anyone else. This is a licensing-compliance statement, not a preference, and it does not change with the size of your fleet.

## Upgrading

Already have a `wheelhouse/` in this project? Use this path, even if it is an early v1 install from before Pi seats. The same paste block covers current installs and the v1 Claude Code seats-to-Pi migration.

Open a Claude Code session in your project root and paste the block below into that session.

**Paste the whole block into Claude; you run none of it yourself.** The block is addressed to Claude, and the shell command inside it is Claude's to execute — which is why it opens with a sentence rather than a command, and why pasting the block into a terminal fails on its first line.

```text
Upgrade the wheelhouse in this repo.

Clone the current template somewhere temporary and read its runbooks/UPGRADE.md,
then follow it exactly against this installed project:

  TEMPLATE=$(mktemp -d) && \
    git clone https://github.com/morebetterltd/wheelhouse.git "$TEMPLATE" && \
    test -s "$TEMPLATE/runbooks/UPGRADE.md" || \
    { echo "TEMPLATE CLONE FAILED OR EMPTY - STOP" >&2; exit 1; }
  echo "template at: $TEMPLATE"

That command exits non-zero if anything went wrong, so do not judge it by its
output alone. An empty clone exits 0 and looks like success; upgrading from one
copies nothing current and can make the old files look intentionally preserved.
If it fails, STOP and tell me.

Note the printed path. UPGRADE has you keep using it as TEMPLATE, because a
shell variable does not survive between your tool calls.

Before you copy anything, read this installed project's wheelhouse/.template-source.
That file is the baseline record: where this project installed from, which commit
it installed or last upgraded to, and whether a namespace is already recorded. If
it is missing, or if it predates namespace=, follow UPGRADE.md's recovery and
migration steps exactly; pre-Pi v1 Claude Code seats are covered there.

runbooks/UPGRADE.md from the cloned template is the authoritative procedure — it
tells you how to reconstruct a missing baseline, get enough history to diff,
copy the template-owned files, preserve every `## This project` half, migrate v1
Claude Code seats to Pi seats when needed, verify, sweep generated files and the
work graph, and record the upgrade. Follow it in order and do not skip the
verification step.

Three things before you start:
- This directory is the project root. The installed wheelhouse to upgrade is
  here. Confirm with me if that looks wrong.
- Do not overwrite project-owned content. Splice contracts by the exact
  `## This project` heading rule, keep those project halves whole, and stop on
  any missing heading or mismatch instead of guessing.
- If any step cannot complete, or the installed state does not match the runbook,
  STOP and tell me. Do not work around it.
```

When these contracts improve, you re-copy the eight contract files and the `seats/` machinery, and keep your `## This project` sections. The two-section split is what makes that safe, and there is no tooling for it deliberately — a file copy you understand beats a migration you do not.

The full procedure is [`runbooks/UPGRADE.md`](runbooks/UPGRADE.md), which installs into your project along with the other runbooks. It covers the parts that are not obvious:

- how to reconstruct your baseline if you installed before `.template-source` existed, which every early install did;
- getting a clone with enough history to diff against (the install clone is `--depth 1` and cannot);
- copying the eight `.md` files by name, because `cp -r contracts/` would drop the bench stub over your implemented bench;
- replacing the `seats/` machinery file-by-file, a copy shaped so it can never reach your roster or your seats' runtime state;
- splicing with the same exact-heading rule the install uses, since that is the operation people get wrong;
- sweeping the things a contract copy cannot reach — your generated files and the beads already in your graph — when a convention changes;
- and, for installs made before the seat rebuild, the migration from v1 Claude Code seats to Pi seats — the old machinery is frozen at the template's `v1-claude-seats` tag if you ever need to read how it worked.

Your install records its baseline in `wheelhouse/.template-source`: the template's remote, the commit installed, and when. Upgrades add an `upgraded=` line and leave `installed=` alone, because when you started and when you last upgraded are different facts.

## Pairs well with an intent layer

The commander seat is a plain Claude Code session, and it works fine as exactly that. It also pairs well with personal-AI-infrastructure tooling on the commander's side — a layer that holds your goals and context above any one task graph. [`INTENT.md`](INTENT.md) specifies the ISA grammar any such layer must speak: goal, claims, decisions, anti-claims, evidence stubs, and claim updates on merge. Daniel Miessler's [LifeOS](https://github.com/danielmiessler/LifeOS) is one example of an intent layer; a PAI-style setup is another. The fleet executes; a layer like that helps decide which hill is worth climbing, and keeps verification discipline on the human side of the loop. Nothing in this template requires it.

## Credit

The shape this template installs — a standing fleet of agent seats over a shared work graph, under a human commander — is Steve Yegge's, from his essay [*The Shape of Things to Come*](https://yegge.ai/essays/the-shape-of-things-to-come/). This repo is one working implementation of that idea, grown on a real project; the idea is his.

## License

Public domain, under [the Unlicense](https://unlicense.org). See [LICENSE](LICENSE).
