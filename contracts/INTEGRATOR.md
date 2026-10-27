# The Integrator

You are the integrator: whoever takes a reviewed branch and puts it into the shared line, and whoever pushes. That may be a human, a standing session, or CI. Set `WHEELHOUSE_INTEGRATOR_PUSH=1` only around integrator-owned `git push` commands that publish `refs/heads/fleet/*`.

These duties attach to the function and not to a job title, deliberately. An obligation attached to a role name is unowned wherever that role does not exist, and half of a two-party check with nobody on one side is not a weaker check — it is no check, wearing the appearance of one.

## Optional batch review sweeps

When several candidates need the same sweep tier, start an isolated batch branch from current main and merge the candidate tips into it. Obtain one normal dispatcher sweep log at that combined tip; the log carries its core/full tier, selection reason and timed inventory. Review each candidate separately with `verify.ts --batch-sweep <complete log>`; only the sweep is shared, never the review judgment or permission to merge/push.

The reviewer dispatcher refuses unless the batch contains the reviewed commit, its first-parent history reaches current main, the complete recorded command/env and recorded-tier inventory passed with rc=0 (for core, exactly the manifest at the batch tip; for full, every root suite), and the log is fresh and safely readable. The verdict names both candidate and batch tips and the log. A full batch can cover a core-required candidate; the receipt distinguishes actual batch tier/reason from the candidate's required tier/reason. A full-required candidate cannot reuse core coverage: refusal names the path or Done-line rule requiring full. A red, partial, stale or unrelated batch proves nothing for reuse. If main or a candidate moves outside the validated batch, make a new combined tree and obtain new evidence; do not edit a failed log into a pass. With no flag, the ordinary per-review sweep path remains unchanged. See `seats/README.md`, “Reuse one passing sweep for a review batch”, for the exact checks and evidence limits.

Alternatively, review the entire combined tree once with `verify.ts BATCH-TASK BATCH-BRANCH AUTHOR REVIEWER --candidates BEAD-A=AUTHOR-A,BEAD-B=AUTHOR-B`. This is a different shape from `--batch-sweep`: they cannot be combined. The dispatcher derives the exact candidates from bead-naming first-parent merges above current local main, pins each second-parent work tip, validates every candidate contract and author/reviewer account separation, and runs one sweep at the batch tip using the strictest required tier. The reviewer emits exactly one plain, outside-fence `CANDIDATE: <bead-id> APPROVE | BOUNCE | DISCOVER [— annotation]` line per derived candidate above the closing VERDICT/PUSH lines and cites the sweep rc and log. Missing, extra, duplicate, malformed or contradictory lines refuse the entire delivered answer; an overall APPROVE cannot contain a non-APPROVE candidate. A batch BOUNCE may preserve an unaffected candidate's APPROVE only with passing sweep coverage.

For this batch-verdict shape, follow this order:

1. Obtain the batch review with `--candidates`. It writes the batch task record at the batch tip and each `seats/verdicts/BEAD.md` at that candidate's merged second-parent tip, with its author/verdict and `batch-task`, `batch-branch`, `batch-tip`, `batch-merge` provenance. Each copies the batch PUSH line, actual sweep and output, and names its own required tier/reason. One bead must have one merge in the batch; two merged tips cannot share one per-bead receipt.
2. Run `walk.ts --work BEAD --branch CANDIDATE-TIP --author AUTHOR` for each candidate with person-on-surface or person-reading outcomes, using the proper independent verifier. If its fleet branch has moved, pass the recorded merged tip, not that branch name. Machine-only candidates need no walk. Batch review does not stand in for consumer proof.
3. Run `merge-gate.ts BEAD CANDIDATE-TIP` for every candidate (with `--repo` as needed). Its PASS receipt must name that same merged tip; a BOUNCE or unverified consumer outcome still refuses.
4. Only then fast-forward the integration line to the reviewed batch tip and push under existing authority. The unchanged guard visits every new first-parent bead merge and checks its second-parent receipt; no per-candidate reviewer session or second sweep is needed. Compare all pinned/reported tips before integration, and preserve decisive output on the graph as usual.

See `seats/README.md`, “Review an entire batch once”, for the command shape and limits of these local working-copy records.

## Nightly red brake

Before merging on a core receipt, check the install's latest `seats/run/nightly-sweep.json`. While its completed result is red (`rc=1`), nothing merges on core coverage: obtain a full-tier receipt, even for a digest-only change or an older core batch. The dispatcher records `tier=full reason=nightly red <date> <tip>` and refuses core-batch reuse. A later completed green releases the brake; a missing record imposes none, and invalid/unreadable state conservatively requires full. `nightly-sweep-missed.json` reports skipped/setup-failed attempts without erasing a previous red. The `nightly-sweep-red` / `nightly-sweep-missed` alerts identify the evidence or reason to inspect. See `seats/README.md`, “Nightly full tier”.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

### Default mandate: take work all the way

The shipped default is autonomy all the way through the install's definition of done. Principal directive, 2026-09-02: "the whole point of the Wheelhouse and the mandate is to create work and to do work, not to ask if you can create work, ask if you can start work, and ask if the work can be declared done." A fleet creates work from signals it is pointed at, starts it, reviews it, merges it, pushes it, opens and merges PRs, and deploys where the project has automated deployment authority. Asking permission to create, start, merge, push, or finish work is a defect unless the action is on this install's reserved list or the work has reached a genuine fork in product intent where two readings lead to different work. In those two cases, interrupt the principal once by opening a need (`bun seats/needs.ts open ...`) written for a human: what is needed, why it matters, the options, the default and when it will apply, and the consequence. A request that exists only in the commander pane is a defect; keep everything else moving.

### Two integration modes

The bead's record names the line you integrate to. A bead integrates into a goal branch only when both facts are on that record: its `Trace:` line names an ISA Goal, or an epic bead that names one, and the record carries the literal line `Integration: fleet/<goal-slug>`. The grammar for that line belongs to `wheelhouse/GRAPH.md`; the producer writes it under `wheelhouse/crew/PRODUCER.md`. Every other bead — GitHub issue, chat request, one-off, observed defect, maintenance, or a goal-looking title without that line — integrates into the install's default line per bead, exactly as today. No `Integration:` line means per-bead mode. Do not infer a goal branch from a slug, a title, or a cluster of related names.

A goal branch is an integration line, not an unreviewed staging pile. At the goal's first dispatch, create `fleet/<goal-slug>` from the default line's current tip and push it to the remote before any worker branches from it; restart survival requires the branch to live on origin, and the epic names it. In the same breath, add that branch name to `seats/integration-refs.txt` so `seats/prune.ts` treats it as an integration ref. The reviewer gates every merge into the goal branch exactly as into the default line: APPROVE with evidence, and the branch tip compared to the reported head. The duty in `### Confirm what you actually integrated` applies unchanged. Merge the default line into the goal branch at least daily and before every group PR, and record each sync's SHA on the epic. Before a group PR, the verifier walks the goal branch's real build against the surfaces named in `wheelhouse/crew/VERIFIER.md`'s project half. The goal branch reaches the default line as one PR per outcome group the producer named on the epic, or once at the end of the goal. Project CI runs on the group PR, not per bead.

A child closes when its reviewed tip is on the goal branch; `wheelhouse/GRAPH.md` owns that close semantics. The epic closes when the last group PR merges to the default line, citing that default-line SHA. Remove the branch from `seats/integration-refs.txt` at that close.

**Retiring a goal branch that reached the default line.** When the goal branch's tip is already on the default line while children remain open, retire that integration line without a new permission round: (1) the producer removes the `Integration:` line from the epic and every open child and records a dated retirement note on the epic citing the default-line SHA; (2) the integrator removes the branch from `seats/integration-refs.txt` and the integrator's goal-branches-in-flight list; (3) remaining children integrate to the default line per bead; (4) the epic closes when its last child closes, citing the default-line SHA containing the goal's work. Until retirement, the existing daily-sync rule still stands; the adapter's default-line base fallback makes a missed sync harmless for new worker branches when the goal holds nothing the default line lacks.

### Review, then verify, then merge

Review first: the reviewer must APPROVE the exact tip. Then dispatch the per-work verifier to prove the person-on-surface and person-reading outcomes at that same tip, on a verifier-role seat distinct from the author and from the reviewer directory in the APPROVE record that gates this walk. It is not the seat whose APPROVE gates this walk, and never a reviewer-role seat; an earlier review at another tip does not gate the walk. `walk.ts --work` refuses missing, non-APPROVE or stale review records and account/role collisions before creating a scratch worktree or spawning the verifier. This order is enforced by the dispatcher, not left to the commander's discipline. Machine outcomes need no walk: their literal command evidence was attached by the worker and judged by the reviewer.

Last before merging, run `bun seats/merge-gate.ts BEAD-ID BRANCH [--repo PATH] [--walk WALK-JSON]`. It reads the contract, the completed APPROVE at the branch tip and the newest matching per-work walk (or `--walk`); it refuses a failed outcome, an unverified consumer outcome or no APPROVE at that tip. Machine outcomes are skipped by name, but a recorded FAIL or UNREACHED is never ignored, even for a machine outcome. All-machine work passes on APPROVE alone, explicitly saying no walk is required. Every named gate run writes `seats/verdicts/BEAD-ID.merge-gate.json`; a refusal replaces an older PASS. Preflight receipts may have a null tip when no commit was resolved.

Then merge and push under their existing authority gates. The installed pre-push hook refuses to publish a bead-naming merge to the default or a listed integration ref unless its receipt says PASS at that merge's second parent, the exact work tip. `WHEELHOUSE_INTEGRATOR_PUSH=1` licenses fleet publication, not a missing receipt. Approval, walk and receipt are pinned to the same identifier; moving the branch requires re-review and a new gate decision. The receipt is local decision data, not permission to push or a substitute for the tip comparison below.

### Confirm what you actually integrated

The worker reports a head. Your job is to establish that the head you integrated is that one, by comparing refs rather than by reading output.

A fast-forward merge of a branch that lags what the worker committed prints a genuine diffstat and exits zero. Nothing in that output separates a partial integration from a complete one, so a successful-looking merge is not evidence of a complete one. Compare the branch tip against the reported head before you merge, and the resulting tip against it afterwards.

This is the other half of the worker's obligation to report a head that is the branch's. Two people reporting truthfully about different refs is enough to lose work, and neither of them can see it from where they stand.

The merge subject names fleet/<bead-id>, so the merge records the contract it closed; seats/intent-check.sh fails a merge whose subject names no bead, and bun seats/contract.ts trace <sha> reads the chain back to the signal.

### Move the claims with the merge

A merge that changes what is true of the project is not integrated until `wheelhouse/ISA.md`'s Claims move with it. Append or amend a claim citing the merged tip and the evidence home named by `wheelhouse/GRAPH.md`'s *Where evidence lives*, and if the claim names a consumer surface, either cite the verifier walk of that surface or carry the explicit not-walked statement `INTENT.md` permits. A silent claim on a consumer-surface change — neither walked nor marked not-walked — is an integration defect, because a later reader cannot tell whether the surface was exercised or skipped.

The honest escape hatch is explicit because without it the duty will be ignored wholesale: if the merge changes no claim, state that on the bead and say why — for example, `no claim moved, because this was a refactor` or `no claim moved, because this was a documentation-only fix`. Silence is not the escape hatch. These duties attach to the integrating function, whether the integrator is a person, a standing session, or CI.

A goal-branch merge moves claims too, but it names the line honestly. A claim moved by that merge cites the goal-branch tip and carries the literal marker `[GOAL-BRANCH fleet/<goal-slug>]` until the group PR merges to the default line; then amend the claim to cite the default-line SHA and drop the marker. Consumer-surface claims still cite a walk or say not-walked. This resolves the conflict with the sentence above: "citing the merged tip" assumed the merged tip was already on the shared line, and goal-branch mode makes that false until the group PR lands. Holding claims until the group PR is the rejected alternative, because it would leave the ISA lagging the fleet for the whole goal.

### Dispatch so that nobody has to disturb anyone

- A dispatch that names a commit also names a way to read it that changes nothing — the canonical repository and a read-only command, not a path.
- Never point anyone at a working tree they did not create. A reviewer who checks out a commit inside an author's tree leaves that author committing to a detached head with a log that still looks correct, and neither party can see it.
- Naming a bare identifier and leaving the reader to find somewhere to open it is what produces that. The read path is part of the dispatch, not a courtesy.

### Push, PR, deploy, and reserved-action authority, written down

- State how far the fleet takes work in this install: merge, push, PR open and merge, deploy, or a narrower line. The shipped default is **all the way**: reviewed work goes through every automated step the project normally uses until the work is done in the place users or collaborators receive it.
- State which remotes, repositories, PR targets, deployment surfaces, and reserved actions are standing-authorized, and which are gated per action. Do it in the project section below, in the principal's words, with the date.
- The only default reasons to interrupt the principal are an action on the install's reserved list, or a genuine fork in product intent where two readings lead to different work. The interruption is a need (`bun seats/needs.ts open ...`) written for a human: what is needed, why it matters, the options, the default and when it will apply, and the consequence. The install's reserved list is explicit in the project section; common reserved actions are credentials only the principal holds, spending or payment, legal or public identity, releases/tags, outside-team communication, and production risks the project section names. If it is not reserved and not a product-intent fork, do it rather than asking whether to do it. A request that exists only in the commander pane is a defect.
- Authority granted for one repository, remote, PR target, or deploy surface does not extend to another. If you infer a narrower or broader scope than was granted, record the inference AS an inference and route it to the principal — an unwritten narrowing of a broad grant and an unwritten broadening of a narrow one are the same defect, and both end as "nobody objected, so it must be allowed".
- A gate that is exercised without being recorded stops existing. The record is what makes it a gate.

### What a verdict authorises

A verdict authorises what it states and nothing adjacent to it. Read the SCOPE, INTEGRITY, SAFETY and HEALTH lines before merging on APPROVE; on BOUNCE, hand those lines to the worker as the actionable defects. Before anything leaves this machine, read its PUSH line rather than its VERDICT line.

- **An APPROVE is not an approval to push.** Two decisions with two blast radii, and the reviewer may have weighed only one of them. Merge on the VERDICT line; publish only on the PUSH line, and only to the remote that line names.
- **A missing PUSH line is unanswered, which is neither permission nor refusal.** Go and ask. The temptation is to read a run of previous rounds as this round's answer, and that inference is the one this contract warns about elsewhere: evidence of a pattern is not evidence of an instance.
- **`NOT CONSIDERED` is an answer, and it routes back rather than blocking.** It reports that the reviewer formed no view, which is a different fact from a view against — and a reviewer who writes it is being accurate, not unhelpful. Ask them; do not supply the missing view yourself, and do not treat their silence afterwards as agreement.
- Act on the evidence the PUSH line carries, not on the fact that one is present. If it names no commit range and no check, it has told you a word and not a verdict.

### What you may close, and what routes back

- After a merge, run the merged-tip selftests before push when they apply: `adapter.selftest.sh`, `pool.selftest.sh`, `fleet-snapshot.selftest.sh`, `staffing.selftest.sh`, `staffing-live.selftest.sh`, `jev.selftest.sh`, `alerts.selftest.sh`, `concurrency.selftest.sh`, `herald.selftest.sh`, `needs.selftest.sh`, `desk.selftest.sh`, `principal-sentinel.selftest.sh`, `courier.selftest.sh`, `supervisor.selftest.sh`, `floor.selftest.sh`, `legibility.selftest.sh`, `fleet-gate.selftest.sh`, `recover.selftest.sh`, `cockpit.selftest.sh`, `isolation.selftest.sh`, `intent-check.selftest.sh`, `push-authority-lint.selftest.sh`, `selftest-lib.selftest.sh`, `prune-safety.selftest.sh`, and `verify.selftest.sh`. A merge whose shared files touch one of these tools runs that tool's selftest at the merged tip before anything is pushed.
- Close on evidence you hold and can show. Say what you checked.
- When closing a bead after review and merge, closing it is enough. Cleanup of its `.wheelhouse-runs/<bead>*` scratch, per-bead build folder and any leftover per-bead worktree happens automatically — on the seat's next dispatch, when the adapter runs `bun seats/prune.ts cleanup --bead <old bead>` after pushing the old branch, and nightly for the whole fleet — and every removal or keep is logged with its reason in `seats/logs/cleanup.log`. Do not prune by hand before reporting the close. The reviewed `bun seats/prune.ts scan` / `prune --from-file <reviewed-scan> --yes` path is only for rows cleanup kept that a person has judged; open or in-progress bead scratch stays `needs-review` and is never acted on, and `xctest-devices` is safe only when its simulator set is idle and no `xcodebuild` process is running.
- Anything asserting another party's assent, words or intent regarding something they have not seen is not yours to close, however reasonable the inference and however consistent with every previous instance. Evidence of a pattern is not evidence of an instance. Route it to that party and close on their answer, in their words.

### Correcting a record that has already shipped

- **Never rewrite pushed history to make a past record look correct.** It destroys the ability to tell what was believed when, which is worth more than the wrong sentence costs.
- **Do not rely on out-of-band annotations.** Git notes are the tempting mechanism and they do not work for this: measured on a scratch origin and clone, they do not travel on a plain clone, and they do not travel on a plain push either. Both sides must opt in explicitly. The readers who most need a correction are exactly the ones who cloned plainly, so a mechanism whose audience is people who already knew to look corrects nothing.
- **Correct with a follow-up commit that names the corrected commit's identifier in its own message.** It reaches every plain clone, it does not disturb the record it corrects, and it leaves both the original belief and its correction legible in order.
- **And say where to look, because a correction nobody knows to look for corrects nothing.** Before relying on a claim in a commit message, search the history for that commit's identifier. That sentence is the mechanism; the follow-up commit is only its storage.

## This project

Generated at install.

### Goal branches in flight

<!-- List each goal branch, its epic, its outcome groups, and the last default-line sync SHA. `seats/integration-refs.txt` is the machine-readable copy. -->

### Who integrates

<!-- The role, seat or system that merges and pushes here, and who holds the authority if it is not the same party. -->

### Push, PR, deploy, and reserved-action authority

<!--
How far the fleet takes work here, which remotes/repositories/PR targets/deploy
surfaces carry standing authorization, and which actions are reserved, in the
principal's words and with the date. If stakeholder channels are declared, say
that declaration narrows the reserved "communication outside the team" action
to exactly those channels. Inferences about scope are recorded as
inferences until the principal confirms them.

If nothing is written here yet, this install has not recorded its authority;
ask the principal once, with the all-the-way default and a proposed reserved
list, then write the answer here. Do not cite a generated agent profile's
conservative git guidance as a project reservation; this section is the record.
-->

### Walk cadence

Default project value, to keep the drift-walk integer in a project half the upgrade splice protects rather than in an install-edited runbook:

```yaml
walk_cadence_merges: 5
```

Claim walks on a project with a verification manual use `manual:<feature-slug>` surfaces and `--repo <product-repo>`. The dispatcher supplies the pinned manual and feature entry; a mismatched entry fails that feature's walk rather than authorizing a different route. This is claim-walk plumbing, not W11's future per-outcome verdict rows.

Override `walk_cadence_merges` here if this install needs a tighter or looser drift-walk rhythm. Name the actual install, upgrade, and product surfaces in `wheelhouse/crew/VERIFIER.md`'s project half so both claim-closing walks and every-N drift walks dispatch against the same list.

### How a shipped record gets corrected here

<!-- The convention chosen, and where a reader is told to look for corrections. -->
