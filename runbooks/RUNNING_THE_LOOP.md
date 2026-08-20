# Running the Loop

The install gives you contracts, briefs and a work graph. This is how you run them: one unit of work from dispatch to merged, and what to do on the days it does not go straight through.

## The one idea

The loop is not a relay of clean handoffs. **Every claim that crosses between people gets executed or adapted by whoever receives it, before it counts.** The stages exist to force those crossings, and almost everything the loop catches is caught at one of them.

That is worth saying plainly because the tidy version is the one people imagine and it does not work. In the rounds this document was written from: a dispatch named a commit and no way to read it, and the reading cost the author two commits. A report named a head that was true where the author stood and false on the branch anyone else would read. A summary of a file substituted for the file, and the receiver escalated on the summary. A recommended fix had never been run. Every one of those was caught by the *next* person doing something rather than agreeing — and every one would have shipped if the stage had been a handoff.

So when you read a stage below, the question is never "was that passed along correctly". It is **"what did the receiver do to it".**

## Before your first loop

- The roles exist. One person may hold several — commander and integrator are commonly the same, and a solo principal can hold all of them at different moments. What must not happen is one person being both author and reviewer of the same change; `wheelhouse/crew/REVIEWER.md` forbids it and it is the one merge that cannot be recovered by care.
- The work graph is initialised and `bd ready` lists something.
- You know whether `wheelhouse/crew/bench.sh` is the shipped stub or a real bench. If it is the stub, no verdict may claim the software runs, and that is deliberate. See `wheelhouse/crew/BENCH.md`.

## One loop

### 1. Dispatch

**What crosses:** a bead id, and enough for someone to start without asking.

The commander names the bead, the repository, and — if it points at any existing commit or branch — **a way to read it that changes nothing**. `wheelhouse/crew/REVIEWER.md` carries the rule and why the wording is what it is; the short version is that a dispatch naming a bare identifier makes the receiver find somewhere to open it, and the somewhere they choose may be someone else's working tree.

Say what "done" is if the bead does not already. If the receiver has to reconstruct it, they will reconstruct a version.

**What the receiver does:** reads the bead itself, not the dispatch's summary of it. If the two disagree, the bead wins and the disagreement is worth reporting — a dispatch is one person's reading, and this is the first crossing where a wrong premise can still be cheap.

**What it costs otherwise:** a dispatch that summarised a passage instead of pointing at it produced an escalation argued on the summary's terms. Both parties were careful. Neither had read the file at the moment it mattered.

### 2. Claim and isolate

The worker sets the bead in progress, then works in a git worktree it creates itself, on the branch `fleet/<bead-id>`. `wheelhouse/fleet/WORKER.md` is the contract; the operational points that bite:

- Create the worktree **outside the repository it branches from**, so it never nests inside it — a sibling directory such as `../.wheelhouse-worktrees/<bead-id>`. `wheelhouse/fleet/WORKER.md` requires that the worktree is one you created and that you never edit the live checkout; the sibling placement is the operational form of that, and it holds whether the wheelhouse sits at a product root or above several.
- Before the first commit, and again before reporting, check that you are on a branch and that the branch's tip is your worktree's HEAD. Both halves. `wheelhouse/fleet/WORKER.md` says why the second is not redundant.
- One bead at a time. A seat working two is a seat reporting on neither.

### 3. Work, then report

**What crosses:** a branch, a head, and a set of claims about what is true of them.

Report **on the bead**, as a comment. Not in a message, not only in a terminal someone was watching. This is the loop's single most reliable failure: an artifact that lives only in a message is invisible to everyone who was not in that conversation, and it blocks whoever needs it next. Everything that went through the graph survived; the things that lived in messages had to be re-sent.

A report says what changed, the head, and the evidence for each claim — command output, not adjectives. `wheelhouse/fleet/WORKER.md` is specific about the form. Then add the review-queue label; `wheelhouse/GRAPH.md` names it and explains why it is a label rather than a status.

**What it costs otherwise:** a head reported from inside a detached worktree was true of everything the author could see and false of the branch. The integrator's fast-forward merge then took four commits of six, printed a real diffstat, and exited zero.

### 4. Review

**What crosses:** the worker's report, which is a claim and not evidence.

The reviewer reads the branch **without disturbing it** — `wheelhouse/crew/REVIEWER.md` has the rule and the reason. It re-runs what is cheap rather than quoting the report, checks the claims as well as the code, and says explicitly what it could not re-run. Where it cannot verify something in principle, it routes rather than approving or bouncing — that clause is in the same file, and it distinguishes two kinds of unverifiable that need different handling.

**What the receiver does:** executes. Not reads. The difference is the whole review.

**What it costs otherwise:** a reviewer that recommends a remedy it has not run is making a claim about behaviour like any other. Four such remedies were defective in the rounds behind this document, and each was caught by the author exercising them rather than applying them.

### 5. Verdict

**What crosses:** a decision, in a form that cannot be mistaken for a different decision.

The verdict goes on the bead in the format `wheelhouse/crew/REVIEWER.md` prescribes: a merge answer and a push answer, as two labelled lines, with the push line required even when the answer is that no view was formed. Do not compress it to one word. The format exists because a single word answered one question when two were being asked, and an absence of thought arrived looking like a considered judgement.

A BOUNCE lists each defect as its own point: what is wrong, where, and what done requires instead. The author fixes, reports the new head, and the reviewer re-checks the delta — not the whole branch again.

### 6. Integrate

**What crosses:** an approved branch and a head someone else asserted.

`wheelhouse/INTEGRATOR.md` is the contract and it is short. The operational core: confirm the tip you merged equals the head that was reported, by comparing identifiers rather than by reading command output. A merge that covers less than the reader assumes still prints a genuine diffstat and exits zero.

Push per your project's recorded authority, in `wheelhouse/INTEGRATOR.md`'s project section. If that section is empty, the answer is that nobody has decided yet, and the decision is the principal's rather than yours.

### 7. Close

Close the bead and drop the review-queue label in the same breath. A closed bead still carrying it reads as in-flight to everyone else. `wheelhouse/GRAPH.md` says so; it is listed here because it is the step most often forgotten at the end of a long round.

## Where things are recorded

On the bead. The graph is the loop's memory, and a decision that lives anywhere else survives exactly as long as the people who were present.

That includes the unglamorous ones: a premise that turned out wrong, a scope choice, a measurement someone else will otherwise redo. If you find yourself explaining something in a message that the next person will need, that is the signal to put it on the bead instead.

## When it does not go straight through

**A report goes quiet.** Probe once, then nudge once. A seat that cannot be reached looks exactly like a seat that is idle, and the distinction matters before you re-dispatch the work to someone else.

**The dispatch's premise was wrong.** Say so and stop, rather than delivering against a brief you know to be mistaken. This happens often enough to be normal: the bead described a file that had moved, a fix that was already applied, a defect that reproduces differently than reported. The correction is worth more than the delivery.

**Two people disagree about a fact.** Neither account settles it — measure. In these rounds, every disagreement between two careful parties was resolved by someone running the thing, and in several cases both prior accounts were wrong. Evidence of a pattern is not evidence of an instance.

**You cannot verify something you are asserting.** Route it to whoever can, name it as unverified, and do not let it pass in silence. Silence is indistinguishable in the record from a check that was made.

**The work is bigger than one bead.** Split it and say so. A bead whose done cannot be stated is not ready to dispatch.

## Cadence

There is no fixed rhythm to prescribe. The shape that worked:

- Start by reading the graph, not the inbox. Deadline beads and anything blocking others first.
- Dispatch one bead per seat, and let the seat finish before adding another.
- Review as soon as work lands, so the author still has the context to fix a bounce cheaply.
- Merge in batches if you like, but confirm each tip against its reported head individually.
- Close the day by checking that nothing is sitting labelled-for-review with nobody looking at it.

If the fleet has no work it can start without the principal, say so out loud. A loop with nothing to do will find something, and what it finds will be its own tooling.

## What this document does not restate

The obligations live with the roles, and duplicating them here would let the two copies drift:

| for | read |
|---|---|
| what a worker owes and how to report it | `wheelhouse/fleet/WORKER.md` |
| what a verdict must contain, and reading a branch safely | `wheelhouse/crew/REVIEWER.md` |
| what a verdict authorises, and confirming what you merged | `wheelhouse/INTEGRATOR.md` |
| how work state is tracked, and the review queue | `wheelhouse/GRAPH.md` |
| what a bench must satisfy | `wheelhouse/crew/BENCH.md` |
| seats, standing prompts, and launching them | `wheelhouse/fleet/SEATS.md` |
