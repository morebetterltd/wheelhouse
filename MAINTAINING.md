# Maintaining this template

How this repo's own prose gets revised. It is a convention of this repo, and it is deliberately **not** a contract — the first thing written here that is not meant to be copied. A contract line is one every installed project must be able to act on, and installed projects are forbidden to edit the shared text at all; a rule about revising that text has no consumer who may execute it, so copying it into every install would ship a standing instruction nobody there is allowed to follow.

## Where reasoning lives

Reasoning a reader needs in order to **apply** a rule belongs in the file. Reasoning needed only to **revise** the rule safely belongs in the tree — the commit body of the change it explains.

Do not overshoot this into "reasoning goes in commit bodies." A commit body is invisible to someone reading the file, and you cannot require every reader to run `git log`. If the reader cannot follow the sentence without the reason, the reason is apply-class and the file carries it.

And not `refs/notes`, which was measured and disqualified before this file existed: notes are doubly opt-in — invisible to a plain clone AND not carried by a plain push — where a commit body travels with every clone and sits anchored to exactly the change it explains.

## The findability convention

A revise-class reason in a commit body is only findable by someone who thinks to look, and "authors will remember to look" is already measured as insufficient on this repo: an author put revise-class rationale into a commit body roughly an hour after being briefed on this exact gap. The remedy is structural, in two pieces.

1. **The marker.** When revise-class reasoning protects a surface a reader might be tempted to fix — a deliberate divergence between files, a choice that reads as an oversight — the file carries one sentence at that point saying the oddity is deliberate and the reason lives in this line's history. The marker names no SHA: a SHA in prose goes stale the first time the line is reworded, and nothing checks it. What the reader needs from the file is the fact that there is something to find; the search below does the rest.

2. **The review gate.** Whoever reviews a template change reads the commit body as part of the diff. Revise-class reasoning found there that protects a fixable surface, with no marker at the surface it protects, is a blocking finding. This is the piece that survives the briefed author: memory did not hold for an hour, and review is standing.

## The prescribed search

From a marker, or from any line you suspect is deliberate: `git log -p --follow -- <file>` and read the history of that line, or `git log -S'<distinctive phrase>' -- <file>` when you hold exact text from the line as it reads today. Know what `-S` cannot tell you: it matches exact strings, so a phrase that has since been reworded returns empty, and that empty is indistinguishable from a genuine absence. An empty result on a line you believe was deliberate is an unread result, not a null one — fall back to the full `-p --follow` read before concluding no reason was recorded.

An installed project cannot run this search where it stands: the install clone is `--depth 1` and discarded. `wheelhouse/.template-source` records the template's remote and commit — clone the template with history and search there.

## The worked example

WORKER.md's routing bullet ("Route what you cannot verify") and REVIEWER.md's routing section ("What you structurally cannot verify") state one rule in two deliberately different sentences, because the author's common case is the assent kind and the reviewer's is the access kind. Nobody needs the reason in order to follow either sentence, which is what makes it revise-class; anyone tempted to tidy the two into agreement needs it, which is why each file carries the marker at that point. The full argument — including why mirroring beats one copy in a shared file, and why drift between deliberately different sentences shows up as visible disagreement rather than hidden duplication — is in this repo's history on those lines, under the commit subject "two kinds of unverifiable, and the author's is the quiet one."
