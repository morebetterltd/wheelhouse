# Bootstrap procedure

You are installing a wheelhouse — a standing agent fleet over a shared work graph — into the user's project. You are talking to the PRINCIPAL: the person who owns this project and whose judgment the fleet defers to.

Work in this order. Do not reorder, and do not write anything before the interview in step 4 is answered.

## 0. Before anything writes — the tools this needs, and what was here before you

Two observations, both taken before anything writes: the binaries this procedure depends on, and the state of the project as you found it. They share a step because they share that property — each is cheap now and expensive or impossible later.

### 0a. The tools this procedure needs

This procedure, and the runbooks and contracts it installs, invoke a handful of binaries. Someone installing on their own machine for the first time has no reason to already have them, and a missing one surfaces halfway through as a bare `command not found` — at which point part of the install exists and part does not, which is the state this whole document is written to avoid.

It runs before step 1 rather than alongside it, even though step 1 is where the "verify before you trust it" rule lives, because the clone step 1 is about to verify was made by `git`, and a missing `bd` is cheaper to find now than after the interview. This part writes nothing, so re-running it costs nothing either.

Four are worth checking. Everything else the procedure runs — `sed`, `grep`, `diff`, `cp`, `mv`, `find`, `mktemp`, `date`, `basename`, `cut`, `ls`, `xargs`, `ps`, `tail`, `printf`, `rm`, `mkdir`, `cat`, `env` — is the POSIX baseline that ships with macOS and every Linux. Checking for those would fail nothing and teach installers to skip the block, which is the same reason step 1 checks the contracts by name rather than counting them.

Deliberately NOT on the list: `gh`. Nothing in `BOOTSTRAP.md`, `runbooks/` or `contracts/` invokes it — measured by grep, not assumed — so do not install it on this file's account. If you add a tool to the list, measure the same way: the list is only worth what it was checked against.

Also deliberately NOT on the list, for a different reason: `claude`. The contracts do invoke it, but only in `contracts/SEATS.md`'s launch procedure and only once someone takes a seat — and an install that declines every seat is a legitimate install whose principal may never run a CLI session. Checking it here would block that install on a tool it never uses, so the check lives at the first moment something actually runs the binary, in that procedure. This sentence exists so the decision is readable in the file rather than only in whoever made it.

```bash
# Positional parameters, not a whitespace-split string: zsh does not word-split an
# unquoted variable, so a `for t in $TOOLS` loop there runs ONCE over the whole list
# and reports one nonexistent tool while checking none of them. "$@" iterates
# identically in bash and zsh -- the same reason step 6's integrity check uses it.
# Each entry is tool:why:how; only the first two colons are separators, so `how` may
# contain a URL and `why` may not contain a colon.
set -- \
  "git:clones the template, and carries every branch, worktree and merge the fleet runs on:brew install git   # macOS also ships one with the Xcode command line tools" \
  "bd:is the work graph -- every unit of work the fleet holds lives in it:brew install beads   # or see https://github.com/gastownhall/beads" \
  "bash:runs wheelhouse/crew/bench.sh, which ships with a bash shebang and is invoked as bash in step 6:preinstalled on macOS and every Linux; brew install bash for a current one" \
  "awk:splits each contract into its contract half and its project half -- step 6's integrity check and runbooks/UPGRADE.md's splice both depend on it:preinstalled on macOS and every Linux"

MISSING=0
for entry in "$@"; do
  tool=${entry%%:*}; rest=${entry#*:}; why=${rest%%:*}; how=${rest#*:}
  if command -v "$tool" >/dev/null 2>&1; then
    echo "OK      $tool — $(command -v "$tool")"
  else
    echo "MISSING $tool"
    echo "        the wheelhouse needs it because it $why"
    echo "        install it: $how"
    MISSING=1
  fi
done

if [ "$MISSING" -eq 0 ]; then
  echo "PREFLIGHT OK — every dependency is on PATH"
else
  echo "PREFLIGHT FAILED — install what is named above, then re-run this block"
  exit 1
fi
```

**A MISSING line is a STOP.** Install what it names and re-run the block; do not proceed on the assumption that the step needing that tool is one you can work around. `brew` is named because it covers the machines this template has been installed on; if you are on a platform it does not cover, install the tool the way that platform does and say which way in your hand-back, rather than adapting the line above silently.

Then record the versions, because two of the things you will check later are stamped against particular builds rather than against the tools in general:

```bash
git --version
bd --version
```

`wheelhouse/GRAPH.md`'s claims about the work graph's CLI were measured on bd 1.2.2, and step 6 re-verifies them against whatever you have. Print the version here so that step has something to compare against, and so a later reader can tell which build this install was made on.

### 0b. What was here before you — the survey that cannot be taken later

Take this from the project directory you are installing into, not from the template clone. If you are not standing in it yet, go there first: a survey of the wrong directory returns a clean answer about a project nobody is installing into.

- **STOP IMMEDIATELY, without writing anything, if `wheelhouse/` or `CLAUDE.md` already exists here.** Say what exists and ask the principal what to do. Overwriting a principal's `CLAUDE.md` is unrecoverable.
- **If neither exists, say so out loud.** That sentence is the record every later step reads. This procedure creates both names itself — the `wheelhouse/` directory step 1 makes for `.template-source`, and the `CLAUDE.md` that `bd init` writes in step 5 — and neither trips this check, because both appear after this survey. That is the whole reason the survey lives here and not further down: seeing those files at step 2 or step 6 tells you nothing, and seeing them now tells you everything.

This is the one observation in the procedure that expires. Every other check can be re-run at any point and give the same answer; this one is about a state that step 1 destroys. If you find yourself past step 1 having never taken it, the cheap answer is gone — ask the principal directly, and read `git log --oneline -1 -- CLAUDE.md wheelhouse`, where a path with history predates you. An empty answer proves nothing in the other direction, since an untracked file that was already here has no history either.

## 1. Confirm you actually have the template

You are already following instructions from this clone, so verify it before trusting any more of it. This comes before the project checks deliberately: everything below depends on these files being real, and a wheelhouse installed from an empty clone is worse than no install.


You were told to clone this repo into a temporary directory. Before you read another word of it, confirm the clone produced something:

- `$TEMPLATE/BOOTSTRAP.md`, `$TEMPLATE/contracts/` and `$TEMPLATE/contracts/WORKER.md` all exist and are non-empty.
- All eight contract files are present — seven briefs plus the bench stub:

  ```bash
  for f in WORKER.md SEATS.md REVIEWER.md DESIGNER.md BENCH.md GRAPH.md INTEGRATOR.md bench.sh.stub; do
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
  echo "namespace="
} > wheelhouse/.template-source
cat wheelhouse/.template-source
```

`namespace=` is written empty here and filled in step 5, because its value comes from the interview that has not happened yet. It is this project's seat namespace, and it is in this file rather than in a file of its own because `runbooks/wire-seats.sh` reads it — the one seat value a program consumes rather than a human, and the one nobody should have to remember to pass.

Every later step reads `path=` out of that file rather than trusting `$TEMPLATE` to still be set:

```bash
TEMPLATE=$(sed -n 's/^path=//p' wheelhouse/.template-source)
```

**`path=` is the one field that is expected to die, and that is a decision rather than an oversight.** The README has you clone into `mktemp -d`, so the path you just recorded points into a directory the OS reclaims — routinely before the first upgrade wants it. A durable clone kept beside the project was the alternative and was not taken: it is a second copy of the contracts that ages silently, and every reader who finds it then has to work out whether it or `commit=` is the truth. `source=` and `commit=` are the durable half, and step 6's integrity check re-clones from `source=` the moment it finds the path dead — the same recovery `runbooks/UPGRADE.md` needs anyway, so the temporary path costs a clone at the moment of use rather than a stale directory for the life of the project. Record it, and expect it to be gone later.

`installed=` records when this project first installed and is never rewritten afterwards; `upgraded=` is the one an upgrade updates. The `commit=` line is the provenance record. It is what tells a future reader which version of the contracts this project installed, and it is the baseline the upgrade path in the README compares against. Without it, "re-copy the contracts" has nothing to diff from.

**A clone of an empty or unpushed repository exits 0.** It creates the directory, prints nothing alarming, and leaves you with nothing to install. If the files above are missing, STOP and tell the principal the template is empty or unreachable — do not proceed, and do not reconstruct the contracts from memory or from this document. A wheelhouse whose contracts were invented by the installer is worse than no wheelhouse, because it looks like the real thing.

## 2. Preflight — verify the project, then report what you found


- Confirm the current directory is a git repository, and say which directory you are about to install into. Let the principal correct you before you continue. A correction here means step 0b surveyed the wrong directory and step 1 wrote into it — say so, and take the survey again in the directory you have just been given.
- Step 0 established that `bd` is on PATH and printed its version. Carry that version forward rather than re-deriving it; if you skipped step 0, go and run it now instead of checking `bd` alone here, because it is not the only tool that has to be there.
- Report uncommitted changes if there are any. Do not block on them; the principal may be mid-work.
- **Report what step 0b's survey found** — whether `wheelhouse/` or `CLAUDE.md` was here before this install, which is the check that guards an unrecoverable overwrite. Carry the answer forward; do not re-derive it from what you can see now. Step 1 created `wheelhouse/` for `.template-source` and `bd init` will create `CLAUDE.md` in step 5, so the directory in front of you cannot answer the question any more. If you skipped step 0b, do not guess: go back and read its last paragraph, which says what to do once the cheap answer is gone.

## 3. Read before you ask

Survey the repository so your questions are informed: build and dependency files, language and framework, test setup, CI config, existing docs, whether there are multiple product repos beneath this root, and how the project is built and run.

Read the branch that merges target out of each repository rather than assuming it, once per product repo, because they need not agree. This is the one survey answer that gets written into several installed files at once, so a guess here is a guess repeated: an install that assumed `master` wrote it into three files, and it surfaced only when a worker ran a dispatch's read path and got `fatal: ambiguous argument 'master'`.

```bash
git -C <repo> branch --list                             # what actually exists
git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD   # if there is a remote
```

Ask the principal for the merge target and check the name you are given against that list. `branch --list` does not answer the question either — it returns the SET of branches that exist, and which one merges target is not a property of the repository. That is the point rather than a hedge: swapping one command for another would reproduce the same defect with better manners, because the failure was never the command, it was taking a value from a tool that was answering something adjacent. Note what `git -C <repo> symbolic-ref --short HEAD` does NOT tell you: it reports the branch currently checked out, which in a worktree is the worktree's own feature branch. Measured on one repository — `master` from its own checkout, `fleet/<bead-id>` from a worktree beside it, and nothing in either answer says which question was asked.

You are forming PROPOSED ANSWERS to step 4. Asking a principal what language their own project is in tells them you did not look.

## 4. Interview — propose, then confirm

Ask in as few turns as you can manage. Lead each question with your proposal from step 3, so the principal is correcting rather than composing.

1. **Product repos, and therefore the shape of this install.** "I see \<what you found\>. Are these the repos the fleet will change, and are they separate git repos from this root?"

   Two shapes, and the common one is the second:

   - **Umbrella root.** This directory is a container; the product lives in one or more separate git repos beneath it. The wheelhouse installs at the container root, the graph spans the repos below it, and workers create worktrees BESIDE the product repos at the container root (for example `<root>/.wheelhouse-worktrees/<bead-id>`), never inside them — same reason as the single-repo case below, and it also keeps the graph reachable from inside the worktree, which `contracts/GRAPH.md` explains (a worktree's `.git` is a file the workspace walk passes through; a nested repo's `.git` is a directory that stops it).
   - **Single repo.** This directory IS the product — one repo, no container. This is the ordinary case and it is fully supported: the wheelhouse installs at the product root, `CLAUDE.md` and `wheelhouse/` are committed alongside the code, and a worker's worktree is a SIBLING directory outside the repo (for example `../.wheelhouse-worktrees/<bead-id>`), so the worktree never nests inside the repo it is branching from.

   **When both shapes fit, one question decides it: is this repo something other people clone as-is?** A template, a starter kit, a library whose repository IS the deliverable — anything whose consumers take the working tree rather than a built artifact. If yes, install the umbrella shape even where a single repo would otherwise be the obvious call: this root becomes a container holding the fleet's machinery, and the consumer-facing repo stays pristine beneath it. The single-repo shape commits `CLAUDE.md` and `wheelhouse/` alongside the code, so everyone who clones receives the installer's fleet state — commander context written for one principal, an ISA stating one project's goal, a work graph of beads that are not theirs — and the first stranger who runs this procedure inside their clone trips step 0b's stop check on files they never wrote. Where single-repo is genuinely required, keep the install out of the tree with `.git/info/exclude` rather than `.gitignore`, and say plainly that it is machine-local: it is not itself committed, so a second seat cloning that repo has to repeat it. This template's own install took the umbrella shape for exactly this reason (2026-08-20) — the product is the wheelhouse template, and its consumers clone it.

   Say which shape you are installing, and record it in the worker's `## This project` section along with where worktrees go. A worker that guesses this wrong creates a worktree inside the repo and pollutes the very diff it is meant to produce.

2. **What "it runs" means.** Four questions, because `crew/BENCH.md` has five sections to fill and (b) fills two of them:

   a. "For a \<project type\>, I would prove a build works by \<your proposal: a server answers a health check; a CLI executes a real command against real input; an app installs and reaches its first screen\>. What is the observation that would convince you a build actually works?"

   b. "What does the bench need in order to do that — what artifact does it take, and what has to be set up and cleaned away around the assertion?" Ask both halves. A long-running target (a server, an emulated device, a container) has to be started and stopped. A one-shot artifact (a CLI, a library, a batch job) starts nothing, but it almost always needs something created for it to act on and removed afterwards — a scratch directory, a throwaway database, a copied input. Asking only about the target invites "nothing" from a principal whose bench does need a fixture, and the answer is then recorded as though the question had been the wider one.

   c. "When it goes wrong, what does that look like in the logs or output — what should the bench scan for and treat as failure?"

   d. "What does someone need installed or running before they can execute this bench at all?"

   `crew/BENCH.md` has five project sections and these four questions fill them; the fifth, the artifact, comes from (b). Do not fill a section the principal did not answer. The template's own rule is no invention: an unanswered section says so, and the stub keeps the reviewer honest until it is filled. If the principal cannot answer yet, record it as unanswered and continue — the bench ships as an explicit stub.

3. **First ideal state.** "What is true when this fleet's first iteration is done?" **DO NOT PROPOSE AN ANSWER.** This is the one thing only the principal knows, and a plausible suggestion gets accepted by default — after which the ISA states your goal rather than theirs.

4. **Principal-only actions.** Offer these defaults and ask them to amend: pushes to any remote, releases and deploys, credentials and signing, spending money, communication outside the team. Everything else the fleet may do within the project's permissions.

5. **Merge policy.** "Does a reviewer's APPROVE carrying bench evidence authorize a merge to your local main, or do you want to confirm each merge yourself?" **Default: the principal confirms each merge.** Say that auto-merge is a graduation documented in `runbooks/PROMOTION.md`, taken once the loop has been right on real merges — not a starting position.

6. **Priorities.** `wheelhouse/GRAPH.md` has a project section for what P0 to P3 mean here. Offer this default and ask them to amend rather than compose: **P0 blocks the fleet or has an external deadline; P1 is the core loop; P2 is maintenance; P3 is nice-to-have.** If they accept it unchanged, say so in the file — a scheme that was confirmed reads differently from one that was assumed.

7. **Seats — derive the namespace once, then walk the roster one seat at a time.** Do not offer a fleet shape and ask whether they want it. A roster proposed whole is accepted whole, and the seat that goes missing is the one nobody was asked about: today that is reliably the designer, because its absence looks like a smaller install rather than a gap.

   **The namespace comes first, because every seat name you are about to collect carries it.** Propose one — short, lowercase, filesystem-safe; this project's own directory name is almost always right — and say what it decides: this project's seat root is `$HOME/.claude-seats-<namespace>`, and every seat on the roster is named `<namespace>-<role>`. Ask them to correct the string, not to design the scheme.

   Say why, in one sentence, because a principal who does not know the reason will shorten it back out later: a machine can host more than one wheelhouse, and seats are the one thing two wheelhouses share by default. The root keeps their seat directories apart on disk, which is what stops one fleet's `wire-seats.sh` sweeping up another's; the name prefix keeps them apart in the commander's session registry, which is NOT per-project and is where a dispatch to `seat-worker-1` would otherwise land on whichever project's worker answered. A second wheelhouse installed on a machine that already ran one hit exactly this, 2026-08-22.

   **Derive it once and record it once.** The value is recorded as `namespace=` in `wheelhouse/.template-source` — that is the copy `wire-seats.sh` reads, which is why the operator never has to pass a seat root — and written out for humans in `wheelhouse/fleet/SEATS.md`'s `### Seat namespace`. Everything else is derived at the moment you write it: the roster's names and `wheelhouse/STARTUP.md`'s launch blocks. Ask a second time and you will get a second answer, and the surface that disagrees will be the one nobody reads until a seat cannot be reached.

   The commander is not on the list and is not a question. It is the principal's own session in the directory whose `CLAUDE.md` you are about to write, so it exists whether or not anyone names it. Say that, then take the rest individually — each answer is yes-with-a-count or no:

   - **Worker** — implements beads on branches, per `wheelhouse/fleet/WORKER.md`. "How many worker seats? One is the working minimum; a second goes in when the reviewer is idle waiting for work."
   - **Reviewer** — gates every diff before it merges and never reviews what it authored, per `wheelhouse/crew/REVIEWER.md`. "How many reviewer seats? One, until a single reviewer is the thing everything waits on."
   - **Designer** — decomposes goals into implementation-ready beads, per `wheelhouse/crew/DESIGNER.md`. Offer it out loud even when you expect a no: "Do you want a designer seat? It earns its place when you are spending more time decomposing work than deciding direction — otherwise you hold that yourself."

   For each seat also ask the name it answers to and the account it is pinned to, since one seat is one subscription and the roster records both. Propose the name already carrying the namespace — `<namespace>-worker-1` rather than `seat-worker-1` — so the prefix is a thing they correct rather than a thing you have to reconcile afterwards.

   How the principal's subscriptions get divided across several fleets on one machine is their call and not this procedure's. If they raise it, say so and move on; the seat-accounting rule constrains sharing a seat, not which wheelhouse a seat belongs to.

   **Write down the no's as well as the yes's.** A refused seat goes into `wheelhouse/fleet/SEATS.md` under `### Declined seats` with the principal's reason and the date. An absence on the page is the same absence whether the seat was refused or never raised, so only the recorded no answers "why is there no designer?" when it is asked six weeks from now.

   Declining every seat is a legitimate answer rather than a failed interview — the commander alone is a working install, and step 8 takes the worker seat itself for the first bead. Say so instead of pushing back.

   If the reviewer seat is among the declined, say in the same breath what review then looks like, so the answer is on the table now rather than a surprise when the first branch is ready: declining the seat declines a standing session, not the review itself. The solo path is in `wheelhouse/runbooks/RUNNING_THE_LOOP.md`, section "When one human holds every seat" — the principal reviews agent-authored changes, or a fresh session that did not author the change is dispatched as reviewer — and the author-review ban holds unchanged in every shape.

## 5. Write

- `bd init` in the project root; confirm the graph exists. Its output is verbose and mentions daemons, migrations and sync; that is normal and not an error. **Expect two side effects it does not ask about:** it creates config files well beyond `.beads/` (a `CLAUDE.md` at the root if none exists, `.claude/settings.json` with a SessionStart hook, `.codex/`, `.agents/`), and on recent builds it **commits them itself**, authored as the signed-in git user. Neither is an error. The `CLAUDE.md` it creates is a scaffold; the next steps write the commander content into that same file, keeping bd's managed block. Review its auto-commit rather than being surprised by it in `git log` later.

  What IS worth stopping for: a non-zero exit, a refusal to create `.beads/`, or a message naming a conflicting existing database. Anything else, run `bd doctor`, paste the output, and continue — but know that on bd builds using the embedded backend (the current default) `bd doctor` prints "not yet supported in embedded mode" and diagnoses nothing; that message is itself a normal result, not a failure. Treat any upgrade suggestions as advisory.

- **Reconcile `AGENTS.md` — conditionally.** `bd init` writes an `AGENTS.md` at the root. On some bd builds its session-completion section mandates pushing ("work is NOT complete until `git push` succeeds", "NEVER stop before pushing"); on current builds it is conservative and says the opposite ("Do not commit or push without clear authority"). **Read the file bd actually wrote before acting**, because one sentence of what you append depends on which one you have.

  Keep bd's useful content — the command reference is genuinely handy — and override the mandate. Append this to `AGENTS.md` in every case, unchanged:

  ```markdown
  ## This project runs a wheelhouse — the rules above are overridden

  `CLAUDE.md` at this root and `wheelhouse/fleet/WORKER.md` govern. Where they and
  the section above disagree, they win.

  Specifically: **do not push.** Pushing to any remote is a principal-only action
  here. A worker's output is a reviewable branch, and work is complete when it is
  committed locally and reported with evidence — not when it is pushed.

  The bd command reference above is accurate and worth keeping.
  ```

  Then, **only if the file bd wrote mandates pushing**, append this one line after that block:

  ```markdown
  Ignore "landing the plane" as written above; land it by reporting.
  ```

  It is a second append rather than a line struck out of the first, because the conditional half is the half installers get wrong: a paste-then-delete leaves two installers on the same branch with different files, and an override quoting "landing the plane" into a conservative `AGENTS.md` that never says it reads as an error to the next person who checks. Appending nothing is an easier instruction to follow exactly than deleting something.

  Say plainly in your hand-back that you did this and why. A principal who later reads `AGENTS.md` unaware of the override will be confused by it, and the fleet's behaviour will look like disobedience rather than policy.
- Create `wheelhouse/crew/` and `wheelhouse/fleet/`.
- Copy **verbatim** from the template's `contracts/`:
  - `WORKER.md` and `SEATS.md` into `wheelhouse/fleet/`
  - `REVIEWER.md`, `DESIGNER.md`, `BENCH.md` into `wheelhouse/crew/`
  - `GRAPH.md` and `INTEGRATOR.md` into `wheelhouse/`
  - the whole `runbooks/` directory into `wheelhouse/runbooks/`. `SEATS.md` and `STARTUP.md` both point at these by path, and a runbook that is only in the template is a broken link in the project. It holds two executable scripts as well as prose — copy in a way that keeps the executable bit (`cp -R` does; a file-by-file rewrite may not), because `wire-seats.sh` is run as a command by a human following `SEAT_DISCOVERY.md`, not sourced.
  - `bench.sh.stub` to `wheelhouse/crew/bench.sh`, executable, unchanged — **it exits non-zero on purpose.** A stub that exits 0 lets the first APPROVE through on nothing.
- To be unambiguous about what "verbatim" means here: you copy the whole file, then append or fill ONLY below the `## This project` heading. Copying verbatim and filling the project section are the same operation, not competing instructions.
- **Do not edit a single line of any `## Contract` section.** They are identical in every project by design; a project that edits its contract has forked from every other one silently.

**How to fill a `## This project` section, precisely.** Find the FIRST line in the file that is exactly `## This project` — the whole line, nothing else on it. FIRST, not last: the integrity check below and `runbooks/UPGRADE.md` both stop at the first match, and a last-match rule would absorb project content into the contract half the moment a project section legitimately quotes that heading. Everything above that line is the contract and is not yours to touch; everything below it is yours to write. Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A contract may legitimately discuss its own structure, and a naive match has already destroyed one contract file this way — deleting a licensing-compliance rule while every automated check still passed.
- Fill each file's `## This project` section from the interview: the designer's territory, the worker's repos and its empty gotchas section, the reviewer's branch and worktree conventions, the bench's run-proof, and the integrator's push authority — the last in the principal's own words, with the date, because it is the one section that records a permission rather than a fact.
- **The bench's five sections come from four answers — hold the mapping here, at the moment of writing, rather than recalling step 4's version of it.** Q2(a) fills *What proves it did its job*. **Q2(b) fills TWO**: the artifact half of the answer goes in *What the artifact is*, the setup-and-teardown half in *What is set up and torn down around the assertion*. Q2(c) fills *What the error scan looks for*, and Q2(d) fills *Prerequisites*. The two-for-one is what a writer loses between reading the question and filling the file, and the section that then goes unwritten is the artifact — which is clause 2's whole subject and the one thing a verdict has to name. A section the principal did not answer is recorded as unanswered, here as everywhere; what this bullet prevents is a section left empty because the answer was given and filed under the other heading.
- The integrator's third section, "How a shipped record gets corrected here", has no interview question on purpose: unless the principal volunteers a convention, fill it with the contract's own default — a follow-up commit naming the corrected commit's identifier, history never rewritten — and label it "adopted from the contract's default" so a later principal knows it was a default rather than their decision. Two cold installs both had to guess this; the default they guessed is now the documented one.
- **Record the namespace in `wheelhouse/.template-source` FIRST, before any file that derives from it.** It is the machine copy — `runbooks/wire-seats.sh` reads it one level up from itself and needs nothing passed to it — and it is what you read back when you write the files below, so that they are copies of a record rather than three recollections of a conversation.

  ```bash
  sed -i.bak "s|^namespace=.*|namespace=<the namespace>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
  grep '^namespace=' wheelhouse/.template-source     # read it back; this value is what the files below quote
  ```

  An install upgrading over a `.template-source` that has no `namespace=` line at all — every install predating this field — appends one instead; `runbooks/UPGRADE.md` step 7 covers that case.
- Fill `wheelhouse/fleet/SEATS.md`'s `## This project` section from question 7's answers, **all three parts**. `### Seat namespace` first, because the other two are derived from it: the namespace string and the seat root it names, `$HOME/.claude-seats-<namespace>`. This is the human record of the value you just recorded above; the two must say the same string and `.template-source` decides, because it is the copy a program acts on. Every other seat-naming surface you are about to write — the roster's names, `wheelhouse/STARTUP.md`'s `CLAUDE_CONFIG_DIR` lines — is written FROM it rather than alongside it. Write the section before the roster and read it back when you write STARTUP.md; a second recollection of a value you already recorded is how the two come to disagree. Then **both halves of the roster**: one roster line per seat that was taken, carrying its namespaced name, and one line under `### Declined seats` per seat that was refused, carrying the reason in the principal's words and the date. A roster listing only what was taken is indistinguishable from one where the question was never asked, which is the reason the interview walks the seats individually in the first place. If every seat was declined, the roster holds the commander line alone and the declined section holds the rest — that is a filled section, not an empty one. Its `## Contract` section — which carries the seat-accounting rule — is copied verbatim like every other contract.
- Write `CLAUDE.md` at the root: commander-session context, product changes happen in product repos via workers, new work becomes a bead immediately, deadline beads outrank everything, plus the principal-only actions from Q4 and the merge policy from Q5.
- Write `wheelhouse/ISA.md`: the goal from Q3, empty claims, empty decisions, and any anti-claims stated. **Do not invent claims.** An ISA with fabricated claims is worse than an empty one.
- Write `wheelhouse/STARTUP.md`: this project's cold-start card. It is what step 8 and the commander point at when it is time to actually start a session, so its job is to resolve rather than to restate — the launch MECHANICS live in `wheelhouse/fleet/SEATS.md`'s "Launching a seat" section, identically in every project, and this file is where those mechanics meet this project's real root path and real seat names. Four things, in this order, and none of them optional:

  1. **The commander.** `cd` to this project's real absolute root, then `claude`. Say that the folder's `CLAUDE.md` is what makes that session the commander, so no launcher is needed.
  2. **One block per seat on the roster**, using that seat's real name, this project's real seat root and this project's real project root — the `export CLAUDE_CONFIG_DIR=...` line, the foreign-directory check that follows it, then `cd` and `claude`, all from the launch procedure with the placeholders already substituted, so the principal can paste rather than translate. Take the seat root and the names from `### Seat namespace` and `### Roster` in the file you have just written, not from your memory of the interview. **Carry the foreign-directory check into every block rather than mentioning it once**: it is three lines, it is the only thing standing between a paste and adopting another fleet's seat, and a check that lives one paragraph away from the command it guards is a check that gets pasted around. Say what a non-empty result means — any project root other than this one is a STOP. Then point at `wheelhouse/fleet/SEATS.md` by name for what those lines mean, the login-per-account rule, the standing prompt to paste, and what the seat does next. **Copy no seat name that is not on the roster**, and if the roster took no seats, say that in place of this section rather than inventing a specimen seat.
  3. **Discovery, then the roll call.** `wheelhouse/runbooks/wire-seats.sh` — with this project's real root in the `cd`, and nothing else, because the script derives its seat root from the `namespace=` you recorded — run by the principal after launching or relaunching any seat, then a commander roll call before it dispatches anything, then each seat messaging the commander unprompted to prove the reverse leg. Say that the script prints which root it used and refuses the run outright if a seat in scope belongs to another project on this machine, so a refusal is the guard working rather than the install being wrong. Point at `wheelhouse/runbooks/SEAT_DISCOVERY.md` for what those three steps mean, why a round trip is not the check, and what the roll call asserts about ambiguous names. An unwired seat looks exactly like an idle one, and an un-rolled fleet is reachable but anonymous.
  4. **How work reaches the fleet** — the principal speaks backlog items to the commander, which files them as beads — and that shutdown is closing the terminals, because in-flight work resumes from the graph.

  Do not reproduce the launch procedure's prose here. A second copy of a contract's text in a generated file is a copy that drifts, and this one would drift in every project separately.

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

  # The pair list is positional parameters, not a whitespace-split string:
  # zsh (the macOS default shell) does not word-split an unquoted variable, so a
  # `for pair in $PAIRS` loop there runs ONCE over the whole list, diffs the wrong
  # files, and leaves six of seven contracts unchecked while exiting 0. "$@" iterates
  # identically in bash and zsh. Found by a cold install run in zsh, 2026-08-20.
  set -- \
    fleet/WORKER.md:WORKER.md fleet/SEATS.md:SEATS.md \
    crew/REVIEWER.md:REVIEWER.md crew/DESIGNER.md:DESIGNER.md \
    crew/BENCH.md:BENCH.md GRAPH.md:GRAPH.md INTEGRATOR.md:INTEGRATOR.md
  FAILED=0

  for pair in "$@"; do
    installed="$ROOT/wheelhouse/${pair%%:*}"; template="$TEMPLATE/contracts/${pair##*:}"
    test -s "$installed" || { echo "FAIL ${pair%%:*} — installed file missing or empty"; FAILED=1; continue; }
    # the contract is everything above the FIRST exact '## This project' line
    awk '/^## This project$/{exit} {print}' "$installed"  > /tmp/wh-a.$$
    awk '/^## This project$/{exit} {print}' "$template"   > /tmp/wh-b.$$
    if diff -q /tmp/wh-a.$$ /tmp/wh-b.$$ >/dev/null; then
      echo "OK   ${pair%%:*}"
    else
      echo "FAIL ${pair%%:*} — contract differs from the template:"; diff /tmp/wh-b.$$ /tmp/wh-a.$$; FAILED=1
    fi
    rm -f /tmp/wh-a.$$ /tmp/wh-b.$$
  done

  # Every contract the TEMPLATE ships must appear in the list above. Derived from
  # the directory, not from a second list, because a list that has to be kept in
  # step with another list is the thing being guarded against.
  for f in "$TEMPLATE"/contracts/*.md; do
    b=$(basename "$f"); seen=""
    for pair in "$@"; do [ "${pair##*:}" = "$b" ] && seen=1; done
    [ -n "$seen" ] || { echo "FAIL $b — present in the template but checked by nothing above"; FAILED=1; }
  done

  # Each installed contract must still have BOTH halves. The loop above compares
  # contract halves and is blind to a project half that went missing.
  for pair in "$@"; do
    installed="$ROOT/wheelhouse/${pair%%:*}"
    grep -qx '## This project' "$installed" 2>/dev/null \
      || { echo "FAIL ${pair%%:*} — no '## This project' heading; the project half is gone"; FAILED=1; }
  done

  # The exit status must agree with the FAIL lines. Before this summary the block
  # printed FAILs and exited 0, so "stop if it fails" could only be judged by
  # reading output — an instruction no script can follow.
  if [ "$FAILED" -eq 0 ]; then echo "INTEGRITY OK — all contracts verified"; else echo "INTEGRITY FAILED — see FAIL lines above"; exit 1; fi
  ```

  Three guards, one list. The pair list is the single registration that matters, and the two loops after it derive from the template directory rather than from a second list — a list kept in step with another list is the thing being guarded against. Together they close the chain: a contract the template ships must appear in the list, a contract in the list must be installed, and an installed contract must still have both halves. Every link says something when it breaks, which was not true before: a contract registered nowhere used to produce a completely clean run.

  A `FAIL` means the installed contract differs from your template source — it does not say why. Two causes exist: the install damaged the contract, or your template clone is newer than the install (contracts do change). Compare the `commit=` in `wheelhouse/.template-source` against the template's HEAD to tell which: same commit → damaged, stop and repair; older commit → you are behind, and the README's upgrade note applies. Every other check in this list can pass on a file whose contract you deleted — this is the only one that looks.

- **Check `GRAPH.md`'s version-stamped claims against the CLI you actually have.** It states that this build has no `in_review` status, so the review queue is a `needs-review` label instead.

  `bd --help` cannot answer this — it lists commands, and `bd update --help` shows `--status` without enumerating its values. Two things that can:

  ```bash
  bd list --help | grep -i status     # the --status filter usually enumerates them
  bd list --status in_review          # expect an "invalid status" error naming the valid ones
  ```

  The second is the better probe — it needs no issue id and changes nothing — and the two do not agree: on bd 1.2.2 the `--status` filter help names five statuses while the rejection names seven, adding `pinned` and `hooked`. Trust the rejection.

  **Read the error text, and treat the exit code as a separate question.** On bd 1.2.2 an invalid status exits non-zero, so the exit code is trustworthy here. On builds before 0.57.0 the same command printed the error and exited 0, so an exit-code check concluded the opposite of the truth. Establish which you have rather than assuming. **If your build differs from what the contract stamped — a different exit code, a different status list — write one line under `### CLI build notes` in `wheelhouse/GRAPH.md`'s `## This project` half saying the build, what you ran, what it did, and the date. If it matches, there is nothing to note** — the stamp already says so, and an entry recording agreement is noise the next reader has to re-verify.

  If your build enumerates `in_review`, or lets you configure it — bd 1.2.2 does, via `bd config set status.custom` — correct `wheelhouse/GRAPH.md` now and say so in the hand-back. The file says it is stamped rather than eternal, and an install is the moment to check.

- `bd ready` — returns without error. On an empty graph this prints nothing, which is indistinguishable from a broken install, so prove the graph round-trips instead: create a real first bead, list it, and leave it in place as the fleet's first piece of work.

  **The bead carries the label `wheelhouse-bootstrap`, and that label is how step 8 finds it again.** Step 8 dispatches this bead minutes from now and has to pick it out of whatever else the graph holds; matching on its title, or on it being the only ready bead, works on an empty graph and nowhere else — a wheelhouse gets installed into projects that were already tracking their work here. The label is documented in this file rather than in `wheelhouse/GRAPH.md` because it is not a fleet signal: `GRAPH.md`'s `needs-review` marks a queue every bead passes through for as long as the fleet runs, while this marker is written by step 6, read once by step 8, and never used again.

  **Look before you create — this is a step re-runs and upgrades repeat.**

  ```bash
  bd list --label wheelhouse-bootstrap --all
  ```

  If that names a bead, the bench bead already exists: create nothing, say which bead it is and what state it is in, and move on. A second one is worse than none, because two beads carrying the same marker put step 8 back to choosing, which is the whole thing the marker removes.

  If it prints `No issues found`, look once more before you conclude the bead is absent. An install made from a template older than this marker left a bench bead with no label on it, and the label filter cannot see it — `bd list --all` and read the titles. If one is there, stamp it rather than duplicating it, and say you did:

  ```bash
  bd update <id> --add-label wheelhouse-bootstrap
  ```

  Only when nothing answers to either:

  ```bash
  bd create "Implement wheelhouse/crew/bench.sh against wheelhouse/crew/BENCH.md" -p 1 \
    --labels wheelhouse-bootstrap \
    --description="The bench ships as a stub that exits non-zero. Until it is implemented, no APPROVE may claim this project's software runs. Acceptance: the eight clauses in wheelhouse/crew/BENCH.md."
  bd ready                                 # must now list that bead
  bd ready --label wheelhouse-bootstrap    # must list that bead and nothing else
  ```

  Two things measured on bd 1.2.2, both of which turn a check into a no-op if you assume otherwise: `bd list --label` hides closed issues unless `--all` is given, so an install upgrading over a graph whose bench bead was already implemented and closed reads as a graph with no bench bead at all and files a duplicate; and an empty result exits 0, so the answer is in the text rather than the exit status. Establish both against the build you have.
- A grep of the files you generated for the template's specimen strings. Scope it to the install — `CLAUDE.md` and `wheelhouse/`, excluding `.beads/` — and use word boundaries, or the specimen name matches inside ordinary words:

  ```bash
  grep -rnwE "Ebb|ebb|Tideline|tideline|cordova|emulator|app-review|com\.example\.app|learn what a good one looks like|take it when the reviewer starts waiting" \
    CLAUDE.md AGENTS.md wheelhouse/
  ```

  **Expect zero hits.** If specimen strings appear in the project's files, the install leaked and must be fixed before you report success. `AGENTS.md` is in scope because you edited it too.

  Those terms come from the template's own `generated/` specimens (the invented project) and `examples/` (the worked benches, which use invented projects of their own). If you are reading this in a template whose specimens have changed, the list is stale — check what `generated/` and `examples/` actually contain and grep for that instead. A hardcoded list that no longer matches the specimens passes everything.

  The first eight terms are names from the invented project, so any wholesale copy of a specimen trips them. The last two are the reason texts from the declined-seats rows in `generated/SEATS.md.example`: a copy of just those two rows carries no project name, so the eight would match nothing and a partial leak of that section would walk through. They are phrases rather than words because every WORD in those rows — designer, worker, reviewer, second — is one a correct install writes for itself. For the same reason the roster seat names are deliberately absent: they are plausible real choices, and grepping for them would fail correct installs.

  Deliberately NOT in the list: "spending more time decomposing beads than deciding direction", which reads as the most distinctive line of that specimen and is not — `runbooks/PROMOTION.md` carries it verbatim, and runbooks are copied into every install, so adding it would fail every correct install on a file the installer never wrote. Any term you add here has to be checked against the template's `runbooks/` and `contracts/`, not only against `generated/`.
- A grep for unfilled placeholders. Anything you leave for the principal to fill uses `{{DOUBLE_BRACE}}` and nothing else, so this check is exact:

  ```bash
  grep -rn "{{" CLAUDE.md wheelhouse/ | grep -v "^wheelhouse/runbooks/"
  ```

  Expect zero. The HTML comments in the contracts' `## This project` sections are guidance, not placeholders, and do not count here. `runbooks/` is excluded deliberately: runbooks are copied verbatim and legitimately ship placeholders that get filled at their own moment of use, not at install — `SEAT_DISCOVERY.md`'s `{{SEAT_NAMES}}` is filled at promotion, from the roster in `fleet/SEATS.md`. Before this exclusion the check failed on every correct install, on a file the installer never authored.

  What to do with them: **when you have content for a section, REPLACE its comment with that content. When you have nothing, leave the comment where it is.** The comment is a prompt for whoever fills the section later, so it stops being useful the moment the section is filled — and a section carrying both guidance and content reads as though the content is an example of what to write.
- **Confirm the bench stub fails.** It is the one file whose whole job is to exit non-zero:

  ```bash
  bash wheelhouse/crew/bench.sh; echo "bench stub exit=$?"   # must be non-zero
  ```

  A stub that exits 0 would let the first behavioral APPROVE through on nothing.

- Confirm `wheelhouse/runbooks/` contains every runbook the template ships — count them in the template rather than trusting this sentence (currently four: `PROMOTION.md`, `RUNNING_THE_LOOP.md`, `SEAT_DISCOVERY.md`, `UPGRADE.md`) — plus the two scripts that ship alongside them, `wire-seats.sh` and `wire-seats.selftest.sh`, both of which must still be executable:

  ```bash
  ls -l wheelhouse/runbooks/wire-seats.sh wheelhouse/runbooks/wire-seats.selftest.sh   # both must show x
  ```

  `SEATS.md` and `STARTUP.md` link to these by path, and a missing runbook is a broken link at the moment someone needs it. A script that arrived without its executable bit fails at the moment a seat cannot be reached, which is the worst moment to be debugging a file mode.

- **The seat namespace agrees with itself across the three places it appears.** It was one answer at the interview and is now a machine record, a human record and a set of seat names, and nothing so far has compared them. Skip this only if the roster took no seats — with no seats there is nothing to name.

  ```bash
  NS=$(sed -n 's/^namespace=//p' wheelhouse/.template-source)
  test -n "$NS" || echo "FAIL no namespace= recorded in wheelhouse/.template-source"
  grep -q "$NS" wheelhouse/fleet/SEATS.md || echo "FAIL SEATS.md does not carry the namespace '$NS'"
  awk '/^### Roster$/{f=1;next} /^### /{f=0} f' wheelhouse/fleet/SEATS.md | grep '`'
  ```

  Read that last listing rather than counting it: every seat name it prints, the commander line excepted, should begin with the namespace. A roster whose names do not carry it is an install where the prefix half of the scheme is absent, and the absence is invisible until two fleets share a machine.
- Confirm every file you created exists and is non-empty.
- Print the resulting tree.

## 7. Commit

Commit the install so the principal can see exactly what was added and revert it in one step:

```bash
git status --short          # look first: bd init may have added files AND a commit you did not expect
# Stage each install path ONLY if that status output actually shows it. bd commits some of
# them itself (.beads/ routinely, and current builds also .claude/, .codex/, .agents/), and an
# install kept out of the tree with .git/info/exclude shows none of them.
for p in CLAUDE.md AGENTS.md wheelhouse/ .beads/; do
  if [ -n "$(git status --short -- "$p")" ]; then git add -- "$p"; fi
done
git status --short          # read what is staged; if nothing is, there is no commit to make
git commit -m "Install the wheelhouse: contracts, briefs, and the work graph"
```

The loop is the rule below — "never `git add` a path you have not seen in the status output" — written as something you can run, and it is a loop rather than one `git add` line because `git add` is atomic: a single absent pathspec fails the whole command having staged nothing. It is an `if` rather than an `&&` chain because the chain form reports the healthy path as a failure. A loop's exit status is its last iteration's, and `guard && git add` exits non-zero whenever that guard is false — so an install with nothing left to stage, which is the ordinary outcome when bd has already committed `.beads/`, ends on a non-zero status and any caller, CI step or wrapper that reads it calls the install failed. Measured at exit 1 in that state under bash, zsh and sh; the `if` form exits 0 in every state. It does NOT abort a `set -e` script mid-run — `A && B` is an AND-OR list, which `set -e` exempts, and execution continues past the false guard in all three shells. The list is a list of CANDIDATES; status decides. Anything else this install wrote — a `.gitattributes` bd added, a `.gitignore` you appended to below — you add to the candidate list yourself after seeing it in that first status.

**Not every install commits.** If step 4 landed on a single repo whose install you kept out of the tree with `.git/info/exclude`, there is nothing here to stage — `CLAUDE.md`, `wheelhouse/` and `.beads/` are excluded on purpose, and committing them is the exact outcome that decision exists to prevent. Hand the principal that fact in place of a commit SHA, and with it the two consequences they will otherwise meet later: the revert-in-one-step above is not available to them, and a second seat cloning that repo receives none of this and has to repeat the exclusion by hand.

Before you stage, make the worktree directory invisible to this repository. Workers create worktrees at the location you recorded in step 4, and in the umbrella shape that location is INSIDE this repo — so every worktree that exists shows up as untracked in the container root's `git status` from then on, which is the diff pollution the location was chosen to avoid, arriving one level up.

```bash
# umbrella shape: the worktree directory sits inside this repo
if [ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ]; then printf '\n' >> .gitignore; fi
grep -qxF '.wheelhouse-worktrees/' .gitignore 2>/dev/null \
  || printf '.wheelhouse-worktrees/\n' >> .gitignore
```

The first line is not decoration. `>>` appends at the byte the file ends on, and a `.gitignore` whose last line has no trailing newline — ordinary output from plenty of editors and generators — turns `node_modules/` and the new entry into the single line `node_modules/.wheelhouse-worktrees/`, which matches neither. Measured: the previously-ignored directory stops being ignored, the new one never starts, and the corrupted file ships inside the install commit to a file nobody re-reads. Verified across all three starting states — no file, trailing newline, no trailing newline — three runs each and idempotent. It is an `if` rather than an `&&` chain because a chain whose guard is false exits non-zero, and here that is the healthy case: measured under bash and zsh, the chain form exits 1 when there is no file and 1 when the file already ends in a newline, reaching 0 only on the corrupted state it exists to repair — so the common path ends on a non-zero status and any caller, CI step or wrapper that reads it calls the install failed. It does NOT abort a `set -e` script mid-run — `A && B` is an AND-OR list, which `set -e` exempts, and execution continues past the false guard under bash, zsh and sh alike. The `if` runs the same command on the same condition and exits 0 either way.

Measured: before, `git status --short` at the container root reports `?? .wheelhouse-worktrees/`; after, it reports nothing for it. In the SINGLE-REPO shape there is nothing to do here — the worktree location is a sibling OUTSIDE this repo, so this repo never sees it. If that sibling location happens to sit inside some other repository, that repository is not this install's to edit; say so to the principal rather than leaving dirt they will find later and attribute to their own working copy.

Stage what `git status` actually shows, not a remembered list. What bd writes varies by build: some versions add `.gitattributes` (graph merge behaviour — include it if present, or the next clone loses that behaviour silently), current ones add `.claude/`, `.codex/` and `.agents/` and commit them unasked, so those may already be in history before you stage anything. Never `git add` a path you have not seen in the status output — `git add` is atomic, and one nonexistent pathspec fails the whole command having staged **nothing**, which leaves you believing the commit is prepared when it is empty.

One file inside `.beads/` is worth naming rather than leaving to that sweep, because it reads as runtime debris and is not: `.beads/interactions.jsonl`, an append-only log of what agents did to the graph and why. **Commit it.** Measured on bd 1.2.2: the `.beads/.gitignore` that bd writes itself does not exclude it — `git check-ignore .beads/interactions.jsonl` exits 1 — and `bd audit --help` says in as many words that the file "is intended to be versioned in git", for auditing why an agent did something and for dataset generation. It is only ever appended to, so it grows slowly and nothing rewrites what is already in it.

The graph is the project's work state: it is meant to be shared between seats and to survive a fresh clone, and a graph that lives only on one machine is not a single source of anything. What it takes to achieve that depends on the CLI build you have, so establish it rather than assuming — this is the step where a wrong assumption is invisible, because committing the directory looks identical either way.

```bash
cat .beads/.gitignore        # what the tool excludes from git itself
ls .beads/                   # what it actually created
git status --short .beads/   # what would be committed as things stand
```

Two shapes exist. If the issue data sits in a JSONL file git will track, committing `.beads/` gives you the durability above: the JSONL is the record that matters and the database beside it is a local cache rebuilt from it. If the data lives in a directory the tool's own `.gitignore` excludes, committing `.beads/` commits configuration and nothing else, and durability becomes a deliberate choice — enable the tool's JSONL export, use its own sync mechanism, or accept a machine-local graph and say so out loud. bd 1.2.2 is the second shape: an embedded database under `embeddeddolt/`, gitignored by the file bd writes itself, with JSONL export disabled by default.

Commit `.beads/` unless the principal says otherwise, and report which shape you found and what you did about it. An installer who commits `.beads/`, then reports that the graph now survives a fresh clone, has written a sentence the next reader will believe and the defaults do not support.

If you found the second shape, put one of these to the principal and run whichever they choose. Each was exercised against a scratch install of this template rather than reasoned about; the consequences below are what was observed, not what the flags promise.

**Snapshot to JSONL, and commit it.**

```bash
bd export -o .beads/issues.jsonl
git add .beads/issues.jsonl && git commit -m "graph snapshot"
```

Survives a fresh clone and a lost machine, at issue level — comments, labels and dependency edges all travel. It is a SNAPSHOT and is stale from the moment it is written. Re-run the export before each commit, or put it in a pre-commit hook.

Do not substitute the config flag for the command. Setting `export.auto: true` in `.beads/config.yaml` does produce the file, and the file it produces LAGS: measured at a five-second interval, `issues.jsonl` held one issue while the database held three, and twelve seconds of waiting did not close the gap. A later command that WRITES catches it up; time alone never does, because this build ships no daemon to run a timed flush. That the file exists is what makes it dangerous — an absent export announces itself, while a present one reads as current and is not, and it is committed by whoever glances at `git status` and sees a tracked file with recent changes.

If you check this yourself, two things change what you will see and neither is visible in the file: the configured interval, and whether any writing command has run since the last one you made. Say both when you report the result — a bare "the export is current" is not a measurement.

Recovery is two steps, not one: `git clone`, then `bd init && bd import .beads/issues.jsonl`. A clone on its own leaves you with the file and a `bd list` that errors.

**Sync the database itself.**

```bash
bd dolt remote add origin <git-remote-url>
bd dolt push
```

Real cross-machine sync rather than a snapshot, and it is the tool's own mechanism — the tool prints this same repair when it notices no remote. Costs a reachable remote and the discipline of someone pushing. Recovery: `git clone`, then `bd bootstrap`. A plain clone does not fetch the data ref, so `bd list` errors until bootstrap runs, and bootstrap goes to the remote rather than to what the clone fetched.

**Keep it machine-local, knowingly.**

No commands, and it is a legitimate choice — but state the consequence rather than leaving it to be discovered. The graph survives a damaged working copy only if you separately back up `.beads/`, and does not survive losing the machine. A fresh clone gets `config.yaml`, `hooks/`, `metadata.json` and `README.md`, and `bd list` answers `no beads database found`. Choosing this is fine; arriving at it by default is what this passage exists to prevent. Record the choice in `wheelhouse/INTEGRATOR.md`'s project section or your ISA, so the next reader can tell a decision from an oversight.

**Whichever of the three you take, bd goes on advising the second one, and that is not the choice failing.** Only the sync option configures a remote, so on the other two the tool keeps printing the repair it prints whenever it notices there is none — after the decision, on ordinary commands, for as long as the project runs. Measured on bd 1.2.2: advisories of that class arrive on stderr while the command itself exits 0, so they cost nothing and change nothing. Say so when you hand back, because a principal who reads them as a symptom will keep re-deciding a decision that was already made.

Do not push. Pushing is a principal-only action, here and in every wheelhouse.

## 8. Take the seat, and hand back from it

You are a session in the directory whose `CLAUDE.md` you just wrote, and that file says a session in this directory is a commander session. So you are the commander already, and the first commander action is yours to perform rather than to recommend. An install that ends on a reading list gives the principal the standards, the procedure and the homework, and leaves the loop unstarted — which is the one thing the install exists to start. Observed on a real install, 2026-08-21: every file was correct and nothing was running.

Four things, in this order.

**Hand back what is now true.** Plainly, and with the two halves kept apart, because a principal who cannot tell them apart will trust the stubs:

- what exists — the files, the graph, the shape you installed and where worktrees go, the merge policy and the principal-only actions in the principal's own words, and anything you corrected on the way through: the `AGENTS.md` override from step 5, any `GRAPH.md` status correction from step 6, and which `.beads/` durability shape you found in step 7 and what was chosen about it;
- what is deliberately STUBBED and therefore not yet true — `wheelhouse/crew/bench.sh` exits non-zero on purpose, the worker's gotchas section is empty because gotchas are earned rather than invented, and the ISA's claims are empty for the same reason.

**Read the loop you are about to run.** `wheelhouse/runbooks/RUNNING_THE_LOOP.md`, now, before the dispatch below — you are executing its first stage in the next paragraph, not filing it for someone to read later. The contracts say what each role owes; that runbook says what the sequence looks like and what to do on the days it does not go straight through, and whoever has the contracts and not the runbook has the standards and no procedure. The role contracts are then read at the stage that needs them — `wheelhouse/fleet/WORKER.md` when you dispatch, `wheelhouse/crew/REVIEWER.md` when a branch lands, `wheelhouse/INTEGRATOR.md` when one is approved, `wheelhouse/GRAPH.md` for the review queue — and the runbook's closing table says which is which. That is the reading list, and it is a step inside this action rather than a parting gift.

**Make the first dispatch.** Read the graph rather than your memory of it:

```bash
bd ready                                 # the graph you are dispatching into
bd ready --label wheelhouse-bootstrap    # the bead step 6 left for you
```

The second command is the one that finds the bead; the first is there so you see what else is in flight before you dispatch into it. Step 6 stamped the bench bead with `wheelhouse-bootstrap` for exactly this handoff, because on a graph that already held work — the ordinary case for a project adopting a wheelhouse — "the ready bead step 6 created" is not something `bd ready` alone can tell you.

That bead is real work rather than a placeholder: implement `wheelhouse/crew/bench.sh` against `wheelhouse/crew/BENCH.md`. It goes first because until the bench is real no verdict on this project may claim its software runs, so every approval until then is an approval of a diff somebody read. Dispatch it per the runbook's stage 1 — name the bead id and the repository, give a way to read anything it points at that changes nothing, and state done if the bead does not already state it.

Two answers are not one bead, and neither is a reason to guess which bead was meant:

- **Nothing listed.** On bd 1.2.2 that prints `No ready work found` and exits 0, so read the text. `bd list --label wheelhouse-bootstrap --all` separates the two causes. If it shows a CLOSED bead, this install went in over a graph whose bench was already implemented — say so, and make the first dispatch from the highest-priority bead `bd ready` does show. If it shows nothing at all, step 6 did not complete; go back and finish it there, where its verification runs, rather than creating the bead here.
- **More than one.** An earlier partial run left a duplicate. Say so to the principal and dispatch none of them until you are told which one is live — a duplicate bench bead is cheap to resolve now and expensive after two seats have worked it.

Where that dispatch goes depends on the per-seat answers from step 4's question 7. Read the roster in `wheelhouse/fleet/SEATS.md` rather than your memory of the conversation:

- **A worker seat is on the roster.** Launch every seat the roster names, then dispatch the bead to the worker. Launching is a hands-on procedure and it is written down twice over, deliberately: `wheelhouse/fleet/SEATS.md`'s "Launching a seat" is the procedure — a terminal per seat, its own config directory, its own account, the standing prompt pasted as the first message, discovery wired and verified afterwards — and `wheelhouse/STARTUP.md` is the same steps with this project's root and seat names already substituted. Follow `STARTUP.md`; if it is thinner than what you just wrote in step 5, the contract is the authority and the STARTUP.md you wrote is the thing to fix. Then hold the commander's seat and wait for the report to arrive on the bead, not in a message.
- **No worker seat.** Say so, and take the worker seat yourself for this one: claim the bead, work in a worktree at the location step 4 recorded, and report on the bead the way `wheelhouse/fleet/WORKER.md` requires of anyone.

Then check the roster for the reviewer, whichever branch you took. The one role the author of a change may not also hold is the reviewer's for that same change — `wheelhouse/crew/REVIEWER.md` forbids author-review, and it is the one merge that care cannot recover afterwards. If no reviewer seat is on the roster, say now how this bead WILL be reviewed, while there is a whole bead's worth of time to arrange it rather than at the moment the branch is ready to merge. An empty roster is not an empty bench of reviewers: `wheelhouse/runbooks/RUNNING_THE_LOOP.md`'s "When one human holds every seat" section is the solo path — the principal reviews an agent-authored change themselves, or a fresh session that did not author the change is dispatched as its reviewer, and the verdict lands on the bead in the same format either way. Name which of those this install will use, or which reviewer seat will be filled instead.

**Run the loop you just started.** The dispatch was `wheelhouse/runbooks/RUNNING_THE_LOOP.md`'s stage 1, and stage 1 is not a finish line: an install that ends on a dispatch hands the principal a fleet with one message in flight and nobody carrying it forward, which is the reading-list failure again with a better opening move. You are the commander for as long as this session lasts, so carry the bead through the runbook's stages yourself. What carrying looks like depends on the same roster read as the dispatch:

- **Seats are on the roster.** Command them. The worker's report arrives on the bead — that is where you read it, not in a message. When it lands, dispatch the reviewer seat the same stage-1 way: the bead id, the branch, a way to read it that changes nothing, `wheelhouse/crew/REVIEWER.md` as its brief. When the verdict lands, integrate per `wheelhouse/INTEGRATOR.md` — confirm the tip you merge equals the head that was reviewed, act on the PUSH line rather than the VERDICT line for anything leaving the machine — and close the bead per the runbook's last stage, dropping the review-queue label in the same breath. Merge under the policy step 4's question 5 recorded. Its default is that the principal confirms each merge, and the principal is the person you are talking to: ask in so many words, rather than reading the install conversation as standing consent. Where nobody else is in the conversation — a solo install, where you hold the commander seat and there is no second party to turn to — you are that person, and the question survives: put it and answer it on the bead, so the merge cites an authorization a later reader can find rather than one that only ever existed inside a session.
- **No seats — you took the worker seat above.** Take it in earnest, in this session: the dispatch was addressed to you, and describing how you would implement the bead is not implementing it. The bench bead is sized for a first session — one script against a written brief. Do the work under the dispatch's own terms; the claim, the worktree and the evidence-carrying report are already in the bullet that took the seat, and the branch name and everything else a worker owes are in `wheelhouse/fleet/WORKER.md`, the contract that bullet named. Then route the review down the solo path you just named. The principal reads the diff and writes the verdict on the bead, or a fresh session that holds nothing of this conversation is dispatched as reviewer per the runbook's "When one human holds every seat" section — and that section's subagent form means the fresh session needs no second terminal, provided its dispatch is composed from the bead and the branch and carries nothing of this session's account of the work; the section says why the empty context is the whole point, and what to check before trusting it. When the verdict is on the bead, change hats once more and integrate exactly as the roster case above: tip equals reviewed head, question 5's policy, close and drop the label. The default policy holds here too — the principal confirms each merge, and they are one question away.

Two limits, stated here because this is the paragraph that would otherwise over-promise. **A session operates in turns.** Nothing in this loop runs while nobody is talking to it: "carry the bead through the stages" means the loop advances each time you act and each time the principal returns and says to continue — a report that lands while the conversation is idle waits for the next turn, and no merge happens unattended. Say where the loop stands whenever you hand the turn back, so the principal knows what a "continue" will do. And **every write the loop makes passes through this session's permission settings** — the worker's commits, the report and the verdict on the bead, the merge itself. A step that stalls on a permission prompt is the reader's gate working, not the procedure failing; the answer belongs to the principal, not to a workaround.

Either way, say which seat you are sitting in and what you are waiting for. Once the first bead is closed, the loop has run end to end and the fleet is operating — the remaining actions are the commander's ordinary ones and they follow from this first loop rather than replacing it: file the beads for the ideal state from step 4's question 3, and launch any seats you have not launched yet per `wheelhouse/STARTUP.md`.

## Failure behavior

Any step that cannot complete: stop, and report where you got to and what blocked you. Do not improvise around it, and do not report success on a partial install.

A half-installed wheelhouse that claims to be finished is worse than no install, because the next session inherits it as if it were sound.
