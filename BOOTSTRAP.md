# Bootstrap procedure

You are installing a wheelhouse — a standing agent fleet over a shared work graph — into the user's project. You are talking to the PRINCIPAL: the person who owns this project and whose judgment the fleet defers to.

Work in this order. Do not reorder, and do not write anything before step 3 is answered.

## 1. Preflight — verify, then report what you found

- Confirm the current directory is a git repository, and say which directory you are about to install into. Let the principal correct you before you continue.
- Confirm the `bd` CLI is on PATH and print its version. If it is missing, stop and say how to install it.
- Report uncommitted changes if there are any. Do not block on them; the principal may be mid-work.
- **STOP IMMEDIATELY, without writing anything, if `wheelhouse/` or `CLAUDE.md` already exists.** Say what exists and ask what to do. Overwriting a principal's `CLAUDE.md` is unrecoverable.

## 1b. Confirm you actually have the template

You were told to clone this repo into a temporary directory. Before you read another word of it, confirm the clone produced something:

- `$TEMPLATE/BOOTSTRAP.md`, `$TEMPLATE/contracts/` and `$TEMPLATE/contracts/WORKER.md` all exist and are non-empty.
- `ls $TEMPLATE/contracts/` lists six files.

**A clone of an empty or unpushed repository exits 0.** It creates the directory, prints nothing alarming, and leaves you with nothing to install. If the files above are missing, STOP and tell the principal the template is empty or unreachable — do not proceed, and do not reconstruct the contracts from memory or from this document. A wheelhouse whose contracts were invented by the installer is worse than no wheelhouse, because it looks like the real thing.

## 2. Read before you ask

Survey the repository so your questions are informed: build and dependency files, language and framework, test setup, CI config, existing docs, whether there are multiple product repos beneath this root, and how the project is built and run.

You are forming PROPOSED ANSWERS to step 3. Asking a principal what language their own project is in tells them you did not look.

## 3. Interview — propose, then confirm

Ask in as few turns as you can manage. Lead each question with your proposal from step 2, so the principal is correcting rather than composing.

1. **Product repos.** "I see \<what you found\>. Are these the repos the fleet will change, and are they separate git repos from this root?"

2. **What "it runs" means.** "For a \<project type\>, I would prove a build works by \<your proposal: a server answers a health check; a CLI executes a real command against real input; an app installs and reaches its first screen\>. What is the observation that would convince you a build actually works?" This becomes the project's bench contract. If they cannot answer yet, record it as unanswered and continue — the bench ships as an explicit stub.

3. **First ideal state.** "What is true when this fleet's first iteration is done?" **DO NOT PROPOSE AN ANSWER.** This is the one thing only the principal knows, and a plausible suggestion gets accepted by default — after which the ISA states your goal rather than theirs.

4. **Principal-only actions.** Offer these defaults and ask them to amend: pushes to any remote, releases and deploys, credentials and signing, spending money, communication outside the team. Everything else the fleet may do within the project's permissions.

5. **Merge policy.** "Does a reviewer's APPROVE carrying bench evidence authorize a merge to your local main, or do you want to confirm each merge yourself?" **Default: the principal confirms each merge.** Say that auto-merge is a graduation documented in `runbooks/PROMOTION.md`, taken once the loop has been right on real merges — not a starting position.

6. **Seats**, only if they want them now. Names and count. Offer the minimum viable fleet: commander, one worker, one reviewer.

## 4. Write

- `bd init` in the project root; confirm the graph exists.

- **Reconcile `AGENTS.md`.** `bd init` writes an `AGENTS.md` at the root whose session-completion section mandates pushing — "work is NOT complete until `git push` succeeds", "NEVER stop before pushing", "YOU must push". At this root that is a direct contradiction of `wheelhouse/fleet/WORKER.md`, which forbids a worker from pushing at all, and of the principal-only actions the principal just confirmed. Two files at the same root giving opposite orders is a defect regardless of which one an agent follows.

  Keep bd's useful content — the command reference is genuinely handy — and override the mandate. Append a section to `AGENTS.md`:

  ```markdown
  ## This project runs a wheelhouse — the rules above are overridden

  `CLAUDE.md` at this root and `wheelhouse/fleet/WORKER.md` govern. Where they and
  the section above disagree, they win.

  Specifically: **do not push.** Pushing to any remote is a principal-only action
  here. A worker's output is a reviewable branch, and work is complete when it is
  committed locally and reported with evidence — not when it is pushed. Ignore
  "landing the plane" as written above; land it by reporting.

  The bd command reference above is accurate and worth keeping.
  ```

  Say plainly in your hand-back that you did this and why. A principal who later reads `AGENTS.md` unaware of the override will be confused by it, and the fleet's behaviour will look like disobedience rather than policy.
- Create `wheelhouse/crew/` and `wheelhouse/fleet/`.
- Copy **verbatim** from the template's `contracts/`:
  - `WORKER.md` and `SEATS.md` into `wheelhouse/fleet/`
  - `REVIEWER.md`, `DESIGNER.md`, `BENCH.md` into `wheelhouse/crew/`
  - `GRAPH.md` into `wheelhouse/`
  - `bench.sh.stub` to `wheelhouse/crew/bench.sh`, executable, unchanged — **it exits non-zero on purpose.** A stub that exits 0 lets the first APPROVE through on nothing.
- **Do not edit a single line of any `## Contract` section.** They are identical in every project by design; a project that edits its contract has forked from every other one silently.

**How to fill a `## This project` section, precisely.** Find the LAST line in the file that is exactly `## This project` — the whole line, nothing else on it. Everything above that line is the contract and is not yours to touch; everything below it is yours to write. Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A contract may legitimately discuss its own structure, and a naive match has already destroyed one contract file this way — deleting a licensing-compliance rule while every automated check still passed.
- Fill each file's `## This project` section from the interview: the designer's territory, the worker's repos and its empty gotchas section, the reviewer's branch and worktree conventions, the bench's run-proof.
- Fill `wheelhouse/fleet/SEATS.md`'s `## This project` roster from the seat answers, or with the minimum viable fleet and a note that seats can be added later. Its `## Contract` section — which carries the seat-accounting rule — is copied verbatim like every other contract.
- Write `CLAUDE.md` at the root: commander-session context, product changes happen in product repos via workers, new work becomes a bead immediately, deadline beads outrank everything, plus the principal-only actions from Q4 and the merge policy from Q5.
- Write `wheelhouse/ISA.md`: the goal from Q3, empty claims, empty decisions, and any anti-claims stated. **Do not invent claims.** An ISA with fabricated claims is worse than an empty one.
- Write `wheelhouse/STARTUP.md` with this project's real paths and seat names.

`generated/` in the template holds specimens of these files. They are examples of the SHAPE. Never copy them — they describe an invented project.

## 5. Verify — show the output, do not summarize it

Run each of these and paste what it prints:

- `bd ready` — returns without error.
- A grep of the installed tree for the template's own specimen strings (`Ebb`, `ebb`, and the example project's terms: `cordova`, `emulator`, `app-review`, `com.example.app`). **Expect zero hits.** If template strings appear in the project's files, the install leaked and must be fixed before you report success.
- A grep for unfilled placeholders and for `<!--` comment stubs you were supposed to replace. Expect zero in the files you generated.
- **Contract integrity — run this before anything else, and stop if it fails.** Every installed `## Contract` section must be byte-identical to the template's. Check each one:

  ```bash
  # $TEMPLATE is the clone you fetched; $ROOT is the project root
  for pair in "fleet/WORKER.md:WORKER.md" "fleet/SEATS.md:SEATS.md" \
              "crew/REVIEWER.md:REVIEWER.md" "crew/DESIGNER.md:DESIGNER.md" \
              "crew/BENCH.md:BENCH.md" "GRAPH.md:GRAPH.md"; do
    installed="$ROOT/wheelhouse/${pair%%:*}"; template="$TEMPLATE/contracts/${pair##*:}"
    # the contract is everything above the last exact '## This project' line
    awk '/^## This project$/{exit} {print}' "$installed"  > /tmp/wh-a.$$
    awk '/^## This project$/{exit} {print}' "$template"   > /tmp/wh-b.$$
    if diff -q /tmp/wh-a.$$ /tmp/wh-b.$$ >/dev/null; then
      echo "OK   ${pair%%:*}"
    else
      echo "FAIL ${pair%%:*} — contract differs from the template:"; diff /tmp/wh-b.$$ /tmp/wh-a.$$
    fi
    rm -f /tmp/wh-a.$$ /tmp/wh-b.$$
  done
  ```

  Any `FAIL` means the install damaged a contract. Stop and repair it before continuing. Every other check in this list can pass on a file whose contract you deleted — this is the only one that looks.

- Confirm every file you created exists and is non-empty.
- Print the resulting tree.

## 6. Hand back

Tell the principal plainly:

- what exists now;
- what is deliberately STUBBED and therefore not yet true — `crew/bench.sh`, the empty gotchas section, the ISA's empty claims;
- the three next actions: file the first beads, implement the bench against `crew/BENCH.md`, launch seats per `STARTUP.md`.

## Failure behavior

Any step that cannot complete: stop, and report where you got to and what blocked you. Do not improvise around it, and do not report success on a partial install.

A half-installed wheelhouse that claims to be finished is worse than no install, because the next session inherits it as if it were sound.
