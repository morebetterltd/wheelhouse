# Promotion

What to change once the loop has proven itself, and what to leave alone until then.

Every graduation here is deliberately NOT the default. A template that ships the endpoint hands a brand-new, untested fleet the authority a working one earned. Each of these is a thing to take when you have evidence, not on installation day.

## Persistent seats are the default now, not a graduation

Earlier versions of this template made this section's first rung — ephemeral dispatches that do the work, report, and end — the shipped default, and persistent seats a graduation with real chores attached: per-seat config directories, operator-run registry wiring after every relaunch, a roll call every session generation, a standing prompt pasted by hand. Those chores were the cost of building standing seats out of interactive terminal sessions, and they are gone because the seat is no longer a terminal: it is a commander-owned `pi --mode rpc` process the adapter spawns with the role injected, addressable by roster name from the moment it starts (`wheelhouse/fleet/SEATS.md`; commands in `seats/README.md`).

So there is nothing to graduate to here. A persistent seat costs no wiring, no roll call, no reset ritual — the session is a warm cache that survives stop and resume, and spawning fresh is one command. What this section still owes you is the judgment the old graduation encoded: a persistent seat idling is a subscription doing nothing, so take seats for the roles you actually dispatch to, and note that the verifier stays deliberately ephemeral — one shot, no session — because for a review gate, independence is worth more than a warm cache.

## Principal-confirmed merges to auto-merge on APPROVE

**Start — and this is the shipped default:** the principal confirms each merge. The reviewer's APPROVE, carrying bench evidence, is what makes that confirmation cheap: read the verdict, not the diff.

**Graduate to:** a bench-evidenced APPROVE authorizes the commander to merge to local main without per-branch confirmation. Pushes to any remote stay principal-only regardless.

**Take it when** all of these are true:

- the reviewer has been right on real merges, repeatedly, including at least one BOUNCE that caught something the principal would have missed;
- the bench is implemented and actually gates behavioral APPROVEs — an auto-merge policy on top of a stub bench is an auto-merge policy on top of nothing;
- a bad merge is cheap to undo, because local main is local.

The precondition is in `wheelhouse/crew/REVIEWER.md`: an APPROVE without bench evidence on a behavioral diff is a defect in the review. That sentence is load-bearing for this graduation and travels with it.

## Per-push approval to standing push authority

**Start — and this is the shipped default:** every push to a remote is the principal's, asked for and granted one at a time. It is the last gate before work leaves the machine, and it is the only one whose mistakes are visible to people outside the project.

**Graduate to:** standing authority to push, scoped to named remotes and named repositories.

**Take it when** all of these are true:

- the merge graduation above has already been taken, and has held. Push authority on top of per-merge confirmation is a gate on the wrong step;
- the reviewer's push line has been carrying its own evidence — the commit range, the tip identifier against what was reviewed, and a scan of added lines for credentials, keys, local paths and internal addresses. A verdict format that asks the push question separately is the precondition here, the same way bench evidence is the precondition for auto-merge;
- someone has been wrong about a push and the check caught it. A gate that has never fired is not evidence of anything.

**Record it in `wheelhouse/INTEGRATOR.md`'s project section**, in the principal's own words and with the date. Not a paraphrase: the grant's exact scope is what a future reader has to work from, and a summary of it is the first place the scope quietly widens.

**Scope does not travel.** Authority over one remote is not authority over another, and authority over one repository is not authority over the next one the project adds. If you find yourself reasoning about whether a grant covers something it does not name, that reasoning is an inference — record it AS an inference, route it to the principal, and act on the narrower reading until they answer. An unwritten narrowing of a broad grant and an unwritten broadening of a narrow one are the same defect: both end as "nobody objected, so it must be allowed", and both leave the record showing a decision nobody made.

**Return to per-push when** the scope changes, a new remote or repository appears, the principal's instruction is unclear, or anything was pushed that should not have been. Going back is cheap and is not a punishment; the ladder is not one-way.

## Cross-vendor seats

Not a graduation either: the vendor is a per-seat roster field. Each entry in `seats/seats.json` records its own `provider` and `model`, so a second vendor's worker is a roster line plus a provisioning run and a login (`seats/README.md`), on the same runtime and under the same briefs — the crew briefs are canonical prose injected at spawn, identical whichever model reads them. The judgment that survives from when this was a graduation: give a new vendor's seat well-scoped implementation beads first, and treat the same review gate passing its work as the evidence your briefs really are model-agnostic.

## Adding seats

**Start:** commander, one worker, one reviewer.

**Graduate to:** a second worker when the reviewer is idle waiting for work; a designer when the principal is spending more time decomposing beads than deciding direction.

Add a seat because a specific person in the loop is the bottleneck, not because the roster looks incomplete.
