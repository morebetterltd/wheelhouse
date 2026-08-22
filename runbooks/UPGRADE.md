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

## 3. Copy what the template owns — the seven contracts by name, then the runbooks

```bash
cp "$TEMPLATE/contracts/WORKER.md"   wheelhouse/fleet/WORKER.md.new
cp "$TEMPLATE/contracts/SEATS.md"    wheelhouse/fleet/SEATS.md.new
cp "$TEMPLATE/contracts/REVIEWER.md" wheelhouse/crew/REVIEWER.md.new
cp "$TEMPLATE/contracts/DESIGNER.md" wheelhouse/crew/DESIGNER.md.new
cp "$TEMPLATE/contracts/BENCH.md"    wheelhouse/crew/BENCH.md.new
cp "$TEMPLATE/contracts/GRAPH.md"    wheelhouse/GRAPH.md.new
cp "$TEMPLATE/contracts/INTEGRATOR.md" wheelhouse/INTEGRATOR.md.new
```

**Seven `.md` files, named individually.** Not `cp -r contracts/`, which would also copy `bench.sh.stub` over `wheelhouse/crew/bench.sh` — and if you have implemented your bench, that replaces it with a stub that exits 1. `bench.sh.stub` is install-only. It is never part of an upgrade.

### The runbooks come too

An upgrade owes `runbooks/` the same currency it owes `contracts/`, and this is where that is paid. Until this section existed the procedure reached nothing but the seven contracts, so a by-the-book upgrade left the project running yesterday's procedures against today's contracts — measured on a real run of this file, baseline `e39f376` to `221623d`: three runbooks left at the baseline's bytes and two scripts, `wire-seats.sh` and `wire-seats.selftest.sh`, that never arrived at all. The project keeps operating out of `RUNNING_THE_LOOP.md`, and nothing above or below this step looks at it.

Runbooks are copied rather than spliced because they have no project half to protect: `BOOTSTRAP.md` step 5 copies the whole directory verbatim, and no part of the install writes into one. But "no project half" is not "nobody has touched it" — `SEAT_DISCOVERY.md` ships `{{SEAT_NAMES}}` to be filled at promotion, and any project may have annotated a procedure it runs every day. So the copy is conditional on the same arbiter the splice uses, moved from inside the file to across time: a runbook still byte-identical to the **baseline's** copy is one you never edited, and it is replaced. One that differs is yours, and it is left alone and named for you to merge by hand.

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

`cp -p`, not `cp`: two of these are executable scripts a human runs as commands, and a runbook that arrives without its executable bit fails at the moment a seat cannot be reached. If your `commit=` is `unknown` the middle branch cannot run — there is no baseline to compare against — and every runbook that differs is reported as yours. That is the conservative direction on purpose: the cost is a hand-merge you did not need, against a silently clobbered procedure you would not have noticed.

## 4. Splice: new contract, your project section

For each file, take the contract half from the new copy and the project half from yours. Use the same rule the install's integrity check uses — the FIRST line that is exactly `## This project`, whole line, nothing else on it (first-match is the safer rule: if a project section ever contained that literal line again, a last-match split would absorb project content into the contract half):

A contract that did not exist at the commit you installed has no project half to keep. Copy those whole — do not splice them, because splicing against a file you do not have silently produces a contract with no `## This project` section, and then there is nowhere to record the things that section exists to record:

```bash
splice() {   # splice <new-contract> <your-file>
  if [ ! -e "$2" ]; then                      # new contract since your install
    cp "$1" "$2"; echo "new, copied whole: $2"; return
  fi
  awk '/^## This project$/{exit} {print}' "$1"  >  "$2.tmp"
  awk 'f{print} /^## This project$/{f=1; print}' "$2" >> "$2.tmp"
  mv "$2.tmp" "$2"
}
splice wheelhouse/fleet/WORKER.md.new   wheelhouse/fleet/WORKER.md
splice wheelhouse/fleet/SEATS.md.new    wheelhouse/fleet/SEATS.md
splice wheelhouse/crew/REVIEWER.md.new  wheelhouse/crew/REVIEWER.md
splice wheelhouse/crew/DESIGNER.md.new  wheelhouse/crew/DESIGNER.md
splice wheelhouse/crew/BENCH.md.new     wheelhouse/crew/BENCH.md
splice wheelhouse/GRAPH.md.new          wheelhouse/GRAPH.md
splice wheelhouse/INTEGRATOR.md.new     wheelhouse/INTEGRATOR.md
find wheelhouse -name '*.md.new' -delete   # find, not **: globstar is off by default in bash
```

Without that guard the failure is quiet in the way this template keeps warning about: `awk` reports `can't open file` on stderr, the function still exits 0, and you are left with a contract file whose project section does not exist. Measured, not assumed. If you have already run an upgrade without the guard, check each contract for its `## This project` heading before trusting the integrity check — the check compares contract halves and will report OK on a file that lost its project half entirely.

Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A naive match has destroyed a contract file this way once already — it deleted a licensing-compliance rule while every automated check still passed. `BOOTSTRAP.md` states the same rule for the same reason; this is the operation it was stating it for.

## 5. Re-verify — the same checks the install runs

- **Contract integrity**, from `BOOTSTRAP.md`. Expect OK for all seven, and no `FAIL` lines after them. That check is also this runbook's backstop: a contract missing from the copy list above never installs, and the check says so rather than passing quietly. Do not skip it on the grounds that the copies looked right. A FAIL now means the splice went wrong, or that this runbook's lists have fallen behind the template's — check that every file the integrity check compares also appears in steps 3 and 4 above before concluding anything about your splice.
- **The bench stub still fails, IF you have not implemented your bench**: `bash wheelhouse/crew/bench.sh; echo $?` must be non-zero. If you have implemented it, run your real bench instead — and if it now exits 0 having done nothing, step 3 clobbered it.
- Your `## This project` sections are intact. Diff them against what you had.
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
- open beads whose text cites paths or commands, especially long-lived ones filed at install.

```bash
git -C "$TEMPLATE" diff "$BASE" "${TARGET:-main}" -- contracts/ | grep -E '^[-+].*`[a-z/.]+`' | sort -u
bd list --status open | head -20      # then read them for the old convention
```

Fix what you find, in the same commit as the upgrade. This is manual on purpose — a convention change is exactly the kind of thing that needs a human deciding what it means in each place it appears.

A real example, from the upgrade this procedure was written from. That upgrade changed one thing upstream: a path convention, `crew/` to `wheelhouse/crew/`. The contracts were re-copied correctly and the check passed 6/6. The install's very first bead — filed by the bootstrap itself — still read *"Implement crew/bench.sh against crew/BENCH.md"*, and its acceptance criterion pointed at `contracts/BENCH.md`, a template path that does not exist in an installed project at all. Nothing was broken and no check could have caught it, because no check looks at the graph. It was found by reading, and fixed by editing the bead.

That is the shape of what step 7 catches: not damage, but the parts of your project that quietly went on speaking the old dialect.

## 8. Commit

```bash
NEW=$(sed -n 's/^commit=//p' wheelhouse/.template-source | cut -c1-12)
git add wheelhouse/ CLAUDE.md .beads/
git commit -m "Upgrade wheelhouse contracts to $NEW"
```

The sha is read back out of `wheelhouse/.template-source` rather than passed down from step 6, so the commit subject and the recorded baseline cannot disagree — they are the same twelve characters of the same line, and this block needs nothing from your shell's history to run. It read `<short-sha>` as a placeholder until this was measured: run verbatim, the block committed the literal subject `Upgrade wheelhouse contracts to `, which is the one thing a later reader of `git log` cannot recover the answer to.
