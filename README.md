# Wheelhouse

A standing agent fleet, over a shared work graph, installable on any project.

The shape: a **commander** session where you argue direction, a **designer** that turns direction into implementable work, **workers** that implement one unit at a time on isolated branches, and a **reviewer** that gates every diff with evidence and never reviews what it wrote. Work lives in a graph, not in chat. Nothing merges on a claim.

This repo is the template. It ships the contracts those roles share, one worked example, and a bootstrap procedure that installs the whole thing into a project by interviewing you about that project.

## Prerequisites

- a git repository you want the fleet to work on
- [Claude Code](https://claude.com/claude-code)
- the `bd` CLI (the work graph) on your PATH — `brew install beads`, or see https://github.com/gastownhall/beads
- `git` able to reach this repo

## Install

Open a Claude Code session in your project root and paste this:

```
Install the wheelhouse in this repo.

Clone the template somewhere temporary and read its BOOTSTRAP.md, then follow it
exactly:

  TEMPLATE=$(mktemp -d) && \
    git clone --depth 1 git@github.com:morebetterltd/wheelhouse.git "$TEMPLATE" && \
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

It will survey your repo, ask you about the handful of things it cannot derive — six topics, plus your seats if you want them set up straight away — then write the tree, verify it, and tell you what is stubbed.

## What lands in your project

```
<project root>/
├── CLAUDE.md                    generated — makes this folder's sessions the commander
├── .beads/                      the work graph
└── wheelhouse/
    ├── .template-source        where these contracts came from, and at which commit
    ├── ISA.md                   generated — your goal, your claims, your decisions
    ├── STARTUP.md               generated — cold start with your real paths
    ├── GRAPH.md                 contract
    ├── crew/
    │   ├── DESIGNER.md          contract + your project's territory
    │   ├── REVIEWER.md          contract + your branch conventions
    │   ├── BENCH.md             contract + what proves YOUR build works
    │   └── bench.sh             stub — exits non-zero until you implement it
    ├── fleet/
    │   ├── WORKER.md            contract + your repos, and your gotchas as you earn them
    │   └── SEATS.md             contract + your roster
    └── runbooks/                seat discovery, upgrading, and the graduations to take later
```

## Contract, and this project

Every brief has two sections.

`## Contract` is copied byte-for-byte into every project and never edited per-project. `## This project` is written at install and accreted afterwards, as review earns scars worth recording.

That split is the whole design. It means a project's specifics never get tangled with the shared rules, upgrading the contract later is a file replace rather than a merge, and the answer to "is this line universal or ours?" is visible at a glance forever.

## What is in this repo

| | |
|---|---|
| `contracts/` | the briefs, copied verbatim at install |
| `generated/` | specimens of what the interview writes — never copied, and drawn from an invented project so they cannot be mistaken for a starting point |
| `runbooks/` | seat discovery, the upgrade procedure, and the graduations to take once the loop has proven itself |
| `examples/android-cordova/` | one fully worked bench, from a real project, labelled as one project's implementation |
| `BOOTSTRAP.md` | the procedure the install session follows |

## Two things worth knowing before you start

**The bench is the load-bearing part.** `contracts/BENCH.md` defines what a bench must satisfy; the eight clauses are stack-agnostic and every one was learned from an artifact that passed a weaker check. The one that earns the file is clause 4: *liveness is not success*. A live process proves a process is live. A server can boot with no routes, a CLI can start and do nothing, an app can render an empty screen — and all three pass any check that only asks whether it is running.

Your install ships a bench stub that exits non-zero. Until you implement it, no APPROVE may claim your software runs. That is deliberate.

**Merges are yours by default.** The shipped policy is that the principal confirms each merge. Auto-merge on a reviewer's APPROVE is documented in `runbooks/PROMOTION.md` as a graduation, with the conditions that make it safe — chief among them a real bench. Auto-merge over a stub bench is auto-merge over nothing.

## Seat accounting

A seat is a standing session pinned to **one subscription, serving one human beneficiary**. No seat serves anyone else. This is a licensing-compliance statement, not a preference, and it does not change with the size of your fleet.

## Upgrading

When these contracts improve, you re-copy the six contract files and keep your `## This project` sections. The two-section split is what makes that safe, and there is no tooling for it deliberately — a file copy you understand beats a migration you do not.

The full procedure is [`runbooks/UPGRADE.md`](runbooks/UPGRADE.md), which installs into your project along with the other runbooks. It covers the parts that are not obvious:

- how to reconstruct your baseline if you installed before `.template-source` existed, which every early install did;
- getting a clone with enough history to diff against (the install clone is `--depth 1` and cannot);
- copying the six `.md` files by name, because `cp -r contracts/` would drop the bench stub over your implemented bench;
- splicing with the same exact-heading rule the install uses, since that is the operation people get wrong;
- and sweeping the things a contract copy cannot reach — your generated files and the beads already in your graph — when a convention changes.

Your install records its baseline in `wheelhouse/.template-source`: the template's remote, the commit installed, and when. Upgrades add an `upgraded=` line and leave `installed=` alone, because when you started and when you last upgraded are different facts.

## License

MIT. See [LICENSE](LICENSE).
