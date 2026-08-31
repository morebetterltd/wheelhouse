# The Work Graph

The graph is the single source of work state. Not the chat, not a seat's memory, not a summary someone wrote afterwards.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

- **One bead in flight per seat.** A seat working two things is a seat reporting on neither.
- **Beads carry their evidence as comments.** The decision trail has to survive the close, because the reason a thing was done outlives everyone's memory of doing it.
- **Comment authorship is configured, not inferred.** Every seat sets `BEADS_ACTOR` to its seat name in the environment the seat runs under, so the bead's comment author field says which seat spoke. One-line setup: export it before spawning or resuming the seat, e.g. `BEADS_ACTOR=worker-1 bun seats/adapter.ts spawn worker-1` (and keep that variable in the pane or service that later dispatches/resumes it). This mechanism is version-stamped against bd 1.2.2 (measured 2026-08-31: `BEADS_ACTOR=<name> bd comment ...` rendered the comment author as `<name>`); re-verify on your bd build the same way this file asks for every CLI behavior.
- **A principal decision relayed by someone else has a fixed form.** Write `principal said "<verbatim words>" in <channel> at <timestamp>`. The quote, channel, and time are all required. A paraphrase, or a relay missing any one of the three, is the relayer's opinion about the principal's decision, not the principal's decision in the graph.
- **Work discovered mid-task becomes a bead, not a detour.** Report it, file it, stay on your own bead.
- **A bead's done is stated by its author and judged by the reviewer.** Neither the worker nor the reviewer gets to move it.

### Where evidence lives

Evidence a report or a verdict relies on must already sit somewhere the graph can reach at the moment the report or verdict is written. Two homes qualify:

- **On the bead**, as comment text. This is the default, and it is what the second bullet above means. Paste the decisive command output rather than a description of it.
- **At a committed path on the branch under review**, named by the bead, for what cannot be pasted — a screen capture, a trace, a log too long to read as a comment. The bead comment still carries the extract that supports the claim, plus the path and the commit that holds it. A reader who never fetches the branch still learns what the artifact showed, and a reader who does can go and look.

A committed capture must also be scrubbed before it is committed: no local usernames, home directories, machine-identifying hostnames, or tmp paths — replace them with neutral placeholders (`[user]`, `[home]`, `[tmpdir]`) at capture time. Use root-relative `seats/evidence-scrub.sh` as the standard write-time filter: `cmd 2>&1 | seats/evidence-scrub.sh > evidence/<bead>/capture.txt`, or `seats/evidence-scrub.sh -o evidence/<bead>/capture.txt -- cmd`. This repo is public-destined, and an `ls -l` owner column or a `/var/folders/...` path in evidence outlives every intention to clean it later.

Rework shape follows the defect class. If a never-pushed branch is bounced for a scrub-class defect — a local path, username, credential, or other string that must not survive in public-destined history — amend the offending commit so the leaked bytes leave the branch entirely before review resumes. The y7h residual tmp-path cleanup is the motivating case: stacking a "redact it now" commit would have kept the bad string in the very history the scrub rule exists to protect. Content-class rework stacks a new commit instead, preserving the bounced state and the review delta. `wheelhouse/crew/REVIEWER.md`'s identifier comparison rule already handles the amended-tip case: a rewritten branch must be reviewed against the new reported head, not waved through because the content looks familiar.

Anywhere else is not evidence. It is a pointer, and a pointer the next reader cannot follow says only that something once existed. The two places this bites are the two the loop creates for itself: a bench's output directory, which `wheelhouse/crew/BENCH.md` clause 1 leaves to whoever runs the bench and which is most naturally a scratch directory the operating system deletes without asking; and a worker's worktree, which is removed once the branch merges. A verdict citing either was true when it was written and unreadable by the time anyone audits it — and it fails in the direction that looks fine, because a citation that cannot be opened is indistinguishable from one nobody has tried to open.

So the order matters as much as the destination: move the evidence to its home first, cite it second. Evidence promised to be copied over later is evidence that lives in a temporary directory, whatever the report says.

### Running the CLI

An errored command piped into a counter looks exactly like a clean zero. That has cost a seat a wrong conclusion and the report built on it, so check the exit status before you believe a count — and check what the exit status is worth on your build.

On the build stamped below, a command whose operations ALL fail exits non-zero, but one where some succeeded and some failed exits zero: the mixed-result batch is the one case measured on that build where a failure reads as success. `bd update <id>` with no update flags prints `No updates specified` and exits zero without ever validating the id, so a mistyped flag turns the command into a silent no-op against an id that need not exist. Older builds were worse still: an invalid status update printed its error and exited zero. Establish which you have instead of carrying this sentence forward on faith.

Where the CLI may be run from is build-dependent, and the answer is neither "the root" nor "anywhere". bd 0.49.1 resolved the graph only from the project root. On bd 1.2.2 the workspace walk climbs out of a plain subdirectory and out of a git WORKTREE, but halts at a nested git REPOSITORY. Measured 2026-08-20 from six places under one root:

| run from | its `.git` | result |
|---|---|---|
| a plain subdirectory | none | exit 0, graph resolved |
| a deeper plain subdirectory | none | exit 0 |
| a git worktree beside the product repos | file | exit 0 |
| a subdirectory inside that worktree | none | exit 0 |
| a product repo checked out under the root | directory | exit 1, `no beads database found` |
| a second product repo | directory | exit 1 |

The discriminator is what kind of `.git` the walk meets, not how deep you are. A worktree's `.git` is a file pointing at the real repository and the walk passes through it — proven by the fourth row, which could not resolve if the walk halted at the worktree root. A repository's `.git` is a directory and the walk halts there, even though the graph sits one level above.

For the layout this contract's own interview prescribes — product repos beneath the root, workers in worktrees beside them — that means the graph is reachable from a worker's worktree and unreachable from the product checkout. Run-from-root still holds for the product repos, and only for them. The consolation is that this build fails honestly there: a message and a non-zero exit, rather than the silent-looking zero the original rule was written against. Before deciding the rule has lapsed for your build, measure from inside a product repo AND from inside a worktree — the two do not behave alike, and testing only the one that happens to work is how a true measurement becomes a false rule.

### The review queue

This bd build has no in_review status. Valid statuses are open, in_progress, blocked, deferred, closed, pinned, hooked (verified against bd 1.2.2 by attempting `bd list --status in_review` and reading the rejection). The needs-review LABEL is the review-queue signal: the worker adds it at done, closing drops it in the same breath. Re-verify this against your own bd version — it is a fact about a build, not about beads.

Two cautions when you re-verify. The probes disagree: `bd list --help` describes its `--status` filter as taking open, in_progress, blocked, deferred, closed — five — while both rejection messages name seven, adding pinned and hooked. Trust the rejection text over the help text. And the absence is a configurable default rather than a property: `bd config set status.custom in_review` is accepted, after which the status validates and beads render as IN_REVIEW. Either shape works; pick one and write it down here, because a fleet where half the seats use the label and half use a status is worse than either.

A closed bead still carrying `needs-review` renders as in-flight in the listing and misleads every seat that reads it.

> Version-stamped: every statement above is a fact about a particular CLI build, not an eternal truth. Verified against bd 1.2.2 on 2026-08-19. Correct this file if your build differs, and say so in your report rather than working around it quietly.

### The template-report marker

The second label the loop depends on, and the only other one this contract names. `needs-review` marks where a bead sits in this fleet's queue; `template-report` marks what the bead is ABOUT — a defect in the wheelhouse template itself or in the tooling every seat runs on, as opposed to work on this project's product. The two are independent and a bead may carry both: a template-class finding is reviewed like any other.

It exists so that the finding can be found by someone who did not file it. `bd list --label template-report` reaches every one of them; a sweep by judgment, or by grepping titles, reaches only the ones phrased the way the reader guessed. So the label is not a synonym for the `Report <tool> issue: ...` bead title that `wheelhouse/crew/DESIGNER.md` prescribes — the title says which tool and what broke, and the label is what makes the bead reachable without reading it. File both, in one command — the label goes on at creation, not in a follow-up you will forget:

```
bd create "Report <tool> issue: <what broke>" --labels template-report -d "<evidence>"
```

On the build stamped above the create-time flag is `--labels` (there is no `--label` on `bd create`; that spelling belongs to `bd list`'s filter), and a bead already filed without it takes the label with `bd update <id> --add-label template-report`. A `Report <tool> issue:` bead without the label is the known failure this section exists to prevent: it reads correctly to a human and is invisible to the harvest.

**If this fleet is not running on the machine that owns the template, the label alone reaches nobody.** It marks the bead in a graph the template's maintainers cannot see, so file the finding as a GitHub issue on the template's repository as well — `github.com/morebetterltd/wheelhouse` for an install from that template, or whatever remote `wheelhouse/.template-source` records if you installed from a fork.

## This project

Generated at install.

### Priorities

<!-- What P0..P3 mean here, and what outranks what. -->

### CLI build notes

<!--
Where a measurement of YOUR bd build disagrees with the version-stamped claims
in the contract above. One line per divergence: the build, what was run, what
it did, and the date.

Add a line only when your build actually differs. A build that matches the
stamped one needs nothing here -- an entry saying "matches" is noise, and the
contract's own stamp already says what matching means. Leave this comment in
place until there is a divergence to record.
-->
