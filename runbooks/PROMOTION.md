# Promotion

What to change once the loop has proven itself, and how to record a project that intentionally narrows the shipped default.

The shipped default is now all the way: reviewed work is merged, pushed, PR-opened/merged, and deployed wherever the install records standing authority and automation. This runbook no longer grants autonomy as a ladder a fleet earns after installation. It records two other moves: a project-specific narrowing when the principal deliberately reserves more than the default reserved list, and the graduation back toward the shipped all-the-way line once evidence says the narrowing is no longer buying safety.

## Persistent seats are the default now, not a graduation

Earlier versions of this template made this section's first rung — ephemeral dispatches that do the work, report, and end — the shipped default, and persistent seats a graduation with real chores attached: per-seat config directories, operator-run registry wiring after every relaunch, a roll call every session generation, a standing prompt pasted by hand. Those chores were the cost of building standing seats out of interactive terminal sessions, and they are gone because the seat is no longer a terminal: it is a commander-owned `pi --mode rpc` process the adapter spawns with the role injected, addressable by roster name from the moment it starts (`wheelhouse/fleet/SEATS.md`; commands in `seats/README.md`).

So there is nothing to graduate to here. A persistent seat costs no wiring, no roll call, no reset ritual — the session is a warm cache that survives stop and resume, and spawning fresh is one command. What this section still owes you is the judgment the old graduation encoded: a persistent seat idling is a subscription doing nothing, so take seats for the roles you actually dispatch to, and note that the verifier stays deliberately ephemeral — one shot, no session — because for a review gate, independence is worth more than a warm cache.

## All-the-way default to principal-confirmed local merges

**Start — and this is the shipped default:** a bench-evidenced APPROVE authorizes the integrator to merge to local main. That is the local-merge slice of the all-the-way mandate in `wheelhouse/INTEGRATOR.md`: reviewed work keeps moving unless the install's project section reserves the action or the work has reached a genuine product-intent fork.

**Narrow to:** principal-confirmed local merges, recorded in `wheelhouse/INTEGRATOR.md`'s project section in the principal's own words and with the date. The reviewer's APPROVE still matters: it is what makes that confirmation a decision on policy rather than a diff review.

**Choose the narrowing only when** at least one of these is true:

- the bench is still the shipped stub, so no behavioral APPROVE can claim the software runs;
- the reviewer seat or verifier path has not yet been proven on real merges;
- local main is unusually expensive to repair in this project, and the project section names why.

**Graduate back to the shipped default when** the bench is implemented for behavioral claims, the reviewer/verifier path has caught at least one real defect or passed enough ordinary changes to be trusted, and reverting a bad local merge is understood. The precondition is in `wheelhouse/crew/REVIEWER.md`: an APPROVE without bench evidence on a behavioral diff is a defect in the review. That sentence is load-bearing for any merge authority and travels with it.

## Recorded push authority to narrower push gates

**Start — and this is the shipped default:** push, PR, and deploy authority is exactly what `wheelhouse/INTEGRATOR.md`'s project section records. A fresh install's question asks how far the fleet takes work; the default answer is all the way, scoped to named remotes, repositories, PR targets, deploy surfaces, and reserved actions. A runbook cannot override that record with a blanket rule.

**Narrow to:** per-push, per-PR, or per-deploy confirmation only when the project section says so. This is an install-specific reservation, not a template default, and it must name the remote, repository, PR target, deploy surface, or risk class it covers.

**Choose the narrowing only when** all of these are true:

- the action leaves the machine or reaches users/collaborators, and the project has not yet seen the reviewer's PUSH line catch a real publishing risk;
- the reviewer's push line has not yet built a trustworthy run of evidence — commit range, tip identifier against what was reviewed, and a scan of added lines for credentials, keys, local paths and internal addresses;
- the project section states the gate in terms a later integrator can execute, not as a memory of one conversation.

**Graduate back to standing authority when** the scope is named and stable, the PUSH line has carried its own evidence over real branches, and at least one mistaken publish attempt or near-miss was caught by the check. Record the grant in `wheelhouse/INTEGRATOR.md`'s project section, in the principal's own words and with the date. Not a paraphrase: the grant's exact scope is what a future reader has to work from, and a summary of it is the first place the scope quietly widens.

**Scope does not travel.** Authority over one remote is not authority over another, authority over one repository is not authority over the next one the project adds, and authority over pushing is not authority over a deploy surface the project section does not name. If you find yourself reasoning about whether a grant covers something it does not name, that reasoning is an inference — record it AS an inference, route it to the principal, and act on the narrower reading until they answer. An unwritten narrowing of a broad grant and an unwritten broadening of a narrow one are the same defect: both end as "nobody objected, so it must be allowed", and both leave the record showing a decision nobody made.

**Return to confirmation when** the scope changes, a new remote/repository/PR target/deploy surface appears, the principal's instruction is unclear, or anything was published that should not have been. Going narrower is cheap and is not a punishment; the ladder moves both ways.

## Cross-vendor seats

Not a graduation either: the vendor is a per-seat roster field. Each entry in `seats/seats.json` records its own `provider` and `model`, so a second vendor's worker is a roster line plus a provisioning run and a login (`seats/README.md`), on the same runtime and under the same briefs — the crew briefs are canonical prose injected at spawn, identical whichever model reads them. The judgment that survives from when this was a graduation: give a new vendor's seat well-scoped implementation beads first, and treat the same review gate passing its work as the evidence your briefs really are model-agnostic.

## Adding seats

**Start:** commander, one worker, one reviewer.

**Graduate to:** a second worker when the reviewer is idle waiting for work; a designer when the principal is spending more time decomposing beads than deciding direction.

Add a seat because a specific person in the loop is the bottleneck, not because the roster looks incomplete.
