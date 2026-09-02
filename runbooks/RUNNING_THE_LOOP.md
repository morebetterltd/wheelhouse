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

- **The fleet's own verifier — when its precondition holds.** The template's review gate is already an ephemeral mind: `seats/verify.ts` dispatches a one-shot verifier pass on a finished branch and maps its verdict to an exit code (`seats/README.md`, "Verifying a branch"). Its precondition is the one thing a solo install may not have: the verifier's account must be distinct from the author's, and `verify.ts` enforces that on disk — same agent directory is a loud STOP, not a warning — so a change authored on the only account you hold cannot be verified on that account. When the precondition holds, this is the preferred shape, because the independence is enforced rather than practiced; when it does not, the two minds below remain.
- **The principal.** For any agent-authored change, the principal is a different mind from the author by construction. The principal may hold the reviewer role for that change: read the diff, re-run the cheap evidence, and write the verdict on the bead in the format `wheelhouse/crew/REVIEWER.md` prescribes. A solo principal already holds commander and integrator at different moments; reviewer is one more role, barred only for changes the principal authored.
- **A fresh session.** For any change — including one the principal wrote by hand — a fresh session is a mind that did not author it: a new terminal, a new context, holding nothing of the conversation that produced the diff. Dispatch it the way stage 1 dispatches any reviewer: the bead id, the branch, a way to read it that changes nothing, and `wheelhouse/crew/REVIEWER.md` as its brief. Running it on the principal's own account is fine — seat accounting governs seats pinned to subscriptions, and an ephemeral session on the principal's own account serving the principal is one subscription serving its one human (`wheelhouse/fleet/SEATS.md`'s Seat accounting section carries the rule; note it is the same account-distinctness that bars the verifier above, which is why this bullet is the fallback rather than the gate). What such a session must never be given is the author's transcript, or the author's summary of the work: a fresh session fed the author's reasoning is the author's mind with a new timestamp.

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

The commander reads `wheelhouse/ISA.md`'s Goal before choosing what to send next, because dispatch is a claim about what advances that goal. A bead with no stateable trace under `wheelhouse/GRAPH.md`'s rule is not dispatched; fix the bead first.

Defined work is ready work: once something is described as a bead, the commander dispatches it immediately, never waiting for the principal's explicit go. Holding work is the exception, and it is expressed IN the graph — a blocking kickoff-gate bead — or by the per-action principal-only classes a project names (releases and tags, license, public-facing identity). A commander that waits to be poked ruins the magic of an autonomous fleet.

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

A report says what changed, the head, and the evidence for each claim — command output, not adjectives. `wheelhouse/fleet/WORKER.md` is specific about the form. Then add the review-queue label; `wheelhouse/GRAPH.md` names it and explains why it is a label rather than a status. The worker does **not** close the bead. Closing belongs to stage 7, after review and integration; a worker close with `needs-review` still attached is not a handoff, it is a corrupted queue entry.

The comment text is a positional argument, not a flag. On bd 1.2.2 the `-m` most people reach for first is not a flag this CLI has, and it fails before writing anything (`unknown shorthand flag: 'm' in -m`, exit 1) — which is the good case, since a report that silently did not land is the failure this stage is about:

```bash
bd comment <bead-id> "the report text"        # short reports
bd comment <bead-id> --file report.md         # a real report, written in a file first
cat report.md | bd comment <bead-id> --stdin  # same, from a pipe
bd update <bead-id> --add-label needs-review  # enter the review queue
# no bd close here — the commander/integrator closes after review + merge
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

The same contract carries the claim-move duty: update `wheelhouse/ISA.md`'s Claims with the merge, or state on the bead why no claim moved. Do not duplicate that rule here; this stage points at the contract that owns it.

Run the intent-check gate at `seats/intent-check.sh` before integrating when that script is present. If this template has not yet received the sibling bead that ships it, the path is still the agreed gate path and this line is the ordering marker.

Push per your project's recorded authority, in `wheelhouse/INTEGRATOR.md`'s project section. If that section is empty, the answer is that nobody has decided yet, and the decision is the principal's rather than yours.

### 7. Close

Close the bead and drop the review-queue label in the same breath, after the integrator has satisfied `wheelhouse/INTEGRATOR.md`'s claim-move duty or its explicit no-claim-moved escape hatch. A closed bead still carrying it reads as in-flight to everyone else. `wheelhouse/GRAPH.md` says so; it is listed here because it is the step most often forgotten at the end of a long round.

## Where things are recorded

On the bead. The graph is the loop's memory, and a decision that lives anywhere else survives exactly as long as the people who were present.

That includes the unglamorous ones: a premise that turned out wrong, a scope choice, a measurement someone else will otherwise redo. If you find yourself explaining something in a message that the next person will need, that is the signal to put it on the bead instead.

It also includes the evidence itself, and there the same reasoning reaches one step further than most people take it. A report or a verdict that cites a file rather than pasting its contents has recorded the sentence and left the proof somewhere else — and the somewhere else, in this loop, is usually a bench output directory or a worktree, both of which are gone by the time anyone re-reads the bead. `wheelhouse/GRAPH.md`'s *Where evidence lives* states which homes qualify and in what order to do it. Stages 3 and 5 are where it applies: the report and the verdict are the two artifacts that cite.

## When it does not go straight through

**A review goes quiet with a bench in flight.** Check the bead before you probe. A reviewer part-way through a split review has left an interim comment saying so, and that comment is the difference between a seat that owes you a wake and a seat that has died — which look identical from outside. If it is there, the next move is the collecting dispatch, not a probe; if it is not, treat the seat as quiet and read the next paragraph.

**A report goes quiet.** Probe once, then nudge once. A seat that cannot be reached looks exactly like a seat that is idle, and the distinction matters before you re-dispatch the work to someone else. If both go unanswered, declare the seat dead and respawn it with the adapter — `bun seats/adapter.ts status`, then `resume` if the session is worth keeping, `spawn` if not; `seats/README.md` has the commands — and re-dispatch the in-flight bead. `wheelhouse/fleet/SEATS.md`'s Lifecycle section says why that re-dispatch is the whole cost.

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

### End of day

When the principal says the fleet is done for the day, three moves, in this
order — the handoffs come BEFORE the stop, because a stopped seat can no longer
write one.

**First, each active seat writes its handoff, on its bead.** The commander
dispatches every seat holding in-flight work one request: write your handoff.
The seat answers as a bead comment — the same channel every report uses, for the
same reason: a note that lives anywhere else is invisible to whoever picks the
bead up — covering three things: the state of the in-flight work (what is done,
what is not, the head if there is one), the exact next step as the seat would
take it, and anything surprising it learned that the bead does not already say.
A seat with nothing in flight has nothing to write, and says so in its reply
rather than inventing a summary. This is a dispatch like any other: it queues
behind a busy seat's current turn and fires when the work drains, so send it,
then collect.

**Second, the commander composes the fleet handoff at `wheelhouse/HANDOFF.md`.**
Not a transcript of the seat handoffs — those live on their beads, where
tomorrow's dispatches will point — but the fleet-level view one screen tall:
per-seat status (bead, state, whether tomorrow's move is `resume` or a fresh
`spawn`), every verdict or `needs-review` bead waiting with nobody on it,
anything the principal decided today that has not yet become a bead or an ISA
entry, and the first two or three actions tomorrow's commander should take, in
order. Why written, when the graph already holds the work: the graph holds
WHAT, not WHERE-WE-WERE — a compacted or fresh commander session re-derives
yesterday from raw state unless a written handoff exists, and re-deriving is
both slow and quietly lossy. The note is cheap tonight and expensive to
reconstruct tomorrow. It gets committed with whatever else the day commits;
an install kept out of the tree keeps it out too, per its own exclusion.

**Third, stop the seats:**

```bash
bun seats/adapter.ts stop-all
```

This is not a context reset. `stop-all` uses the same graceful SIGTERM path as
`stop`, only for seats that are idle; seats mid-turn are reported and left
running because `wheelhouse/fleet/SEATS.md`'s Lifecycle rule is literal: a
SIGTERM during a turn lands in the running tool's process tree. The stopped
seats keep their session files, so tomorrow's commander can decide whether the
right lifecycle move is `resume` (warm cache, same context) or `spawn`/`reset`
(fresh context). That choice belongs to the commander's morning read of the
work, not to the shutdown ritual — and the handoff note is where tonight's
commander records what it would choose, so the morning read starts from a
recommendation instead of a blank.

### Next morning

Read `wheelhouse/HANDOFF.md` first — before the graph, before the seats. The
cadence rule above ("start by reading the graph, not the inbox") is about not
letting messages outrank work; the handoff note is not an inbox, it is
yesterday's commander writing to today's, and it says where the fleet actually
stood at sign-off — which seats to `resume` and which to respawn, which
verdicts are waiting, what the first dispatch should be. The graph still
decides what the work IS; the note says where to stand while reading it.

Then archive it — after ingesting, not before:

```bash
mkdir -p wheelhouse/handoffs
mv wheelhouse/HANDOFF.md "wheelhouse/handoffs/$(date -r wheelhouse/HANDOFF.md +%Y-%m-%d 2>/dev/null \
  || stat -f %Sm -t %Y-%m-%d wheelhouse/HANDOFF.md).md"
```

Dated for the day it describes — the sign-off day — not the day it is read,
because a note read after a weekend still describes Friday. That is why the
date comes from the note's own modification time rather than from "yesterday":
the two agree on an ordinary morning and disagree after any gap, and the file
knows when it was written. (The two commands are the GNU and BSD spellings of
the same question; the fallback covers whichever your platform lacks.) The move is the
record that it was ingested: a `HANDOFF.md` still sitting at the root is a
morning read that has not happened yet, which is exactly what the next session
needs to be able to see. No `HANDOFF.md` at all is the normal first-morning
state (and the state after any day that ended without the ritual) — start from
the graph as the cadence rule says, and say so rather than hunting for a note
nobody wrote.

If the fleet has no work it can start without the principal, say so out loud. A loop with nothing to do will find something, and what it finds will be its own tooling.

## What this document does not restate

The obligations live with the roles, and duplicating them here would let the two copies drift:

| for | read |
|---|---|
| what a worker owes and how to report it | `wheelhouse/fleet/WORKER.md` |
| what a verdict must contain, and reading a branch safely | `wheelhouse/crew/REVIEWER.md` |
| what a verdict authorises, confirming what you merged, and moving Claims with a merge | `wheelhouse/INTEGRATOR.md` |
| how work state is tracked, the review queue, and where cited evidence must live | `wheelhouse/GRAPH.md` |
| what a bench must satisfy | `wheelhouse/crew/BENCH.md` |
| seats, the roster, and running them | `wheelhouse/fleet/SEATS.md`, commands in `seats/README.md` |
