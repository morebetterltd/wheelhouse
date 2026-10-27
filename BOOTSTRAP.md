# Bootstrap procedure

You are installing a wheelhouse — a standing agent fleet over a shared work graph — into the user's project. You are talking to the PRINCIPAL: the person who owns this project and whose judgment the fleet defers to.

Six steps, in this order. Do not reorder. Steps 1 and 2 write nothing that depends on an answer; nothing the interview decides is written before step 3 is answered. After install, `seats/template-drift.sh` reports local seat/contract drift against the recorded template commit before an upgrade overwrites it.

1. Prerequisites — the tools, and what was here before you
2. Get the template in, verbatim
3. Read, then interview — ending in a written roster
4. Provision the seats
5. Initialize the graph and write the install (verify and commit included)
6. Close the loop — prove the manual, then the smoke dispatch that proves the fleet

## 1. Before anything writes — the tools this needs, and what was here before you

Two observations, both taken before anything writes: the binaries this procedure depends on, and the state of the project as you found it. They share a step because they share that property — each is cheap now and expensive or impossible later.

### 1a. The tools this procedure needs

This procedure, and the runbooks and contracts it installs, invoke a handful of binaries. Someone installing on their own machine for the first time has no reason to already have them, and a missing one surfaces halfway through as a bare `command not found` — at which point part of the install exists and part does not, which is the state this whole document is written to avoid.

It runs before step 2 rather than alongside it, even though step 2 is where the "verify before you trust it" rule lives, because the clone step 2 is about to verify was made by `git`, and a missing `bd` is cheaper to find now than after the interview. This part writes nothing, so re-running it costs nothing either.

Six are worth checking before the interview; harness-specific seat binaries are checked after question 8 chooses them. Everything else the procedure runs — `sed`, `grep`, `diff`, `cp`, `mv`, `find`, `mktemp`, `date`, `basename`, `cut`, `ls`, `xargs`, `ps`, `tail`, `printf`, `rm`, `mkdir`, `cat`, `env` — is the POSIX baseline that ships with macOS and every Linux. Checking for those would fail nothing and teach installers to skip the block, which is the same reason step 2 checks the contracts by name rather than counting them.

Deliberately NOT on the list: `gh`. The grep now hits this sentence, the opt-in publishing question, and the `.template-source` paragraph below; the runbook/contract prose documents the same optional path without invoking `gh`. `seats/report-issues.ts` and `seats/alerts.ts`'s issue watch are the two optional users of `gh`, both off or no-op when `gh` is absent, so `gh` is still not a prerequisite. If you add a tool to the list, measure the same way: the list is only worth what it was checked against.

`bun` is still unconditional because it runs the adapter, reviewer/walker dispatchers, prune tool and floor for every local seat harness. `claude` is unconditional for the commander: the commander seat is a Claude Code session in the install root, and it is the one seat every install has. `pi`, `claude`, and `codex` as seat harness binaries are checked again after question 8, once the roster says which harnesses any non-external seats actually use; a no-worker install should not fail because a seat harness it never chose is absent.

```bash
# Positional parameters, not a whitespace-split string: zsh does not word-split an
# unquoted variable, so a `for t in $TOOLS` loop there runs ONCE over the whole list
# and reports one nonexistent tool while checking none of them. "$@" iterates
# identically in bash and zsh -- the same reason step 5's integrity check uses it.
# Each entry is tool:why:how; only the first two colons are separators, so `how` may
# contain a URL and `why` may not contain a colon.
set -- \
  "git:clones the template, and carries every branch, worktree and merge the fleet runs on:brew install git   # macOS also ships one with the Xcode command line tools" \
  "bd:is the work graph -- every unit of work the fleet holds lives in it:brew install beads   # or see https://github.com/gastownhall/beads" \
  "bash:runs wheelhouse/crew/bench.sh, which ships with a bash shebang and is invoked as bash in step 5:preinstalled on macOS and every Linux; brew install bash for a current one" \
  "awk:splits each contract into its contract half and its project half -- step 5's integrity check and runbooks/UPGRADE.md's splice both depend on it:preinstalled on macOS and every Linux" \
  "bun:runs the seat adapter, reviewer/verifier dispatchers, prune tool and floor (seats/adapter.ts, verify.ts, walk.ts, prune.ts, floor.ts) -- without it seats cannot be spawned, dispatched, walked, or pruned:brew install oven-sh/bun/bun   # or see https://bun.sh" \
  "claude:is the commander's harness -- the principal's own session in the install root is a Claude Code session, and step 6 closes the loop from it:npm install -g @anthropic-ai/claude-code   # or see https://docs.anthropic.com/en/docs/claude-code"

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

`wheelhouse/GRAPH.md`'s claims about the work graph's CLI were measured on bd 1.2.2, and step 5's verification re-verifies them against whatever you have. Print the version here so that step has something to compare against, and so a later reader can tell which build this install was made on.

### 1b. What was here before you — the survey that cannot be taken later

Take this from the project directory you are installing into, not from the template clone. If you are not standing in it yet, go there first: a survey of the wrong directory returns a clean answer about a project nobody is installing into.

- **STOP IMMEDIATELY, without writing anything, if `wheelhouse/` or `CLAUDE.md` already exists here.** Say what exists and ask the principal what to do. Overwriting a principal's `CLAUDE.md` is unrecoverable.
- **Survey root `AGENTS.md` before anything writes.** If it is already committed, say so and leave it product-owned. If it exists but is not committed, ownership is ambiguous: STOP before writing and ask the principal whether it is product guidance to commit/preserve or local debris to move/remove. The wheelhouse's install instructions go in `wheelhouse/AGENTS.md`; do not append to or git-exclude the root cross-agent file.
- **If none of `wheelhouse/`, `CLAUDE.md`, or root `AGENTS.md` exists, say so out loud.** That sentence is the record every later step reads. This procedure creates `wheelhouse/` itself in step 2 and creates `CLAUDE.md` in step 5 after `bd init --skip-agents`; neither trips this check, because both appear after this survey. That is the whole reason the survey lives here and not further down: seeing those files at step 3 or step 5 tells you nothing, and seeing them now tells you everything.

This is the one observation in the procedure that expires. Every other check can be re-run at any point and give the same answer; this one is about a state that step 2 destroys. If you find yourself past step 2 having never taken it, the cheap answer is gone — ask the principal directly, and read `git log --oneline -1 -- CLAUDE.md AGENTS.md wheelhouse`, where a path with history predates you. An empty answer proves nothing in the other direction, since an untracked file that was already here has no history either.

## 2. Get the template in, verbatim

You are already following instructions from this clone, so verify it before trusting any more of it. This comes before the project checks deliberately: everything below depends on these files being real, and a wheelhouse installed from an empty clone is worse than no install. This step then copies everything that is copied VERBATIM — contracts, runbooks, the seats machinery, the bench stub. Nothing here depends on an interview answer; everything the interview decides is written in steps 3 and 5.


You were told to clone this repo into a temporary directory. Before you read another word of it, confirm the clone produced something:

- `$TEMPLATE/BOOTSTRAP.md`, `$TEMPLATE/contracts/` and `$TEMPLATE/contracts/WORKER.md` all exist and are non-empty.
- All ten contract files are present — nine briefs plus the bench stub:

  ```bash
  for f in WORKER.md SEATS.md REVIEWER.md PRODUCER.md VERIFIER.md RESEARCHER.md BENCH.md GRAPH.md INTEGRATOR.md bench.sh.stub; do
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
  echo "product-repo=$(pwd -P)"
  echo "merge-target="
  echo "installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "upgraded="
  echo "namespace="
  echo "github-issue-watch="
  echo "github-issue-repos="
  echo "github-issue-include-labels="
  echo "github-issue-exclude-labels="
  echo "github-issue-author="
  echo "github-report=off"
  echo "github-report-routes="
  echo "seat_push=on"
  echo "seat_worktrees=per-seat"
  echo "cleanup=on"
  echo "sweep=on"
  echo "sweep-hour=03"
  echo "isa_signals=on"
} > wheelhouse/.template-source
cat wheelhouse/.template-source
```

`product-repo=` defaults to the install root for a single-repository install. If the install is a container beside a separate product repository, set this field to that product's Git root before step 5 (an absolute path, or a path relative to the install root). The product need not contain `seats/`. The pre-push installer uses this record to protect both repositories.

`namespace=` is written empty here and filled at the end of step 3's interview, because its value comes from an answer that has not been given yet. It is this project's seat namespace: the value `seats/seat-env.sh` is invoked with, and the one that names this project's seat root (`$HOME/.pi-seats-<namespace>`), which is what keeps two fleets' seat directories apart on one machine. It lives in this file rather than in a file of its own because `.template-source` is already per-install and already read by other steps.

The `github-issue-*` lines are install-owned alerts configuration. Empty is the default for each: `github-issue-watch=` means the GitHub issue watch is on (set it to `off`, `false`, `disabled`, `none`, or `0` to silence it); `github-issue-repos=` means derive the watched `owner/repo` from the product repo's `origin` remote (otherwise list `owner/repo` values separated by commas or semicolons); `github-issue-include-labels=` means no required labels (otherwise comma/semicolon-separated labels, with any one matching enough); `github-issue-exclude-labels=` means no excluded labels (otherwise comma/semicolon-separated labels, with any one matching enough to skip the issue); `github-issue-author=` means any author (otherwise one GitHub login). `seats/alerts.ts` writes the result into `seats/run/fleet-snapshot.json`; the optional fleet-gate reader only displays active alert names from that snapshot.

The `github-report=off` line is the written default for publishing template-class findings: only the literal `github-report=on` enables the commander-run publisher, `seats/report-issues.ts`. `github-report-routes=` empty means the single default route `template-report -> <owner/repo>` parsed from this file's `source=` line; add a product route as `<label>:<owner/repo>`, separated by commas or semicolons. The publisher is commander-run, dry-run by default, scrubs issue bodies with `seats/evidence-scrub.sh`, refuses credential-shaped text, and uses `gh`'s own login rather than any token under `seats/run/`.

The `seat_push=on`, `seat_worktrees=per-seat`, and `cleanup=on` lines record the default install policy for seat machinery. Leave them at the default unless this install's recorded authority requires an opt-out: `seat_push=off` means the adapter never pushes branches, `seat_worktrees=per-task` means the adapter uses the install's existing task worktree instead of creating/moving `.wheelhouse-worktrees/<seat>`, and `cleanup=off` disables automatic cleanup while `cleanup=report` writes a would-remove report without deleting.

Every later step reads `path=` out of that file rather than trusting `$TEMPLATE` to still be set:

```bash
TEMPLATE=$(sed -n 's/^path=//p' wheelhouse/.template-source)
```

**`path=` is the one field that is expected to die, and that is a decision rather than an oversight.** The README has you clone into `mktemp -d`, so the path you just recorded points into a directory the OS reclaims — routinely before the first upgrade wants it. A durable clone kept beside the project was the alternative and was not taken: it is a second copy of the contracts that ages silently, and every reader who finds it then has to work out whether it or `commit=` is the truth. `source=` and `commit=` are the durable half, and step 5's integrity check refreshes an install-local cache from `source=` the moment it finds the path dead — the same recovery `runbooks/UPGRADE.md` needs anyway, so the temporary path costs a clone at the moment of use rather than a stale directory for the life of the project. Record it, and expect it to be gone later.

`installed=` records when this project first installed and is never rewritten afterwards; `upgraded=` is the one an upgrade updates. The `commit=` line is the provenance record. It is what tells a future reader which version of the contracts this project installed, and it is the baseline the upgrade path in the README compares against. Without it, "re-copy the contracts" has nothing to diff from. `merge-target=` is filled after the interview records the principal-confirmed integration branch; seat dispatch uses it for fresh worker branches before falling back to `origin/HEAD`, because a repository's default branch is not necessarily this fleet's merge target.

**A clone of an empty or unpushed repository exits 0.** It creates the directory, prints nothing alarming, and leaves you with nothing to install. If the files above are missing, STOP and tell the principal the template is empty or unreachable — do not proceed, and do not reconstruct the contracts from memory or from this document. A wheelhouse whose contracts were invented by the installer is worse than no wheelhouse, because it looks like the real thing.

### Confirm the project, then report what you found

- Confirm the current directory is a git repository, and say which directory you are about to install into. Let the principal correct you before you continue. A correction here means step 1b surveyed the wrong directory and this step wrote into it — say so, and take the survey again in the directory you have just been given.
- Step 1 established that every named tool is on PATH and printed the versions. Carry `bd`'s version forward rather than re-deriving it; if you skipped step 1, go and run it now instead of checking `bd` alone here, because it is not the only tool that has to be there.
- Report uncommitted changes if there are any. Do not block on them; the principal may be mid-work.
- **Report what step 1b's survey found** — whether `wheelhouse/`, `CLAUDE.md`, or root `AGENTS.md` was here before this install, which is the check that guards an unrecoverable overwrite and preserves product-owned agent guidance. Carry the answer forward; do not re-derive it from what you can see now. This step created `wheelhouse/` for `.template-source`, and step 5 creates `CLAUDE.md`, so the directory in front of you cannot answer the question any more. If you skipped step 1b, do not guess: go back and read its last paragraph, which says what to do once the cheap answer is gone.

### Copy the verbatim half of the install

Everything in this list is copied whole and unedited. The interview-derived content — every `## This project` fill, `CLAUDE.md`, the ISA, `STARTUP.md`, `seats/seats.json`, `seats/channels.json` — is written in steps 3 and 5, not here; what this step lands is the half that is byte-identical in every project.

- Create `wheelhouse/crew/`, `wheelhouse/fleet/`, and `wheelhouse/research/`.
- Copy **verbatim** from the template's `contracts/`:
  - `WORKER.md` and `SEATS.md` into `wheelhouse/fleet/`
  - `REVIEWER.md`, `PRODUCER.md`, `VERIFIER.md`, `RESEARCHER.md`, `BENCH.md` into `wheelhouse/crew/`
  - `GRAPH.md` and `INTEGRATOR.md` into `wheelhouse/`
  - the whole `runbooks/` directory into `wheelhouse/runbooks/`. `SEATS.md` and `STARTUP.md` both point at these by path, and a runbook that is only in the template is a broken link in the project.
  - `bench.sh.stub` to `wheelhouse/crew/bench.sh`, executable, unchanged — **it exits non-zero on purpose.** A stub that exits 0 lets the first APPROVE through on nothing.
- Copy the whole `seats/` directory from the template to `seats/` at the install root, scripts kept executable (`cp -R "$TEMPLATE/seats" seats`). This is the machinery every seat runs on — `seat-env.sh` (provisioning), `adapter.ts` (spawn/dispatch/status/stop/resume), `verify.ts` (the reviewer bead-verdict dispatcher), `walk.ts` (the consumer-surface verifier walk), `needs.ts` (durable human requests), `intake.ts` (durable signal intake), `desk.ts` (the local needs/board web desk), `principal-sentinel.sh` (Claude Code Stop hook for `@principal:`), `inbox-hook.sh` and `inbox-hook.selftest.sh` (identity-guarded lifecycle inbox delivery), `courier.ts`, `channels.ts`, `comms.ts`, `seats/channels.json.example` plus `transports/` (optional off-machine replies through a declared principal channel and stakeholder channels across Telegram, Slack and Teams), `pool.ts`/`roster.ts` plus `pool.json.example` (optional dynamic-staffing pool support; inert until `seats/pool.json` exists), `prune.ts` (safe worktree/cache pruning), `floor.ts` and `cockpit.sh` (the bridge), `recover.ts` (post-interruption triage), their selftests, and `seats/README.md`, which documents every command. It lands at the ROOT rather than under `wheelhouse/` because every path the contracts and runbooks print — `seats/seat-env.sh`, `bun seats/adapter.ts ...` — is root-relative, and a copy that lands anywhere else breaks each of them. `seats/seats.json.example` arrives with it as the roster format's reference; the real `seats.json` is written by step 3's interview.
- Copy the shipped skills to the install root and recreate the two contract-writing compatibility links. `.agents/skills/` is a **shared namespace**: only the template's shipped skill directories and top-level metadata files are template-owned, never the whole parent. Project verification manuals such as `verify-<project>/` remain product-owned, including when the product repository is the install root. This fresh-install recipe conservatively refuses any existing skills root: stop and reconcile it with the owner (or use the upgrade recipe to preserve unshipped skills); never delete it or nest a copy into existing product skills. A real directory or file at either compatibility-link path is also a named refusal, not permission to delete it. Other `.agents/` and `.claude/` contents stay untouched.

  ```bash
  # Template skills install — run at the install root, with TEMPLATE from above.
  test -f "$TEMPLATE/.agents/skills/intent/SKILL.md" && test -f "$TEMPLATE/.agents/skills/outcomes/SKILL.md" || { echo "STOP: template skills missing" >&2; exit 1; }
  for p in .agents .claude .claude/skills; do
    [ ! -L "$p" ] && { [ ! -e "$p" ] || [ -d "$p" ]; } || { echo "STOP: skill parent is not a real directory: $p" >&2; exit 1; }
  done
  [ ! -e .agents/skills ] && [ ! -L .agents/skills ] || { echo "STOP: .agents/skills already exists; reconcile with the owner before installing" >&2; exit 1; }
  for skill in intent outcomes; do
    p=".claude/skills/$skill"
    [ ! -e "$p" ] || [ -L "$p" ] || { echo "STOP: $p exists and is not a symlink; preserve it and reconcile with the owner before continuing" >&2; exit 1; }
  done
  mkdir -p .agents && cp -R "$TEMPLATE/.agents/skills" .agents/skills
  mkdir -p .claude/skills
  ln -sfn ../../.agents/skills/intent .claude/skills/intent
  ln -sfn ../../.agents/skills/outcomes .claude/skills/outcomes
  test -f .claude/skills/intent/SKILL.md && test -f .claude/skills/outcomes/SKILL.md
  ```

- The seats machinery writes per-machine runtime state beside itself — `seats/run/` (FIFOs), `seats/logs/` (event streams), `seats/state.json` (pid/session records), `seats/staffing.json` (dynamic staffing's live seats), `seats/verdicts/` (the commander's working copies of reviewer verdict output) — none of which is product, so keep it out of git now, before anything creates it. The guard first line is the same trailing-newline repair the worktree entry in step 5's commit section explains; it is not decoration.

  ```bash
  if [ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ]; then printf '\n' >> .gitignore; fi
  for e in 'seats/run/' 'seats/logs/' 'seats/state.json' 'seats/staffing.json' 'seats/verdicts/'; do
    grep -qxF "$e" .gitignore 2>/dev/null || printf '%s\n' "$e" >> .gitignore
  done
  ```

- **Do not edit a single line of any `## Contract` section, now or ever.** They are identical in every project by design; a project that edits its contract has forked from every other one silently. To be unambiguous about what "verbatim" means here: you copy the whole file, and step 5 appends or fills ONLY below the `## This project` heading. Copying verbatim and later filling the project section are the same operation, not competing instructions.

## 3. Read, then interview

Survey the repository so your questions are informed: build and dependency files, language and framework, test setup, CI config, existing docs, whether there are multiple product repos beneath this root, and how the project is built and run. For each product repo, also scan its user-facing features — routes, commands, screens, menus and documented workflows — as the create-verification skill's first section describes. Form a complete proposed list in user words before the interview, with a stable feature slug and observable entry points for each item; distinguish the real product from examples and note inaccessible areas. This is the found list for question 2e, not yet a claim that the scan found everything.

Read the branch that merges target out of each repository rather than assuming it, once per product repo, because they need not agree. This is the one survey answer that gets written into several installed files at once, so a guess here is a guess repeated: an install that assumed `master` wrote it into three files, and it surfaced only when a worker ran a dispatch's read path and got `fatal: ambiguous argument 'master'`.

```bash
git -C <repo> branch --list                             # what actually exists
git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD   # if there is a remote
```

Ask the principal for the merge target and check the name you are given against that list. `branch --list` does not answer the question either — it returns the SET of branches that exist, and which one merges target is not a property of the repository. That is the point rather than a hedge: swapping one command for another would reproduce the same defect with better manners, because the failure was never the command, it was taking a value from a tool that was answering something adjacent. Note what `git -C <repo> symbolic-ref --short HEAD` does NOT tell you: it reports the branch currently checked out, which in a worktree is the worktree's own feature branch. Measured on one repository — `master` from its own checkout, `fleet/<bead-id>` from a worktree beside it, and nothing in either answer says which question was asked.

You are forming PROPOSED ANSWERS to the interview below. Asking a principal what language their own project is in tells them you did not look.

### The interview — propose, then confirm

Ask in as few turns as you can manage. Lead each question with your proposal from the survey above, so the principal is correcting rather than composing.

1. **Product repos, and therefore the shape of this install.** "I see \<what you found\>. Are these the repos the fleet will change, and are they separate git repos from this root?"

   Two shapes, and the common one is the second:

   - **Umbrella root.** This directory is a container; the product lives in one or more separate git repos beneath it. The wheelhouse installs at the container root, the graph spans the repos below it, and the adapter creates each worker seat's worktree at the container root (for example `<root>/.wheelhouse-worktrees/<seat-name>`), never inside a product repo. That keeps the graph reachable from inside the worktree, which `contracts/GRAPH.md` explains (a worktree's `.git` is a file the workspace walk passes through; a nested repo's `.git` is a directory that stops it).
   - **Single repo.** This directory IS the product — one repo, no container. This is the ordinary case and it is fully supported: the wheelhouse installs at the product root, `CLAUDE.md` and `wheelhouse/` are committed alongside the code, and a worker seat's worktree is inside that root at `<root>/.wheelhouse-worktrees/<seat-name>`, created by the adapter on first dispatch. That is the path `seats/adapter.ts` dispatches to, `seats/prune.ts` cleans up, and `seats/seat-env.sh`'s root trust grant covers. It is machine-local fleet runtime, and the template's tracked `.gitignore` already ignores `.wheelhouse-worktrees/` and `.wheelhouse-runs/`, so there is no exclude step to take.

   **When both shapes fit, one question decides it: is this repo something other people clone as-is?** A template, a starter kit, a library whose repository IS the deliverable — anything whose consumers take the working tree rather than a built artifact. If yes, install the umbrella shape even where a single repo would otherwise be the obvious call: this root becomes a container holding the fleet's machinery, and the consumer-facing repo stays pristine beneath it. The single-repo shape commits `CLAUDE.md` and `wheelhouse/` alongside the code, so everyone who clones receives the installer's fleet state — commander context written for one principal, an ISA stating one project's goal, a work graph of beads that are not theirs — and the first stranger who runs this procedure inside their clone trips step 1b's stop check on files they never wrote. Where single-repo is genuinely required, keep the install out of the tree with `.git/info/exclude` rather than `.gitignore`, and say plainly that it is machine-local: it is not itself committed, so a second seat cloning that repo has to repeat it. This template's own install took the umbrella shape for exactly this reason (2026-08-20) — the product is the wheelhouse template, and its consumers clone it.

   Say which shape you are installing, and record it in the worker's `## This project` section along with where worktrees go. An install that records this wrong puts the seat worktrees inside the repo and pollutes the very diff the workers are meant to produce.

2. **What "it runs" means.** The bench questions (a–d) fill `crew/BENCH.md`'s five sections, with (b) filling two; (e) confirms the feature inventory the verification manual will cover:

   a. "For a \<project type\>, I would prove a build works by \<your proposal: a server answers a health check; a CLI executes a real command against real input; an app installs and reaches its first screen\>. What is the observation that would convince you a build actually works?"

   b. "What does the bench need in order to do that — what artifact does it take, and what has to be set up and cleaned away around the assertion?" Ask both halves. A long-running target (a server, an emulated device, a container) has to be started and stopped. A one-shot artifact (a CLI, a library, a batch job) starts nothing, but it almost always needs something created for it to act on and removed afterwards — a scratch directory, a throwaway database, a copied input. Asking only about the target invites "nothing" from a principal whose bench does need a fixture, and the answer is then recorded as though the question had been the wider one.

   c. "When it goes wrong, what does that look like in the logs or output — what should the bench scan for and treat as failure?" Then ask where that appears, and how the bench tells this artifact's failures from everyone else's: a scan reading from a location shared with other processes — a machine-wide crash-report directory, a system log — needs the scoping filter (a process name, a bundle id, a log tag) recorded with the patterns, per `crew/BENCH.md` clause 7's scoping half, or the bench fails on any bystander that stumbles during the run window. "The location is private to the artifact" is a complete answer — record it as the reason no filter is needed.

   d. "What does someone need installed or running before they can execute this bench at all?"

   `crew/BENCH.md` has five project sections and these four bench questions fill them; the fifth, the artifact, comes from (b). Do not fill a section the principal did not answer. The template's own rule is no invention: an unanswered section says so, and the stub keeps the reviewer honest until it is filled. If the principal cannot answer yet, record it as unanswered and continue — the bench ships as an explicit stub.

   e. **Features I found.** Show the proposed list for each product repo, numbered with one feature per line in user words, and ask: "Features I found: <the numbered list>. Is this right, and what is missing?" With `AskUserQuestion`, offer `List is right` and `Add or correct features`, with free text for the additions/corrections; without the tool, ask in prose. An empty scan still gets this question, not an assumed empty map. For each addition, ask how a person reaches it in this same interview turn, including any flag, data, login or launch condition the scan could not derive. Record prerequisites, never credentials or secrets. Preserve the owner's words for that reach; never guess a URL or workflow. Read the corrected list back, including every owner-named feature, and record it in `wheelhouse/interview/features.md` below. Step 5 maps every recorded feature, using the owner's words in `## How to get to it` for additions. This question is not skippable: the feature the owner names is the one the scan could not see, and the map without it is the map the verifier will trust. If the owner cannot yet explain a reach, record that gap and stop the manual from passing rather than inventing an entry.

3. **First ideal state.** "What is true when this fleet's first iteration is done?" **DO NOT PROPOSE AN ANSWER.** This is the one thing only the principal knows, and a plausible suggestion gets accepted by default — after which the ISA states your goal rather than theirs.

4. **Reserved actions.** Offer these defaults and ask them to amend: credentials and signing the principal alone holds, spending money, legal or public-facing identity, production risks the project wants named, releases/tags, deploys, pushes to protected branches or remotes, PR merges, and communication outside the team. This list is explicit per install and lives in `wheelhouse/INTEGRATOR.md`'s project section; anything not on it is not principal-only merely because a generated tool profile says to be conservative.

4b. **How far does the fleet take work?** Ask this as its own question, with the default answer first: **all the way**. "My default is that once work is reviewed, the fleet takes it through this project's full definition of done: merge, push, open and merge PRs, and deploy wherever the project has an automated deploy path, stopping only for the reserved actions we just named or for a genuine fork in product intent. Is that right, or do you want a narrower line?" With `AskUserQuestion`, present `All the way` as the default option and a free-text/narrower option for the exception. The answer is written into `wheelhouse/INTEGRATOR.md`'s project section as standing authority, alongside the reserved list. The principal directive this question installs is quoted there verbatim: "the whole point of the Wheelhouse and the mandate is to create work and to do work, not to ask if you can create work, ask if you can start work, and ask if the work can be declared done."

5. **Merge policy.** "Does a reviewer's APPROVE carrying bench evidence authorize the integrator to merge to local main, or do you want to reserve local merges for confirmation?" **Default: APPROVE authorizes local merge**, because question 4b's default takes reviewed work all the way. A narrower merge line is a valid project answer, but write it as a reservation in `wheelhouse/INTEGRATOR.md` rather than leaving the fleet to ask each time.

6. **Priorities.** `wheelhouse/GRAPH.md` has a project section for what P0 to P3 mean here. Offer this default and ask them to amend rather than compose: **P0 blocks the fleet or has an external deadline; P1 is the core loop; P2 is maintenance; P3 is nice-to-have.** If they accept it unchanged, say so in the file — a scheme that was confirmed reads differently from one that was assumed.

7. **Seats — the namespace once, then the roster walked one seat at a time.** Do not offer a fleet shape and ask whether they want it. Every install has a producer: it judges signals and writes intent and outcomes, and the commander never does. The producer is required, not an optional seat to decline; ask which form it takes, a standing seat or a commander subagent. If the installer is Claude Code and has `AskUserQuestion`, run this roster walk through the tool: two affirmative producer-form options, and take/carry or decline options for the optional standing seats; free prose is only the fallback when the tool is absent. This question decides WHO is on the roster and nothing else — each managed seat's provider, auth route and model are question 8, a separate round, not a combined question.

   **The namespace comes first, because everything you are about to write sits under it.** Derive the default deterministically from the exact project directory name, lowercased and made filesystem-safe as one path segment (for example, collapse or replace characters the filesystem should not carry in a seat-root name; do not shorten or rebrand it). That default is the rule, not a suggestion. Correct it only for an actual collision on this machine or because the principal explicitly chooses a different namespace. Say what it decides: this project's seat root is `$HOME/.pi-seats-<namespace>`, the directory every seat's account lands under and the value `seats/seat-env.sh` is invoked with. Ask them to confirm or correct the derived string, not to design the scheme. Say why in one sentence, because a principal who does not know the reason will shorten it back out later: a machine can host more than one wheelhouse, and per-project seat roots are what keep two fleets' accounts apart on disk — same directory would mean same `auth.json` would mean one login serving two fleets, which is the collision `wheelhouse/fleet/SEATS.md`'s seat-accounting section forbids. That is the namespace's ONLY job now: seat NAMES are `seats/seats.json` keys, addressed per-project by the adapter, and carry no prefix — `worker-1`, not `<namespace>-worker-1`.

   The commander is not a question. It is the principal's own session in the directory whose `CLAUDE.md` you are about to write, so it exists whether or not anyone names it; it goes into `seats.json` as the `commander` entry, marked `"external": true`, because it runs on its own harness and the adapter manages nothing about it. Say that, and ask whether that commander session is launched directly or under a wrapper/status-line layer; if it is wrapped, point them at `seats/README.md`'s `WHEELHOUSE_HERALD_IDLE_RE` measurement recipe before choosing an idle regex. Then walk the rest individually. For the required producer ask only which form; for optional standing seats each answer is yes-with-a-count or no. Keep each optional prompt about its own role only, so a tool-driven fixture or a human scanning quickly cannot classify it by the wrong role. With `AskUserQuestion`, use labels shaped like the records you will write: `2 workers`, `1 reviewer`, `Take verifier`, and matching decline labels; the producer labels are `Standing producer` and `Producer subagent`, never decline.

   - **Worker** — implements beads on branches, per `wheelhouse/fleet/WORKER.md`. "How many worker seats? One is the working minimum; a second opens another implementation lane when work is queued." If the answer is two or more, that answer names concrete seats, not capacity in the abstract: write `worker-1` and `worker-2` (and `worker-3` for three), derive each account directory, and walk question 8 for each worker by name. A roster with only `worker-1` after a `2 workers` answer is a failed interview, not a smaller valid roster.
   - **Reviewer** — gates every diff before it merges and never reviews what it authored, per `wheelhouse/crew/REVIEWER.md`. Ask with those words in the question: "How many reviewer seats? One, until a single reviewer is the thing everything waits on."
   - **Verifier** — the consumer-surface walker, per `wheelhouse/crew/VERIFIER.md`. It runs as an ephemeral `seats/walk.ts` pass for one ISA claim and one named surface, walks that surface as a stranger, and gates claims rather than beads. It is a roster entry and an account, not a standing process: nothing spawns until a claim needs a walk. Its `account.dir` must differ from every worker's so the empty-context surface walk is not the author's own account.
   - **Researcher** — produces sourced decision-grade research reports, per `wheelhouse/crew/RESEARCHER.md`. Ask with those words in the question: "Do you want a researcher seat? It earns its place when the fleet needs best-practice research before building, landscape maps, or hard-debug source searches." If it needs skills, record them in the optional `skills` array in `seats/seats.json`; paths must already exist when the adapter reads the roster.
   - **Producer (required)** — judges every signal and writes each piece of work's intent and outcomes with the intent and outcomes skills, per `wheelhouse/crew/PRODUCER.md`. Ask: "Which producer form: a standing seat or a producer subagent?" There is no opt-out and the commander never writes contracts itself. A standing producer gets its own account and Q8 round; a subagent is explicitly recorded under `seats` as `"producer": {"role": "producer", "external": true, "runtime": "commander-subagent"}`, reads PRODUCER.md on dispatch, and has no separate account or provisioning round.

   **For each managed seat taken, collect the two facts this round owns — `seats/seats.json`'s other two columns are question 8's:**

   - **Name**: the `seats.json` key the seat answers to (`producer`, `worker-1`, `reviewer-1`, `reviewer-2`, `verifier`, `researcher`). Number review seats from 1 even when there is only one. Write role `reviewer` for every review seat and role `verifier` only for the consumer-surface walker; `verify.ts` and `walk.ts` refuse each other's roles. Short, role-shaped, no namespace prefix.
   - **Account directory**: `~/.pi-seats-<namespace>/<seat-name>` — derived, not asked; offer it for correction only if the principal keeps accounts somewhere unusual. The reviewer's and verifier's directories must differ from every worker's, per the seat-accounting rule.

   **Write down the no's as well as the yes's.** A refused optional standing seat goes into `wheelhouse/fleet/SEATS.md` under `### Declined seats` with the principal's reason and the date. An absence on the page is the same absence whether it was refused or never raised. Choosing the subagent form is not declining the producer role: record that producer in the roster.

   Declining every optional standing session is legitimate — the commander still dispatches a producer subagent, and never writes intent or outcomes itself. Step 6 says what the smoke loop becomes without managed seats; the commander may take the worker role for the first bead, not the producer's job.

   If the reviewer seat is among the declined, say in the same breath what review then looks like, so the answer is on the table now rather than a surprise when the first branch is ready: declining the seat declines a standing session, not the review itself. The solo path is in `wheelhouse/runbooks/RUNNING_THE_LOOP.md`, section "When one human holds every seat" — the principal reviews agent-authored changes, or a fresh session that did not author the change is dispatched as reviewer — and the author-review ban holds unchanged in every shape.

8. **Seat harness, provider, auth route and model — a round of its own, run after the crew is chosen, walked over the seats question 7 ACTUALLY took.** Never one blanket question. A combined harness/provider/model question fails the same two ways the old provider+model question failed: its options cannot reflect a mixed crew, and its model options come from the interviewer's memory instead of the selected harness's account. Walk each taken seat by name, one at a time. Every seat gets its own explicit answer: "same as the previous seat" is an answer the principal gives, not a default you assume.

   Ask Q8 as four separate **choice rounds** after Q7 has chosen the roster. A round may contain one question per taken seat in a single `AskUserQuestion` call, but a round never mixes question kinds. This keeps the turn count bounded while preserving the narrowing order. The harness round is unmistakably separate: every harness question has its own header shaped exactly `Question 8 — <seat> harness`, its option labels are one label per option (`pi`, `claude-code`, `codex`), and the question text says explicitly that provider, auth route, and model are asked AFTER the harness answer and are never combined with it.

   **Round 1 is only harness choices for all taken seats.** Each question literally asks `Which harness?`, and its option labels are exactly `pi`, `claude-code`, `codex`. Do not include provider, auth route, or model text in that question or in those option labels.

   **Round 2 is only provider choices for all taken seats**, asked after the harness answers land and narrowed by each seat's chosen harness: `pi` uses today's live `pi --list-models` providers; `claude-code` offers only `anthropic`; `codex` offers only `openai-codex` or `openai`. Do not include auth routes or model ids in provider labels.

   For the `pi` harness:

   - **Provider — with a role-sensible proposal to correct.** Three routes are measured (2026-08-30 through 2026-09-02) and anything else `pi` supports is legitimate: `openai-codex` (a ChatGPT subscription, via OAuth), `openai` (an OpenAI API key, metered), `anthropic` (an Anthropic API key, metered), and OpenRouter when the live listing prints it for the seat. The proposals, each shaped by the role rather than by a scheme: a worker → the subscription route if the principal holds one, because implementation is the volume work and flat-rate absorbs it; the reviewer → an API-key provider on an identity distinct from every worker's, with the default offer being a mid-tier or cheap strong gate such as an Opus-class model or a GLM-class model through OpenRouter rather than the most expensive frontier option; the verifier → lead with the cheapest listed tool-capable provider/model row you can defend, commonly a GLM-class OpenRouter row when one prints, before offering Anthropic or other deeper metered rows, because the empty context is what matters, not the model's depth — the walker follows instructions on a surface and gates claims, not code review; the producer → plain `openai` by API key when the principal has that key, else the subscription route if it has headroom, else another API-key provider the principal names. If the installer asks provider as an option list, the producer/API-key path must be a visible `openai` option, not hidden behind "otherwise API-key provider" while the labels show only `openai-codex`, `anthropic`, and `google`; that exact omission forced a free-text answer in a live interview. Proposals, not a scheme to defend — the principal corrects, per seat. One fact is load-bearing at exactly this moment: **Anthropic subscription OAuth is NOT a route for a pi seat** — the API rejects third-party subscription auth outright (measured twice, 400 "third-party apps draw from extra usage"), so an Anthropic `pi` seat is an `api_key` or `env` seat. The `claude-code` harness route below is the Anthropic-subscription path for seats that should use Claude Code instead of Pi.

   **Round 3 is only auth-route choices for all taken seats**, asked after the provider answers land and narrowed by each seat's chosen harness/provider: `pi` offers `oauth`, `api_key`, `env`; `claude-code` offers `oauth` as the default Anthropic-subscription route and `api_key` only as the metered/non-default route; `codex` offers `oauth` or `api_key`. The option labels are exactly route values such as `oauth` and `api_key`, never `auth_json + ...`, `env_var + ...`, or any label that also names a model.

   For the `pi` harness:

   - **Auth route — stated per seat even where the provider implies it, because step 4 executes exactly what this answer records.** `openai-codex` has one route: OAuth — launch `PI_CODING_AGENT_DIR=... pi`, type `/login` inside the interactive REPL, complete the browser flow, then type `/exit`; that writes the seat's `auth.json` for that account, and there is no env-var route. Probed working headlessly on a real subscription. An `api_key` provider has two routes, both verified against pi 0.84.x, and which one is this answer: write the seat's `auth.json` yourself after step 4 provisions the directory — `{"<provider>": {"type": "api_key", "key": "<the key>"}}`, e.g. `{"anthropic": {"type": "api_key", "key": "sk-ant-..."}}`, permissions `0600` — or keep the key out of files entirely and export the provider's own env var (`ANTHROPIC_API_KEY` for anthropic; the name is the provider's own, and it is `GEMINI_API_KEY`, not `GOOGLE_API_KEY`, for google) in the shell that spawns the seat. Know the resolution order, because it has a silent edge: `--api-key`, then `auth.json`, then the env var — so a credential sitting in the seat's `auth.json` BEATS an exported key without a word, and switching a seat from the file route to the env route means removing that provider's `auth.json` entry, not just exporting. The file route is the one that survives a new shell; the env route is the one that never touches disk. **No secret ever enters `seats.json` — it records names, roles, providers, models and directories, and that is why it is safe to commit.** The key lives with the operator, never in the roster, never in git, never on a bead.

   **Round 4 is only model choices for all taken seats**, asked after the auth answers land and using model ids from each seat's selected harness/account listing or binding probe. A model question that includes every harness's options is a failed Q8, not a helpful shortcut. A model option label is just the model id for that seat's selected provider/harness — never a row combining harness, provider, auth, and model. Do not offer an `Other`, `custom`, `notes`, `same as previous`, or free-text label for ordinary choices; free prose is only the fallback when the tool is absent or when the principal explicitly chooses a correction path you named.

   For the `pi` harness:

   - **Model — pinned from a LIVE listing, taken at the moment of asking.** Run, now, on this machine: `pi --list-models | awk '$1=="<provider>"'` — and offer only ids that command just printed. The filter is the awk, because the command's optional search argument is a fuzzy match over whole rows, not a provider filter (measured: searching `openai-codex` returned `openai` and `openrouter` rows too). A model the runtime does not list for that provider is a typo the seat discovers at its first dispatch. Ids collide across providers (`gpt-5.4` exists under both `openai-codex` and plain `openai`, with different limits), which is one more reason provider and model are always passed together. Recommend one id from what printed and say why — for the reviewer, lead with a mid-tier or cheap strong default such as an Opus-class or GLM-class row, because reviewer seats run on every bead and every rework; for the verifier, lead with the cheapest listed id that still handles tool use, and make the first option the cheapest tool-capable row you are recommending rather than an Anthropic/frontier row unless Anthropic is genuinely the cheapest listed tool-capable option; the explicit expensive option is the provider's frontier row, called out as expensive with this worked example beside it: in one measured 2026-09-02 shadow day, the frontier gate cost about $120 total, about $5.70 per review round, while GLM 5.3 flash via OpenRouter cost $0.79 total, about $0.04 per round, and a flat subscription had $0 marginal cost. For workers, recommend a high-context id with strong tool use. The recommendation is a row the listing just produced, never a name this file remembers. Two gotchas are load-bearing (bead l0e): the model must be pinned in the roster, because a bare `--provider` silently falls back to the DEFAULT provider rather than erroring; and a ChatGPT-subscription account accepts only ids from the `openai-codex` listing — never propose an id from the plain `openai` (API-key) listing to a subscription seat, however similar it looks.

   Known-good `AskUserQuestion` shapes for the standard mixed scratch roster are intentionally boring: Q7 labels `2 workers`, `1 reviewer`, `Take verifier`, and the required producer's `Standing producer` / `Producer subagent` forms; the Q8 harness round labels `pi`, `claude-code`, `codex` for each taken seat; provider/auth/model labels follow only after the prior round's answers. The epic's falsifier roster is mixed — worker on Claude Code, reviewer on Codex, verifier on Pi — so the interview must not assume one harness for the fleet.

   **Anthropic subscription OAuth is not a route THROUGH PI** (measured twice, 400 "third-party apps draw from extra usage"). Through the `claude-code` harness it IS the route — measured 2026-09-15: `claude auth status` reports `authMethod claude.ai`, `subscriptionType max`, and every session init reports `apiKeySource none` — and that is why the harness column exists. A worker that should run on an Anthropic subscription is a `claude-code` seat with `account.authRoute` `oauth`; an `anthropic` seat on `pi` is still an `api_key` or `env` seat, never subscription OAuth.

   **Model — pinned from the selected harness's own live source, taken at the moment of asking.** For `pi`, run `PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" pi --list-models | awk '$1=="<provider>"'` and offer only ids it prints for that provider. For `claude-code`, there is no list command in `claude --help`; offer the documented aliases as option labels — `fable`, `opus`, `sonnet`, `haiku` — but do not write the alias as the pin; record the full id the binding probe's `system/init` reports as the pinned model (for example, `sonnet` resolves to `claude-sonnet-5`). For `codex`, use the driver/app-server model list (`printf '{"jsonrpc":"2.0","id":1,"method":"model/list","params":{}}\n' | CODEX_HOME="$HOME/.pi-seats-<namespace>/<seat-name>" codex app-server`) and never a remembered catalog. If `model/list` returns no rows in this scratch harness or for this account, STOP the model round for that seat and ask for login/provisioning; do not offer remembered `gpt-*` ids, do not call them provisional, and do not substitute whatever model names you know. A model the selected harness/account cannot list or resolve is a typo the seat discovers at first dispatch.

     **The listing is credential-resolved, and so is the catalog behind it** (measured on pi 0.84.4, 2026-09-01): a provider prints only if its credential resolves for the process running the command, and the catalog refresh (`pi update --models`) fetches only for providers whose credentials resolve — a fresh agent directory's refresh fetched the env-key providers and skipped the OAuth one. So there is no pre-login listing for an OAuth provider on a machine that has never held that login, and a provider absent from YOUR listing may simply be one you are not logged into, not one pi lacks. When the filter prints nothing for a chosen provider, two honest paths, offered in this order:

     1. **Give the seat its identity now, then list.** The namespace is already recorded, so this seat's directory can exist this minute: `seats/seat-env.sh <namespace> <seat-name>` (safe to re-run; step 4 will find it done), the one-time login or key placement by the route just chosen, then the listing under the seat's own directory — `PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" pi --list-models | awk '$1=="<provider>"'`. This is the better path whenever the principal can log in now: what prints is what THAT account can actually run, plan limits included, and step 4 then has nothing left for this seat but the probe.
     2. **Defer the listing only with a recorded provisional pin.** Record the role-sensible proposal as provisional, and make step 4's listing/resolution check mandatory before the probe counts.

   How the principal's subscriptions get divided across several fleets on one machine is their call and not this procedure's. If they raise it, say so and move on; the seat-accounting rule constrains sharing a seat, not which wheelhouse a seat belongs to.

   **The round ends in a read-back, not a feeling of completeness**: one line per taken seat — name, harness, provider, auth route, pinned model, account directory, with any provisional pin marked as such — shown to the principal as a table before anything is written. Every taken seat has all six answers or the round is not over. The read-back columns are: `seat | harness | provider | auth route | model | account dir`.

9. **Host build budget — opt in only for projects with heavy builds or tests.** Ask this after the roster rounds, because the answer is a project-wide seat-runtime setting rather than a property of any one seat: "Does this project have heavy builds or tests (Rust, C++, dotnet, large JS) that should be serialized machine-wide so several fleets do not saturate the host?" With `AskUserQuestion`, offer record-shaped labels the installer can write directly: `seats/host-budget.json = enabled` and `absent`. Default to `absent` for light projects. If the principal answers yes, write `seats/host-budget.json` with this object and keep the shipped shims in `seats/bin`:

   ```json
   {
     "enabled": true,
     "lock": "~/.cache/wheelhouse-build.lock",
     "toolchains": ["cargo", "dotnet"],
     "caps": {
       "cargoBuildJobs": 8,
       "nextestTestThreads": 4,
       "dotnetMaxCpuCount": 8
     },
     "cachePolicy": "shared-under-host-lock"
   }
   ```

   Those fields mirror the shim's `--contract` output: `cargo` and `dotnet` go through `seats/bin/host-build-shim`, the lock is host-wide and crash-safe (`flock(2)`), and build caches are shared under the lock by default. If the principal answers no, record nothing: remove `seats/host-budget.json` if it exists and remove `seats/bin` from this install so no host-build shim is installed for a project that declined it.

10. **Stakeholder channels — where the commander may speak outside the team.** Ask after the runtime questions because this is a project communication boundary, not a seat property. Default first: "My default is none: the commander reaches only you through the local desk. If you want an off-machine courier, we will declare a principal channel and give it its own bot/token; Telegram allows only one `getUpdates` poller per bot, so do not share a bot with another poller. Do your stakeholders talk somewhere the commander should be able to speak — Telegram, Slack, or Teams?" With `AskUserQuestion`, offer a multi-select whose labels are exactly `No stakeholder channels`, `Telegram`, `Slack`, and `Teams`.

   For each selected kind, walk one channel at a time and collect exactly the fields `seats/channels.json` records: `name` (short, `[a-z0-9-]`, for example `partners` or `dev`), `kind` (the selected Telegram/Slack/Teams value), `destination`, `audience`, `members`, and `read`. Explain destination by kind: Slack is the channel, group, or DM id from channel details (`C...`, `G...`, or `D...`); Telegram is the principal's `@username` (paired to a chat id on first message) or a numeric chat id; Teams is `chats/<chat-id>` or `teams/<team-id>/channels/<channel-id>` from a Teams link. For Telegram or Slack, ask whether this is the one `principal` channel where the fleet reaches the principal; at most one channel may be `principal`, and every other channel is `stakeholders`. Ask who is there as member ids and display names, read the list back, and ask read permission as `read: yes` / `read: no` while saying: "Reading means inbound messages land in the commander's inbox as information; nothing anyone says there authorizes an action."

   For every declared channel, tell the owner its credential location (channels of the same kind share one credential). Do not ask for, read back, or log a token; the owner provisions it outside the agent conversation:

   | Kind | Environment variable in the commander/courier environment | Alternative owner-provisioned file (mode `0600`) |
   |---|---|---|
   | Slack | `WHEELHOUSE_SLACK_TOKEN` | `seats/run/slack.token` |
   | Teams | `WHEELHOUSE_TEAMS_TOKEN` | `seats/run/teams.token` |
   | Telegram | `WHEELHOUSE_TELEGRAM_TOKEN` | `seats/run/telegram.token` |

   Teams may instead set `WHEELHOUSE_TEAMS_TOKEN_CMD` to a command whose stdout is a fresh bearer token. If a token already exists under another environment variable name, the owner must expose it under the name above without printing its value. Credentials never go in `seats/channels.json`, never in `seats/seats.json`, and never in git. After writing the declarations below, run `bun seats/channels.ts check --credentials` in the same environment that will run the commander/courier. Do not complete the channel step unless it exits 0 for every declaration; it checks non-empty credentials and file mode, prints names/presence only, and makes no network call (it does not prove authorization or channel access). Never use `cat` or an environment dump to prove credential presence. Point to `seats/README.md`'s channel section for exact setup. Since question 4's reserved list includes communication outside the team, say that declaring stakeholder channels is the principal narrowing that reservation to exactly the channels in `seats/channels.json`, and write that same sentence into `wheelhouse/INTEGRATOR.md` beside the reserved list.

   The round ends in a read-back table, before anything is written: `name | kind | destination | audience | read | members`. If the answer was `No stakeholder channels`, the table is empty and the record still says so.

11. **Dynamic staffing — optional.** Ask after stakeholder channels because this is a seat-runtime shape, not a communication boundary. Start with the fixed-roster default and propose the option before asking for commitment: "My default is a fixed roster: the seats question 7 took, nothing scales. If you hold spare subscriptions, the fleet can staff itself: you list each subscription once (harness, provider, models, its own login folder), set a minimum and maximum for workers and for reviewers, and the fleet adds a seat when work piles up and drops one when it is quiet." With `AskUserQuestion`, offer labels exactly `Fixed roster` and `Dynamic staffing`, with `Fixed roster` first.

   If the principal skips the question or chooses `Fixed roster`, write no `seats/pool.json`; remove an existing one during reinstall/upgrade before continuing, and say in the read-back that the install is fixed-roster mode. The `seats/seats.json` you already planned remains exactly the roster from questions 7 and 8. Do not create an empty pool file as a sentinel: absence is the fixed-roster switch and `bun seats/pool.ts check` must print `pool: none (fixed roster)`.

   If the principal configures dynamic staffing, collect the pool as records shaped like `seats/pool.json.example`, not as prose. First choose which roles are pooled: `workers`, `reviewers`, or both. For every pooled role, the pool replaces the corresponding fixed roster role (`workers` replace `role: "worker"`; `reviewers` replace `role: "reviewer"`). Say that before collecting subscriptions, then remove those fixed rows from the planned `seats/seats.json`; non-pooled roles remain fixed exactly as questions 7 and 8 chose them. Keep commander, producer and researcher outside the pool. A dynamic worker pool does not remove any non-pooled reviewer; a dynamic reviewer pool does not remove fixed workers or the fixed verifier walker.

   Then collect one subscription entry at a time, with labels and fields that can be written directly. Use Q8's harness-round labels exactly — `pi`, `claude-code`, `codex` — and do not combine provider or model into that harness question. For each entry, collect: entry name (`[a-z0-9-]`, for example `claude-a` or `codex-b`), harness, provider id, offered models, login folder derived as `~/.pi-seats-<namespace>/pool/<entry>`, optional public label, and auth route (`oauth`, `api_key`, or `env`; no `default`). Provider and offered-model lists come from the same live sources question 8 uses for that harness, never memory: for `pi`, list as the entry account after `seats/seat-env.sh <namespace> --pool <entry>` with `PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/pool/<entry>" pi --list-models`; for `claude-code`, use that entry's `CLAUDE_CONFIG_DIR` account listing/resolution command before choosing the model; for `codex`, use that entry's `CODEX_HOME` account listing/resolution command before choosing the model. Reuse question 8's route rules: `env` is valid only where the harness driver supports it, and credentials never go in `seats/pool.json`. For each pooled role, collect `min`, `max`, the subscription entry names it may use, and the model for the role (one shared model string or an object keyed by entry). Require `0 <= min <= max`, `max` no larger than the listed subscriptions, and role models drawn from each entry's offered models; a role whose `min` equals its `max` is fine and means the role stays fixed at that count while still using pool identities.

   Refusals must name the fix in the same words the validator will use. If a pool would reuse a commander or fixed-seat login, say "fix: create a separate pool login" or "fix: move one account.dir so every seat is distinct". If role limits exceed subscriptions, say "fix: lower max or add entries". If a role model is not offered, say "fix: choose one of that entry's models". If a fixed row remains for a pooled role, say "fix: remove <seat> from seats/seats.json or remove <role> from the pool". If a login folder does not exist yet, say "fix: run seats/seat-env.sh <namespace> --pool <entry> and log in".

   The round ends in a read-back table before anything is written: `entry | harness | provider | models | login folder | label | auth route`, followed by `role | min | max | entries | model`. Say whether fixed worker/reviewer rows will be removed, and read back each login folder as the derived `~/.pi-seats-<namespace>/pool/<entry>` path. The acceptance checkpoint is explicit: "This will create `seats/pool.json` and validate it with `bun seats/pool.ts check`; choose `Fixed roster` instead?" If they choose `Fixed roster` at that checkpoint, take the skip path above and write no pool file.


12. **Publishing findings to GitHub: opt in only.** Default first: "My default is off: template-class findings stay as `Report <tool> issue:` tasks in the graph, and `wheelhouse/GRAPH.md` tells you to file them on the template repo by hand when this machine is not the template owner's. If you want the commander to publish them with one command, we turn on `github-report`; it needs `gh` installed and signed in as a login you are willing to post issues under (the template repo is public), seats never run it, and every body is scrubbed and refused if it carries a credential shape." With `AskUserQuestion`, offer labels exactly `github-report=off` and `github-report=on`. If the answer is `github-report=on`, also ask for extra routes as `<label>:<owner/repo>`, default none; empty routes keep the single default route `template-report` to the template repository parsed from `source=`.

   Write the answers into `wheelhouse/.template-source` with the same `sed -i.bak ... && rm -f` shape the namespace write uses, then read them back:

   ```bash
   sed -i.bak "s|^github-report=.*|<github-report=off or github-report=on>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
   sed -i.bak "s|^github-report-routes=.*|github-report-routes=<comma-separated routes or empty>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
   grep -E '^github-report(-routes)?=' wheelhouse/.template-source
   ```

13. **Nightly full-tier hour.** Default first: “My default is one full test run at **03:00 local time** each day. Core protects ordinary reviews; the nightly covers the rest, and a red nightly forces every review to full until a later nightly is green. What hour is this install available, outside any pause window?” Ask for an hour `00`–`23`, showing `03` as the default, and offer `sweep=off` only as an explicit opt-out. Record the answer rather than assuming this machine's pause policy. A `seats/run/paused` marker (or `WHEELHOUSE_SUPERVISOR_PAUSE_FILE` override) skips a due nightly; the installer does not modify an existing pause mechanism.

   Write and read back the chosen settings:

   ```bash
   sed -i.bak "s|^sweep=.*|<sweep=on or sweep=off>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
   sed -i.bak "s|^sweep-hour=.*|sweep-hour=<chosen local hour, default 03>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
   grep -E '^sweep(-hour)?=' wheelhouse/.template-source
   ```

   `WHEELHOUSE_SUPERVISOR_SWEEP_HOUR` can override the recorded hour. Point to `seats/README.md`, “Nightly full tier”, for logs, missed attempts, the red-review brake and safe manual retries.

### Record what the interview decided — the machine copies, before anything derives from them

The following machine records close the interview, in this order, because everything step 4 provisions and step 5 fills is a COPY of these records rather than a recollection of the conversation.

**First, the merge target, into `wheelhouse/.template-source`** — the machine record for the principal-confirmed branch new fleet branches integrate into:

```bash
sed -i.bak "s|^merge-target=.*|merge-target=<the merge target branch>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
grep '^merge-target=' wheelhouse/.template-source  # read it back; adapter dispatch uses this before origin/HEAD
```

Record the branch name (`main`, `staging`, `release/next`) rather than a mutable local checkout answer. The adapter resolves it as `origin/<name>` when that exists.

**Then the namespace, into `wheelhouse/.template-source`** — the machine record, the value `seats/seat-env.sh` is invoked with:

```bash
sed -i.bak "s|^namespace=.*|namespace=<the namespace>|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
grep '^namespace=' wheelhouse/.template-source     # read it back; this value is what every file below quotes
```

An install upgrading over a `.template-source` that has no `namespace=` line at all — every install predating this field — appends one instead; `runbooks/UPGRADE.md` covers that case.

**Then the host-build budget record, from question 9** — if the answer was `seats/host-budget.json = enabled`, write `seats/host-budget.json` exactly as the JSON object in question 9 and ensure `seats/bin/host-build-shim`, `seats/bin/cargo`, and `seats/bin/dotnet` are present and executable/symlinked as shipped by the template. If the answer was `absent`, remove `seats/host-budget.json` and remove `seats/bin`; the absence of the file is the adapter's switch, and the absence of `seats/bin` is the install's record that it did not opt in.

**Then `seats/seats.json`, from the read-back value** — the roster's machine record, in the format `seats/README.md` documents and `seats/seats.json.example` shows: the `commander` entry marked external, then the required producer entry (external for the subagent form), plus one entry per managed seat carrying exactly the six roster columns the interview collected — name and agent directory from question 7, harness, provider, pinned model, and auth route from question 8's read-back table — `account.dir` spelled under `~/.pi-seats-<namespace>/`, `harness` written as `pi`, `claude-code`, or `codex` (omitting it is allowed only for explicit Pi/default compatibility), and the auth route written as `account.authRoute` matching whichever route the seat's read-back row recorded. If every optional standing session was declined, write the file anyway with the commander entry and the explicit external producer-subagent entry under `seats`; an empty `seats` map is not the required producer. External subagent rows have no provider/model/account fields and skip question 8 and step 4. Read it back with `bun -e 'import fs from "node:fs"; console.log(JSON.stringify(JSON.parse(fs.readFileSync("./seats/seats.json","utf8")), null, 2))'` or equivalent so a syntax error surfaces now, at the moment of writing, not at the first spawn; then run `bun seats/roster.ts check` and stop on refusal: builder seats without a producer are not a valid install. Run that explicit check again after roster edits.

**Then `seats/pool.json`, only from question 11's accepted dynamic-staffing table** — if question 11 ended on `Fixed roster`, remove `seats/pool.json` if it exists and write nothing in its place. The absence of this file is the fixed-roster switch; verify that path with:

```bash
rm -f seats/pool.json
bun seats/pool.ts check    # expect: pool: none (fixed roster)
```

If question 11 accepted dynamic staffing, write `seats/pool.json` in the format `seats/pool.json.example` shows and then run `bun seats/pool.ts check` before step 4. Every generated pool must load through `pool.ts`; never hand-wave a pool that has not passed that check. If `pool.ts` refuses, stop and fix the machine records instead of editing around the validator: its message names the required fix, including missing login folders (`run seats/seat-env.sh <namespace> --pool <entry> and log in`), fixed roster conflicts for pooled roles (`remove <seat> from seats/seats.json or remove <role> from the pool`), impossible limits (`lower max or add entries`), and role models that are not in an entry's offered models (`choose one of that entry's models`).

A pooled role replaces the corresponding fixed rows in `seats/seats.json`: a `roles.workers` pool means no non-external `role: "worker"` entries remain in `seats.json`; a `roles.reviewers` pool means no non-external `role: "reviewer"` entries remain. That replacement is part of the generated records, not a runtime clean-up. Non-pooled roles remain in `seats.json` exactly as questions 7 and 8 selected them.

**Then `seats/channels.json`, from question 10's read-back table** — the channel machine record, in the format `seats/channels.json.example` shows. Write `{"version":1,"channels":{}}` when the answer was `No stakeholder channels` and no principal channel was declared; a file that says "nobody" is a record, while an absent file is an unanswered install question. Read it back immediately:

```bash
bun seats/channels.ts check --credentials    # require exit 0; names/presence only, then declared count (or none)
```

For every declared Slack, Teams or Telegram channel, have the owner provision its credential using question 10's exact locations before this check. A STOP names the missing kind's environment variable and mode-`0600` file; fix it and rerun, rather than completing the step or bypassing the send gate with a raw API call. Paste only the credential-free presence/count lines into the install log. An empty channel record still passes without credentials.

**Then `wheelhouse/interview/features.md`, from question 2e's corrected read-back** — commit this record with the install; do not create `wheelhouse/.install-features.json` or rely on a transcript that step 5 cannot read. Write a Markdown heading, one `Confirmed repo: ` line followed by a JSON-quoted question-1 repo path for each confirmed product repo (even one with no features), and one fenced `jsonl` block, with one JSON object per feature (found or owner-named). Each object has `repo` (the question-1 product path relative to the install root, `.` for a single repo), `slug` (a unique flat lowercase hyphenated name within that repo), `origin` (`[found]` or `[owner]`), `name` (the feature in user words) and `reach` (how a person reaches it). Use JSON string escaping, so punctuation and quoted owner words remain unambiguous; the `[owner]` origin marks every addition the scan missed. Preserve that owner's reach verbatim in the string. If it is unanswered, use `null`, never invented instructions. Include every confirmed feature, not just additions; explicitly record a confirmed empty list for a genuinely surface-less repo. Read the file back to the owner before moving on. In an umbrella install the shared record identifies each repo separately; do not compare one repo's map to another repo's answers. If the factory install is deliberately machine-local and excluded, retain this factory record with those files and report that exception rather than force-adding excluded paths.

## 4. Provision the seats

One pass per fixed roster seat and per dynamic pool entry, from the records just written — and if the roster took no seats and no pool entries, say so and move to step 5; this step then has nothing to do, which is a report, not a failure.

For each fixed seat in `seats/seats.json`, and for each accepted pool entry in `seats/pool.json` using the pool form `seats/seat-env.sh <namespace> --pool <entry>`:

1. **Provision the directory**: fixed seats use `seats/seat-env.sh <namespace> <seat-name>`; pool entries use `seats/seat-env.sh <namespace> --pool <entry>`. Both are safe to re-run. Fixed seats create `$HOME/.pi-seats-<namespace>/<seat-name>/`; pool entries create `$HOME/.pi-seats-<namespace>/pool/<entry>/`. The command writes `$HOME/.pi-seats-<namespace>/.project` as the backlink to this canonical project root (or STOPS if that namespace root already names a different project). The path name is historical and shared by every harness. For a `pi` seat or pool entry, provisioning also pre-grants Pi trust for the project root and prints `PI_CODING_AGENT_DIR=... pi` login help when needed. For a `claude-code` seat or pool entry, it must not require the `pi` binary and must not write `trust.json`; it prints `CLAUDE_CONFIG_DIR=... claude auth login --claudeai`. For a `codex` seat or pool entry, it must not require `pi` and must not write `trust.json`; it prints the recorded Codex login route. A MISSING or STOP line from provisioning is a stop for that fixed seat or pool entry.
2. **Give the seat its identity, by the harness and route question 8 recorded**:
   - `pi` + `oauth`: `PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" pi`, then `/login` inside the REPL, complete the browser flow, then `/exit`.
   - `pi` + `api_key`: write the seat's `auth.json` (`{"<provider>": {"type": "api_key", "key": "..."}}`, `0600`).
   - `pi` + `env`: export the provider env var in the shell that spawns the seat; do not write an `auth.json` stub because Pi checks `auth.json` before env.
   - `claude-code` + `oauth`: `CLAUDE_CONFIG_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" claude auth login --claudeai` (browser flow). This is the default Anthropic-subscription path.
   - `claude-code` + `api_key`: `CLAUDE_CONFIG_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" claude auth login --console` only when the principal explicitly chose the metered API-key route.
   - `codex` + `oauth`: `CODEX_HOME="$HOME/.pi-seats-<namespace>/<seat-name>" codex login` (or `codex login --device-auth` for headless).
   - `codex` + `api_key`: `printenv OPENAI_API_KEY | CODEX_HOME="$HOME/.pi-seats-<namespace>/<seat-name>" codex login --with-api-key`.
   Never paste a key into the conversation, the roster, or a bead. No `env` route exists for `claude-code` or `codex` seats; their drivers strip provider env vars from child processes so a subscription seat cannot silently bill a shell key.
3. **Verify the harness login before the binding probe**:
   - `pi`: `PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" pi auth check --provider <provider> --json` (or the current Pi equivalent when the CLI names it differently). Semantics: `pi auth check --provider <provider> --json     # {"status":"ready",...} exit 0 | {"status":"not_ready",...} exit 1`.
   - `claude-code`: `CLAUDE_CONFIG_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" claude auth status` must report `loggedIn true`.
   - `codex`: `CODEX_HOME="$HOME/.pi-seats-<namespace>/<seat-name>" codex login status` must report the chosen route (for ChatGPT OAuth, `Logged in using ChatGPT`).
4. **Run the per-harness binding probe** — the check that the seat's account, provider and model actually resolve TOGETHER:
   - `pi`: `PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" pi -p --no-session --provider <provider> --model <model> "Reply with exactly the word OK. Use no tools." </dev/null`
   - `claude-code`: `CLAUDE_CONFIG_DIR="$HOME/.pi-seats-<namespace>/<seat-name>" claude -p --output-format json --model <model> --setting-sources project "Reply with exactly the word OK. Use no tools." </dev/null`
   - `codex`: `CODEX_HOME="$HOME/.pi-seats-<namespace>/<seat-name>" codex exec --json --skip-git-repo-check -s read-only -c approval_policy=never -m <model> "Reply with exactly the word OK. Use no tools." </dev/null`

   Expect `OK` from the binding probe. For a pool entry, the equivalent machine check is `bun seats/adapter.ts probe --entry <entry>` after its login folder exists; it must print `OK` or a capacity-clear line and exit 0 before that subscription is counted as available. A probe that errors names the weakest link — dead login, missing key or env var, wrong model for the plan, revoked key — and the seat or pool entry is not provisioned until it answers. For a `pi` seat, both the auth check and the binding probe select the account through `PI_CODING_AGENT_DIR` plus the credential route recorded for the seat — measured: the same probe answers `OK` under a logged-in/file-key directory, answers `OK` under an env-route directory when the provider env var is exported, and says "No API key found" only when no usable credential route is present. `--no-session` keeps the Pi probe out of the seat's session history; the provider and model are the ROSTER's, spelled out, because the probe exists to test exactly that pair (a bare `--provider` falls back to the default provider silently — the l0e gotcha again, and here it would make the probe vacuous). If question 8 marked a pin provisional, the selected harness's listing/resolution check is mandatory here before the binding probe, and any correction updates both `seats/seats.json` and the roster table in `wheelhouse/fleet/SEATS.md`. Do not proceed to step 6's smoke loop claiming a seat or pool entry this probe has not passed.

A seat the probe fails and the principal cannot fix now is recorded as declined-for-now in `### Declined seats` with the probe's error as the reason — that keeps the roster honest about what actually exists, and moving it back is one interview question later.


## 5. Initialize the graph and write the install

- `bd init --skip-agents` in the project root; confirm the graph exists. Its output is verbose and mentions daemons, migrations and sync; that is normal and not an error. `--skip-agents` is load-bearing: a wheelhouse install never asks bd to write root `AGENTS.md`, `.agents/`, `.codex/`, or Claude/Codex setup into the product namespace. The integrations the wheelhouse actually needs are installed explicitly in the next block, at the paths this procedure owns. Review any bd auto-commit rather than being surprised by it in `git log` later.

  ```bash
  bd init --skip-agents
  test -d .beads || echo "FAIL bd init did not create .beads/"
  ```

  What IS worth stopping for: a non-zero exit, a refusal to create `.beads/`, or a message naming a conflicting existing database. Anything else, run `bd doctor`, paste the output, and continue — but know that on bd builds using the embedded backend (the current default) `bd doctor` prints "not yet supported in embedded mode" and diagnoses nothing; that message is itself a normal result, not a failure. Treat any upgrade suggestions as advisory.

- **Reinstall only the Beads integrations this install owns.** The commander needs bd's Claude `SessionStart` hook and a CLAUDE scaffold for the managed Beads block; the wheelhouse note belongs under `wheelhouse/AGENTS.md`, not at root.

  ```bash
  bd setup claude
  bd setup codex -o wheelhouse/AGENTS.md
  seats/install-fleet-pre-push-guard.sh || { echo "STOP: fleet pre-push guard installation failed" >&2; exit 1; }
  test -f .claude/settings.json || echo "FAIL bd setup claude did not write .claude/settings.json"
  test -f CLAUDE.md || echo "FAIL bd setup claude did not create CLAUDE.md"
  test -f wheelhouse/AGENTS.md || echo "FAIL bd setup codex did not write wheelhouse/AGENTS.md"
  test -x "$(git config --get core.hooksPath)/pre-push" || echo "FAIL fleet pre-push guard is not installed in core.hooksPath"
  echo "fleet pre-push guard installed at $(git config --get core.hooksPath)/pre-push"
  ```

  The single pre-push installer call protects the container and the distinct `product-repo=` recorded in `wheelhouse/.template-source`, respecting each repository's own `core.hooksPath` (including a shared `.beads/hooks`). It prints each installed hook and the existing guard script it invokes from the install's `seats/`; a product with no `seats/` is supported. Existing pre-push hooks are preserved and receive the same arguments and stdin after the fleet guard allows a push. Check that both repositories appear when they are distinct; a missing/invalid product path is a stop, not a successful container-only install. This is a bypassable tripwire, not separate write credentials.

  `bd setup claude` is the explicit replacement for the SessionStart hook that `bd init --skip-agents` deliberately skipped. It may create or update `CLAUDE.md`; the next steps write the commander content into that same file, keeping bd's managed block. Do not run a setup command that writes root `AGENTS.md`, and do not let `bd init` claim `.agents/` wholesale. Step 2 explicitly installs the shipped entries inside `.agents/skills/`, a shared namespace whose other entries remain product-owned. bd must not write there or anywhere else under `.agents/`.

- **Set the graph's role explicitly, immediately after `bd init`:**

  ```bash
  git config beads.role maintainer
  git config --get beads.role   # must print: maintainer
  ```

  Current bd builds set this themselves — measured on bd 1.2.2, a fresh `bd init` leaves `git config --get beads.role` printing `maintainer` — but older builds did not, and upstream tracks init and upgrade paths that leave it unset (gastownhall/beads#2950). Left unset, every bd command prints `warning: beads.role not configured (GH#2950)` on stderr, and role detection falls back to a deprecated remote-URL heuristic that reads a plain-HTTPS `origin` as `contributor`. That value is not cosmetic: the role drives bd's multi-repo routing, and `contributor` routes `bd create` — and with it `bd list` and `bd ready` — to a separate planning repository (`~/.beads-planning` by default) instead of this project's graph, which breaks "the graph is the single source of work state" without an error. `maintainer` is the right value here in every case, because a wheelhouse owns its graph at the install root by design; a principal who genuinely wants contributor routing is installing something other than what this procedure installs, and that is a decision to record, not a default to detect. The command is idempotent — if the role was already `maintainer`, setting it again changes nothing, and the read-back is the evidence either way.

- **Confirm the root agent namespace stayed product-owned.** Because step 1b stopped on ambiguous root `AGENTS.md` and step 5 ran `bd init --skip-agents`, the only healthy outcomes are: no root `AGENTS.md`, or the same product-owned committed root `AGENTS.md` step 1b reported. The wheelhouse note is `wheelhouse/AGENTS.md`.

  ```bash
  if git ls-files --error-unmatch AGENTS.md >/dev/null 2>&1; then
    echo "root AGENTS.md is committed and remains product-owned"
  elif [ -e AGENTS.md ]; then
    echo "FAIL root AGENTS.md exists but is not committed; ownership is ambiguous"
  else
    echo "root AGENTS.md absent; wheelhouse did not create one"
  fi
  sed -i.bak '/^AGENTS\.md$/d;/^\/AGENTS\.md$/d;/^\.agents\/$/d;/^\/\.agents\/$/d' .git/info/exclude 2>/dev/null || true
  rm -f .git/info/exclude.bak
  git check-ignore AGENTS.md >/dev/null 2>&1; test $? -eq 1 || echo "FAIL root AGENTS.md is still ignored"
  git check-ignore .agents >/dev/null 2>&1; test $? -eq 1 || echo "FAIL .agents/ is still blanket-ignored"
  test -f wheelhouse/AGENTS.md || echo "FAIL wheelhouse/AGENTS.md missing"
  ```

  On some bd builds the session-completion section mandates pushing ("work is NOT complete until `git push` succeeds", "NEVER stop before pushing"); on current builds it is conservative and says the opposite ("Do not commit or push without clear authority"). **Read `wheelhouse/AGENTS.md` before acting**, because one sentence of what you append depends on which one you have.

  Keep bd's useful content — the command reference is genuinely handy — and override the mandate. Append this to `wheelhouse/AGENTS.md` in every case, unchanged except for the project paths if this install is not at the repository root:

  ```markdown
  ## This project runs a wheelhouse — the rules above are overridden

  `CLAUDE.md` at this root and the contracts under `wheelhouse/` govern. Where they
  and the section above disagree, they win.

  Specifically: bd's conservative profile is not this fleet's definition of done.
  Workers still never push, merge, or close their own beads; they report branches
  for review. The commander/integrator then follows `wheelhouse/INTEGRATOR.md`:
  merge, push, PR, and deploy all the way through the recorded project authority,
  stopping only for the reserved actions written there or for a genuine fork in
  product intent.

  The bd command reference above is accurate and worth keeping.
  ```

  Then, **only if the file bd wrote mandates pushing**, append this one line after that block:

  ```markdown
  Ignore "landing the plane" as written above; land it by reporting.
  ```

  It is a second append rather than a line struck out of the first, because the conditional half is the half installers get wrong: a paste-then-delete leaves two installers on the same branch with different files, and an override quoting "landing the plane" into a conservative `wheelhouse/AGENTS.md` that never says it reads as an error to the next person who checks. Appending nothing is an easier instruction to follow exactly than deleting something.

  Say plainly in your hand-back that you did this and why. A principal or seat who later reads `wheelhouse/AGENTS.md` unaware of the override will be confused by it, and the fleet's behaviour will look like disobedience rather than policy. A seat may not cite bd's generated Conservative/default text as a reason to stop; the installed authority is `CLAUDE.md` plus `wheelhouse/INTEGRATOR.md`.
- The verbatim half — contracts, runbooks, the seats machinery, the bench stub — is already in place from step 2. What this step writes is the interview's half: the `## This project` fills below, plus `CLAUDE.md`, the ISA, and `STARTUP.md`. This includes `wheelhouse/crew/VERIFIER.md`'s project half: the install's named consumer surfaces for claim walks. The rule from step 2 holds while you do it: **not a single line of any `## Contract` section changes**; you append or fill ONLY below the `## This project` heading.

**How to fill a `## This project` section, precisely.** Find the FIRST line in the file that is exactly `## This project` — the whole line, nothing else on it. FIRST, not last: the integrity check below and `runbooks/UPGRADE.md` both stop at the first match, and a last-match rule would absorb project content into the contract half the moment a project section legitimately quotes that heading. Everything above that line is the contract and is not yours to touch; everything below it is yours to write. Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A contract may legitimately discuss its own structure, and a naive match has already destroyed one contract file this way — deleting a licensing-compliance rule while every automated check still passed.
- Fill each file's `## This project` section from the interview: the producer's territory, the worker's repos and its empty gotchas section, the reviewer's branch and worktree conventions, the verifier's named consumer surfaces, the bench's run-proof, and the integrator's push/PR/deploy authority plus reserved-action list — the last in the principal's own words, with the date, because it is the one section that records a permission rather than a fact. The standing line comes from question 4b, defaulting to all the way; the reserved list comes from question 4. If the principal gives a narrower line, write it as the project's line rather than editing the contract half.
- **The bench's five sections come from four answers — hold the mapping here, at the moment of writing, rather than recalling step 3's version of it.** Q2(a) fills *What proves it did its job*. **Q2(b) fills TWO**: the artifact half of the answer goes in *What the artifact is*, the setup-and-teardown half in *What is set up and torn down around the assertion*. Q2(c) fills *What the error scan looks for*, and Q2(d) fills *Prerequisites*. The two-for-one is what a writer loses between reading the question and filling the file, and the section that then goes unwritten is the artifact — which is clause 2's whole subject and the one thing a verdict has to name. A section the principal did not answer is recorded as unanswered, here as everywhere; what this bullet prevents is a section left empty because the answer was given and filed under the other heading.
- The integrator's third section, "How a shipped record gets corrected here", has no interview question on purpose: unless the principal volunteers a convention, fill it with the contract's own default — a follow-up commit naming the corrected commit's identifier, history never rewritten — and label it "adopted from the contract's default" so a later principal knows it was a default rather than their decision. Two cold installs both had to guess this; the default they guessed is now the documented one.
- Fill `wheelhouse/crew/VERIFIER.md`'s `## This project` section from a distinct consumer-surface interview moment. Ask the principal to name the surfaces a stranger can actually walk for this install's claims. For a template-style fleet, offer these defaults for confirmation: README front door on the template's merge branch, first morning / generated start prompt, and upgrade runbook from a real consumer baseline. For a product fleet, ask for the app's staging URL, emulator or launch command, CLI command, API endpoint, or other public entry point. At least one surface must be named, or the section records the honest gap: `no consumer surface yet — walks impossible, claims close not-walked`. Do not leave the project half blank; a blank verifier section makes the walk gate look configured when it is not.
- Fill `wheelhouse/fleet/SEATS.md`'s `## This project` section from the answers to questions 7 and 8, **both parts**, quoting the two machine records step 3 wrote — `namespace=` read back out of `wheelhouse/.template-source`, and `seats/seats.json` — rather than your memory of the conversation. **The roster first, under a `### Roster` heading**: an intro line naming the seat root the recorded namespace decides (`$HOME/.pi-seats-<namespace>/` and where it is recorded), then one line per seat that was taken, mirroring `seats/seats.json` column for column — name, role brief, harness, provider, model, auth route, agent directory (`account.dir`) — with the verifier row saying it is the consumer-surface walker when the project took one, and with the commander's line carrying its "the principal's own session, external in the roster" shape; `generated/SEATS.md.example` in the template shows the table. `seats.json` is the machine record and decides; this table is the human record and must agree with it. Then `### Declined seats`: one line per seat that was refused, carrying the reason in the principal's words and the date. A roster listing only what was taken is indistinguishable from one where the question was never asked, which is the reason the interview walks the seats individually in the first place. If every optional standing session was declined, the roster holds the commander and producer-subagent lines and the declined section holds the rest — that is a filled section, not an empty one. Add `### Walk cadence` as a pointer to the authoritative `walk_cadence_merges` value in `wheelhouse/INTEGRATOR.md`'s project half; do not duplicate the integer as a second source of truth. Its `## Contract` section — which carries the seat-accounting rule — stays verbatim like every other contract.
- Write `CLAUDE.md` at the root: commander-session context, product changes happen in product repos via workers, principal direction lands in `wheelhouse/ISA.md`'s Decisions and affected claim first, then `bun seats/isa-signals.ts sync` routes it to the producer before work depends on it; no dispatch happens without reading the ISA Goal; merges move Claims per `wheelhouse/INTEGRATOR.md`; the commander's verbs are route, dispatch, merge and report, and it never defines work or writes an intent or outcomes; new work the principal mentions reaches the producer immediately as intake signals, and the producer files the contracts; deadline tasks outrank everything; a tooling defect goes to the producer as a finding for a `Report <tool> issue:` task labelled `template-report` rather than a silent workaround, plus an `## Autonomy mandate` section carrying the principal directive from question 4b, the reserved actions from Q4, the merge policy from Q5, the rule that only reserved actions and genuine product-intent forks interrupt the principal, and the restart checklist: read ISA, read the graph, resume seats, pick up every in-flight branch or PR before starting new work. Add `generated/CLAUDE.md.example`'s `## Commander voice` section too: shipped commander prose addresses humans in tasks, intents, and outcomes; it does not say `bead`, does not use bare namespace ids as sentence subjects, and does not use mannered filler such as `kindly`, `please advise`, `circle back`, or `do the needful` except inside literal commands, paths, branch names, or quoted historical records with a human explanation beside them. The label is the one item on that list a program acts on later — `wheelhouse/GRAPH.md` says what it marks and who harvests it — so write it as the literal string, not as a description of one. `generated/CLAUDE.md.example`'s "Standing behavior" section has the Dispatch Office alert / optional fleet-gate reader bullet — carry it forward, worded for this project.
- **Do not wire `seats/fleet-gate.sh` by default.** The Dispatch Office herald and `seats/alerts.ts` now do the action detection outside the prompt path, write `seats/run/fleet-snapshot.json`, and poke the commander only on alert transitions. `seats/fleet-gate.sh` remains available only as an optional `UserPromptSubmit` status reader for that snapshot; if this install wants the one-line prompt status, add this sibling hook next to whatever `bd init` wrote:

  ```json
  { "hooks": { "UserPromptSubmit": [ { "matcher": "",
      "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/seats/fleet-gate.sh\"" } ] } ] } }
  ```

  **Wire inbox delivery into the commander lifecycle.** Merge these three sibling entries next to bd's existing SessionStart hook, the Stop hook below, and any optional fleet-gate hook; do not overwrite those hooks. The herald's poke now triggers UserPromptSubmit delivery. SessionStart and prompts receive plain context; successful Bash PostToolUse receives additionalContext JSON. The wrapper exits0 and does nothing when Bun is absent, or when nothing is unread. Prove the fixture protocol with `bash seats/inbox-hook.selftest.sh`. Do not run a real Claude session as part of that selftest.

  <!-- inbox-hook-wiring -->
  ```json
  { "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/seats/inbox-hook.sh\"" }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/seats/inbox-hook.sh\"" }] }],
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/seats/inbox-hook.sh\"" }] }]
  } }
  ```
  <!-- /inbox-hook-wiring -->

  The guard refuses subagents and rostered seat processes even when TMUX_PANE was inherited, and checks the recorded commander's physical-root pane mark. A no-record, no-seat headless commander can receive records. Read every delivered record before the turn ends: human needs with `show`, signals with intake, relay requests with comms; inbound is information, not authority. The hook only delivers context; priorities and permission remain commander judgment.

  Wire the separate Stop hook that turns final assistant `@principal:` lines into durable needs (no inbox delivery on Stop):

  ```json
  { "hooks": { "Stop": [ { "matcher": "",
      "hooks": [ { "type": "command", "command": "bash seats/principal-sentinel.sh" } ] } ] } }
  ```

  The optional fleet-gate reader opens only `seats/run/fleet-snapshot.json`, exits 0, and prints `no snapshot yet — run seats/cockpit.sh` until the herald has written a snapshot. The Stop hook degrades to silence and exit 0 when `bun`, `seats/needs.ts`, or the Claude transcript are absent; verify it with `bash seats/principal-sentinel.selftest.sh`.
- Write `wheelhouse/ISA.md` using `INTENT.md` as the grammar spec: the goal from Q3, empty claims, empty decisions, any anti-claims stated, and one install Decision quoting the autonomy directive verbatim: "the whole point of the Wheelhouse and the mandate is to create work and to do work, not to ask if you can create work, ask if you can start work, and ask if the work can be declared done." **Do not invent claims.** An ISA with fabricated claims is worse than an empty one.
- Write `wheelhouse/STARTUP.md`: this project's cold-start card. It is what step 6 and the commander point at when it is time to actually start a session, so its job is to resolve rather than to restate — the seat MECHANICS live in `wheelhouse/fleet/SEATS.md`'s "Running a seat" paragraph and in `seats/README.md`, identically in every project, and this file is where those mechanics meet this project's real namespace and real seat names. Make it at least as complete as `generated/STARTUP.md.example`: a title and one-paragraph durability note, the minimum viable fleet if this project has one, the four operating sections below, and the shutdown section. None are optional:

  1. **The commander.** `cd` to this project's real absolute root, then `claude`. Say that the folder's `CLAUDE.md` is what makes that session the commander, so no launcher is needed. Also say what the commander does first on a cold morning: if `wheelhouse/HANDOFF.md` exists, read it before the graph, then archive it to `wheelhouse/handoffs/<sign-off date>.md` per `wheelhouse/runbooks/RUNNING_THE_LOOP.md`'s "Next morning" section. No note is the normal first-morning state.
  2. **Provisioning and spawning, from the roster and pool records you have just written.** One `seats/seat-env.sh <namespace> <seat-name>` line per fixed roster seat, plus one `seats/seat-env.sh <namespace> --pool <entry>` line per dynamic pool entry if `seats/pool.json` exists — run once, safe to re-run — with a sentence saying it prints the one-time login flow for the harness and account that seat or pool entry should BE (`PI_CODING_AGENT_DIR=... pi`, `CLAUDE_CONFIG_DIR=... claude auth login --claudeai`, or `CODEX_HOME=... codex login` / key login, matching questions 8 and 11), and that the login-per-account rule is `wheelhouse/fleet/SEATS.md`'s seat-accounting section. Then the spawn lines: `bun seats/adapter.ts spawn <seat>` per fixed seat that is actually on the roster, plus `status`; if there is a pool, include `bun seats/pool.ts check`, `bun seats/staffing.ts status`, and say the herald runs staffing checks and staffs pooled workers/reviewers from `seats/pool.json` rather than spawning pool entries by fixed names. At wake, read `bun seats/staffing.ts status` beside `bun seats/adapter.ts status` when a pool exists. Add a sentence saying `resume` is the warm reattach after a stop or reboot. After a bead-bound spawn (`spawn <seat> <bead-id>`) or dispatch prepares the worktree, run `bun seats/adapter.ts skills-check <seat>` and stop on refusal; bare spawn starts at the install root, not a prepared worktree. Take the namespace, harnesses and names from the sections you have just written, not from your memory of the interview. There is nothing to paste into a seat — say so, because the role brief is injected at spawn. **Copy no seat name that is not on the roster or generated by the pool (`worker-<entry>` / `reviewer-<entry>`)**, and if the roster and pool took no seats, say that in place of this section rather than inventing a specimen seat.
  3. **Watching the fleet.** How dispatches go out (`bun seats/adapter.ts dispatch <seat> <bead-id> ...`) and where each seat's events land (`seats/logs/<seat>.jsonl`), with `bun seats/adapter.ts status` as the always-available liveness view. Then the bridge, by name, because it is real machinery this install just copied and a vague pointer here is the difference between a cockpit that gets used and one that gets rediscovered months in: `seats/cockpit.sh <namespace>` builds (or re-attaches to — it never duplicates, and a re-run respawns a missing floor pane) the project's tmux session `wh-<namespace>`, commander pane on the left, and `bun seats/floor.ts` on the right as the read-only floor — spotlight one seat, rail of every seat's attention cues. The supervisor owns the herald, desk, courier, dead-seat recovery, and nightly cleanup; cockpit records the commander pane in `seats/run/commander-pane.json` so the herald can aim itself. Write the real namespace into that line. Optional OS keep-alive is an explicit human step: on macOS, `seats/supervisor.sh install-launchd --print` writes `~/Library/LaunchAgents/com.wheelhouse.<namespace>.supervisor.plist` and prints the `launchctl bootstrap`/`bootout` commands without running them; on Linux, `seats/supervisor.sh print-systemd` prints a user unit to install by hand. Point at `seats/README.md`'s "The bridge" section for the keys and what each cue means rather than restating them.
  4. **How work reaches the fleet.** The principal speaks backlog items to the commander, which hands the signals to the required producer to judge and write contracts in the graph; the commander never writes intent or outcomes; workers report done on the task record with comments and the `needs-review` label without closing; reviewers gate branches with bench evidence; the commander/integrator closes only after merge per this project's merge policy. Use commander voice here too: say what the human task, intent, or outcome is, not just the internal graph id. Include step 6's exact signal-command paragraph and standalone command block in this section of the installed `wheelhouse/STARTUP.md`, including the one-row/no-other-action statement; do not leave them only in the install transcript.
  5. **Shutdown.** The end-of-day ritual from `wheelhouse/runbooks/RUNNING_THE_LOOP.md`, in order: dispatch each active seat a write-your-handoff request (the seat answers on its bead), compose the fleet note at `wheelhouse/HANDOFF.md` with per-seat status, waiting verdicts and tomorrow's first actions, and only then run `bun seats/adapter.ts stop-all`. Say that `stop-all` is graceful, keeps sessions, and reports busy seats instead of killing them. A plain machine shutdown loses nothing the graph holds, but it skips the handoff and makes tomorrow's commander start from raw state.

  Do not reproduce the contract's Running-a-seat prose here. A second copy of a contract's text in a generated file is a copy that drifts, and this one would drift in every project separately.

`generated/` in the template holds specimens of these files. They are examples of the SHAPE. Never copy them — they describe an invented project.

### Write the verification manual

For **each product repo from question 1** (the root in the single-repo shape), load the installed `.agents/skills/create-verification/SKILL.md` at the install root and follow it against that repo. Read `wheelhouse/interview/features.md` from step 3 and map every feature recorded for this repo, not just the scan's shortlist. Reconcile it with the source scan so later discoveries are not dropped. First list every recorded slug in the feature index, including owner-named additions. For an addition whose reach the scan cannot derive, use the owner's words in `## How to get to it`; if those words were not collected in question 2e, return to that interview question, not a guessed recipe. Keep an unanswered feature listed in the index but do not invent its file: `manual.ts check` must fail on that missing file until the owner supplies its reach. Write the five-section manual and complete feature map at that product repo's `.agents/skills/verify-<project>/`, where `<project>` is the repo directory's basename. The manual belongs in the product repo, not under `wheelhouse/`, because it is the project's property and travels with the code.

The create skill writes the real copy; the installer writes the compatibility link. From the install root, set `repo` to the actual product repo path from question 1 (`.` for a single repo), then run:

```bash
[ -n "${repo:-}" ] && [ -d "$repo/.git" -o -f "$repo/.git" ] || { echo "STOP: product repo required" >&2; exit 1; }
repo=$(cd "$repo" && pwd -P) || exit 1
project=$(basename "$repo")
mkdir -p "$repo/.claude/skills"
# If this path already exists, inspect it; do not overwrite another skill or link.
if [ ! -e "$repo/.claude/skills/verify-$project" ] && [ ! -L "$repo/.claude/skills/verify-$project" ]; then
  ln -s "../../.agents/skills/verify-$project" "$repo/.claude/skills/verify-$project"
fi
bun seats/manual.ts check --repo "$repo" || { echo "FAIL verification manual — stop" >&2; exit 1; }
```

Paste the check output. For a runnable repo expect `manual ok: N features`, and compare the map against the scan: the structural check cannot discover an omitted feature. Follow the create skill's own proof and cleanup instructions; do not describe an unrun recipe as verified. If the product genuinely has no runnable surface, follow its `surface: none` exception: two-sentence manual, empty feature index, no invented live proof. The check prints `manual ok: no surface` for that declaration; report it as stubbed, and the first work whose outcomes name a product surface owes Launch, Doctor, Drive, Evidence and Cleanup sections plus that surface's map entry.

Commit the manual and link **locally on that product repo's default line**, as recorded in the survey/interview. Check `git -C "$repo" symbolic-ref --short HEAD` against that record before committing; if it is detached, on another line, or has unrelated staged changes, stop and resolve the checkout with the owner rather than switching or merging their work. In an umbrella install, inspect status and stage only the new manual directory and compatibility link, then `git -C "$repo" commit -m "Add the verification manual for $project"`. In a single-repo install, include those exact paths in the step-5 install commit below, using that same subject. This product-owned manual is committed even when the factory files were deliberately excluded. The commit stays local: **never push from this step**; question 4b and `wheelhouse/INTEGRATOR.md` govern later push authority; creating a manual grants none.

### Verify — show the output, do not summarize it

Run each of these and paste what it prints:

- **Contract integrity — this one first, and stop if it fails.** (Upgrading rather than installing? `wheelhouse/runbooks/UPGRADE.md` is the procedure; it uses this same check, and step 0 there covers installs old enough to have no `.template-source` at all.) Every installed `## Contract` section must be byte-identical to the template's. Check each one:

  ```bash
  ROOT="$(pwd -P)"
  COMMIT=$(sed -n 's/^commit=//p' wheelhouse/.template-source)
  [[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || { printf "REFUSED template source: invalid commit='%s'; expected 7-40 lowercase hexadecimal characters\n" "$COMMIT" >&2; exit 1; }
  TEMPLATE=$(sed -n 's/^path=//p' wheelhouse/.template-source)

  # A missing or empty template path makes every comparison below vacuously true.
  # That is the failure mode this whole check exists to prevent, so refuse to run --
  # but try to recover first, because path= points at a mktemp directory the OS
  # eventually deletes, and an upgrade months later will always find it gone.
  # NOTE this makes the block more than a pure check: on a dead path it performs a
  # clone/fetch and rewrites the machine-local path= field. That is the whole of
  # its side effects; the contracts themselves are never written by this block.
  if [ -z "$TEMPLATE" ] || [ ! -s "$TEMPLATE/contracts/WORKER.md" ]; then
    SOURCE=$(sed -n 's/^source=//p' wheelhouse/.template-source 2>/dev/null)
    if [ -n "$SOURCE" ]; then
      CACHE_ROOT="$ROOT/wheelhouse/.template-cache"
      TEMPLATE="$CACHE_ROOT/source-head"
      [ ! -L "$CACHE_ROOT" ] || { echo "STOP: cache root is a symlink: $CACHE_ROOT" >&2; exit 1; }
      [ "$(cd "$ROOT/wheelhouse" && pwd -P)" = "$ROOT/wheelhouse" ] || { echo "STOP: wheelhouse is not the physical install directory" >&2; exit 1; }
      mkdir -p "$CACHE_ROOT" || { echo "STOP: cannot create cache root: $CACHE_ROOT" >&2; exit 1; }
      [ -d "$CACHE_ROOT" ] && [ ! -L "$CACHE_ROOT" ] || { echo "STOP: cache root is not a real directory: $CACHE_ROOT" >&2; exit 1; }
      CACHE_REAL=$(cd "$CACHE_ROOT" && pwd -P) || { echo "STOP: cannot resolve cache root" >&2; exit 1; }
      [ "$CACHE_REAL" = "$CACHE_ROOT" ] || { echo "STOP: cache root escapes install: $CACHE_ROOT" >&2; exit 1; }
      CACHE_PARENT=$(cd "$(dirname "$TEMPLATE")" && pwd -P) || { echo "STOP: cannot resolve cache parent" >&2; exit 1; }
      [ "$CACHE_PARENT" = "$CACHE_REAL" ] && [ ! -L "$TEMPLATE" ] || { echo "STOP: cache path escapes its real directory: $TEMPLATE" >&2; exit 1; }
      grep -qxF 'wheelhouse/.template-cache/' .gitignore 2>/dev/null || printf '%s\n' 'wheelhouse/.template-cache/' >> .gitignore
      echo "template path was dead; refreshing install-local cache from $SOURCE"
      if [ -d "$TEMPLATE/.git" ]; then
        git -C "$TEMPLATE" fetch --quiet --tags origin || true
        git -C "$TEMPLATE" fetch --quiet origin || true
      else
        rm -rf "$TEMPLATE"
        git clone --quiet "$SOURCE" "$TEMPLATE" || true
      fi
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
  # files, and leaves all but the first named contract unchecked while exiting 0. "$@" iterates
  # identically in bash and zsh. Found by a cold install run in zsh, 2026-08-20.
  set -- \
    fleet/WORKER.md:WORKER.md fleet/SEATS.md:SEATS.md \
    crew/REVIEWER.md:REVIEWER.md crew/PRODUCER.md:PRODUCER.md \
    crew/VERIFIER.md:VERIFIER.md crew/RESEARCHER.md:RESEARCHER.md \
    crew/BENCH.md:BENCH.md GRAPH.md:GRAPH.md INTEGRATOR.md:INTEGRATOR.md
  FAILED=0

  for pair in "$@"; do
    installed="$ROOT/wheelhouse/${pair%%:*}"; template="$TEMPLATE/contracts/${pair##*:}"
    test -s "$installed" || { echo "FAIL ${pair%%:*} — installed file missing or empty"; FAILED=1; continue; }
    # the contract is everything above the FIRST exact '## This project' line
    # Never adopt an old pid-named file: unlink only our exclusive allocations.
    compare_a=$(mktemp "${TMPDIR:-/tmp}/wh-a.XXXXXX") || { echo "FAIL cannot allocate contract comparison"; exit 1; }
    compare_b=$(mktemp "${TMPDIR:-/tmp}/wh-b.XXXXXX") || { rm -f "$compare_a"; echo "FAIL cannot allocate contract comparison"; exit 1; }
    awk '/^## This project$/{exit} {print}' "$installed"  > "$compare_a"
    awk '/^## This project$/{exit} {print}' "$template"   > "$compare_b"
    if diff -q "$compare_a" "$compare_b" >/dev/null; then
      echo "OK   ${pair%%:*}"
    else
      echo "FAIL ${pair%%:*} — contract differs from the template:"; diff "$compare_b" "$compare_a"; FAILED=1
    fi
    rm -f "$compare_a" "$compare_b"
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

- **Skills integrity.** Compare every shipped skill directory recursively and each shipped metadata file, not the shared parent: product verification manuals and feature maps are allowed beside them. Expect empty diff output and resolving relative compatibility links. Stop on any nonzero exit:

  ```bash
  # Template skills integrity
  for skill in intent outcomes; do
    test -f "$TEMPLATE/.agents/skills/$skill/SKILL.md" || { echo "FAIL template skill missing: $skill" >&2; exit 1; }
  done
  for src in "$TEMPLATE"/.agents/skills/*; do
    p=".agents/skills/${src##*/}"
    [ ! -L "$p" ] && diff -r "$src" "$p" || { echo "FAIL template skill differs: $p" >&2; exit 1; }
  done
  test -L .claude/skills/intent && test "$(readlink .claude/skills/intent)" = ../../.agents/skills/intent && test -f .claude/skills/intent/SKILL.md || { echo "FAIL intent skill link" >&2; exit 1; }
  test -L .claude/skills/outcomes && test "$(readlink .claude/skills/outcomes)" = ../../.agents/skills/outcomes && test -f .claude/skills/outcomes/SKILL.md || { echo "FAIL outcomes skill link" >&2; exit 1; }
  ```

- **Verification manual — repeat per product repo from question 1.** The create-verification skill above must have produced the product-owned manual and complete map. From the install root, set `repo` to that repo's path and `project` to its directory basename (do not reuse the last repo's values), then run and paste:

  ```bash
  bun seats/manual.ts check --repo "$repo" || { echo "FAIL verification manual — stop" >&2; exit 1; }
  test -L "$repo/.claude/skills/verify-$project" && test -f "$repo/.claude/skills/verify-$project/SKILL.md" || { echo "FAIL verification manual link — stop" >&2; exit 1; }
  # Compare this repo's interview record with the CLI's actual feature inventory.
  inventory=$(bun seats/manual.ts features --repo "$repo" --json) || { echo "FAIL feature inventory — stop" >&2; exit 1; }
  printf '%s\n' "$inventory"
  printf '%s\n' "$inventory" | bun seats/install-features.ts "$repo" wheelhouse/interview/features.md || { echo "FAIL interview feature map — stop" >&2; exit 1; }
  ```

  Require matching per-repo counts from `wheelhouse/interview/features.md` and `manual.ts features --json` (equivalently the JSON array's `jq length`), with every recorded slug present; a mismatch is a FAIL naming the missing or unrecorded feature, even when totals happen to agree. An owner-named entry must carry the recorded reach, not invented words. Stop and reconcile the interview and map on any failure. Require `manual ok: N features` and the resolving link. A declared `surface: none` prints `manual ok: no surface`; name that declaration, not a successful live journey. Read the feature inventory against the scan and report its count per repo. Any nonzero check or link failure stops this procedure just as a contract-integrity FAIL does; do not hand back a partial install as success.

- **Live manual evidence — finish this check in step 6, after Cleanup, not before the drive.** For each product repo with a runnable surface, from the install root with this repo's `project` set, run and paste:

  ```bash
  test -n "$(ls evidence/install/verify-"$project"/*/ 2>/dev/null)" || { echo "FAIL manual evidence missing after Cleanup — stop" >&2; exit 1; }
  ```

  This listing is only the presence check. Step 6 also requires `manual.ts evidence` for the selected feature and inspection of its actual end-state proof. A `surface: none` declaration is an explicit skip, never a successful live drive.

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

  **The bead carries the label `wheelhouse-bootstrap`, and that label is how step 6 finds it again.** Step 6 dispatches this bead minutes from now and has to pick it out of whatever else the graph holds; matching on its title, or on it being the only ready bead, works on an empty graph and nowhere else — a wheelhouse gets installed into projects that were already tracking their work here. The label is documented in this file rather than in `wheelhouse/GRAPH.md` because it is not a fleet signal: `GRAPH.md`'s `needs-review` marks a queue every bead passes through for as long as the fleet runs, while this marker is written here, read once by step 6, and never used again.

  **Look before you create — this is a step re-runs and upgrades repeat.**

  ```bash
  bd list --label wheelhouse-bootstrap --all
  ```

  If that names a bead, the bench bead already exists: create nothing, say which bead it is and what state it is in, and move on. A second one is worse than none, because two beads carrying the same marker put step 6 back to choosing, which is the whole thing the marker removes.

  If it prints `No issues found`, look once more before you conclude the bead is absent. An install made from a template older than this marker left a bench bead with no label on it, and the label filter cannot see it — `bd list --all` and read the titles. If one is there, stamp it rather than duplicating it, and say you did:

  ```bash
  bd update <id> --add-label wheelhouse-bootstrap
  ```

  Only when nothing answers to either:

  ```bash
  bd create "Implement wheelhouse/crew/bench.sh against wheelhouse/crew/BENCH.md" -p 1 \
    --labels wheelhouse-bootstrap --body-file /dev/stdin <<'CONTRACT'
Trace: install procedure wheelhouse-bootstrap carve-out.
Signal: install-procedure
Skills: install-procedure carve-out

Intent:
Implement the project's bench so the fleet can prove the software runs instead of relying on a successful build. The shipped stub exits non-zero; until it is implemented, no APPROVE may claim this project's software runs. Work in a worktree per wheelhouse/fleet/WORKER.md.

Outcomes:
- O1 The project bench proves the eight clauses in wheelhouse/crew/BENCH.md.
  consumer: machine — the verification runner checking this project's software
  surface: wheelhouse/crew/bench.sh
  check: run — the bench exits 0 on the project and prints the clause evidence BENCH.md names
CONTRACT
  bd ready                                 # must now list that bead
  bd ready --label wheelhouse-bootstrap    # must list that bead and nothing else
  ```

  Two things measured on bd 1.2.2, both of which turn a check into a no-op if you assume otherwise: `bd list --label` hides closed issues unless `--all` is given, so an install upgrading over a graph whose bench bead was already implemented and closed reads as a graph with no bench bead at all and files a duplicate; and an empty result exits 0, so the answer is in the text rather than the exit status. Establish both against the build you have.
- **Check the intent gate arrived with the seats machinery.** It is copied in step 2, but a missing file there strands the integrate/close hook the runbook now names.

  ```bash
  test -x seats/intent-check.sh
  bash seats/intent-check.selftest.sh    # expect: intent-check.selftest: PASS (... legs)
  ```

  The selftest is the important half: an executable file can still be an empty gate. It plants both passing and failing fixtures, including the distinct `UNRUNNABLE` exit for installs whose ISA is not committed.
- **Check the pruning tool arrived with the seats machinery.** It is copied in step 2, and it replaces the old one-off worktree pruning runbook.

  ```bash
  test -x seats/prune.ts
  bash seats/prune.selftest.sh    # expect: prune.selftest: PASS
  ```

  The selftest plants a closed merged worktree, a seat-anchored worktree, an orphaned checkout, build caches, closed/open bead scratch under `.wheelhouse-runs` and `/private/tmp`, fake bead-named simctl devices, an idle fake XCTestDevices set, a stale bench lock, and an active bench lock guard, then proves only the safe rows are touched by `prune --yes` and open-bead scratch remains byte-identical.
- **Check the stakeholder channel machinery arrived with the seats machinery.** It is copied in step 2 and later runbooks depend on it refusing undeclared channels before any transport call.

  ```bash
  bash seats/channels.selftest.sh      # expect: channels.selftest: PASS
  bash seats/transports.selftest.sh    # expect: transports.selftest: PASS
  bash seats/comms.selftest.sh         # expect: comms.selftest: PASS
  ```

  `channels.selftest.sh` proves the declared-channel file shape in `seats/channels.json`, including the no-channels record; `transports.selftest.sh` proves Telegram, Slack, and Teams can post/read-back/read against fakes without credential literals; `comms.selftest.sh` proves the single send gate.
- A grep of the files you generated for the template's specimen strings. Scope it to the install — `CLAUDE.md` and `wheelhouse/`, excluding `.beads/` — and use word boundaries, or the specimen name matches inside ordinary words:

  ```bash
  # Every term in this list must be checked against current contracts/ and runbooks/ before shipping;
  # a term that appears in copied contract prose false-fails every correct install.
  grep -rnwE "Ebb|ebb|Tideline|tideline|cordova|headless emulator|app-review|com\.example\.app|learn what a good one looks like|take it when the reviewer starts waiting" \
    CLAUDE.md wheelhouse/
  ```

  **Expect zero hits.** If specimen strings appear in the project's generated wheelhouse files, the install leaked and must be fixed before you report success. Root `AGENTS.md` is deliberately out of scope because it is product-owned; `wheelhouse/AGENTS.md` is covered by `wheelhouse/`.

  Those terms come from the template's own `generated/` specimens (the invented project) and `examples/` (the worked benches, which use invented projects of their own). If you are reading this in a template whose specimens have changed, the list is stale — check what `generated/` and `examples/` actually contain and grep for that instead. A hardcoded list that no longer matches the specimens passes everything. Before adding or broadening a term, run it against current `contracts/` and `runbooks/` too; every term must be proved specimen-only on the files a correct install copies.

  The first eight terms are names from the invented project, so any wholesale copy of a specimen trips them. `headless emulator` is deliberately phrased as the specimen-only example text rather than the bare word `emulator`, because `contracts/VERIFIER.md` legitimately asks projects to name an emulator command as a consumer surface. The last two are the reason texts from the declined-seats rows in `generated/SEATS.md.example`: a copy of just those two rows carries no project name, so the eight would match nothing and a partial leak of that section would walk through. They are phrases rather than words because every WORD in those rows — producer, worker, reviewer, second — is one a correct install writes for itself. For the same reason the roster seat names are deliberately absent: they are plausible real choices, and grepping for them would fail correct installs.

  Deliberately NOT in the list: "spending more time decomposing beads than deciding direction", which reads as the most distinctive line of that specimen and is not — `runbooks/PROMOTION.md` carries it verbatim, and runbooks are copied into every install, so adding it would fail every correct install on a file the installer never wrote. Any term you add here has to be checked against the template's `runbooks/` and `contracts/`, not only against `generated/`.
- A grep for unfilled placeholders. Anything you leave for the principal to fill uses `{{DOUBLE_BRACE}}` and nothing else, so this check is exact:

  ```bash
  grep -rIn "{{" CLAUDE.md wheelhouse/ | grep -v "^wheelhouse/runbooks/"
  ```

  Expect zero. `-I` makes the search text-only, so binary product assets such as PNG images cannot report `Binary file ... matches` just because its bytes contain the brace pair. The HTML comments in the contracts' `## This project` sections are guidance, not placeholders, and do not count here. `runbooks/` is excluded deliberately: runbooks are copied verbatim, so any brace syntax one ever carries is the template's text, not an unfilled blank the installer left. Before this exclusion the check failed on every correct install, on a file the installer never authored.

  What to do with them: **when you have content for a section, REPLACE its comment with that content. When you have nothing, leave the comment where it is.** The comment is a prompt for whoever fills the section later, so it stops being useful the moment the section is filled — and a section carrying both guidance and content reads as though the content is an example of what to write.
- **Confirm the bench stub fails.** It is the one file whose whole job is to exit non-zero:

  ```bash
  bash wheelhouse/crew/bench.sh; echo "bench stub exit=$?"   # must be non-zero
  ```

  A stub that exits 0 would let the first behavioral APPROVE through on nothing.

- Confirm `wheelhouse/runbooks/` contains every runbook the template ships — count them in the template rather than trusting this sentence (currently three: `PROMOTION.md`, `RUNNING_THE_LOOP.md`, `UPGRADE.md`):

  ```bash
  ls wheelhouse/runbooks/
  ```

  `SEATS.md` and `STARTUP.md` link to these by path, and a missing runbook is a broken link at the moment someone needs it.

- **The seat namespace agrees with itself across the three places it appears.** It was one answer at the interview and is now a machine record (`namespace=` in `.template-source`), a human record (the roster's agent directories in `fleet/SEATS.md`), and the directories `seats/seats.json` actually records — and nothing so far has compared them. Skip this only if the roster took no seats — with no seats there is nothing to name.

  ```bash
  NS=$(sed -n 's/^namespace=//p' wheelhouse/.template-source)
  test -n "$NS" || echo "FAIL no namespace= recorded in wheelhouse/.template-source"
  awk '/^### Roster$/{f=1;next} /^### /{f=0} f' wheelhouse/fleet/SEATS.md \
    | grep -qE "pi-seats-$NS([^A-Za-z0-9_-]|\$)" \
    || echo "FAIL SEATS.md's roster does not record agent directories under the root for '$NS'"
  grep -oE "pi-seats-[A-Za-z0-9_-]+" seats/seats.json | sort -u
  ```

  **The middle check is a comparison rather than a search, and both halves of the pattern are load-bearing.** Scoped to the roster section, because the namespace is usually a word this file says anyway — the project's own name — so a bare `grep "$NS" SEATS.md` passes on the prose, on the contract half, on any sentence that happens to mention the project. It answers "does this string occur" when the question is "is this string *recorded*". Matched on the ROOT (`pi-seats-$NS`) rather than the bare namespace, and with a non-name character required after it, so a namespace that is a substring or extension of a sibling fleet's does not pass on the sibling's directories.

  Read that last listing rather than counting it: every root it prints out of `seats/seats.json` should be `pi-seats-$NS` and nothing else. A roster whose directories sit under another root is an install pointed at another fleet's seats — the collision `wheelhouse/fleet/SEATS.md`'s seat-accounting section describes — and the absence is invisible until two fleets share a machine.
- Confirm every file you created exists and is non-empty.
- Print the resulting tree.

### Commit

Commit the install so the principal can see exactly what was added and revert it in one step:

```bash
git status --short          # look first: bd init may have added files AND a commit you did not expect
# Stage each install path ONLY if that status output actually shows it. bd may commit some of
# them itself (.beads/ routinely); root AGENTS.md and .codex/ remain product-owned.
# Reuse the checked TEMPLATE from skills integrity; if it is not in this shell, re-run that
# source-recovery/integrity step first. Never stage the shared .agents/skills/ parent.
[ -n "${TEMPLATE:-}" ] && [ -d "$TEMPLATE/.agents/skills" ] || { echo "STOP: checked TEMPLATE required for shipped skill staging" >&2; exit 1; }
# An install kept out of the tree with .git/info/exclude shows none of these install paths.
for p in CLAUDE.md .claude/ wheelhouse/ .beads/; do
  if [ -n "$(git status --short -- "$p")" ]; then git add -- "$p"; fi
done
for src in "$TEMPLATE"/.agents/skills/*; do
  p=".agents/skills/${src##*/}"
  if [ -n "$(git status --short -- "$p")" ]; then git add -- "$p"; fi
done
git status --short          # read what is staged; commit using the shape-specific block below
```

**Single-repo shape:** add the product-owned manual explicitly, never the shared skills parent. Confirm this is the recorded default line and there are no unrelated staged changes, then commit the manual together with the install:

```bash
project=$(basename "$(pwd -P)")
for p in ".agents/skills/verify-$project" ".claude/skills/verify-$project"; do
  if [ -n "$(git status --short -- "$p")" ]; then git add -- "$p"; fi
done
git status --short
git commit -m "Add the verification manual for $project"
```

**Umbrella shape:** the product manuals were committed in their own repos above; commit the container's install with `git commit -m "Install the wheelhouse: contracts, briefs, and the work graph"` if its staged diff is nonempty. Neither shape pushes from this step.

The loop is the rule below — "never `git add` a path you have not seen in the status output" — written as something you can run, and it is a loop rather than one `git add` line because `git add` is atomic: a single absent pathspec fails the whole command having staged nothing. It is an `if` rather than an `&&` chain because the chain form reports the healthy path as a failure. A loop's exit status is its last iteration's, and `guard && git add` exits non-zero whenever that guard is false — so an install with nothing left to stage, which is the ordinary outcome when bd has already committed `.beads/`, ends on a non-zero status and any caller, CI step or wrapper that reads it calls the install failed. Measured at exit 1 in that state under bash, zsh and sh; the `if` form exits 0 in every state. It does NOT abort a `set -e` script mid-run — `A && B` is an AND-OR list, which `set -e` exempts, and execution continues past the false guard in all three shells. The list is a list of CANDIDATES; status decides. Anything else this install wrote — a `.gitattributes` bd added, a `.gitignore` you appended to below — you add to the candidate list yourself after seeing it in that first status.

**Not every factory install commits.** If step 3 landed on a single repo whose factory files you kept out of the tree with `.git/info/exclude`, `CLAUDE.md`, `wheelhouse/` and `.beads/` are excluded on purpose: do not force-add them. The product-owned verification manual and its link are not factory state: do not exclude them, and commit their exact paths as above. Tell the principal which factory files remain machine-local, with the two consequences they will otherwise meet later: the factory's revert-in-one-step above is not available to them, and a second seat cloning that repo receives none of those factory files and has to repeat the exclusion by hand.

Before you stage, confirm the fleet's runtime directories are already invisible to this repository. The adapter creates each worker seat's worktree at `<root>/.wheelhouse-worktrees/<seat-name>` and per-bead scratch under `<root>/.wheelhouse-runs/<bead-id>/` in both supported shapes, because that is the single pair of paths the adapter, the cleanup reaper, and the seat trust model agree on. Both are runtime state, not product, and the template's tracked `.gitignore` already lists `.wheelhouse-worktrees/` and `.wheelhouse-runs/`, so there is no `.git/info/exclude` step to take for them. Check rather than assume:

```bash
git check-ignore -v .wheelhouse-worktrees/x .wheelhouse-runs/x   # both lines must name a .gitignore rule
```

Measured: in a fresh install, `git status --short` at the install root reports nothing for either directory once they exist, and `git check-ignore` names the tracked `.gitignore` line for each. If the check prints nothing for one of them, the install's `.gitignore` drifted from the template's; restore those two lines from `$TEMPLATE/.gitignore` before staging. If this checkout sits inside some other repository, that outer repository is not this install's to edit; say so to the principal rather than leaving dirt they will find later and attribute to their own working copy.

Stage what `git status` actually shows, not a remembered list. What bd writes varies by build: some versions add `.gitattributes` (graph merge behaviour — include it if present, or the next clone loses that behaviour silently), and the explicit Claude setup adds `.claude/`; include those when status shows them. Root `AGENTS.md`, `.agents/` beyond the explicitly installed shipped skill entries and the product manual written above, and `.codex/` remain product/tool namespaces: do not stage them unless the principal explicitly identified a product-owned file. Never `git add` a path you have not seen in the status output — `git add` is atomic, and one nonexistent pathspec fails the whole command having staged **nothing**, which leaves you believing the commit is prepared when it is empty.

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

Do not infer push policy from bd's generated agent profile. Push, PR, and deploy authority is whatever `wheelhouse/INTEGRATOR.md`'s project section records from question 4b; workers still do not push their own branches.

## 6. Close the loop — prove the manual, then the smoke dispatch that proves the fleet

You are a session in the directory whose `CLAUDE.md` you just wrote, and that file says a session in this directory is a commander session. So you are the commander already, and the first commander action is yours to perform rather than to recommend. An install that ends on a reading list gives the principal the standards, the procedure and the homework, and leaves the loop unstarted — which is the one thing the install exists to start. Observed on a real install, 2026-08-21: every file was correct and nothing was running.

Step 5's checks verified the FILES. This step first proves one live journey per runnable product manual, then verifies the FLEET, by the only measure that means anything: one bead travels the whole loop — dispatched through the adapter to a real seat, worked, reported with evidence, and judged by the reviewer — and the verdict lands where the graph can read it. Until that has happened once, "the install works" is a claim about bytes on disk.

Six things, in this order. The manual proof needs no seat and is not waived by the smoke loop's no-seat skip.

**1. Hand back what is now true.** Plainly, and with the two halves kept apart, because a principal who cannot tell them apart will trust the stubs:

For any `surface: none` repo, list its two-sentence manual and empty feature index as stubbed, not live-proven; the first surface-naming work owes the five manual sections (including Launch and Drive) and that surface's map entry.

- what exists — the files, each product repo's verification-manual path and number of mapped features, the graph, the shape you installed and where worktrees go, the merge policy, the fleet's push/PR/deploy authority, and the reserved actions in the principal's own words, and anything you corrected on the way through: the `wheelhouse/AGENTS.md` override from step 5, any `GRAPH.md` status correction from its verification, and which `.beads/` durability shape you found at its commit and what was chosen about it;
- what is deliberately STUBBED and therefore not yet true — any repo declaring `surface: none` has no live journey yet (name each one), `wheelhouse/crew/bench.sh` exits non-zero on purpose, the worker's gotchas section is empty because gotchas are earned rather than invented, and the ISA's claims are empty for the same reason.

**2. Read the loop you are about to run.** `wheelhouse/runbooks/RUNNING_THE_LOOP.md`, now, before the dispatch below — you are executing its first stage later in this step, not filing it for someone to read later. The contracts say what each role owes; that runbook says what the sequence looks like and what to do on the days it does not go straight through, and whoever has the contracts and not the runbook has the standards and no procedure. The role contracts are then read at the stage that needs them — `wheelhouse/fleet/WORKER.md` when you dispatch, `wheelhouse/crew/REVIEWER.md` when a branch lands, `wheelhouse/INTEGRATOR.md` when one is approved, `wheelhouse/GRAPH.md` for the review queue — and the runbook's closing table says which is which. That is the reading list, and it is a step inside this action rather than a parting gift.

**3. Prove the manual — one mapped feature live, not the whole map.** Repeat for each product repo from question 1. Read its `.agents/skills/verify-<project>/SKILL.md` and `features/README.md`. If it declares `surface: none`, name the repo and skip only this live proof. Otherwise choose the **first feature listed in that map's README**, using its linked file's slug as `feature`; an empty runnable map stops the install, not an implicit skip. Do not substitute the easiest feature or merely re-run a build.

Follow the manual itself, in its five-section order, pasting commands, exit statuses and observed output into the install transcript:

1. **Launch:** use isolated scratch state and a non-production port/socket, never an installed service. Set a finite run bound and teardown for every helper and any app you start before launching; retain PID/identity ownership so cleanup stops only your instance. Observe and paste the manual's ready condition; a live process alone is not ready.
2. **Doctor:** run its checks against that test instance and paste their output. Require the manual's passing result before driving.
3. **Drive:** follow the selected feature's `How to get to it` and `How to drive it`. Paste the actions and what you actually observed; require the exact end state in `What proves it works`. One mapped feature per repo is sufficient; the other features are not claimed driven.
4. **Evidence:** follow the manual's capture recipe, directing retained proof to the absolute install-root path `evidence/install/verify-<project>/<feature>/` (the manual's evidence base is `evidence/install/verify-<project>`). Keep this outside disposable run state, even for an umbrella product repo. Retain the response/screenshot or equivalent end-state proof, commands/statuses and launch/doctor output, not just a ready line. Do not put secrets in captures. This is retained, git-excluded install evidence, not product source: transcribe the scrubbed decisive output onto the graph before citing it, per `wheelhouse/GRAPH.md`.
5. **Cleanup:** always run the manual's teardown, **including after a failed Launch, Doctor, Drive or Evidence step**. Do not delete the retained proof. Confirm no owned app/helper remains running; on a partial launch, join the failed child and retain both output streams/status even if later-step files were never created. Never signal a replacement or unrelated process.

After Cleanup, return to the **install root**, set `repo` to this product repo's path, `project` to its basename and `feature` to the selected slug, and run:

```bash
bun seats/manual.ts evidence "$feature" --repo "$repo" --dir "evidence/install/verify-$project" || { echo "STOP: the manual's Evidence step failed: proof missing after Cleanup" >&2; exit 1; }
test -n "$(ls evidence/install/verify-"$project"/*/ 2>/dev/null)" || { echo "STOP: the manual's Evidence step failed: empty retained proof" >&2; exit 1; }
```

Paste the retained file listing and inspect its contents against the feature's named end state **after** teardown: `manual.ts evidence` checks file presence, not whether the journey worked. In the hand-back name each repo, the feature driven and its evidence path; do not say the proof exists until these post-cleanup checks pass.

**A failed proof STOPS the install before the smoke loop.** A Launch that never reaches ready, a failing Doctor, a Drive ending anywhere other than the entry names, an Evidence capture failure or evidence missing after Cleanup is a failed install. Name the step and observed output, for example `the manual's Launch step failed: <observed output>`. Run Cleanup even on that path, report any cleanup failure too, and do not continue to the smoke loop or report the install finished. Fix the named failure and repeat the proof before proceeding.

**4. Run the smoke loop — the install's own verification, and the fleet's first revolution.** It runs whenever step 4 left at least one worker seat with a passing probe; the one legitimate skip is below.

1. **Spawn what the smoke needs**, per `wheelhouse/STARTUP.md`: with a fixed worker, spawn it (`bun seats/adapter.ts spawn <worker-seat>`); with a dynamic worker pool, run `bun seats/staffing.ts check` now and use the first staffed worker it creates. Confirm with `bun seats/adapter.ts status` and, when a pool exists, `bun seats/staffing.ts status`. The reviewer used for `seats/verify.ts` needs no spawn — the dispatcher starts its one-shot verdict process at the moment of judgment. The verifier/walker also needs no spawn; `seats/walk.ts` starts it when a claim walk is due.
2. **File the smoke bead**, sized to prove plumbing and nothing else:

   ```bash
   bd create "Smoke: prove the loop closes" -p 1 --labels wheelhouse-smoke \
     --body-file /dev/stdin <<'CONTRACT'
Trace: install procedure wheelhouse-smoke carve-out.
Signal: install-procedure
Skills: install-procedure carve-out

Intent:
Prove that this install's loop closes: a worker receives work, commits a result, reports evidence on this bead, and an independent reviewer delivers a verdict. Keep the work trivial so any failure exposes the plumbing rather than product ambiguity. Work in a worktree per wheelhouse/fleet/WORKER.md; the branch itself is disposable once the verdict lands.

Outcomes:
- O1 The committed smoke result contains exactly the single line 'the loop closes'.
  consumer: machine — the reviewer checking this install's smoke result
  surface: branch fleet/<this bead's id>, file SMOKE.md
  check: run — git show fleet/<id>:SMOKE.md prints exactly the loop closes
- O2 The report lists the skills the seat can see, including intent, outcomes, create-verification, maintain-verification and the project manual.
  consumer: person-reading — the installer reading the real seat's report
  surface: the smoke bead's report comment
  check: read — the report pastes the harness-level skills listing, not only the filesystem check
CONTRACT
   ```

   Trivial is the point: the bead exists to exercise dispatch, worktree, branch, report and verdict, and any failure it surfaces is an install failure, undiluted by real work's ambiguity.
3. **Dispatch it through the adapter, and wait on the bead**: `bun seats/adapter.ts dispatch <worker-seat> <bead-id> <the dispatch text>` — composed per the runbook's stage 1: the bead id, the repo, a way to read anything it points at that changes nothing. The report arrives ON THE BEAD, not in a message; a silent seat gets the probe-then-nudge from `wheelhouse/fleet/SEATS.md`'s rules, not a guess.
3a. **Check every prepared standing seat's skills**, after smoke dispatch has created its worktree. Run from the install root and paste the listings. This is a filesystem/Git check, not the real harness listing required in the smoke report. For other standing seats with worktrees, prepare them with a bead-bound spawn or dispatch first; bare spawn starts at the install root. A non-zero result stops this install naming the seat and missing/dirty skill; do not report the install finished.

<!-- factory-skills-check:start -->
```bash
bun seats/roster.ts check || exit 2
skill_seats="$(bun -e '
import fs from "node:fs";
import path from "node:path";
import {effectiveRoster} from "./seats/roster";
const state = fs.existsSync("seats/state.json") ? JSON.parse(fs.readFileSync("seats/state.json", "utf8")) : {seats: {}};
for (const [name, entry] of Object.entries(effectiveRoster(process.cwd()))) {
  if (entry.external || entry.role === "verifier") continue;
  const candidates = [state.seats?.[name]?.cwd, path.join(".wheelhouse-worktrees", name)].filter(Boolean);
  const prepared = candidates.some(cwd => {
    try { return fs.lstatSync(path.join(cwd, ".git")).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  if (prepared) console.log(name);
}
')" || exit 2
while IFS= read -r seat; do
  [ -n "$seat" ] || continue
  bun seats/adapter.ts skills-check "$seat" || {
    printf 'STOP: skills-check failed for seat %s; repair the named skill before finishing install.\n' "$seat" >&2
    exit 2
  }
done <<< "$skill_seats"
```
<!-- factory-skills-check:end -->

The adapter hides only the individual factory links, with exact Git exclude
entries **without trailing slashes**. A trailing-slash rule matches a directory,
not the symlink Git sees; never hide the whole skills directory, because new
project manual/map files must remain visible.

4. **Verdict, by the one-shot reviewer**: `bun seats/verify.ts <bead-id> fleet/<bead-id> <worker-seat>`. The exit code IS the verdict — 0 APPROVE, 2 BOUNCE, 3 DISCOVER, 1 error/malformed output, 4 reviewer busy (retry later), 5 no-verdict (reviewer ended without a judgment), 6 refused: not a contract — and the full output lands in `seats/verdicts/<bead-id>.md`, which git ignores because it is a working copy. **Transcribe the decisive extract onto the bead before citing it** (`wheelhouse/GRAPH.md`, "Where evidence lives"), then close the smoke bead naming the verdict. If the roster has no reviewer seat, or `verify.ts` refuses because the only reviewer shares the author's account, the verdict comes from the solo path instead — the principal, or a fresh session that authored nothing — recorded on the bead in the same shape, and say plainly that the mechanical reviewer leg went unexercised. Before the install's first ISA claim closes, run the first claim walk with `bun seats/walk.ts <claim-ref> --surface <kind>:<spec> --out .wheelhouse-runs/<bead-id>/<surface-walk> --verifier <verifier-seat>` and post the scrubbed walk transcript and verdict on the task before citing them in the claim (the local output is a git-excluded working copy, not something to commit), or state `Not walked:` explicitly per `INTENT.md`.
5. **The loop closing IS the install verification.** A BOUNCE or an error is not an embarrassment to smooth over — it is the install failing loudly at the cheapest possible moment, and it stops this procedure exactly as a FAIL in step 5 would: diagnose, fix, re-run the smoke. Merging the one-line branch is not required for the verdict to count; whether it merges or is deleted is the principal's call under question 5's policy.

6. **Show the owner the skills and the one signal command.** Load `.agents/skills/intent/SKILL.md` and `.agents/skills/outcomes/SKILL.md` to show the owner the two contract-writing skills now installed at the root (also readable through `.claude/skills/intent` and `.claude/skills/outcomes`). **Print the following paragraph and command block in the install transcript, saying them aloud to the owner**, and confirm that step 5 wrote the same text into `wheelhouse/STARTUP.md` under “How work reaches the fleet.” Do this even when the smoke loop is skipped:

   Any script, hook or person hands this factory a signal with one command: `bun seats/intake.ts post --kind <goal|isa-change|report|error|finding> --source <name> --title <one line> --text <body>`. Each call adds one row to seats/intake.jsonl and does nothing else; the producer reads it from there.

   ```bash
   bun seats/intake.ts post --kind <goal|isa-change|report|error|finding> --source <name> --title <one line> --text <body>
   ```

   Replace the angle-bracket placeholders with values (choose one kind; quote multiword title/body arguments); show this syntax, do not execute a placeholder command or post a signal on the owner's behalf.

**The one legitimate skip.** If step 4 provisioned no seat that passed its probe — every optional managed seat declined, or every provisioning attempt failed and was recorded — the smoke loop has nothing to run on. Skip it SAYING SO, with the reason, in the hand-back and on the record (the declined-seats section already carries it): the solo-install doctrine holds, the commander plus its required producer subagent is a working install, and the first real bead below then runs the loop's solo path as its own de-facto smoke. What is not legitimate is skipping it quietly, or skipping it while a probed seat sits idle.

**5. Make the first real dispatch.** Read the graph rather than your memory of it:

```bash
bd ready                                 # the graph you are dispatching into
bd ready --label wheelhouse-bootstrap    # the bead step 5 left for you
```

The second command is the one that finds the bead; the first is there so you see what else is in flight before you dispatch into it (the closed smoke bead is not among it). Step 5 stamped the bench bead with `wheelhouse-bootstrap` for exactly this handoff, because on a graph that already held work — the ordinary case for a project adopting a wheelhouse — "the ready bead step 5 created" is not something `bd ready` alone can tell you.

That bead is real work rather than a placeholder: implement `wheelhouse/crew/bench.sh` against `wheelhouse/crew/BENCH.md`. It goes first because until the bench is real no verdict on this project may claim its software runs, so every approval until then is an approval of a diff somebody read. Dispatch it per the runbook's stage 1 — name the bead id and the repository, give a way to read anything it points at that changes nothing, and state done if the bead does not already state it.

Two answers are not one bead, and neither is a reason to guess which bead was meant:

- **Nothing listed.** On bd 1.2.2 that prints `No ready work found` and exits 0, so read the text. `bd list --label wheelhouse-bootstrap --all` separates the two causes. If it shows a CLOSED bead, this install went in over a graph whose bench was already implemented — say so, and make the first dispatch from the highest-priority bead `bd ready` does show. If it shows nothing at all, step 5 did not complete; go back and finish it there, where its verification runs, rather than creating the bead here.
- **More than one.** An earlier partial run left a duplicate. Say so to the principal and dispatch none of them until you are told which one is live — a duplicate bench bead is cheap to resolve now and expensive after two seats have worked it.

Where that dispatch goes depends on the per-seat answers from step 3's questions 7 and 8. Read the roster in `wheelhouse/fleet/SEATS.md` rather than your memory of the conversation:

- **A worker seat is on the roster.** The seats are provisioned from step 4 and the worker is already spawned from the smoke loop; spawn any the roster names that are not running yet, then dispatch the bead to the worker. The procedure is written down twice over, deliberately: `wheelhouse/fleet/SEATS.md`'s "Running a seat" is the contract's one paragraph — `seats/seat-env.sh` once per seat, the one-time login as that seat's own account, then `bun seats/adapter.ts spawn` and `dispatch`, with `seats/README.md` documenting every command — and `wheelhouse/STARTUP.md` is the same steps with this project's namespace and seat names already substituted. Follow `STARTUP.md`; if it is thinner than what you just wrote in step 5, the contract is the authority and the STARTUP.md you wrote is the thing to fix. Then hold the commander's seat and wait for the report to arrive on the bead, not in a message.
- **No worker seat.** Say so, and take the worker seat yourself for this one: claim the bead, work in a worktree at the location step 3 recorded, and report on the bead the way `wheelhouse/fleet/WORKER.md` requires of anyone.

Then check the roster for the reviewer, whichever branch you took. The one role the author of a change may not also hold is the reviewer's for that same change — `wheelhouse/crew/REVIEWER.md` forbids author-review, and it is the one merge that care cannot recover afterwards. If no reviewer seat is on the roster, say now how this bead WILL be reviewed, while there is a whole bead's worth of time to arrange it rather than at the moment the branch is ready to merge. An empty roster is not an empty bench of reviewers: `wheelhouse/runbooks/RUNNING_THE_LOOP.md`'s "When one human holds every seat" section is the solo path — the principal reviews an agent-authored change themselves, or a fresh session that did not author the change is dispatched as its reviewer, and the verdict lands on the bead in the same format either way. Name which of those this install will use, or which reviewer seat will be filled instead.

**6. Run the loop you just started.** The dispatch was `wheelhouse/runbooks/RUNNING_THE_LOOP.md`'s stage 1, and stage 1 is not a finish line: an install that ends on a dispatch hands the principal a fleet with one message in flight and nobody carrying it forward, which is the reading-list failure again with a better opening move. You are the commander for as long as this session lasts, so carry the bead through the runbook's stages yourself. What carrying looks like depends on the same roster read as the dispatch:

- **Managed worker/reviewer seats are on the roster.** Command them. The worker's report arrives on the bead as a comment plus the `needs-review` label — that is where you read it, not in a message, and the worker does not close the bead. When it lands, dispatch the reviewer seat the same stage-1 way: the bead id, the branch, a way to read it that changes nothing, `wheelhouse/crew/REVIEWER.md` as its brief. When the verdict lands, integrate per `wheelhouse/INTEGRATOR.md` — confirm the tip you merge equals the head that was reviewed, act on the PUSH line rather than the VERDICT line for anything leaving the machine, and carry merge/push/PR/deploy as far as question 4b recorded — then close the bead per the runbook's last stage, dropping the review-queue label in the same breath. If the action is on the reserved list from question 4, or if two product-intent readings lead to different work, ask once with a recommendation and default; otherwise the install interview's standing authority is the record.
- **No managed seats — you took the worker seat above, with a required producer subagent still on the roster.** Take it in earnest, in this session: the dispatch was addressed to you, and describing how you would implement the bead is not implementing it. The bench bead is sized for a first session — one script against a written brief. Do the work under the dispatch's own terms; the claim, the worktree and the evidence-carrying report are already in the bullet that took the seat, and the branch name and everything else a worker owes are in `wheelhouse/fleet/WORKER.md`, the contract that bullet named. Then route the review down the solo path you just named. The principal reads the diff and writes the verdict on the bead, or a fresh session that holds nothing of this conversation is dispatched as reviewer per the runbook's "When one human holds every seat" section — and that section's subagent form means the fresh session needs no second terminal, provided its dispatch is composed from the bead and the branch and carries nothing of this session's account of the work; the section says why the empty context is the whole point, and what to check before trusting it. When the verdict is on the bead, change hats once more and integrate exactly as the roster case above: tip equals reviewed head, question 4b's authority, question 5's merge policy, close and drop the label.

Two limits, stated here because this is the paragraph that would otherwise over-promise. **A session decides in turns, but turn boundaries do not stop processes.** The loop's decisions happen only when someone takes a turn — "carry the bead through the stages" means the loop advances each time you act and each time the principal returns and says to continue, and a report that lands while the conversation is idle waits for the next turn. Do not read that as "nothing runs while nobody is talking": measured on pi 0.84.1 (2026-08-30), a process a turn puts in the background keeps running after the turn ends and after the seat's process exits normally; an idle seat initiates nothing on its own — its event log, left alone for five minutes, did not grow by a byte — but a dispatch already queued behind a busy seat fires the moment the current work drains, with nobody present. Between turns the loop is quiet, not inert: what a turn set in motion continues, and what was queued will run. "No merge happens unattended" therefore holds because the contracts place the merge inside an attended integrator turn and the permission gate below sits in front of it — it is policy, not physics, and on any other harness both halves of this paragraph are measurements to redo, not assumptions to import. Say where the loop stands whenever you hand the turn back, so the principal knows what a "continue" will do — and say what you have left running or queued, because that part does not wait for the "continue". And **every write the loop makes passes through this session's permission settings** — the worker's commits, the report and the verdict on the bead, the merge itself. A step that stalls on a permission prompt is the reader's gate working, not the procedure failing; the answer belongs to the principal, not to a workaround.

Either way, say which seat you are sitting in and what you are waiting for. Once the first bead is closed, the loop has run end to end and the fleet is operating — the remaining actions are the commander's ordinary ones and they follow from this first loop rather than replacing it: post the ideal state's claims from step 3's question 3 as signals for the producer (or hand it existing ISA-change intake ids instead of posting duplicates), then dispatch the work it produces, and launch any seats you have not launched yet per `wheelhouse/STARTUP.md`.

## Failure behavior

Any step that cannot complete: stop, and report where you got to and what blocked you. Do not improvise around it, and do not report success on a partial install.

A manual proof failure in step 6 is a STOP before the smoke loop: name the failed Launch, Doctor, Drive, Evidence or Cleanup step and paste the observed output (for example, `the manual's Launch step failed: <observed output>`). Launch not reaching ready, Doctor failing, Drive not reaching the mapped end state, or evidence missing after Cleanup cannot be reported as a finished install. Always attempt the manual's Cleanup after a failed step; confirm no owned processes remain, retain diagnostics and proof, and report cleanup failure rather than hiding it.

A half-installed wheelhouse that claims to be finished is worse than no install, because the next session inherits it as if it were sound.
