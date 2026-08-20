# The Integrator

You are the integrator: whoever takes a reviewed branch and puts it into the shared line, and whoever pushes. That may be a human, a standing session, or CI.

These duties attach to the function and not to a job title, deliberately. An obligation attached to a role name is unowned wherever that role does not exist, and half of a two-party check with nobody on one side is not a weaker check — it is no check, wearing the appearance of one.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

### Confirm what you actually integrated

The worker reports a head. Your job is to establish that the head you integrated is that one, by comparing refs rather than by reading output.

A fast-forward merge of a branch that lags what the worker committed prints a genuine diffstat and exits zero. Nothing in that output separates a partial integration from a complete one, so a successful-looking merge is not evidence of a complete one. Compare the branch tip against the reported head before you merge, and the resulting tip against it afterwards.

This is the other half of the worker's obligation to report a head that is the branch's. Two people reporting truthfully about different refs is enough to lose work, and neither of them can see it from where they stand.

### Dispatch so that nobody has to disturb anyone

- A dispatch that names a commit also names a way to read it that changes nothing — the canonical repository and a read-only command, not a path.
- Never point anyone at a working tree they did not create. A reviewer who checks out a commit inside an author's tree leaves that author committing to a detached head with a log that still looks correct, and neither party can see it.
- Naming a bare identifier and leaving the reader to find somewhere to open it is what produces that. The read path is part of the dispatch, not a courtesy.

### Push authority, written down

- State which remotes and repositories carry standing authorization to push, and which are gated per push. Do it in the project section below, in the principal's words, with the date.
- Authority granted for one repository does not extend to another. If you infer a narrower or broader scope than was granted, record the inference AS an inference and route it to the principal — an unwritten narrowing of a broad grant and an unwritten broadening of a narrow one are the same defect, and both end as "nobody objected, so it must be allowed".
- A gate that is exercised without being recorded stops existing. The record is what makes it a gate.

### What a verdict authorises

A verdict authorises what it states and nothing adjacent to it. Before anything leaves this machine, read its PUSH line rather than its VERDICT line.

- **An APPROVE is not an approval to push.** Two decisions with two blast radii, and the reviewer may have weighed only one of them. Merge on the VERDICT line; publish only on the PUSH line, and only to the remote that line names.
- **A missing PUSH line is unanswered, which is neither permission nor refusal.** Go and ask. The temptation is to read a run of previous rounds as this round's answer, and that inference is the one this contract warns about elsewhere: evidence of a pattern is not evidence of an instance.
- **`NOT CONSIDERED` is an answer, and it routes back rather than blocking.** It reports that the reviewer formed no view, which is a different fact from a view against — and a reviewer who writes it is being accurate, not unhelpful. Ask them; do not supply the missing view yourself, and do not treat their silence afterwards as agreement.
- Act on the evidence the PUSH line carries, not on the fact that one is present. If it names no commit range and no check, it has told you a word and not a verdict.

### What you may close, and what routes back

- Close on evidence you hold and can show. Say what you checked.
- Anything asserting another party's assent, words or intent regarding something they have not seen is not yours to close, however reasonable the inference and however consistent with every previous instance. Evidence of a pattern is not evidence of an instance. Route it to that party and close on their answer, in their words.

### Correcting a record that has already shipped

- **Never rewrite pushed history to make a past record look correct.** It destroys the ability to tell what was believed when, which is worth more than the wrong sentence costs.
- **Do not rely on out-of-band annotations.** Git notes are the tempting mechanism and they do not work for this: measured on a scratch origin and clone, they do not travel on a plain clone, and they do not travel on a plain push either. Both sides must opt in explicitly. The readers who most need a correction are exactly the ones who cloned plainly, so a mechanism whose audience is people who already knew to look corrects nothing.
- **Correct with a follow-up commit that names the corrected commit's identifier in its own message.** It reaches every plain clone, it does not disturb the record it corrects, and it leaves both the original belief and its correction legible in order.
- **And say where to look, because a correction nobody knows to look for corrects nothing.** Before relying on a claim in a commit message, search the history for that commit's identifier. That sentence is the mechanism; the follow-up commit is only its storage.

## This project

Generated at install.

### Who integrates

<!-- The role, seat or system that merges and pushes here, and who holds the authority if it is not the same party. -->

### Push authority and its scope

<!--
Which remotes and repositories carry standing authorization, which are gated
per push, in the principal's words and with the date. Inferences about scope
recorded as inferences until the principal confirms them.

If nothing is written here yet, the answer is per-push and the principal's —
that is the shipped default, not an omission. `wheelhouse/runbooks/PROMOTION.md`
describes what earns a standing grant and what returns you to per-push.
-->

### How a shipped record gets corrected here

<!-- The convention chosen, and where a reader is told to look for corrections. -->
