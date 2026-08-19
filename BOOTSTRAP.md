# Bootstrap procedure

You are installing a wheelhouse — a standing agent fleet over a shared work graph — into the user's project. You are talking to the PRINCIPAL: the person who owns this project and whose judgment the fleet defers to.

Work in this order. Do not reorder, and do not write anything before the interview in step 4 is answered.

## 1. Confirm you actually have the template

You are already following instructions from this clone, so verify it before trusting any more of it. This comes before the project checks deliberately: everything below depends on these files being real, and a wheelhouse installed from an empty clone is worse than no install.


You were told to clone this repo into a temporary directory. Before you read another word of it, confirm the clone produced something:

- `$TEMPLATE/BOOTSTRAP.md`, `$TEMPLATE/contracts/` and `$TEMPLATE/contracts/WORKER.md` all exist and are non-empty.
- All seven contract files are present — six briefs plus the bench stub:

  ```bash
  for f in WORKER.md SEATS.md REVIEWER.md DESIGNER.md BENCH.md GRAPH.md bench.sh.stub; do
    test -s "$TEMPLATE/contracts/$f" || echo "MISSING: contracts/$f"
  done
  ```

  Check for the files by name rather than counting them. A count breaks every time the template gains a file, and a check that halts on a healthy clone teaches installers to skip it.

**Then record where the template came from, before you do anything else with it.** A shell variable does not survive between your tool calls; a file does.

```bash
mkdir -p wheelhouse
{ echo "source=$(git -C "$TEMPLATE" remote get-url origin 2>/dev/null || echo "$TEMPLATE")"
  echo "commit=$(git -C "$TEMPLATE" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "path=$TEMPLATE"
  echo "installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "upgraded="
} > wheelhouse/.template-source
cat wheelhouse/.template-source
```

Every later step reads `path=` out of that file rather than trusting `$TEMPLATE` to still be set:

```bash
TEMPLATE=$(sed -n 's/^path=//p' wheelhouse/.template-source)
```

`installed=` records when this project first installed and is never rewritten afterwards; `upgraded=` is the one an upgrade updates. The `commit=` line is the provenance record. It is what tells a future reader which version of the contracts this project installed, and it is the baseline the upgrade path in the README compares against. Without it, "re-copy the contracts" has nothing to diff from.

**A clone of an empty or unpushed repository exits 0.** It creates the directory, prints nothing alarming, and leaves you with nothing to install. If the files above are missing, STOP and tell the principal the template is empty or unreachable — do not proceed, and do not reconstruct the contracts from memory or from this document. A wheelhouse whose contracts were invented by the installer is worse than no wheelhouse, because it looks like the real thing.

## 2. Preflight — verify the project, then report what you found


- Confirm the current directory is a git repository, and say which directory you are about to install into. Let the principal correct you before you continue.
- Confirm the `bd` CLI is on PATH and print its version. If it is missing, stop and give the install command from the README's prerequisites rather than guessing one.
- Report uncommitted changes if there are any. Do not block on them; the principal may be mid-work.
- **STOP IMMEDIATELY, without writing anything, if `wheelhouse/` or `CLAUDE.md` already exists.** Say what exists and ask what to do. Overwriting a principal's `CLAUDE.md` is unrecoverable.

## 3. Read before you ask

Survey the repository so your questions are informed: build and dependency files, language and framework, test setup, CI config, existing docs, whether there are multiple product repos beneath this root, and how the project is built and run.

You are forming PROPOSED ANSWERS to step 4. Asking a principal what language their own project is in tells them you did not look.

## 4. Interview — propose, then confirm

Ask in as few turns as you can manage. Lead each question with your proposal from step 3, so the principal is correcting rather than composing.

1. **Product repos, and therefore the shape of this install.** "I see \<what you found\>. Are these the repos the fleet will change, and are they separate git repos from this root?"

   Two shapes, and the common one is the second:

   - **Umbrella root.** This directory is a container; the product lives in one or more separate git repos beneath it. The wheelhouse installs at the container root, the graph spans the repos below it, and workers create worktrees inside each product repo.
   - **Single repo.** This directory IS the product — one repo, no container. This is the ordinary case and it is fully supported: the wheelhouse installs at the product root, `CLAUDE.md` and `wheelhouse/` are committed alongside the code, and a worker's worktree is a SIBLING directory outside the repo (for example `../.wheelhouse-worktrees/<bead-id>`), so the worktree never nests inside the repo it is branching from.

   Say which shape you are installing, and record it in the worker's `## This project` section along with where worktrees go. A worker that guesses this wrong creates a worktree inside the repo and pollutes the very diff it is meant to produce.

2. **What "it runs" means.** Two questions, because `crew/BENCH.md` has five sections to fill and one answer fills one of them:

   a. "For a \<project type\>, I would prove a build works by \<your proposal: a server answers a health check; a CLI executes a real command against real input; an app installs and reaches its first screen\>. What is the observation that would convince you a build actually works?"

   b. "What does the bench need in order to do that — what artifact does it take, and does anything have to be started and torn down around it?" A long-running target (a server, an emulator, a container) needs start and teardown; a one-shot artifact (a CLI, a library, a batch job) does not, and its bench is much shorter.

   c. "When it goes wrong, what does that look like in the logs or output — what should the bench scan for and treat as failure?"

   d. "What does someone need installed or running before they can execute this bench at all?"

   `crew/BENCH.md` has five project sections and these four questions fill them; the fifth, the artifact, comes from (b). Do not fill a section the principal did not answer. The template's own rule is no invention: an unanswered section says so, and the stub keeps the reviewer honest until it is filled. If the principal cannot answer yet, record it as unanswered and continue — the bench ships as an explicit stub.

3. **First ideal state.** "What is true when this fleet's first iteration is done?" **DO NOT PROPOSE AN ANSWER.** This is the one thing only the principal knows, and a plausible suggestion gets accepted by default — after which the ISA states your goal rather than theirs.

4. **Principal-only actions.** Offer these defaults and ask them to amend: pushes to any remote, releases and deploys, credentials and signing, spending money, communication outside the team. Everything else the fleet may do within the project's permissions.

5. **Merge policy.** "Does a reviewer's APPROVE carrying bench evidence authorize a merge to your local main, or do you want to confirm each merge yourself?" **Default: the principal confirms each merge.** Say that auto-merge is a graduation documented in `runbooks/PROMOTION.md`, taken once the loop has been right on real merges — not a starting position.

6. **Priorities.** `wheelhouse/GRAPH.md` has a project section for what P0 to P3 mean here. Offer this default and ask them to amend rather than compose: **P0 blocks the fleet or has an external deadline; P1 is the core loop; P2 is maintenance; P3 is nice-to-have.** If they accept it unchanged, say so in the file — a scheme that was confirmed reads differently from one that was assumed.

7. **Seats**, only if they want them now. Names and count. Offer the minimum viable fleet: commander, one worker, one reviewer.

## 5. Write

- `bd init` in the project root; confirm the graph exists. Its output is verbose and mentions daemons, migrations and sync; that is normal and not an error.

  What IS worth stopping for: a non-zero exit, a refusal to create `.beads/`, or a message naming a conflicting existing database. Anything else, run `bd doctor`, paste the output, and continue. Treat `bd doctor`'s upgrade suggestions as advisory — one of them names a formula that may not exist.

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
  - the whole `runbooks/` directory into `wheelhouse/runbooks/`. `SEATS.md` and `STARTUP.md` both point at these by path, and a runbook that is only in the template is a broken link in the project.
  - `bench.sh.stub` to `wheelhouse/crew/bench.sh`, executable, unchanged — **it exits non-zero on purpose.** A stub that exits 0 lets the first APPROVE through on nothing.
- To be unambiguous about what "verbatim" means here: you copy the whole file, then append or fill ONLY below the `## This project` heading. Copying verbatim and filling the project section are the same operation, not competing instructions.
- **Do not edit a single line of any `## Contract` section.** They are identical in every project by design; a project that edits its contract has forked from every other one silently.

**How to fill a `## This project` section, precisely.** Find the LAST line in the file that is exactly `## This project` — the whole line, nothing else on it. Everything above that line is the contract and is not yours to touch; everything below it is yours to write. Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A contract may legitimately discuss its own structure, and a naive match has already destroyed one contract file this way — deleting a licensing-compliance rule while every automated check still passed.
- Fill each file's `## This project` section from the interview: the designer's territory, the worker's repos and its empty gotchas section, the reviewer's branch and worktree conventions, the bench's run-proof.
- Fill `wheelhouse/fleet/SEATS.md`'s `## This project` roster from the seat answers, or with the minimum viable fleet and a note that seats can be added later. Its `## Contract` section — which carries the seat-accounting rule — is copied verbatim like every other contract.
- Write `CLAUDE.md` at the root: commander-session context, product changes happen in product repos via workers, new work becomes a bead immediately, deadline beads outrank everything, plus the principal-only actions from Q4 and the merge policy from Q5.
- Write `wheelhouse/ISA.md`: the goal from Q3, empty claims, empty decisions, and any anti-claims stated. **Do not invent claims.** An ISA with fabricated claims is worse than an empty one.
- Write `wheelhouse/STARTUP.md` with this project's real paths and seat names.

`generated/` in the template holds specimens of these files. They are examples of the SHAPE. Never copy them — they describe an invented project.

## 6. Verify — show the output, do not summarize it

Run each of these and paste what it prints:

- **Contract integrity — this one first, and stop if it fails.** (Upgrading rather than installing? `wheelhouse/runbooks/UPGRADE.md` is the procedure; it uses this same check, and step 0 there covers installs old enough to have no `.template-source` at all.) Every installed `## Contract` section must be byte-identical to the template's. Check each one:

  ```bash
  ROOT="$PWD"
  TEMPLATE=$(sed -n 's/^path=//p' wheelhouse/.template-source)

  # A missing or empty template path makes every comparison below vacuously true.
  # That is the failure mode this whole check exists to prevent, so refuse to run --
  # but try to recover first, because path= points at a mktemp directory the OS
  # eventually deletes, and an upgrade months later will always find it gone.
  # NOTE this makes the block more than a pure check: on a dead path it performs a
  # network clone and rewrites the machine-local path= field. That is the whole of
  # its side effects; the contracts themselves are never written by this block.
  if [ -z "$TEMPLATE" ] || [ ! -s "$TEMPLATE/contracts/WORKER.md" ]; then
    SOURCE=$(sed -n 's/^source=//p' wheelhouse/.template-source 2>/dev/null)
    if [ -n "$SOURCE" ]; then
      TEMPLATE=$(mktemp -d)
      echo "template path was dead; re-cloning from $SOURCE"
      git clone --quiet "$SOURCE" "$TEMPLATE" || true
      sed -i.bak "s|^path=.*|path=$TEMPLATE|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
    fi
  fi
  if [ -z "$TEMPLATE" ] || [ ! -s "$TEMPLATE/contracts/WORKER.md" ]; then
    echo "FAIL cannot verify contracts: no usable template ($TEMPLATE)"
    echo "     recover one per wheelhouse/runbooks/UPGRADE.md step 0-1, then re-run"
    exit 1
  fi

  for pair in "fleet/WORKER.md:WORKER.md" "fleet/SEATS.md:SEATS.md" \
              "crew/REVIEWER.md:REVIEWER.md" "crew/DESIGNER.md:DESIGNER.md" \
              "crew/BENCH.md:BENCH.md" "GRAPH.md:GRAPH.md"; do
    installed="$ROOT/wheelhouse/${pair%%:*}"; template="$TEMPLATE/contracts/${pair##*:}"
    test -s "$installed" || { echo "FAIL ${pair%%:*} — installed file missing or empty"; continue; }
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

  A `FAIL` means the installed contract differs from your template source — it does not say why. Two causes exist: the install damaged the contract, or your template clone is newer than the install (contracts do change). Compare the `commit=` in `wheelhouse/.template-source` against the template's HEAD to tell which: same commit → damaged, stop and repair; older commit → you are behind, and the README's upgrade note applies. Every other check in this list can pass on a file whose contract you deleted — this is the only one that looks.

- **Check `GRAPH.md`'s version-stamped claims against the CLI you actually have.** It states that this build has no `in_review` status, so the review queue is a `needs-review` label instead.

  `bd --help` cannot answer this — it lists commands, and `bd update --help` shows `--status` without enumerating its values. Two things that can:

  ```bash
  bd list --help | grep -i status     # the --status filter enumerates the valid statuses
  bd update <some-id> --status in_review   # expect an "invalid status" error
  ```

  **Read the error text, not the exit code.** This build prints `invalid status: in_review` and then exits 0, so an exit-code check concludes the opposite of the truth. That is a defect in the tool, not in your reading.

  If your build does enumerate `in_review`, correct `wheelhouse/GRAPH.md` now and say so in the hand-back. The file says it is stamped rather than eternal, and an install is the moment to check.

- `bd ready` — returns without error. On an empty graph this prints nothing, which is indistinguishable from a broken install, so prove the graph round-trips instead: create a real first bead, list it, and leave it in place as the fleet's first piece of work.

  ```bash
  bd create "Implement wheelhouse/crew/bench.sh against wheelhouse/crew/BENCH.md" -p 1 \
    --description="The bench ships as a stub that exits non-zero. Until it is implemented, no APPROVE may claim this project's software runs. Acceptance: the eight clauses in wheelhouse/crew/BENCH.md."
  bd ready          # must now list that bead
  ```
- A grep of the files you generated for the template's specimen strings. Scope it to the install — `CLAUDE.md` and `wheelhouse/`, excluding `.beads/` — and use word boundaries, or the specimen name matches inside ordinary words:

  ```bash
  grep -rnwE "Ebb|ebb|cordova|emulator|app-review|com\.example\.app" \
    CLAUDE.md AGENTS.md wheelhouse/
  ```

  **Expect zero hits.** If specimen strings appear in the project's files, the install leaked and must be fixed before you report success. `AGENTS.md` is in scope because you edited it too.

  Those terms come from the template's own `generated/` specimens (the invented project) and `examples/` (the one worked example). If you are reading this in a template whose specimens have changed, the list is stale — check what `generated/` and `examples/` actually contain and grep for that instead. A hardcoded list that no longer matches the specimens passes everything.
- A grep for unfilled placeholders. Anything you leave for the principal to fill uses `{{DOUBLE_BRACE}}` and nothing else, so this check is exact:

  ```bash
  grep -rn "{{" CLAUDE.md wheelhouse/
  ```

  Expect zero. The HTML comments in the contracts' `## This project` sections are guidance, not placeholders, and do not count here.

  What to do with them: **when you have content for a section, REPLACE its comment with that content. When you have nothing, leave the comment where it is.** The comment is a prompt for whoever fills the section later, so it stops being useful the moment the section is filled — and a section carrying both guidance and content reads as though the content is an example of what to write.
- **Confirm the bench stub fails.** It is the one file whose whole job is to exit non-zero:

  ```bash
  bash wheelhouse/crew/bench.sh; echo "bench stub exit=$?"   # must be non-zero
  ```

  A stub that exits 0 would let the first behavioral APPROVE through on nothing.

- Confirm `wheelhouse/runbooks/` contains both runbooks. `SEATS.md` and `STARTUP.md` link to them by path, and a missing runbook is a broken link at the moment someone needs it.

- Confirm every file you created exists and is non-empty.
- Print the resulting tree.

## 7. Commit

Commit the install so the principal can see exactly what was added and revert it in one step:

```bash
git status --short          # look first: bd init may have added files you did not expect
git add CLAUDE.md AGENTS.md .gitattributes wheelhouse/ .beads/
git commit -m "Install the wheelhouse: contracts, briefs, and the work graph"
```

`bd init` also writes `.gitattributes` (it sets up merge behaviour for the graph). Include it, or the next clone loses that behaviour silently.

Inside `.beads/` there is a JSONL file and a database. The JSONL is the durable, diffable record and is the one that matters in git; the database is a local cache rebuilt from it. Committing the directory as a whole is fine and is what the tool expects. Commit `.beads/` unless the principal says otherwise. The graph is the project's work state, it is meant to be shared between seats and to survive a fresh clone, and a graph that lives only on one machine is not a single source of anything. If the principal prefers it untracked, add it to `.gitignore` and say what that costs.

Do not push. Pushing is a principal-only action, here and in every wheelhouse.

## 8. Hand back

Tell the principal plainly:

- what exists now;
- what is deliberately STUBBED and therefore not yet true — `crew/bench.sh`, the empty gotchas section, the ISA's empty claims;
- the three next actions: file the first beads, implement the bench against `crew/BENCH.md`, launch seats per `STARTUP.md`.

## Failure behavior

Any step that cannot complete: stop, and report where you got to and what blocked you. Do not improvise around it, and do not report success on a partial install.

A half-installed wheelhouse that claims to be finished is worse than no install, because the next session inherits it as if it were sound.
