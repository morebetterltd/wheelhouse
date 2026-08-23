# Running the Loop

The install gives you contracts, briefs and a work graph. This is how you run them: one unit of work from dispatch to merged, and what to do on the days it does not go straight through.

## The one idea

The loop is not a relay of clean handoffs. **Every claim that crosses between people gets executed or adapted by whoever receives it, before it counts.** The stages exist to force those crossings, and almost everything the loop catches is caught at one of them.

That is worth saying plainly because the tidy version is the one people imagine and it does not work. In the rounds this document was written from: a dispatch named a commit and no way to read it, and the reading cost the author two commits. A report named a head that was true where the author stood and false on the branch anyone else would read. A summary of a file substituted for the file, and the receiver escalated on the summary. A recommended fix had never been run. Every one of those was caught by the *next* person doing something rather than agreeing — and every one would have shipped if the stage had been a handoff.

So when you read a stage below, the question is never "was that passed along correctly". It is **"what did the receiver do to it".**

## Before your first loop

- The roles exist. One person may hold several — commander and integrator are commonly the same, and a solo principal can hold all of them at different moments. What must not happen is one person being both author and reviewer of the same change; `wheelhouse/crew/REVIEWER.md` forbids it and it is the one merge that cannot be recovered by care. A solo install, where one human holds every role, closes that gap the way the next section describes.
- The work graph is initialised and `bd ready` lists something.
- You know whether `wheelhouse/crew/bench.sh` is the shipped stub or a real bench. If it is the stub, no verdict may claim the software runs, and that is deliberate. See `wheelhouse/crew/BENCH.md`.

## When one human holds every seat

A solo install — one human, one subscription, every standing seat declined — is a legitimate install, and it still runs this loop. What it cannot do is waive the rule the loop is built around: **no change is approved by the mind that authored it.**

That rule is narrower than it first reads. Its unit is the authoring CONTEXT — the session that produced the diff, carrying its own reasoning, assumptions and investment — not the account the session ran on, and not the human who owns the account. A solo install therefore always has more reviewers available than it has seats, because it has more minds than accounts:

- **The principal.** For any agent-authored change, the principal is a different mind from the author by construction. The principal may hold the reviewer role for that change: read the diff, re-run the cheap evidence, and write the verdict on the bead in the format `wheelhouse/crew/REVIEWER.md` prescribes. A solo principal already holds commander and integrator at different moments; reviewer is one more role, barred only for changes the principal authored.
- **A fresh session.** For any change — including one the principal wrote by hand — a fresh session is a mind that did not author it: a new terminal, a new context, holding nothing of the conversation that produced the diff. Dispatch it the way stage 1 dispatches any reviewer: the bead id, the branch, a way to read it that changes nothing, and `wheelhouse/crew/REVIEWER.md` as its brief. Running it on the principal's own account is fine — seat accounting governs standing seats pinned to subscriptions, and an ephemeral session serving the principal is one subscription serving its one human (`wheelhouse/fleet/SEATS.md`'s Lifecycle section: ephemeral is the default shape, and a standing seat is a promotion). What such a session must never be given is the author's transcript, or the author's summary of the work: a fresh session fed the author's reasoning is the author's mind with a new timestamp.

A new terminal is the fresh session's obvious form, not its only one. A subagent dispatched from the session you are already in qualifies on the same test, and it is the form that needs nothing beyond the one terminal you have open: the harness starts a subagent with an empty context, holding nothing of the conversation that produced the diff — which is the property the new terminal was buying. What decides whether it stays a fresh mind is the dispatch you write, and you are writing it as the author, so the temptation is to help: a line about what the change does, where to look first, what you already checked. Every one of those is the author's summary the bullet above forbids. Compose the dispatch from the bead and the branch — the bead id, the branch, a way to read it that changes nothing, the reviewer's brief, and nothing else — and let the reviewer form its own account. Two facts to establish about your harness rather than assume, because both vary by harness and by how yours is configured: that its subagents genuinely start empty rather than inheriting the conversation, since one that inherits is the author's mind under a different name and the new terminal is the fallback; and that your permission settings let the subagent read the branch and write its verdict on the bead, because those settings gate every tool an agent runs, and a verdict that reached only the author's screen has landed nowhere the record can see.

Say on the verdict which one reviewed — "reviewed by the principal" or "reviewed by a fresh session, dispatched <when>" — because the record otherwise cannot distinguish either from the author approving itself.

And say what this shape does NOT buy, because the honest cost is the reason the fleet shape exists:

- **Correlated blind spots.** A fresh session of the same model catches the author's context-bound errors — the rationalisation, the skipped check, the claim that outran its evidence — but it shares the model's systematic errors with the author session, and those it will make too.
- **Procedural, not structural, independence.** The principal dispatches the review, reads the verdict, and merges. Nothing outside the principal's own discipline forces the gate to close before the merge; a standing reviewer seat on its own account makes skipping the gate a visible act, and here it is a private one.
- **The least adversarial reviewer.** The principal wants the change to be done, and reviewing toward a merge you already want is how a skim acquires the authority of a review. Prefer the fresh session whenever you notice you would skim; take the review yourself only when you will genuinely re-run the evidence.

What remains forbidden, in every shape: the session that authored a change writing its verdict, and a "review" produced by feeding the author's account of the work back to a second session. If a change truly has no available mind that did not author it, the work waits — `wheelhouse/fleet/SEATS.md` states that rule for seats, and it holds for minds.

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

The comment text is a positional argument, not a flag. On bd 1.2.2 the `-m` most people reach for first is not a flag this CLI has, and it fails before writing anything (`unknown shorthand flag: 'm' in -m`, exit 1) — which is the good case, since a report that silently did not land is the failure this stage is about:

```bash
bd comment <bead-id> "the report text"        # short reports
bd comment <bead-id> --file report.md         # a real report, written in a file first
cat report.md | bd comment <bead-id> --stdin  # same, from a pipe
```

Prefer the file or stdin form for anything with command output in it: a multi-line report typed as one shell-quoted argument is one stray quote away from a mangled comment, and `--file` also leaves you the text to re-send if the write fails. Verify the form against your own build the way `wheelhouse/GRAPH.md` asks — `bd comment --help` enumerates it in one line — rather than carrying this paragraph forward on faith.

**What it costs otherwise:** a head reported from inside a detached worktree was true of everything the author could see and false of the branch. The integrator's fast-forward merge then took four commits of six, printed a real diffstat, and exited zero.

### 4. Review

**What crosses:** the worker's report, which is a claim and not evidence.

The reviewer reads the branch **without disturbing it** — `wheelhouse/crew/REVIEWER.md` has the rule and the reason. It re-runs what is cheap rather than quoting the report, checks the claims as well as the code, and says explicitly what it could not re-run. Where it cannot verify something in principle, it routes rather than approving or bouncing — that clause is in the same file, and it distinguishes two kinds of unverifiable that need different handling.

If the bead's done is behavioral the bench is mandatory, and its length does not soften that — `wheelhouse/crew/REVIEWER.md` is explicit that a long bench is a scheduling problem rather than grounds for a lower bar. What length changes is the order to run it in: **bench first, reading second.** An ephemeral reviewer exists only while it is taking a turn, so a bench started at the end of the review is a bench started at the end of the reviewer — and the seat that backgrounds one and goes idle is the seat the commander finds hours later, still holding no verdict. Starting it first turns the wait into the static half of the review, which is work the reviewer owes anyway.

A bench that will not fit in one turn splits the review into **two dispatches** rather than one seat promising to return. Dispatch one: static half done, bench started, output aimed at a home the graph can reach, and an interim comment on the bead saying what is running, at which SHA, and that a collecting dispatch is owed — with no verdict line on it, because nothing has been concluded. Dispatch two: a reviewer collects the output, checks it against the SHA and artifact identity the interim comment named, and writes the verdict. The commander owns the second dispatch. That is the point of the shape: the wake has to sit with a party that outlives the seat, and on the bead rather than in anyone's memory. `wheelhouse/crew/REVIEWER.md` carries the obligations, including the two ways a collected bench result can be the wrong result.

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

It also includes the evidence itself, and there the same reasoning reaches one step further than most people take it. A report or a verdict that cites a file rather than pasting its contents has recorded the sentence and left the proof somewhere else — and the somewhere else, in this loop, is usually a bench output directory or a worktree, both of which are gone by the time anyone re-reads the bead. `wheelhouse/GRAPH.md`'s *Where evidence lives* states which homes qualify and in what order to do it. Stages 3 and 5 are where it applies: the report and the verdict are the two artifacts that cite.

## When it does not go straight through

**A review goes quiet with a bench in flight.** Check the bead before you probe. A reviewer part-way through a split review has left an interim comment saying so, and that comment is the difference between a seat that owes you a wake and a seat that has died — which look identical from outside. If it is there, the next move is the collecting dispatch, not a probe; if it is not, treat the seat as quiet and read the next paragraph.

**A report goes quiet.** Probe once, then nudge once. A seat that cannot be reached looks exactly like a seat that is idle, and the distinction matters before you re-dispatch the work to someone else. If both go unanswered, declare the seat dead and relaunch it per `wheelhouse/fleet/SEATS.md`'s launch procedure — its Lifecycle section says why re-dispatching the in-flight bead is the whole cost.

On a fleet of standing seats, check one thing before you declare anything: a seat that answers your probe but never reports on its own is not quiet, it is half-wired — it can reply to you and cannot initiate to you, which is what a missing reverse leg looks like from this side. `wheelhouse/runbooks/SEAT_DISCOVERY.md` step 3 is the check, and re-running the wiring is the fix. Relaunching that seat instead costs you its context and leaves the actual cause in place.

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
| how work state is tracked, the review queue, and where cited evidence must live | `wheelhouse/GRAPH.md` |
| what a bench must satisfy | `wheelhouse/crew/BENCH.md` |
| seats, standing prompts, and launching them | `wheelhouse/fleet/SEATS.md` |
