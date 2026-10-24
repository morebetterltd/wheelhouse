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
  if diff -rq <(git show ${c}:contracts/WORKER.md) /path/to/project/wheelhouse/fleet/WORKER.md >/dev/null 2>&1; then
    echo "candidate baseline: $c"; break
  fi
done
```

If neither works, ask the principal when they installed and take the template commit nearest that date. An approximate baseline is still worth having: it makes the diff in step 2 mostly-right instead of impossible.

Then write the file:

```bash
{ echo "source=git@github.com:morebetterltd/wheelhouse.git"
  echo "commit=<the recovered lowercase hexadecimal commit, 7-40 characters>"
  echo "path=<disposable cache path, filled in step 1>"
  echo "product-repo=$(pwd -P)"
  echo "merge-target=<the branch reviewed work integrates into, e.g. main or staging>"
  echo "installed=<date if you know it, else 'unknown'>"
  echo "github-issue-watch="
  echo "github-issue-repos="
  echo "github-issue-include-labels="
  echo "github-issue-exclude-labels="
  echo "github-issue-author="
  echo "seat_push=on"
  echo "seat_worktrees=per-seat"
  echo "cleanup=on"
  echo "isa_signals=on"
} > wheelhouse/.template-source
```

A historical `commit=unknown` may honestly record missing provenance, but cache recovery and integrity verification now REFUSE it. Resolve and record a lowercase hexadecimal commit (7-40 characters) before continuing; no path is removed on an invalid value. `path=` is the one field expected to die: it is only a cache hint. Existing installs may record a stale path into some other checkout; that is now harmless as long as `source=` and `commit=` are correct.

The `github-issue-*` lines are optional alerts configuration; append them to older `.template-source` files if you want the defaults visible before changing them. Empty is the default for each: `github-issue-watch=` means the GitHub issue watch is on (set it to `off`, `false`, `disabled`, `none`, or `0` to silence it); `github-issue-repos=` means derive the watched `owner/repo` from the product repo's `origin` remote (otherwise list `owner/repo` values separated by commas or semicolons); `github-issue-include-labels=` means no required labels (otherwise comma/semicolon-separated labels, with any one matching enough); `github-issue-exclude-labels=` means no excluded labels (otherwise comma/semicolon-separated labels, with any one matching enough to skip the issue); `github-issue-author=` means any author (otherwise one GitHub login). `seats/alerts.ts` writes the result into `seats/run/fleet-snapshot.json`; the optional fleet-gate reader only displays active alert names from that snapshot.

The `merge-target` line is the install's principal-confirmed integration branch. Fresh per-seat branches use it before `origin/HEAD`, because GitHub's default branch is not necessarily the branch this fleet merges into. Existing installs upgrading over a `.template-source` without this line must add it now:

```bash
grep -q '^merge-target=' wheelhouse/.template-source \
  && sed -i.bak "s|^merge-target=.*|merge-target=<the merge target branch>|" wheelhouse/.template-source \
  || echo "merge-target=<the merge target branch>" >> wheelhouse/.template-source
rm -f wheelhouse/.template-source.bak
grep '^merge-target=' wheelhouse/.template-source
```

The `seat_push`, `seat_worktrees`, and `cleanup` lines are install policy switches read by the copied seat machinery from this same committed file. Omit them to keep today's template defaults: `seat_push=on` lets cross-bead dispatch publish the previous branch before moving; `seat_worktrees=per-seat` lets the adapter create and switch `.wheelhouse-worktrees/<seat>`; `cleanup=on` runs automatic closed-bead cleanup. Installs whose recorded authority forbids one of those actions may set the independent opt-outs: `seat_push=off` means the adapter never pushes, `seat_worktrees=per-task` means the adapter does not create, move, or switch worktrees and instead uses the cwd already recorded by the install, and `cleanup=off` disables automatic cleanup while `cleanup=report` writes the would-remove cleanup report without deleting anything.

## 0.5. Check local drift before copying

Run `bash seats/template-drift.sh` before you copy from the template. Every `MODIFIED` line is a local fix the upgrade may overwrite; file it upstream first as a template issue/report, or decide deliberately to carry it. `LOCAL-ONLY` lines are install-owned tools the template does not know about. `MISSING` lines are template files absent from the install. A `DRIFT: cannot compare` result is not clean; fix `.template-source` or the cache before upgrading.

### One-time rotation for existing oversize seat logs

If an install already has very large `seats/logs/*.jsonl` files, rotate them once before relying on the copied adapter's automatic cap. Do not rename a live seat's log: either stop the seat first, or use the same copy-truncate form the adapter uses (`cp seats/logs/worker.jsonl seats/logs/worker.jsonl.1 && : > seats/logs/worker.jsonl`) so a live writer holding the log open keeps appending to the current path. Stop/restart the herald around a manual rotation so its cursor sees the rotation boundary. The automatic cap is configurable with `WHEELHOUSE_LOG_ROTATE_BYTES` (default 256 MiB) and keeps `WHEELHOUSE_LOG_ROTATE_KEEP` archives (default 3). The runtime rotation relies on `herald.ts`'s documented offset reset: when a log shrinks below the saved offset after rotation, herald resets the offset to zero and continues from the new file. Newer heralds also write `seats/run/commander-pane.json` and `seats/run/herald.target.json`; cockpit records the pane and the herald aims itself. Newer installs also replace the legacy desk and courier watchdog scripts with `seats/supervisor.sh`: delete those old watchdog scripts and `seats/run/{desk,courier}-watchdog.pid`, copy `seats/daemons.sh` and `seats/supervisor.sh`, then re-run cockpit so it starts the supervisor. The supervisor now also runs cockpit's dead-seat recovery pass every minute and schedules the nightly `bun seats/prune.ts cleanup` fleet-wide reaper (skipped when `cleanup=off`). If this install wants OS-level keep-alive after logout or reboot, run `seats/supervisor.sh install-launchd --print` on macOS or `seats/supervisor.sh print-systemd` on Linux and review/install the printed unit manually; the template command writes the plist but never loads, unloads, bootstraps, bootouts or kickstarts it.

## 1. Get a clone you can actually diff

The install clones with `--depth 1`, which is enough to copy files and **not** enough to diff two commits. Use a clone under this install's git-excluded cache when you need one, so `.template-source` never points at a folder inside another project:

```bash
SOURCE=$(sed -n 's/^source=//p' wheelhouse/.template-source)
BASE=$(sed -n 's/^commit=//p' wheelhouse/.template-source)
[[ "$BASE" =~ ^[0-9a-f]{7,40}$ ]] || { printf "REFUSED template source: invalid commit='%s'; expected 7-40 lowercase hexadecimal characters\n" "$BASE" >&2; exit 1; }
TARGET=main     # the template ref you are upgrading TO: a branch, a tag, or a SHA
CACHE_NAME=${TARGET//[^A-Za-z0-9._-]/_}
case "$CACHE_NAME" in ''|.*) printf "STOP: unsafe TARGET cache name='%s' from TARGET='%s'\n" "$CACHE_NAME" "$TARGET" >&2; exit 1;; esac
ROOT="$(pwd -P)"
CACHE_ROOT="$ROOT/wheelhouse/.template-cache"
CACHE="$CACHE_ROOT/$CACHE_NAME"
[ ! -L "$CACHE_ROOT" ] || { echo "STOP: cache root is a symlink: $CACHE_ROOT" >&2; exit 1; }
[ "$(cd "$ROOT/wheelhouse" && pwd -P)" = "$ROOT/wheelhouse" ] || { echo "STOP: wheelhouse is not the physical install directory" >&2; exit 1; }
mkdir -p "$CACHE_ROOT" || { echo "STOP: cannot create cache root: $CACHE_ROOT" >&2; exit 1; }
[ -d "$CACHE_ROOT" ] && [ ! -L "$CACHE_ROOT" ] || { echo "STOP: cache root is not a real directory: $CACHE_ROOT" >&2; exit 1; }
CACHE_REAL=$(cd "$CACHE_ROOT" && pwd -P) || { echo "STOP: cannot resolve cache root" >&2; exit 1; }
[ "$CACHE_REAL" = "$CACHE_ROOT" ] || { echo "STOP: cache root escapes install: $CACHE_ROOT" >&2; exit 1; }
CACHE_PARENT=$(cd "$(dirname "$CACHE")" && pwd -P) || { echo "STOP: cannot resolve cache parent" >&2; exit 1; }
[ "$CACHE_PARENT" = "$CACHE_REAL" ] && [ ! -L "$CACHE" ] || { echo "STOP: cache path escapes its real directory: $CACHE" >&2; exit 1; }
grep -qxF 'wheelhouse/.template-cache/' .gitignore 2>/dev/null || printf '%s\n' 'wheelhouse/.template-cache/' >> .gitignore

if [ ! -d "$CACHE/.git" ]; then
  rm -rf "$CACHE"
  git clone "$SOURCE" "$CACHE"   # full history, local to this install
fi
TEMPLATE=$CACHE
git -C "$TEMPLATE" fetch --tags origin
git -C "$TEMPLATE" fetch origin
git -C "$TEMPLATE" rev-parse "${TARGET:-main}" >/dev/null
git -C "$TEMPLATE" checkout --quiet "${TARGET:-main}"
if git -C "$TEMPLATE" rev-parse --verify --quiet "origin/${TARGET:-main}^{commit}" >/dev/null; then
  git -C "$TEMPLATE" merge --ff-only --quiet "origin/${TARGET:-main}" \
    || { echo "STOP: cache branch ${TARGET:-main} could not fast-forward to origin/${TARGET:-main}" >&2; exit 1; }
fi
git -C "$TEMPLATE" cat-file -e "${BASE}^{commit}"
sed -i.bak "s|^path=.*|path=$TEMPLATE|" wheelhouse/.template-source && rm -f wheelhouse/.template-source.bak
# Preserve an existing separate-product record; only older installs need the default.
grep -q '^product-repo=' wheelhouse/.template-source \
  || echo "product-repo=$(pwd -P)" >> wheelhouse/.template-source
# One-time for installs older than merge-target=: replace the placeholder with the branch reviewed work integrates into.
grep -q '^merge-target=' wheelhouse/.template-source || echo "merge-target=<the merge target branch>" >> wheelhouse/.template-source
grep '^merge-target=' wheelhouse/.template-source
```

If you prefer a one-off clone, make it with `mktemp -d`; do not record a durable checkout inside another project. `source=` plus `commit=` are the durable provenance. `path=` is disposable in the same sense BOOTSTRAP records it: it may point at a cache that is deleted later, and every copied selftest that needs template history must recover by fetching `commit=` from `source=` rather than depending on that path.

`TARGET` is the second of the two facts every step below needs, and it is separated out for the same reason `TEMPLATE` is: the procedure works just as well upgrading to a tag or to a commit that is not the tip, and a runbook that named `main` in four places was one that only worked for people upgrading to `main`. Every block below reads `${TARGET:-main}` rather than naming a branch (the fourth site, step 0's search for a lost baseline, reads the clone's own `HEAD` — it runs before `TARGET` exists and wants whatever branch you cloned), so each one still runs on its own if you paste it into a fresh shell and never set `TARGET` — you get `main`, which is what you almost always want.

## 2. See what actually changed before you copy anything

```bash
BASE=$(sed -n 's/^commit=//p' wheelhouse/.template-source)
[[ "$BASE" =~ ^[0-9a-f]{7,40}$ ]] || { printf "REFUSED template source: invalid commit='%s'; expected 7-40 lowercase hexadecimal characters\n" "$BASE" >&2; exit 1; }
git -C "$TEMPLATE" diff "$BASE" "${TARGET:-main}" -- contracts/ || true     # diff exits 1 when differences exist
```

Read it. If nothing changed in `contracts/`, you are already current and there is nothing to do.

## 3. Copy what the template owns — the nine contracts by name, the runbooks, and the seats machinery

### Designer becomes producer

Run this **before the copy block below**, so step 4 splices into the renamed target and keeps your own `## This project` half byte-for-byte. If both names exist, stop and reconcile them by hand; never overwrite either territory.

```bash
check_producer_rename() {
  test ! -e wheelhouse/crew/DESIGNER.md || {
    echo "STOP: legacy planning brief remains; rename it before copying and splicing the producer brief" >&2
    return 1
  }
}
if [ -e wheelhouse/crew/DESIGNER.md ]; then
  [ ! -e wheelhouse/crew/PRODUCER.md ] || { echo "STOP: both planning briefs exist; reconcile their territory before renaming" >&2; exit 1; }
  git mv wheelhouse/crew/DESIGNER.md wheelhouse/crew/PRODUCER.md
fi
if [ -e seats/seats.json ] || [ -L seats/seats.json ]; then
  bun -e 'import fs from "node:fs"; const p="seats/seats.json", r=JSON.parse(fs.readFileSync(p,"utf8")); for(const [name,s] of Object.entries(r.seats ?? {})) if(s.role === "designer") { s.role="producer"; console.log("producer role changed: " + name); } fs.writeFileSync(p,JSON.stringify(r,null,2)+"\n");'
else
  echo "producer roster rewrite skipped: seats/seats.json absent (pre-seats install)"
fi
```

A pre-seats install with no `seats/seats.json` skips only the roster rewrite, reporting that once; it does not invent a roster. Choose and record the required producer after copying the seats machinery and before step 5's roster check. An existing but unreadable or malformed roster still fails rather than being treated as absent.

The roster rewrite changes roles, not seat keys or account directories. Update your `wheelhouse/fleet/SEATS.md` roster and declined-standing-session rows and your install's `CLAUDE.md` to say producer. The producer is required: if the install never took a designer, choose a standing producer or record `"producer": {"role": "producer", "external": true, "runtime": "commander-subagent"}` under `seats`, per BOOTSTRAP question 7. A subagent reads PRODUCER.md; the commander never writes intent or outcomes. For a Claude Code standing producer, adopt the read/graph-only tool limits in `seats/seats.json.example`; for Pi and Codex the brief is the limit. After copying the seats machinery, run `bun seats/roster.ts check` and repair any refusal before dispatch.

Skipping the rename is data loss in disguise: the absent-file splice copies PRODUCER.md whole, while DESIGNER.md is left behind holding the only copy of your territory. Step 5 calls `check_producer_rename` and refuses that state. Keep this function in the upgrade shell; in a fresh shell, re-run this block before step 5. An install with no old brief gets PRODUCER.md whole via the ordinary absent-file path, with its empty template project scaffold.

### Copy the contracts

```bash
cp "$TEMPLATE/contracts/WORKER.md"   wheelhouse/fleet/WORKER.md.new
cp "$TEMPLATE/contracts/SEATS.md"    wheelhouse/fleet/SEATS.md.new
cp "$TEMPLATE/contracts/REVIEWER.md" wheelhouse/crew/REVIEWER.md.new
cp "$TEMPLATE/contracts/PRODUCER.md" wheelhouse/crew/PRODUCER.md.new
cp "$TEMPLATE/contracts/VERIFIER.md" wheelhouse/crew/VERIFIER.md.new
cp "$TEMPLATE/contracts/RESEARCHER.md" wheelhouse/crew/RESEARCHER.md.new
mkdir -p wheelhouse/research/ # RESEARCHER.md cites this as the durable report destination.
cp "$TEMPLATE/contracts/BENCH.md"    wheelhouse/crew/BENCH.md.new
cp "$TEMPLATE/contracts/GRAPH.md"    wheelhouse/GRAPH.md.new
cp "$TEMPLATE/contracts/INTEGRATOR.md" wheelhouse/INTEGRATOR.md.new
```

**Nine `.md` files, named individually.** Not `cp -r contracts/`, which would also copy `bench.sh.stub` over `wheelhouse/crew/bench.sh` — and if you have implemented your bench, that replaces it with a stub that exits 1. `bench.sh.stub` is install-only. It is never part of an upgrade. `RESEARCHER.md` is new in template upgrades that carry researcher seats; copy it whole, then fill only its `## This project` half if this install takes a researcher. Existing `seats/seats.json` rosters do not need a `skills` field; when present it is an optional array of skill directories that the adapter tilde-expands and passes as Pi `--skill`, stopping on a missing path. This list matches `BOOTSTRAP.md` step 2's — nine briefs plus the stub it alone copies — and step 5's integrity check is what catches the two drifting apart.

### Adopt the host-wide heavy-test admission without replacing your bench

After copying `seats/` below, preserve your implemented bench and add this prologue before any build, fixture or test work in `wheelhouse/crew/bench.sh` (Bash):

```bash
WHEELHOUSE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
. "$WHEELHOUSE_ROOT/seats/heavy-test.sh"
```

Do not copy the stub over an implemented bench. For a non-Bash bench, keep its public Bash entry point and delegate to the implementation via `bash "$WHEELHOUSE_ROOT/seats/heavy-test.sh" <command> [args...]`. Until adoption, workers must wrap direct bench/build/test commands that way. Updated `verify.ts` admits its entire review, so even a legacy bench called from it shares the FIFO. Nested sweeps reuse verified ancestor admission. Upgrade all contenders while the host lock is idle; every install uses the same default `/tmp/wheelhouse-selftest-sweep.lock`, not a project-specific override.

If the install has a pressure guard, audit its brake action separately: it may block **new** heavy work, but must leave admitted reviews, sweeps, benches and their owning worker process trees running (or suspend/resume them). Do not signal a running review to implement a load brake. The template does not replace local guard scripts or thresholds. `WHEELHOUSE_HEAVY_TEST_PAUSE` defaults to the install's `seats/run/host-guard-pause`. For a Mac-wide brake, choose **one guard as the marker's writer**; two independent guards must not clear one another's brake. On the same Mac/account, add this to that guard, each bench **before** its source line above, and every fleet/verification launcher environment:

```bash
export WHEELHOUSE_HEAVY_TEST_PAUSE=/tmp/wheelhouse-heavy-test.pause
# Keep the canonical FIFO; remove old per-install lock overrides everywhere.
unset WHEELHOUSE_SELFTEST_SWEEP_LOCK WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER
```

In that guard, replace the old install-local pressure-marker assignment (often `BRAKE=...`) so its existing marker-presence tests and calm/release conditions inspect the shared marker too:

```bash
BRAKE="$WHEELHOUSE_HEAVY_TEST_PAUSE"
```

Do not leave a later assignment resetting `BRAKE` to the old path. In the designated guard's existing sustained-pressure branch, replace the pressure-pause/cancellation action with:

```bash
: > "$WHEELHOUSE_HEAVY_TEST_PAUSE"  # block admission, NOT a signal to a process
```

In its existing sustained-calm release branch:

```bash
rm -f "$WHEELHOUSE_HEAVY_TEST_PAUSE"
```

Also delete any old unconditional **“suite without a selftest-sweep ancestor”** kill loop (often labelled “suite outside the host lock” and implemented with `pgrep`, an ancestry walk and `kill_tree`). Do not merely exempt reviews from the pressure-pause action: that separate loop will still kill a direct suite legitimately admitted by `selftest-lib.sh` or `heavy-test.sh`. Sweep ancestry is no longer the ownership proof; the installed admission helpers validate the actual host token and FIFO head. Do not replace the old loop with another argv/cwd/process-name heuristic. Keep the pressure sampler and marker publication/release branches, not the obsolete enforcement loop.

Leave the install's load/memory/swap thresholds configurable and its hysteresis intact. Other guards may observe the shared marker, but only the designated writer clears it. Remove pressure-triggered `adapter stop`, review/sweep/bench TERM/KILL, or an overnight-pause call that stops their worker process trees; marker admission replaces those actions, not the operator's explicit cancel command. Exporting a variable inside the guard does **not** configure already-running seat/verify launchers: put the same export in their launch environment and restart/reload them only through the install's normal safe upgrade procedure. A separate account needs an agreed shared path and permissions, not a private `$TMPDIR` marker.

#### Check two real installs on one Mac

First run `bash seats/heavy-test.selftest.sh` in each upgraded install. It proves two-install FIFO contention and mid-run brake completion with isolated idle fixtures; it does not fire a production guard. Then check the two **installed** entry points on the actual canonical FIFO. Use two terminals under the same Mac account. Set absolute `INSTALL_A`, `INSTALL_B`, `CONTAINER`, and an existing maintenance `CHECK_BEAD` whose owned scratch directory was allocated normally. In both terminals:

```bash
test -r "$INSTALL_A/seats/heavy-test.sh" && test -r "$INSTALL_B/seats/heavy-test.sh" || exit 1
test -d "$CONTAINER/.wheelhouse-runs/$CHECK_BEAD" || exit 1
CHECK="$CONTAINER/.wheelhouse-runs/$CHECK_BEAD/admission-check"
mkdir -p "$CHECK"
export WHEELHOUSE_HEAVY_TEST_PAUSE=/tmp/wheelhouse-heavy-test.pause
unset WHEELHOUSE_SELFTEST_SWEEP_LOCK WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER
```

Use a fresh `CHECK` subdirectory for each repetition; stale ready files are not readiness. Terminal A:

```bash
cd "$INSTALL_A" || exit 1
bash seats/heavy-test.sh bash -c '
  printf "A admitted\\n"; : > "$1/A.admitted"
  while [ ! -e "$1/release-A" ]; do sleep 1; done
  printf "A finished\\n"
' check "$CHECK" > "$CHECK/A.out" 2> "$CHECK/A.err"
printf 'A exit=%s\\n' "$?"
```

Wait for `$CHECK/A.admitted` to exist (A may itself be behind another fleet), then terminal B:

```bash
cd "$INSTALL_B" || exit 1
bash seats/heavy-test.sh bash -c '
  printf "B admitted\\n"; : > "$1/B.admitted"
' check "$CHECK" > "$CHECK/B.out" 2> "$CHECK/B.err"
printf 'B exit=%s\\n' "$?"
```

From an observer terminal with the same `CHECK`, expect A's ready file, a B wait diagnostic naming `/private/tmp/wheelhouse-selftest-sweep.lock` (or `/tmp/...`), and **no** B ready file:

```bash
test -f "$CHECK/A.admitted" && test -s "$CHECK/B.err" || exit 1
grep 'waiting for host-wide lock.*wheelhouse-selftest-sweep.lock.*queue_position=' "$CHECK/B.err" || exit 1
test ! -e "$CHECK/B.admitted" || { echo 'FAIL: installs overlapped'; exit 1; }
: > "$CHECK/release-A"
```

Both terminals must then exit 0; `A.out` contains `A finished`, and `B.out` contains `B admitted` with its ready file present. Repeat with A/B roles reversed and a fresh check directory. A wait that ends in an error or timeout is not a pass. To test an installed sweep against the held command, use `WHEELHOUSE_SELFTEST_SWEEP_PATTERN=<absolute-idle-probe.selftest.sh> bash seats/selftest-sweep.sh` in B with an idle probe under the same owned scratch; the automatic selftest already checks this direction and its reverse. Do not set or clear the production brake marker, stop a service, or launch a real application build just to perform this check. A production brake already set means wait for its designated guard to release it.

### The seats machinery comes too

The template owns `seats/` the way it owns the contracts: `seat-env.sh`, `adapter.ts`, `seat-worktree.ts`, `verify.ts`, `walk.ts`, `needs.ts`, `desk.ts`, `principal-sentinel.sh`, `courier.ts`, `channels.ts`, `comms.ts`, `transports/` (including `transports/teams.ts`), `prune.ts`, `floor.ts`, `cockpit.sh`, `recover.ts`, `intent-check.sh`, their selftests, `seats.json.example`, `channels.json.example`, and `seats/README.md` are byte-identical in every project, and an upgrade replaces them the same way. That file-by-file copy is how the integrate/close intent gate reaches existing installs; after the copy, `seats/intent-check.sh` should exist and `bash seats/intent-check.selftest.sh` should pass before you rely on the gate. Some copied selftests need template history as their fixture; they first use `wheelhouse/.template-source`'s `path=` if it is a live repository carrying `commit=`, otherwise they fetch `commit=` from `source=` into `wheelhouse/.template-cache/` under this install. What the copy can never touch is what the template does not ship: your `seats/seats.json` roster, `seats/channels.json`, `seats/integration-refs.txt`, `seats/state.json`, `seats/run/`, `seats/logs/`, `seats/verdicts/`, `seats/comms.jsonl` — none of those exist in the template, so a file-by-file copy of the template's `seats/` cannot reach them. That is why the copy is a loop over the template's files rather than a `cp -R` of the directory onto yours in reverse:

```bash
mkdir -p seats
for f in "$TEMPLATE"/seats/*; do
  if [ -d "$f" ]; then
    rm -rf "seats/$(basename "$f")"
    cp -pR "$f" "seats/$(basename "$f")"
  else
    cp -p "$f" "seats/$(basename "$f")"
  fi
done
if [ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ]; then printf '\n' >> .gitignore; fi
for e in 'seats/run/' 'seats/logs/' 'seats/state.json' 'seats/verdicts/'; do
  grep -qxF "$e" .gitignore 2>/dev/null || printf '%s\n' "$e" >> .gitignore
done
seats/install-fleet-pre-push-guard.sh || { echo "STOP: fleet pre-push guard installation failed" >&2; exit 1; }
```

The copy does not remove retired selftests: existing installs must delete `seats/adapter-cwd.selftest.sh`, `seats/pid-ownership.selftest.sh`, and `seats/pipefail.selftest.sh` from their `seats/` directory; the source-resolution check now lives in `selftest-lib.selftest.sh`, and behavioural PID-reuse coverage remains in `adapter.selftest.sh`.

The installer above protects both the container and the separate product Git root named by `product-repo=` in `wheelhouse/.template-source`. Preserve that value during upgrades; for an older install using the default, correct it before running the installer if the product is separate (absolute paths or paths relative to the install root are accepted). Each repository keeps its own hooks location, including a shared `.beads/hooks`, and its previous pre-push hook. Re-running refreshes the guard path without nesting wrappers or losing the previous hook. The product does not need a `seats/` directory: both hooks invoke the guard shipped with this install. Review the per-repository installation output; invalid/missing product roots stop the command rather than silently leaving them unguarded. The guard remains a bypassable tripwire, not credential isolation.

`seats/` lands at the install ROOT, beside `wheelhouse/`, because every path the contracts print — `seats/seat-env.sh`, `bun seats/adapter.ts ...` — is root-relative; `BOOTSTRAP.md` step 2 puts it there for the same reason. Current template seats include optional dynamic-staffing pool support (`seats/pool.ts`, `seats/roster.ts`, `seats/pool.json.example`, and `seats/pool.selftest.sh`); copying the template files does not create `seats/pool.json`, so existing fixed-roster installs keep their current behavior unless they deliberately add a pool. The `.gitignore` lines keep the per-machine runtime state out of git, and the guard on each makes the block safe to re-run; an install that already has them appends nothing.

### Optional host build budget for existing installs

If this project has heavy builds or tests (Rust, C++, dotnet, large JS) and the principal wants them serialized machine-wide, adopt the same opt-in record that new installs choose in `BOOTSTRAP.md` question 9:

1. Keep/copy the shipped shims under `seats/bin`: `host-build-shim`, plus `cargo` and `dotnet` symlinks to it.
2. Ensure seat launch and one-shot commands will see that directory by relying on the copied adapter/verify/walk machinery; when `seats/host-budget.json` exists, they prepend this project's `seats/bin` to PATH.
3. Write `seats/host-budget.json`:

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

If the project does not opt in, do not write `seats/host-budget.json`; keep the shipped `seats/bin` directory. It is template-owned machinery and inert unless `seats/host-budget.json` exists, and the selftests use it to prove the opt-in path still works.

If this project already had Pi seats, open `seats/seats.json` now and inspect every carried seat. Current rosters may record two fields older Pi rosters do not: `account.authRoute`, which is the credential route (`oauth`, `api_key`, or `env`) that gave the seat its identity, and `shadow`, which is a boolean only for intentional mirror seats. Back-fill `account.authRoute` for each carried seat from the route you actually use — OAuth `/login` for `openai-codex` subscription accounts, a file-backed provider entry in that seat's `auth.json` for `api_key`, or an exported provider env var for `env` — and do not record any credential material. Then read the JSON and probe every seat so both syntax and route are checked by the copied machinery:

```bash
bun -e 'import fs from "node:fs"; console.log(JSON.stringify(JSON.parse(fs.readFileSync("./seats/seats.json","utf8")), null, 2))'
for seat in $(bun -e 'import fs from "node:fs"; const j=JSON.parse(fs.readFileSync("./seats/seats.json","utf8")); console.log(Object.keys(j.seats||{}).join("\n"))'); do
  seats/seat-env.sh "$(sed -n 's/^namespace=//p' wheelhouse/.template-source | tail -1)" "$seat"
  bun seats/adapter.ts probe "$seat"
done
```

There is no safe deterministic conversion from an old roster: the same `provider` can be backed by file credentials or environment credentials, and committed roster data deliberately does not expose the secret source. Do not invent `shadow` while doing this. Absence still means `false`; add `"shadow": true` only when the project is intentionally creating a mirror seat whose output never gates or carries assigned work.

### Change a seat's harness

Existing rosters that have no `harness` field need **zero edits** for this upgrade: absent `harness` means `pi`. Leave those rows alone unless the principal is deliberately switching that named seat to another harness. A valid upgrade must not require touching any seat the principal did not switch; their `seats/state.json` records, sessions, account dirs, and worktrees stay intact.

For the one seat being changed:

1. Wait until it is idle, then stop only that seat:

   ```bash
   bun seats/adapter.ts status
   bun seats/adapter.ts stop <seat>
   ```

   Do not run `stop-all` as a shortcut unless the principal asked to stop the whole fleet. Other seats are not part of this migration.

2. Edit only that seat's entry in `seats/seats.json`:

   - set `harness` to `pi`, `claude-code`, or `codex`;
   - set the matching `provider`, `model`, and `account.authRoute`;
   - for `claude-code`, set `provider: "anthropic"`, choose a Claude Code model alias/id, and keep an `allowedTools` list for unattended `acceptEdits` mode;
   - for `codex`, use the Codex account's live model list (for ChatGPT Codex seats this is the `openai-codex` provider family) and record `authRoute: "oauth"` or `"api_key"` as appropriate.

3. Provision the new harness binding directory for that same seat name:

   ```bash
   NS=$(sed -n 's/^namespace=//p' wheelhouse/.template-source | tail -1)
   seats/seat-env.sh "$NS" <seat> "$(pwd -P)"
   ```

   `seat-env.sh` reads the roster and prints the binding for the selected harness: `PI_CODING_AGENT_DIR` for `pi`, `CLAUDE_CONFIG_DIR` for `claude-code`, or `CODEX_HOME` for `codex`. It also prints the credential flow for that harness. Run that login/key step as the account the seat should be:

   - `pi`: OAuth `/login` in `pi`, an operator-written `auth.json` for `api_key`, or provider env var for `env`;
   - `claude-code`: `CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai` for subscription OAuth, or `claude auth login --console` for metered API-key setup;
   - `codex`: `CODEX_HOME=<dir> codex login` / `codex login --device-auth` for OAuth, or `printenv OPENAI_API_KEY | CODEX_HOME=<dir> codex login --with-api-key` for API-key setup.

4. Probe the binding through the selected harness before doing work:

   ```bash
   bun seats/adapter.ts probe <seat>
   ```

   A good probe prints exactly `OK`. If it fails, fix that seat's harness login/model/allowed-tools entry; do not edit unrelated seats.

5. Reset only that seat so it starts cold under the new harness and cannot accidentally resume the old harness session:

   ```bash
   bun seats/adapter.ts reset <seat>
   ```

6. Send one smoke dispatch to a scratch bead/worktree and wait for a normal completion in that seat's log:

   ```bash
   bun seats/adapter.ts dispatch <seat> <scratch-bead-id> 'Smoke check after harness switch: reply OK and stop.'
   tail -f seats/logs/<seat>.jsonl
   ```

The old harness session file remains history in `seats/state.json` until `reset` replaces that seat's record. Other seats' records and session files must not change; that is the falsifier for this procedure.

Before running the upgraded dispatchers, inspect **every** `"role": "verifier"` row in `seats/seats.json` and `seats/staffing.json`. Old versions used that role for bead review. For each review seat, the one-line fix is `seats["<actual-seat-name>"].role = "reviewer"` in the file containing it. Preserve its key and `account.dir` so credentials and runtime history stay attached; new fixed review seats are named `reviewer-1`, `reviewer-2`, and newly staffed ones `reviewer-<entry>`. Keep role `verifier` only for a consumer-surface walker in `seats.json` (normally seat `verifier`); never auto-convert a real walker. Mirror the corrected roles in the installed SEATS roster and cold-reset any persistent review process after the brief changes. `verify.ts` now refuses a wrongly typed explicit seat and, if no reviewer exists, names each verifier seat with this fix; legacy staffing records STOP naming the seat and fix rather than silently becoming walkers. No credentials are moved or rewritten.

If your install already has a **walker** verifier entry, this upgrade keeps what that role means: `wheelhouse/crew/VERIFIER.md` is now the consumer-surface walker, dispatched by `bun seats/walk.ts` for ISA claims, not the bead-review verdict pass. Keep or repoint the verifier to a cheap tool-capable model (for example a GLM-class OpenRouter row when the seat's own live `pi --list-models` prints it), because the empty context is what matters, not the model's depth. Fill `wheelhouse/crew/VERIFIER.md`'s `## This project` section with this install's named surfaces — README/front door or first morning for a template-style fleet, upgrade runbook from a real baseline when one exists, or the product's staging URL/emulator/launch command/API/CLI surface. If there is no walkable consumer surface yet, write the honest gap: `no consumer surface yet — walks impossible, claims close not-walked`. Existing ISA claims that already say `Not walked:` remain valid history; this upgrade does not demand retro-walking them.

If your install predates `seats/` entirely — every seat a Claude Code session — this copy is the first half of a real migration, and the second half is written out at the end of step 7.

### The runbooks come too

An upgrade owes `runbooks/` the same currency it owes `contracts/`, and this is where that is paid. Until this section existed the procedure reached nothing but the contracts, so a by-the-book upgrade left the project running yesterday's procedures against today's contracts — measured on a real run of this file, baseline `e39f376` to `221623d`: three runbooks left at the baseline's bytes and two newly-added files that never arrived at all. The project keeps operating out of `RUNNING_THE_LOOP.md`, and nothing above or below this step looks at it.

Runbooks are copied rather than spliced because they have no project half to protect: `BOOTSTRAP.md` step 2 copies the whole directory verbatim, and no part of the install writes into one. But "no project half" is not "nobody has touched it" — any project may have annotated a procedure it runs every day. So the copy is conditional on the same arbiter the splice uses, moved from inside the file to across time: a runbook still byte-identical to the **baseline's** copy is one you never edited, and it is replaced. One that differs from a successfully-read baseline is yours, and it is left alone and named for you to merge by hand; one whose baseline cannot be read is named separately so you re-run before deciding whether any hand-merge is real.

```bash
mkdir -p wheelhouse/runbooks
for f in "$TEMPLATE"/runbooks/*; do
  b=$(basename "$f")
  if [ ! -e "wheelhouse/runbooks/$b" ]; then
    cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook ARRIVED: $b"
    continue
  fi

  baseline=$(mktemp)
  if git -C "$TEMPLATE" show "${BASE:-unknown}:runbooks/$b" >"$baseline" 2>/dev/null; then
    if diff -q "$f" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
      echo "runbook current: $b"
    elif diff -q "$baseline" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
      cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook updated: $b"
    else
      echo "runbook YOURS, merge by hand: $b"
    fi
  else
    echo "runbook baseline unreadable — re-run before hand-merging: $b"
  fi
  rm -f "$baseline"
done
```

`cp -p`, not `cp`: it preserves the file mode, so a runbook that ships executable arrives executable. This is load-bearing: some shipped runbooks are executable pointers, and the era when this directory carried more scripts is why it is written down. If the baseline read fails (for example, an older procedure left `commit=unknown`, which step 1 now refuses), the comparison cannot run — there is no trusted baseline to compare against — and the runbook is reported as `baseline unreadable` rather than `YOURS`. That is the conservative direction on purpose: the cost is re-running before a possible hand-merge, against either a silently clobbered procedure or a spurious hand-merge queue you would not have noticed.

## 4. Splice: new contract, your project section

For each file, take the contract half from the new copy and the project half from yours. Use the same rule the install's integrity check uses — the FIRST line that is exactly `## This project`, whole line, nothing else on it (first-match is the safer rule: if a project section ever contained that literal line again, a last-match split would absorb project content into the contract half):

A contract that did not exist at the commit you installed has no project half to keep. Copy those whole — do not splice them, because splicing against a file you do not have silently produces a contract with no `## This project` section, and then there is nowhere to record the things that section exists to record.

An **existing** contract with no `## This project` heading is different from an absent contract, and it is a loud stop rather than a copy-whole case. That file is usually from a pre-template or hand-built adoption: copy the new contract half whole, then hand-fold the existing local text under one freshly-added `## This project` heading. Do not let the splice invent that shape, because the splice cannot know which of the old prose is local policy and which is obsolete contract text. The mechanical recovery is:

1. save the old file somewhere temporary;
2. copy the new `.new` contract to the target path;
3. keep the copied contract half exactly as shipped through its first `## This project` line;
4. move the old file's still-current local content below that heading, rewriting it as the project's section rather than pasting it blindly;
5. re-run this step, which should now report exactly one heading for the file.

That adoption path is separate from the absent-file path below: absent files are newly-arrived contracts and are copied whole, including the template's empty project-half scaffold.

```bash
targets=(
  wheelhouse/fleet/WORKER.md
  wheelhouse/fleet/SEATS.md
  wheelhouse/crew/REVIEWER.md
  wheelhouse/crew/PRODUCER.md
  wheelhouse/crew/VERIFIER.md
  wheelhouse/crew/BENCH.md
  wheelhouse/GRAPH.md
  wheelhouse/INTEGRATOR.md
)
for target in "${targets[@]}"; do
  [ -e "$target" ] || continue                 # absent: new contract since your install; splice() copies whole
  heading_count=$(grep -cx '## This project' "$target" || true)
  case "$heading_count" in
    1) ;;
    0)
      echo "STOP: existing contract has no '## This project' heading: $target" >&2
      echo "Adopt it first: copy the new contract half whole, then hand-fold the existing content under a freshly added '## This project' heading as described above." >&2
      exit 1
      ;;
    *)
      first_heading=$(grep -n '^## This project$' "$target" | head -1 | cut -d: -f1)
      echo "STOP: existing contract has $heading_count '## This project' headings: $target" >&2
      echo "The splice uses the first exact heading (line $first_heading); remove or rename the later duplicate before continuing." >&2
      exit 1
      ;;
  esac
done

splice() {   # splice <new-contract> <your-file>
  if [ ! -e "$2" ]; then                      # new contract since your install
    cp "$1" "$2"; echo "new, copied whole: $2"; return
  fi
  # Headings the template's project-half scaffold carries and yours does not,
  # plus headings both halves have but in a different position. Read from the
  # two halves that are about to be joined, because after the mv the new file's
  # project half is gone and nothing downstream looks there.
  yours_h=$(mktemp); upstream_h=$(mktemp)
  awk 'f&&/^##+ /{print} /^## This project$/{f=1}' "$2" > "$yours_h"
  awk 'f&&/^##+ /{print} /^## This project$/{f=1}' "$1" > "$upstream_h"
  comm -13 <(sort -u "$yours_h") <(sort -u "$upstream_h") \
    | sed "s|^|project section UPSTREAM, not in yours — $2: |"
  awk -v file="$2" '
    NR==FNR { if (!($0 in yi)) yi[$0]=FNR; next }
    ($0 in yi) && yi[$0] != FNR { print "project section UPSTREAM, present, different position — " file ": " $0 }
  ' "$yours_h" "$upstream_h"
  rm -f "$yours_h" "$upstream_h"
  awk '/^## This project$/{exit} {print}' "$1"  >  "$2.tmp"
  awk 'f{print} /^## This project$/{f=1; print}' "$2" >> "$2.tmp"
  mv "$2.tmp" "$2"
}
splice wheelhouse/fleet/WORKER.md.new   wheelhouse/fleet/WORKER.md
splice wheelhouse/fleet/SEATS.md.new    wheelhouse/fleet/SEATS.md
splice wheelhouse/crew/REVIEWER.md.new  wheelhouse/crew/REVIEWER.md
splice wheelhouse/crew/PRODUCER.md.new  wheelhouse/crew/PRODUCER.md
splice wheelhouse/crew/VERIFIER.md.new  wheelhouse/crew/VERIFIER.md
splice wheelhouse/crew/RESEARCHER.md.new wheelhouse/crew/RESEARCHER.md
splice wheelhouse/crew/BENCH.md.new     wheelhouse/crew/BENCH.md
splice wheelhouse/GRAPH.md.new          wheelhouse/GRAPH.md
splice wheelhouse/INTEGRATOR.md.new     wheelhouse/INTEGRATOR.md
find wheelhouse -name '*.md.new' -delete   # find, not **: globstar is off by default in bash
```

Without that guard the failure is quiet in the way this template keeps warning about: `awk` reports `can't open file` on stderr, the function still exits 0, and you are left with a contract file whose project section does not exist. Measured, not assumed. If you have already run an upgrade without the guard, check each contract for its `## This project` heading before trusting the integrity check — the check compares contract halves and will report OK on a file that lost its project half entirely.

**The `project section UPSTREAM, not in yours` and `project section UPSTREAM, present, different position` lines are the other thing this step reports, and they are not failures.** The splice keeps your project half whole, which is what you want and must not change — but "whole" means the template's own scaffold below `## This project` never reaches you, and that scaffold moves too. Between two real commits of this template, `SEATS.md` gained `### Declined seats`, `GRAPH.md` gained `### CLI build notes`, and `BENCH.md` renamed `### What is set up and torn down around the assertion`; a project that ran this procedure by the book learned none of it, because every check in step 5 compares contract halves and the one bullet about project halves is scoped to contracts copied whole — of which that run had none. The heading report above is what closes that: it is the same reporting the runbook loop in step 3 does for `runbooks/`, one level down.

Read the lines and decide. A `not in yours` heading that is genuinely new is a section you may want to fill; a heading that is your own under a different name is a rename you may want to adopt or ignore. The report cannot tell those apart — a rename looks exactly like an arrival to a set of headings — and it does not try, because which one it is depends on content only you can read. A `present, different position` heading is already present in your project half, but the upstream scaffold now places it somewhere else; decide whether to reorder your project prose or keep your local order. Compare `##`-level headings and above rather than every line, so this is a list of sections and not a second copy of the diff you already read in step 2. It reads headings inside fenced code blocks too, if a contract's project half ever contains one; that is a line you dismiss, not a check that lies to you.

Do not split on the first occurrence of the words "this project", and do not split on a mention inside a sentence. A naive match has destroyed a contract file this way once already — it deleted a licensing-compliance rule while every automated check still passed. `BOOTSTRAP.md` states the same rule for the same reason; this is the operation it was stating it for.

## 5. Re-verify — the same checks the install runs

- **The producer rename completed.** In the shell that ran the rename subsection, run the guard defined there. If you opened a new shell, run that subsection first; a missing function is not a passed check.

  ```bash
  check_producer_rename || { echo "STOP: producer rename not verified" >&2; exit 1; }
  bun seats/roster.ts check || { echo "STOP: required producer missing or roster unreadable" >&2; exit 1; }
  ```

- **Contract integrity**, from `BOOTSTRAP.md`. Expect OK for all nine contract `.md` files, and no `FAIL` lines after them. That check is also this runbook's backstop: a contract missing from the copy list above never installs, and the check says so rather than passing quietly. Do not skip it on the grounds that the copies looked right. A FAIL now means the splice went wrong, or that this runbook's lists have fallen behind the template's — check that every file the integrity check compares also appears in steps 3 and 4 above before concluding anything about your splice.
- **Your bench is the file you had before, whichever file that was.** Step 3 copies nine named `.md` files, the contents of `runbooks/`, and the template's `seats/` files, and none of those lists can reach `wheelhouse/crew/bench.sh` — so the check is that nothing reached it, and it reads the same in both states:

  ```bash
  git diff --stat -- wheelhouse/crew/bench.sh          # expect: nothing. The upgrade is not committed until step 8.
  diff -q wheelhouse/crew/bench.sh "$TEMPLATE/contracts/bench.sh.stub" >/dev/null 2>&1 \
    && echo "bench.sh: IS THE STUB" || echo "bench.sh: NOT the stub"
  ```

  If you have not implemented your bench, `IS THE STUB` is the correct answer and `bash wheelhouse/crew/bench.sh; echo $?` being non-zero confirms it still refuses. If you have implemented it, `IS THE STUB` means something overwrote it — `cp -r contracts/` in place of step 3's named copies is how that happens — and the file to restore is in your git history, not in the template.

  Do **not** use "run your real bench and check it is non-zero" as the clobber check, which is what this bullet said until it was run against a real one. An implemented bench takes arguments; invoked bare it exits non-zero on a usage error, having tested nothing: measured, `bash wheelhouse/crew/bench.sh` exits 2 and prints `usage: ...` to stderr. That satisfies the check as written while answering none of the question, and the failure it named — "exits 0 having done nothing" — is not what a clobbered bench does anyway, because the stub it would be replaced by exits 1. Running your real bench properly, with its arguments, is worth doing and is how you learn the upgraded contracts did not break your loop. It is a different question from this one.
- Your `## This project` sections are intact. Diff them against what you had.
- **Every `project section UPSTREAM, not in yours` and `project section UPSTREAM, present, different position` line from step 4 has been read.** Those lines are the only place the procedure looks below `## This project` at all: the integrity check compares contract halves, and the bullet below about newly-arrived contracts only fires for a contract you did not have. A project half that is intact and a project half that is current are different claims, and every check here except this one measures the first. Read each line and decide — fill the section, adopt the rename, reorder the existing section, or decide your wording is the one you want. Deciding to do nothing is a fine answer; not knowing there was something to decide is what this closes.
- **Every `runbook YOURS, merge by hand:` line from step 3 has been acted on.** That line is the one output of this procedure that no later check looks at: the integrity check compares contracts, and a runbook left at your version is a legitimate outcome the tooling cannot distinguish from a merge you meant to do and forgot. Read the diff and decide, per file:

  ```bash
  diff wheelhouse/runbooks/<the-file> "$TEMPLATE/runbooks/<the-file>"
  ```
- **Stakeholder channel docs and machinery are present.** Before relying on declared-channel communication, confirm `seats/channels.json` is install-owned (not copied from the template), `seats/channels.json.example` remains placeholder-only, and `bun seats/channels.ts check --credentials` succeeds once you have declared real channels and the owner has provisioned their credentials.
- **Newly-arrived contracts have an EMPTY project half, and the check above cannot tell you so.** The integrity check compares contract halves; the project-half check confirms the heading exists. A contract copied whole in step 4 satisfies both while carrying nothing but the template's guidance comments. That is not a failure and should not be made one — the template's own rule is that a guidance comment stays until you have content for it — but it is not evidence either, and "my project sections diffed clean" is trivially true for a file that never had one.

  So name them and act on them. Step 4 printed `new, copied whole:` for each; for every file it named:

  ```bash
  # for each newly-arrived contract, show what is still unfilled
  awk 'f; /^## This project$/{f=1}' wheelhouse/<the-file> | grep -n '<!--'
  ```

  Fill each section from what your project already knows, or write one sentence saying it is deliberately unfilled and why. Do not leave it silent. `wheelhouse/INTEGRATOR.md` is the case that shows why: its project half records who may push and to where, and an upgraded project that leaves it empty has taken delivery of the contract whose central claim is that a gate exercised without being recorded stops existing — with the gate unrecorded.

## 6. Record the upgrade

```bash
NEW_COMMIT=$(git -C "$TEMPLATE" rev-parse HEAD)
if [ "$BASE" != unknown ] && [ "$NEW_COMMIT" = "$BASE" ] \
  && git -C "$TEMPLATE" rev-parse --verify --quiet "origin/${TARGET:-main}^{commit}" >/dev/null \
  && [ "$(git -C "$TEMPLATE" rev-parse "origin/${TARGET:-main}^{commit}")" != "$BASE" ]; then
  echo "STOP: target resolves to the baseline; the cache did not advance to origin/${TARGET:-main}" >&2
  exit 1
fi
sed -i.bak "s|^commit=.*|commit=$NEW_COMMIT|" wheelhouse/.template-source
rm -f wheelhouse/.template-source.bak
grep -q '^upgraded=' wheelhouse/.template-source \
  && sed -i.bak "s|^upgraded=.*|upgraded=$(date -u +%Y-%m-%dT%H:%M:%SZ)|" wheelhouse/.template-source \
  || echo "upgraded=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> wheelhouse/.template-source
rm -f wheelhouse/.template-source.bak
```

**Leave `installed=` alone, or `adopted=` if this project was adopted rather than freshly installed.** It records when this project first took the contracts, which is a different fact from when it last upgraded, and re-running the install block would overwrite it with today's date and lose that.

## 7. Sweep what the contracts do not cover

An upgrade re-copies the contracts and the runbooks and reaches nothing else. If the change altered a convention — a path form, a command name, a label — then your generated files and your existing beads still speak the old one:

- If this install has an uncommitted, git-excluded root `AGENTS.md` carrying the wheelhouse note, move it to `wheelhouse/AGENTS.md` and drop any `AGENTS.md` or `/AGENTS.md` line from `.git/info/exclude`; then `git check-ignore AGENTS.md` must exit 1. If root `AGENTS.md` is committed, leave it product-owned and put only the wheelhouse note in `wheelhouse/AGENTS.md`. Also remove any blanket `.agents/` or `/.agents/` line from `.git/info/exclude`; a wheelhouse install no longer claims that namespace, and only named machine-generated paths belong in the machine-local exclude file.

  ```bash
  sed -i.bak '/^AGENTS\.md$/d;/^\/AGENTS\.md$/d;/^\.agents\/$/d;/^\/\.agents\/$/d' .git/info/exclude 2>/dev/null || true
  rm -f .git/info/exclude.bak
  git check-ignore AGENTS.md >/dev/null 2>&1; test $? -eq 1 || echo "FAIL root AGENTS.md is still ignored"
  git check-ignore .agents >/dev/null 2>&1; test $? -eq 1 || echo "FAIL .agents/ is still blanket-ignored"
  ```
- `CLAUDE.md`, `wheelhouse/ISA.md`, `wheelhouse/STARTUP.md`, and the `## This project` sections you just preserved;
- if the target template changed `generated/CLAUDE.md.example`, `generated/STARTUP.md.example`, or `generated/SEATS.md.example`, read those specimens and hand-merge the matching standing behaviors into your real `CLAUDE.md`, `wheelhouse/STARTUP.md`, or `wheelhouse/fleet/SEATS.md` project half; generated examples are not installed by an upgrade, so existing installs do not learn new Decisions-before-beads, Goal-before-dispatch, Claims-move-on-merge, the two-mode `## Merge policy` for `Integration: fleet/<goal-slug>` goal branch work, verifier walker launch notes, roster cadence pointers, morning handoff archive, end-of-day `stop-all`, or Dispatch Office herald startup rules unless you add them. Also fill the new `### Goal branches in flight` stub that step 4's project section UPSTREAM report will list for `wheelhouse/INTEGRATOR.md`;
- the Dispatch Office herald arrives through the `seats/` copy, but copying the file does not start it. Hand-merge the `generated/STARTUP.md.example` cockpit guidance that says `seats/cockpit.sh <namespace>` owns the herald through `ensure_herald`: a first cockpit launch starts it, a later launch verifies or restarts it, and the proof is a `herald started:`/`herald already running:`/`herald dead: ... restarting` line from cockpit plus later `poke sent`/`poke cooldown`/`poke not-idle` lines in `seats/logs/herald.out.log` once inbox traffic exists. A non-cockpit cold start (`bun seats/adapter.ts spawn ...` plus `status`) starts seats but not the herald, so say that if you keep a no-cockpit path. When the copied herald first sees pre-existing `seats/logs/*.jsonl` files with no `seats/herald.state.json` cursor, it records their current EOF and does not replay their history; only later appends can create inbox events. This is the intended upgrade/adoption behavior, not lost evidence.
- Sweep `CLAUDE.md` and `wheelhouse/STARTUP.md` against `generated/CLAUDE.md.example` and `generated/STARTUP.md.example` for retired mechanics wording: old prose about the fleet-gate prompt hook, cockpit-started commander-pane polling, making the herald run, one-off herald checking through cockpit, and the old desk/courier watchdog scripts should be deleted or rewritten as pointers to supervisor, herald self-aim, alerts, and the fleet snapshot.
- Remove any old Claude Code `UserPromptSubmit` hook that runs `bash seats/fleet-gate.sh`; the herald/alerts path replaces the per-prompt computation. If this install intentionally wants the prompt status line, it may keep that hook now that `seats/fleet-gate.sh` is only a sub-second reader of `seats/run/fleet-snapshot.json`, but wire it with the project-root-anchored command `bash "$CLAUDE_PROJECT_DIR/seats/fleet-gate.sh"` so a shell in a product subdirectory does not run a nested copy.
- `seats/principal-sentinel.sh` also arrives through the `seats/` copy, but copying it does not wire the commander. Hand-merge the Claude Code Stop hook into `.claude/settings.json`: `{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash seats/principal-sentinel.sh"}]}]}}`. Keep any existing `SessionStart`, optional `UserPromptSubmit`, and other hooks; add this as a sibling. Then run `bash seats/principal-sentinel.selftest.sh`.
- `seats/desk.ts` and `seats/courier.ts` also arrive through the `seats/` copy. Hand-merge the generated startup prose that says `seats/cockpit.sh <namespace>` starts/verifies the local desk, writes its URL to `seats/run/desk.port`, exposes `/needs` and read-only `/board`, and starts the optional courier only when `seats/channels.json` declares an `audience: "principal"` channel. A bare legacy `seats/run/telegram.token` no longer makes cockpit start the courier; leave existing token files in place only for manual/back-compat courier runs, and do not create `seats/run/telegram.token` during an upgrade. If this install wants Telegram courier delivery, first declare a principal Telegram channel, then provision a dedicated bot/token outside git with mode `0600`; Telegram allows only one `getUpdates` poller per bot, so do not share a bot with another poller. Never commit anything under `seats/run/`. Then run `bash seats/desk.selftest.sh`, `bash seats/supervisor.selftest.sh`, and, when present in the copied template, `bash seats/courier.selftest.sh`.
- **Declare your stakeholder channels.** The `seats/` copy brought `seats/channels.ts`, `seats/comms.ts`, `seats/transports/teams.ts`, and `seats/channels.json.example`, but nothing is declared until you write install-owned `seats/channels.json`. Ask the same questions the current install interview asks: where do stakeholders talk; what stable channel name should the fleet use; is it `telegram`, `slack`, or `teams`; what destination id does the platform use; is its audience `principal` or `stakeholders`; who belongs there (member ids and human names); and may the commander read it (`read: true` or `false`). At most one channel may have `audience: "principal"`. Use `seats/channels.json.example` for the exact shape, then run the read-back:

  ```bash
  bun seats/channels.ts check --credentials
  ```

  For every declaration, tell the owner exactly where its credential goes (channels of the same kind share one credential). The owner provisions it; do not ask for a token or print one:

  | Kind | Environment variable in the commander/courier environment | Alternative file (mode `0600`) |
  |---|---|---|
  | Slack | `WHEELHOUSE_SLACK_TOKEN` | `seats/run/slack.token` |
  | Teams | `WHEELHOUSE_TEAMS_TOKEN` | `seats/run/teams.token` |
  | Telegram | `WHEELHOUSE_TELEGRAM_TOKEN` | `seats/run/telegram.token` |

  Teams may instead use `WHEELHOUSE_TEAMS_TOKEN_CMD`, a command whose stdout is a fresh Graph bearer token. If an existing credential is exported under another name, the owner exposes it under the supported name without displaying the value. Keep credentials out of `seats/channels.json`, `seats/seats.json`, git and logs; never dump the environment or token files. Run the check in the environment that will run the commander/courier, and require exit 0 before completing this walk. Missing, empty or wrong-mode credentials STOP with the supported names; fix and rerun, not a raw API bypass. Record only its channel-name/presence/count output. This is a local presence/mode check, not proof of authorization or channel access; it sends nothing. A no-channels record needs no credential. The legacy courier files `seats/run/telegram.allow` and `seats/run/slack.channel` are manual/back-compat inputs only when no principal channel is declared; cockpit starts the needs courier only from a declared principal channel. If this install grew a private channel watcher, a private `COMMS.md`, or a Slack-watch script, move the ids into `seats/channels.json`, set `read: true` on the channels it watched, and retire the private watcher only after `bun seats/comms.ts read <channel>` shows rows in `seats/inbox.jsonl`. For Telegram, that retirement is mandatory before enabling a courier/read path on the same bot: `getUpdates` has one offset consumer per bot token, so do not run two pollers. This is the migration path for installs like Releaf and Meridian: declare the watched Slack conversations, verify the template read path, then delete the local watcher rather than running two readers.
- the intent layer and prune machinery's other paths are covered by the upgrade mechanics above: `GRAPH.md` and `INTEGRATOR.md` contract halves move through the splice list, `RUNNING_THE_LOOP.md` and the retired `prune-worktrees.sh` pointer move through the runbook copy, and `seats/intent-check.sh` plus `seats/prune.ts` move through the seats copy; verify those outputs rather than hand-editing them here;
- every bead that is not closed and whose text cites paths or commands, especially long-lived ones filed at install;
- the `template-report` label, if you installed before it existed — `wheelhouse/GRAPH.md` names it as the marker for template-class findings, and nothing back-fills it onto the `Report <tool> issue: ...` beads you already filed or writes its line into a `CLAUDE.md` generated before it.
- installs predating `github-report=` have no line, which the publisher reads as off; append `github-report=off` and `github-report-routes=` to `wheelhouse/.template-source` so the record is explicit, and point at `BOOTSTRAP.md`'s publishing question if the principal wants it on.

### Carry ISA direction changes to the producer

The copied supervisor syncs changed open claims from `wheelhouse/ISA.md` into
`isa-change` intake signals every 30 seconds. Make the install policy explicit
without overriding an existing opt-out:

```bash
grep -q '^isa_signals=' wheelhouse/.template-source \
  || printf '\nisa_signals=on\n' >> wheelhouse/.template-source
```

`isa_signals=off` disables the tick. The first `bun seats/isa-signals.ts sync`
only snapshots existing claims, avoiding an upgrade flood; subsequent changed
or new open claims reach the producer through `seats/intake.jsonl`. Hand-merge
the matching direction-first paragraph from `generated/CLAUDE.md.example`:
the commander records the human's words, dated, in ISA Decisions and updates
the affected claim before work depends on it, then syncs that claim to intake;
the producer defines the work, not the commander. See `seats/README.md`, **ISA
claims — direction reaching intake**, for the manual sync and status commands.

### Dispatch refuses work that is not a contract

After copying `seats/`, run the audit below. Use step 3's complete runtime copy, not `contract.ts` alone: Signal checks also load `intake.ts` and its shared helpers. This keeps the audit on the same intake implementation as dispatch and trace.

```bash
contract_audit_rc=0
bun seats/contract.ts audit || contract_audit_rc=$?
case "$contract_audit_rc" in
  0) ;;
  1) echo "Contract audit found legacy beads: repair their Intent: and Outcomes: before dispatch; continuing the upgrade sweep." ;;
  *) echo "STOP: contract audit could not read the graph (exit $contract_audit_rc); repair the read failure before continuing." >&2
     exit "$contract_audit_rc" ;;
esac
```

Each listed open or in_progress bead needs its `Intent:` and `Outcomes:` sections, with a consumer, surface and matching check per outcome, before the fleet can dispatch it. Use `wheelhouse/GRAPH.md`, **Every bead is a contract**, for the grammar; `bun seats/contract.ts check <bead-id>` prints every defect for one bead. Audit exits 1 for invalid contracts and 3 if the graph cannot be read. The block reports legacy contracts without aborting the rest of the upgrade sweep, including under `set -e`; repair them before dispatch. An unreadable graph still stops the upgrade: repair the read failure instead of treating it as an empty queue. `verify.ts` also refuses uncontracted work with exit 6; `WHEELHOUSE_DISPATCH_FORCE=1` does not bypass the dispatch gate. Signal and Skills are parsed here; their refusal gates are separate upgrades.

### Adopt the autonomy mandate in existing installs

Ask the principal the same question current `BOOTSTRAP.md` asks: how far does the fleet take work? The default answer is **all the way** — merge, push, open and merge PRs, and deploy wherever the project has an automated deploy path — stopping only for this install's reserved actions or a genuine fork in product intent. Record the answer in `wheelhouse/INTEGRATOR.md`'s project section along with the explicit reserved list and the date. The mandate line must quote the principal directive verbatim: "the whole point of the Wheelhouse and the mandate is to create work and to do work, not to ask if you can create work, ask if you can start work, and ask if the work can be declared done."

Then hand-merge the same standing behavior into `CLAUDE.md` from `generated/CLAUDE.md.example`: the `## Autonomy mandate` section, the `## Commander voice` section, the two-and-only-two reasons to interrupt the principal, and the restart checklist. The voice addition is not cosmetic: commander prose that reaches humans names tasks, intents, and outcomes, not `bead`, bare namespace ids, or mannered filler such as `kindly`, `please advise`, `circle back`, or `do the needful` except inside literal commands, paths, branch names, or quoted history with a human explanation beside it. Add an ISA Decision quoting the directive in `wheelhouse/ISA.md` so a restarted commander cannot lose it. Finally, read `wheelhouse/AGENTS.md` if the install has one: keep bd's command reference, but append or update the wheelhouse override so bd's Conservative/default "do not push" text cannot be cited against the authority in `wheelhouse/INTEGRATOR.md`.

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

**An upgrade does not break your fleet mid-flight.** Nothing in steps 3 and 4 touches a running session or its config directory; your v1 seats keep working from the files they were launched from until you retire them. What IS true the moment step 3 lands is that your installed runbooks and contracts describe the Pi shape while your `STARTUP.md` and seat directories are still v1 — so treat this migration as one sitting, not a background task. The normal sitting still has a seam: commit the upgrade proper first, then pause for principal-only seat credentials and land the roster in a second commit.

Step 4 above will have printed `project section UPSTREAM, not in yours — wheelhouse/fleet/SEATS.md: ### Declined seats` (and `new, copied whole: wheelhouse/crew/VERIFIER.md` before it): the new seat contract and the verifier arriving are this migration announcing itself. Here is the order that works:

1. **Record the namespace, in the file the machinery reads.** Derive the default deterministically from the exact project directory name, lowercased and made filesystem-safe as one path segment. That default is the rule; correct it only for an actual collision on this machine or because the principal explicitly chooses a different namespace. It names this project's seat root, `$HOME/.pi-seats-<namespace>`, which is what keeps two fleets' accounts apart on one machine; `BOOTSTRAP.md` step 3's question 7 says why in full.

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

   Guarded with `-f` because which of these a v1 install actually has depends on when it installed; absent files are the fine case. Your install may hold them at other paths, as Releaf did with `wire-seats.sh` under `wheelhouse/fleet/`; find the old v1 files by name before deciding they are absent. Sweep your own surfaces for the same era's residue while you are here: any `CLAUDE_CONFIG_DIR` export, `SEATS_ROOT` export, foreign-directory check, or `claude --permission-mode auto` launch block in `wheelhouse/STARTUP.md`, and any note that points a reader at the roll call or `SEAT_DISCOVERY.md`. Those blocks are the v1 launch surface, and every one of them comes out — `STARTUP.md`'s job is now to name this project's namespace and seat names over the `seats/` commands, in the shape `BOOTSTRAP.md` step 5 writes for a fresh install.

3. **Interview yourself into a roster, and write `seats/seats.json`.** This is `BOOTSTRAP.md` step 3, questions 7 and 8, run over the fleet you already have instead of a proposed one — read both and answer them for real, because two of their facts did not exist in v1: each seat's **provider and auth route** (`openai-codex` by ChatGPT-subscription OAuth, or an `api_key` provider — an Anthropic seat is an API-key seat, since the API rejects third-party subscription auth) and its **pinned model**. Question 7's walk decides which v1 seats carry forward; question 8 is then its own round over the seats that carried, one seat at a time — provider, auth route, and a model pinned from a LIVE `pi --list-models` listing (filtered with the awk question 8 shows), with question 8's read-back table closing the round. If the upgrader is Claude Code and has `AskUserQuestion`, conduct the migration interview through the tool: one round for carry-or-decline, then one per carried seat with model options built from the listing's own output; free prose is only the fallback when the tool is absent. Seat names carry no namespace prefix — `worker-1`, not `<namespace>-worker-1`; the per-project seat ROOT is what keeps fleets apart now, and the adapter addresses seats per-project. Your v1 roster in `wheelhouse/fleet/SEATS.md`'s project half is the list of seats to walk; rewrite that section as the human record of the new roster (and fill `### Declined seats` with any v1 seat you are not carrying forward, reason and date), while `seats/seats.json` is the machine record every command reads. No secret enters `seats.json`, ever.

4. **Provision and probe each seat.** `BOOTSTRAP.md` step 4, verbatim: `seats/seat-env.sh <namespace> <seat-name>` once per seat, the one-time OAuth flow (`PI_CODING_AGENT_DIR=... pi`, then `/login` inside the REPL, then `/exit`) or api_key placement (`auth.json` / provider env var) as that seat's own account, then the readiness probe. Re-running `seat-env.sh` on an existing Pi seat also retrofits `$HOME/.pi-seats-<namespace>/.project` without touching `auth.json`; if that backlink already names a different project root, the STOP is the collision signal to resolve before provisioning continues. The one-seat-one-account rule survives the rebuild unchanged: the reviewer's and verifier's directories must differ from every worker's. For the proving dispatch, nobody creates a worktree by hand: `bun seats/adapter.ts dispatch` prepares the seat's own `.wheelhouse-worktrees/<seat-name>` on the bead's `fleet/<bead-id>` branch itself.

5. **Retire the old roots, last.** The v1 config directories under `$HOME/.claude-seats*/` hold real logins, so they are the one thing you delete only after the new seats have passed their probes and a real dispatch has come back. Read what is left before deleting anything — on a machine that hosted more than one v1 wheelhouse, what remains under a shared root is another project's fleet.

A real example, from the upgrade this procedure was written from. That upgrade changed one thing upstream: a path convention, `crew/` to `wheelhouse/crew/`. The contracts were re-copied correctly and the check passed 6/6. The install's very first bead — filed by the bootstrap itself — still read *"Implement crew/bench.sh against crew/BENCH.md"*, and its acceptance criterion pointed at `contracts/BENCH.md`, a template path that does not exist in an installed project at all. Nothing was broken and no check could have caught it, because no check looks at the graph. It was found by reading, and fixed by editing the bead.

That is the shape of what step 7 catches: not damage, but the parts of your project that quietly went on speaking the old dialect.

## 8. Commit

Check that this commit contains only the upgrade and the sweep above, not pre-existing dirt. Read the `??` lines too: an untracked evidence directory under `wheelhouse/` will ride the directory add below unless you exclude it or replace the broad directory add with explicit paths. Never stage fleet captures or task-graph dumps: post decisive output on the task and keep local working captures git-excluded. Step 7 can also make you edit project-owned surfaces outside `wheelhouse/`, especially `.claude/settings.json`; stage those exact files when they exist, and stage any other step-7 path you deliberately changed before committing.

```bash
git status --short
```

```bash
NEW_COMMIT=$(sed -n 's/^commit=//p' wheelhouse/.template-source)
[[ "$NEW_COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || { printf "REFUSED template source: invalid commit='%s'; expected 7-40 lowercase hexadecimal characters\n" "$NEW_COMMIT" >&2; exit 1; }
NEW=$(printf '%s' "$NEW_COMMIT" | cut -c1-12)
git add wheelhouse/ seats/ .gitignore CLAUDE.md .beads/
for p in .claude/settings.json; do
  [ ! -e "$p" ] || git add "$p"
done
# If step 7 made you edit any other project-owned file, add its exact path now.
git status --short
git commit -m "Upgrade wheelhouse contracts to $NEW"
```

The sha is read back out of `wheelhouse/.template-source` rather than passed down from step 6, so the commit subject and the recorded baseline cannot disagree — they are the same twelve characters of the same line, and this block needs nothing from your shell's history to run. It read `<short-sha>` as a placeholder until this was measured: run verbatim, the block committed the literal subject `Upgrade wheelhouse contracts to `, which is the one thing a later reader of `git log` cannot recover the answer to.
