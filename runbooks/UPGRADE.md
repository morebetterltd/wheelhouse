# Upgrading the contracts

The contracts improve. Your `## This project` sections are yours. This is how you take the first without losing the second.

There is no tooling, deliberately: a file copy you understand beats a migration you do not. But "re-copy the contracts" is a one-line summary of an operation with three failure modes, so the steps are written out.

## 0. First, do you have a baseline?

```bash
cat wheelhouse/.template-source
```

**If that file exists, skip to step 1.**

**If it does not, you installed before the file existed, and you need to reconstruct it.** Every install predating it is in this position, so this is a normal starting point and not a sign anything is wrong. You need three facts: where the template came from, which commit you installed, and where a clone of it is.

Recover the commit, in order of preference:

```bash
# 1. the install commit in YOUR project's history usually names it
git log --oneline --all -- wheelhouse/ | tail -5
git show --stat <that-commit> | head -20

# 2. failing that, match your contracts against the template's history:
#    the newest template commit whose contracts equal yours is your baseline
cd /path/to/template-clone
for c in $(git rev-list HEAD -- contracts/); do
  if diff -rq <(git show $c:contracts/WORKER.md) /path/to/project/wheelhouse/fleet/WORKER.md >/dev/null 2>&1; then
    echo "candidate baseline: $c"; break
  fi
done
```

If neither works, ask the principal when they installed and take the template commit nearest that date. An approximate baseline is still worth having: it makes the diff in step 2 mostly-right instead of impossible.

Then write the file:

```bash
{ echo "source=git@github.com:morebetterltd/wheelhouse.git"
  echo "commit=<the commit you recovered, or 'unknown'>"
  echo "path=/path/to/your/template-clone"
  echo "installed=<date if you know it, else 'unknown'>"
} > wheelhouse/.template-source
```

`commit=unknown` is honest and still useful — the integrity check runs on it, you just do not get the behind-versus-damaged diagnosis in step 5 until your next upgrade sets a real one.

## 1. Get a clone you can actually diff

The install clones with `--depth 1`, which is enough to copy files and **not** enough to diff two commits. Either re-clone with history, or unshallow the one you have:

```bash
git clone git@github.com:morebetterltd/wheelhouse.git /path/to/template-clone   # full history
# or, in an existing shallow clone:
git -C /path/to/template-clone fetch --unshallow
git -C /path/to/template-clone pull
```

Then point your baseline at it, because `path=` from install time was a `mktemp -d` directory the operating system has almost certainly deleted:

```bash
TEMPLATE=/path/to/template-clone
TARGET=main     # the template ref you are upgrading TO: a branch, a tag, or a SHA
sed -i.bak "s|^path=.*|path=$TEMPLATE|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
```

`TARGET` is the second of the two facts every step below needs, and it is separated out for the same reason `TEMPLATE` is: the procedure works just as well upgrading to a tag or to a commit that is not the tip, and a runbook that named `main` in four places was one that only worked for people upgrading to `main`. Every block below reads `${TARGET:-main}` rather than naming a branch (the fourth site, step 0's search for a lost baseline, reads the clone's own `HEAD` — it runs before `TARGET` exists and wants whatever branch you cloned), so each one still runs on its own if you paste it into a fresh shell and never set `TARGET` — you get `main`, which is what you almost always want.

## 2. See what actually changed before you copy anything

```bash
BASE=$(sed -n 's/^commit=//p' wheelhouse/.template-source)
git -C "$TEMPLATE" diff "$BASE" "${TARGET:-main}" -- contracts/     # skip if BASE is 'unknown'
```

Read it. If nothing changed in `contracts/`, you are already current and there is nothing to do.

## 3. Copy what the template owns — the eight contracts by name, the runbooks, and the seats machinery

```bash
cp "$TEMPLATE/contracts/WORKER.md"   wheelhouse/fleet/WORKER.md.new
cp "$TEMPLATE/contracts/SEATS.md"    wheelhouse/fleet/SEATS.md.new
cp "$TEMPLATE/contracts/REVIEWER.md" wheelhouse/crew/REVIEWER.md.new
cp "$TEMPLATE/contracts/DESIGNER.md" wheelhouse/crew/DESIGNER.md.new
cp "$TEMPLATE/contracts/VERIFIER.md" wheelhouse/crew/VERIFIER.md.new
cp "$TEMPLATE/contracts/BENCH.md"    wheelhouse/crew/BENCH.md.new
cp "$TEMPLATE/contracts/GRAPH.md"    wheelhouse/GRAPH.md.new
cp "$TEMPLATE/contracts/INTEGRATOR.md" wheelhouse/INTEGRATOR.md.new
```

**Eight `.md` files, named individually.** Not `cp -r contracts/`, which would also copy `bench.sh.stub` over `wheelhouse/crew/bench.sh` — and if you have implemented your bench, that replaces it with a stub that exits 1. `bench.sh.stub` is install-only. It is never part of an upgrade. This list matches `BOOTSTRAP.md` step 2's — eight briefs plus the stub it alone copies — and step 5's integrity check is what catches the two drifting apart.

### The seats machinery comes too

The template owns `seats/` the way it owns the contracts: `seat-env.sh`, `adapter.ts`, `verify.ts`, `floor.ts`, `cockpit.sh`, `recover.ts`, their selftests, `seats.json.example`, and `seats/README.md` are byte-identical in every project, and an upgrade replaces them the same way. What it can never touch is what the template does not ship: your `seats/seats.json` roster, `seats/state.json`, `seats/run/`, `seats/logs/`, `seats/verdicts/` — none of those exist in the template, so a file-by-file copy of the template's `seats/` cannot reach them. That is why the copy is a loop over the template's files rather than a `cp -R` of the directory onto yours in reverse:

```bash
mkdir -p seats
for f in "$TEMPLATE"/seats/*; do
  cp -p "$f" "seats/$(basename "$f")"
done
if [ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ]; then printf '\n' >> .gitignore; fi
for e in 'seats/run/' 'seats/logs/' 'seats/state.json' 'seats/verdicts/'; do
  grep -qxF "$e" .gitignore 2>/dev/null || printf '%s\n' "$e" >> .gitignore
done
```

`seats/` lands at the install ROOT, beside `wheelhouse/`, because every path the contracts print — `seats/seat-env.sh`, `bun seats/adapter.ts ...` — is root-relative; `BOOTSTRAP.md` step 2 puts it there for the same reason. The `.gitignore` lines keep the per-machine runtime state out of git, and the guard on each makes the block safe to re-run; an install that already has them appends nothing. If your install predates `seats/` entirely — every seat a Claude Code session — this copy is the first half of a real migration, and the second half is written out at the end of step 7.

### The runbooks come too

An upgrade owes `runbooks/` the same currency it owes `contracts/`, and this is where that is paid. Until this section existed the procedure reached nothing but the contracts, so a by-the-book upgrade left the project running yesterday's procedures against today's contracts — measured on a real run of this file, baseline `e39f376` to `221623d`: three runbooks left at the baseline's bytes and two newly-added files that never arrived at all. The project keeps operating out of `RUNNING_THE_LOOP.md`, and nothing above or below this step looks at it.

Runbooks are copied rather than spliced because they have no project half to protect: `BOOTSTRAP.md` step 2 copies the whole directory verbatim, and no part of the install writes into one. But "no project half" is not "nobody has touched it" — any project may have annotated a procedure it runs every day. So the copy is conditional on the same arbiter the splice uses, moved from inside the file to across time: a runbook still byte-identical to the **baseline's** copy is one you never edited, and it is replaced. One that differs is yours, and it is left alone and named for you to merge by hand.

```bash
mkdir -p wheelhouse/runbooks
for f in "$TEMPLATE"/runbooks/*; do
  b=$(basename "$f")
  if [ ! -e "wheelhouse/runbooks/$b" ]; then
    cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook ARRIVED: $b"
  elif git -C "$TEMPLATE" show "${BASE:-unknown}:runbooks/$b" 2>/dev/null \
       | diff -q - "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
    cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook updated: $b"
  elif diff -q "$f" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
    echo "runbook current: $b"
  else
    echo "runbook YOURS, merge by hand: $b"
  fi
done
```

`cp -p`, not `cp`: it preserves the file mode, so a runbook that ships executable arrives executable. Today's three runbooks are all prose and the habit costs nothing — the era when this directory carried scripts is why it is written down. If your `commit=` is `unknown` the middle branch cannot run — there is no baseline to compare against — and every runbook that differs is reported as yours. That is the conservative direction on purpose: the cost is a hand-merge you did not need, against a silently clobbered procedure you would not have noticed.

## 4. Splice: new contract, your project section

For each file, take the contract half from the new copy and the project half from yours. Use the same rule the install's integrity check uses — the FIRST line that is exactly `## This project`, whole line, nothing else on it (first-match is the safer rule: if a project section ever contained that literal line again, a last-match split would absorb project content into the contract half):

A contract that did not exist at the commit you installed has no project half to keep. Copy those whole — do not splice them, because splicing against a file you do not have silently produces a contract with no `## This project` section, and then there is nowhere to record the things that section exists to record:

```bash
splice() {   # splice <new-contract> <your-file>
  if [ ! -e "$2" ]; then                      # new contract since your install
    cp "$1" "$2"; echo "new, copied whole: $2"; return
  fi
  # Headings the template's project-half scaffold carries and yours does not.
  # Read from the two halves that are about to be joined, because after the mv
  # the new file's project half is gone and nothing downstream looks there.
  diff <(awk 'f&&/^##+ /{print} /^## This project$/{f=1}' "$2") \
       <(awk 'f&&/^##+ /{print} /^## This project$/{f=1}' "$1") \
    | sed -n "s|^> |project section UPSTREAM, not in yours — $2: |p"
  awk '/^## This project$/{exit} {print}' "$1"  >  "$2.tmp"
  awk 'f{print} /^## This project$/{f=1; print}' "$2" >> "$2.tmp"
  mv "$2.tmp" "$2"
}
splice wheelhouse/fleet/WORKER.md.new   wheelhouse/fleet/WORKER.md
splice wheelhouse/fleet/SEATS.md.new    wheelhouse/fleet/SEATS.md
splice wheelhouse/crew/REVIEWER.md.new  wheelhouse/crew/REVIEWER.md
splice wheelhouse/crew/DESIGNER.md.new  wheelhouse/crew/DESIGNER.md
splice wheelhouse/crew/VERIFIER.md.new  wheelhouse/crew/VERIFIER.md
splice wheelhouse/crew/BENCH.md.new     wheelhouse/crew/BENCH.md
splice wheelhouse/GRAPH.md.new          wheelhouse/GRAPH.md
splice wheelhouse/INTEGRATOR.md.new     wheelhouse/INTEGRATOR.md
find wheelhouse -name '*.md.new' -delete   # find, not **: globstar is off by default in bash
```

Without that guard the failure is quiet in the way this template keeps warning about: `awk` reports `can't open file` on stderr, the function still exits 0, and you are left with a contract file whose project section does not exist. Measured, not assumed. If you have already run an upgrade without the guard, check each contract for its `## This project` heading before trusting the integrity check — the check compares contract halves and will report OK on a file that lost its project half entirely.

**The `project section UPSTREAM, not in yours` lines are the other thing this step reports, and they are not failures.** The splice keeps your project half whole, which is what you want and must not change — but "whole" means the template's own scaffold below `## This project` never reaches you, and that scaffold moves too. Between two real commits of this template, `SEATS.md` gained `### Declined seats`, `GRAPH.md` gained `### CLI build notes`, and `BENCH.md` renamed `### What is set up and torn down around the assertion`; a project that ran this procedure by the book learned none of it, because every check in step 5 compares contract halves and the one bullet about project halves is scoped to contracts copied whole — of which that run had none. The heading diff above is what closes that: it is the same reporting the runbook loop in step 3 does for `runbooks/`, one level down.

Read the lines and decide. A heading that is genuinely new is a section you may want to fill; a heading that is your own under a different name is a rename you may want to adopt or ignore. The report cannot tell those apart — a rename looks exactly like an arrival to a diff of headings — and it does not try, because which one it is depends on content only you can read. Compare `##`-level headings and above rather than every line, so this is a list of sections and not a second copy of the diff you already read in step 2. It reads headings inside fenced code blocks too, if a contract's project half ever contains one; that is a line you dismiss, not a check that lies to you.

Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A naive match has destroyed a contract file this way once already — it deleted a licensing-compliance rule while every automated check still passed. `BOOTSTRAP.md` states the same rule for the same reason; this is the operation it was stating it for.

## 5. Re-verify — the same checks the install runs

- **Contract integrity**, from `BOOTSTRAP.md`. Expect OK for all eight, and no `FAIL` lines after them. That check is also this runbook's backstop: a contract missing from the copy list above never installs, and the check says so rather than passing quietly. Do not skip it on the grounds that the copies looked right. A FAIL now means the splice went wrong, or that this runbook's lists have fallen behind the template's — check that every file the integrity check compares also appears in steps 3 and 4 above before concluding anything about your splice.
- **Your bench is the file you had before, whichever file that was.** Step 3 copies eight named `.md` files, the contents of `runbooks/`, and the template's `seats/` files, and none of those lists can reach `wheelhouse/crew/bench.sh` — so the check is that nothing reached it, and it reads the same in both states:

  ```bash
  git diff --stat -- wheelhouse/crew/bench.sh          # expect: nothing. The upgrade is not committed until step 8.
  diff -q wheelhouse/crew/bench.sh "$TEMPLATE/contracts/bench.sh.stub" >/dev/null 2>&1 \
    && echo "bench.sh: IS THE STUB" || echo "bench.sh: NOT the stub"
  ```

  If you have not implemented your bench, `IS THE STUB` is the correct answer and `bash wheelhouse/crew/bench.sh; echo $?` being non-zero confirms it still refuses. If you have implemented it, `IS THE STUB` means something overwrote it — `cp -r contracts/` in place of step 3's named copies is how that happens — and the file to restore is in your git history, not in the template.

  Do **not** use "run your real bench and check it is non-zero" as the clobber check, which is what this bullet said until it was run against a real one. An implemented bench takes arguments; invoked bare it exits non-zero on a usage error, having tested nothing: measured, `bash wheelhouse/crew/bench.sh` exits 2 and prints `usage: ...` to stderr. That satisfies the check as written while answering none of the question, and the failure it named — "exits 0 having done nothing" — is not what a clobbered bench does anyway, because the stub it would be replaced by exits 1. Running your real bench properly, with its arguments, is worth doing and is how you learn the upgraded contracts did not break your loop. It is a different question from this one.
- Your `## This project` sections are intact. Diff them against what you had.
- **Every `project section UPSTREAM, not in yours` line from step 4 has been read.** Those lines are the only place the procedure looks below `## This project` at all: the integrity check compares contract halves, and the bullet below about newly-arrived contracts only fires for a contract you did not have. A project half that is intact and a project half that is current are different claims, and every check here except this one measures the first. Read each line and decide — fill the section, adopt the rename, or decide your wording is the one you want. Deciding to do nothing is a fine answer; not knowing there was something to decide is what this closes.
- **Every `runbook YOURS, merge by hand:` line from step 3 has been acted on.** That line is the one output of this procedure that no later check looks at: the integrity check compares contracts, and a runbook left at your version is a legitimate outcome the tooling cannot distinguish from a merge you meant to do and forgot. Read the diff and decide, per file:

  ```bash
  diff wheelhouse/runbooks/<the-file> "$TEMPLATE/runbooks/<the-file>"
  ```
- **Newly-arrived contracts have an EMPTY project half, and the check above cannot tell you so.** The integrity check compares contract halves; the project-half check confirms the heading exists. A contract copied whole in step 4 satisfies both while carrying nothing but the template's guidance comments. That is not a failure and should not be made one — the template's own rule is that a guidance comment stays until you have content for it — but it is not evidence either, and "my project sections diffed clean" is trivially true for a file that never had one.

  So name them and act on them. Step 4 printed `new, copied whole:` for each; for every file it named:

  ```bash
  # for each newly-arrived contract, show what is still unfilled
  awk 'f; /^## This project$/{f=1}' wheelhouse/<the-file> | grep -n '<!--'
  ```

  Fill each section from what your project already knows, or write one sentence saying it is deliberately unfilled and why. Do not leave it silent. `wheelhouse/INTEGRATOR.md` is the case that shows why: its project half records who may push and to where, and an upgraded project that leaves it empty has taken delivery of the contract whose central claim is that a gate exercised without being recorded stops existing — with the gate unrecorded.

## 6. Record the upgrade

```bash
sed -i.bak "s|^commit=.*|commit=$(git -C "$TEMPLATE" rev-parse "${TARGET:-main}")|" wheelhouse/.template-source
rm -f wheelhouse/.template-source.bak
grep -q '^upgraded=' wheelhouse/.template-source \
  && sed -i.bak "s|^upgraded=.*|upgraded=$(date -u +%Y-%m-%dT%H:%M:%SZ)|" wheelhouse/.template-source \
  || echo "upgraded=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> wheelhouse/.template-source
rm -f wheelhouse/.template-source.bak
```

**Leave `installed=` alone.** It records when this project first installed, which is a different fact from when it last upgraded, and re-running the install block would overwrite it with today's date and lose that.

## 7. Sweep what the contracts do not cover

An upgrade re-copies the contracts and the runbooks and reaches nothing else. If the change altered a convention — a path form, a command name, a label — then your generated files and your existing beads still speak the old one:

- `CLAUDE.md`, `wheelhouse/ISA.md`, `wheelhouse/STARTUP.md`, and the `## This project` sections you just preserved;
- every bead that is not closed and whose text cites paths or commands, especially long-lived ones filed at install;
- the `template-report` label, if you installed before it existed — `wheelhouse/GRAPH.md` names it as the marker for template-class findings, and nothing back-fills it onto the `Report <tool> issue: ...` beads you already filed or writes its line into a `CLAUDE.md` generated before it.

```bash
git -C "$TEMPLATE" diff "$BASE" "${TARGET:-main}" -- contracts/ | grep -E '^[-+].*`[a-z/.]+`' | sort -u
bd list --status open,in_progress,blocked,deferred --limit 0   # then read them for the old convention
bd list --label template-report --limit 0                      # empty is the expected result here, not the finished one
```

**An added convention needs this sweep as much as a renamed one, and hides better.** A rename leaves the old string sitting in your files where a diff of the contracts will point at it. An addition leaves nothing behind: `bd list --label template-report` on a graph that predates the label prints `No issues found.`, which is what a graph with genuinely nothing to mark also prints. The two are told apart by reading the unclosed beads from the sweep above for `Report <tool> issue: ...` titles and labelling those — `bd update <id> --add-label template-report` — and by checking your `CLAUDE.md` against `generated/CLAUDE.md.example` for the line the current template writes.

**Every unclosed state, not just `open`.** `bd list --status open` means the stored status `open` and nothing else, so a bead someone has claimed is invisible to it — and the beads most likely to carry an old dialect, the long-lived ones filed at install, are also the ones most likely to be claimed. Measured on the graph this fix was written from: `--status open` printed `No issues found.` while four unclosed beads existed, all `in_progress`. Comma-separated is the form to use; `bd` 1.2.2 documents that repeating `-s` silently overwrites the previous value rather than accumulating. Not `--all`, which adds every closed bead — those are history, and nobody is going to act on their text again. `--limit 0` because `bd list` defaults to 50 and a sweep that stops early is the same vacuous check in a different costume.

Fix what you find, in the same commit as the upgrade. This is manual on purpose — a convention change is exactly the kind of thing that needs a human deciding what it means in each place it appears.

### From v1 Claude seats to Pi seats, if you installed before the seat rebuild

The template's bench never exercises this section's operator steps — the roster interview, the logins, retiring the old roots — so their verification is not upstream evidence but your own: each seat's readiness probe, and a dispatch that came back.

Every install made from a template before 2026-08-30 is in this position, so this is a normal starting point and not a sign anything is wrong. In those installs a seat was a standing Claude Code session: a per-seat `CLAUDE_CONFIG_DIR` under `$HOME/.claude-seats*/`, launch blocks in `STARTUP.md` an operator pasted into terminals, `wire-seats.sh` writing commander registrations, and `SEAT_DISCOVERY.md`'s roll call binding names to sessions. All of that is v1, and none of it exists in what step 3 just delivered. Today a seat is a commander-owned Pi RPC process: `seats/seats.json` is the roster, `seats/seat-env.sh` provisions each seat's isolated account directory under `$HOME/.pi-seats-<namespace>/`, and `bun seats/adapter.ts` spawns, dispatches, and stops them — `wheelhouse/fleet/SEATS.md` carries the contract and `seats/README.md` documents every command. The template commit the old machinery last shipped in is tagged `v1-claude-seats` in the template repo; that tag is the frozen reference if you ever need to read how the old wiring worked, and nothing after it will.

**An upgrade does not break your fleet mid-flight.** Nothing in steps 3 and 4 touches a running session or its config directory; your v1 seats keep working from the files they were launched from until you retire them. What IS true the moment step 3 lands is that your installed runbooks and contracts describe the Pi shape while your `STARTUP.md` and seat directories are still v1 — so treat this migration as one sitting, not a background task.

Step 4 above will have printed `project section UPSTREAM, not in yours — wheelhouse/fleet/SEATS.md: ### Declined seats` (and `new, copied whole: wheelhouse/crew/VERIFIER.md` before it): the new seat contract and the verifier arriving are this migration announcing itself. Here is the order that works:

1. **Record the namespace, in the file the machinery reads.** Short, lowercase, filesystem-safe — this project's own directory name is almost always right. It names this project's seat root, `$HOME/.pi-seats-<namespace>`, which is what keeps two fleets' accounts apart on one machine; `BOOTSTRAP.md` step 3's question 7 says why in full.

   ```bash
   grep -q '^namespace=' wheelhouse/.template-source \
     && sed -i.bak "s|^namespace=.*|namespace=<the namespace>|" wheelhouse/.template-source \
     || echo "namespace=<the namespace>" >> wheelhouse/.template-source
   rm -f wheelhouse/.template-source.bak
   grep '^namespace=' wheelhouse/.template-source
   ```

   A v1 `.template-source` predates the field, so the append branch is the one that will run — the `grep -q` guard is there so re-running this does not add a second line. If you were mid-way through the old namespace migration and a `namespace=` line already exists, the sed branch keeps it to one line and the value you already chose is fine: the string carries over, only the root it names changes from the retired `.claude-seats-` form to `.pi-seats-`.

2. **Shut the v1 seats down and remove the v1 machinery from your project.** Close the seat terminals first — a v1 seat is a session an operator launched, and nothing in the new machinery manages or even sees it. Then delete the files v1 installed and this template no longer ships; they are dead weight that reads as live instructions to anyone who finds them:

   ```bash
   rm -f wheelhouse/runbooks/wire-seats.sh wheelhouse/runbooks/wire-seats.selftest.sh
   rm -f wheelhouse/runbooks/SEAT_DISCOVERY.md
   ```

   Guarded with `-f` because which of these a v1 install actually has depends on when it installed; absent files are the fine case. Sweep your own surfaces for the same era's residue while you are here: any `CLAUDE_CONFIG_DIR` export, `SEATS_ROOT` export, foreign-directory check, or `claude --permission-mode auto` launch block in `wheelhouse/STARTUP.md`, and any note that points a reader at the roll call or `SEAT_DISCOVERY.md`. Those blocks are the v1 launch surface, and every one of them comes out — `STARTUP.md`'s job is now to name this project's namespace and seat names over the `seats/` commands, in the shape `BOOTSTRAP.md` step 5 writes for a fresh install.

3. **Interview yourself into a roster, and write `seats/seats.json`.** This is `BOOTSTRAP.md` step 3, question 7, run over the fleet you already have instead of a proposed one — read it and answer it for real, because two of its facts did not exist in v1: each seat's **provider** (`openai-codex` by ChatGPT-subscription OAuth, or an `api_key` provider — an Anthropic seat is an API-key seat, since the API rejects third-party subscription auth) and its **pinned model**, validated against `pi --list-models`. If the upgrader is Claude Code and has `AskUserQuestion`, conduct the migration interview through the tool: option lists per seat for carry or decline, provider, and pinned model; free prose is only the fallback when the tool is absent. Field precedent: a real five-seat roster fit in two `AskUserQuestion` rounds. Seat names carry no namespace prefix — `worker-1`, not `<namespace>-worker-1`; the per-project seat ROOT is what keeps fleets apart now, and the adapter addresses seats per-project. Your v1 roster in `wheelhouse/fleet/SEATS.md`'s project half is the list of seats to walk; rewrite that section as the human record of the new roster (and fill `### Declined seats` with any v1 seat you are not carrying forward, reason and date), while `seats/seats.json` is the machine record every command reads. No secret enters `seats.json`, ever.

4. **Provision and probe each seat.** `BOOTSTRAP.md` step 4, verbatim: `seats/seat-env.sh <namespace> <seat-name>` once per seat, the one-time OAuth flow (`PI_CODING_AGENT_DIR=... pi`, then `/login` inside the REPL, then `/exit`) or api_key placement (`auth.json` / provider env var) as that seat's own account, then the readiness probe. The one-seat-one-account rule survives the rebuild unchanged: the reviewer's and verifier's directories must differ from every worker's.

5. **Retire the old roots, last.** The v1 config directories under `$HOME/.claude-seats*/` hold real logins, so they are the one thing you delete only after the new seats have passed their probes and a real dispatch has come back. Read what is left before deleting anything — on a machine that hosted more than one v1 wheelhouse, what remains under a shared root is another project's fleet.

A real example, from the upgrade this procedure was written from. That upgrade changed one thing upstream: a path convention, `crew/` to `wheelhouse/crew/`. The contracts were re-copied correctly and the check passed 6/6. The install's very first bead — filed by the bootstrap itself — still read *"Implement crew/bench.sh against crew/BENCH.md"*, and its acceptance criterion pointed at `contracts/BENCH.md`, a template path that does not exist in an installed project at all. Nothing was broken and no check could have caught it, because no check looks at the graph. It was found by reading, and fixed by editing the bead.

That is the shape of what step 7 catches: not damage, but the parts of your project that quietly went on speaking the old dialect.

## 8. Commit

```bash
NEW=$(sed -n 's/^commit=//p' wheelhouse/.template-source | cut -c1-12)
git add wheelhouse/ seats/ .gitignore CLAUDE.md .beads/
git commit -m "Upgrade wheelhouse contracts to $NEW"
```

The sha is read back out of `wheelhouse/.template-source` rather than passed down from step 6, so the commit subject and the recorded baseline cannot disagree — they are the same twelve characters of the same line, and this block needs nothing from your shell's history to run. It read `<short-sha>` as a placeholder until this was measured: run verbatim, the block committed the literal subject `Upgrade wheelhouse contracts to `, which is the one thing a later reader of `git log` cannot recover the answer to.
