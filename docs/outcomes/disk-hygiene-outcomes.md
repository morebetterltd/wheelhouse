# Disk hygiene — outcomes

What "done" looks like for Keenan's intent of 2026-09-29: **"Disk stays clean forever."** Fix it "once and for all"; "no other sessions has been able to." Disk hygiene becomes durable across every Wheelhouse fleet (Parslee-AI and CAR on the home Mac; MoreBetter fleets on the Air through the template), with no manual cleanups.

Nothing in this file is built yet. Each bullet is a promise the work keeps, written so a stranger can confirm it through the channel its user actually meets it on. The checks live in `../../ISA.md`, one per bullet.

## Who uses each surface, and how each outcome is confirmed

| Who | Surface | How its outcomes are confirmed |
|---|---|---|
| **Keenan** | The Telegram texts the needs queue sends him (disk alarm, reaper failure digest); the free-space number he sees (`df -g /`; Finder shows the same disk, but `df` is the number this work promises) | Receive and read the real text (or the real dry-run body the queue would send); run `df` |
| **Fleet commanders and seats** (Parslee-AI, CAR; MoreBetter on the Air) | Their worktrees, run folders, branches, the commander's cleanup routine | Run the fleet's own tools (`git worktree list`, `bun seats/prune.ts scan`, `bd show`), read a seat's log, look at the disk |
| **Forge/Codex dispatches** | The `codex exec` sandbox, its writable roots, the shared build folder and lock, Codex session logs | A real dispatch, then `ls`, `lsof`, the lock log and the helper's stdout JSON |
| **The machine** | The Pulse reaper job, the shared Rust target and its cap, the copied daemon binary, gitignore, selftests, logs | Tests, literal command output, log lines, exit codes |

Baseline on 2026-09-29 13:05 EDT (captured into `../../baseline/`): 926 GB disk, 201 GB free; Parslee 40 registered worktrees and 8 seats + a commander; car 24 registered worktrees; `~/.codex/sessions` 15 GB (10,366 files older than 30 days); car index holding 302 staged run logs; 297 `~/.cache/car-home-*` scratch folders. The shared Rust target `~/.cache/cargo-target` and `~/.cache/car-regen` are ABSENT at capture time (removed since the morning report), so the first fleet build recreates the shared target from zero; three hand-started `car do --serve` daemons still run from the deleted `cargo-target/release/car` binary and a fourth from a private `car-verify-deadline2-target`; five private targets exist (`car-fcrp-target`, `car-main-daemon-target`, `cargo-target-fcrp-headless`, `cargo-target-kimi-auditor`, `car-verify-deadline2-target`).

---

## A. Keenan — the disk alarm text

Channel: the Telegram text on his phone; `needs list --all` shows the same need.

- When free space on a Mac falls under 100 GB, Keenan gets exactly one Telegram text from the needs queue, and its title says in plain words that the disk is low and how many GB are free (for example "Disk low: 84 GB free on the home Mac").
- The alarm text names what is growing, in plain nouns and sizes, not paths: for example "Rust build folder 61 GB, Codex session logs 15 GB, Parslee worktrees 22 GB". A stranger reading it knows what to blame without opening a terminal.
- The alarm text contains no file paths, no bead or seat ids, no pane names, no JSON, no credential values and no stack traces.
- The alarm text says what happens if he does nothing (the "If no answer:" line): the nightly reaper keeps freeing what is safe, and he is texted again only when a new low-disk episode starts.
- The alarm is a one-way notice: the text has no "Reply yes/no" line, it never resurfaces as "Still waiting", and it does not sit in `needs list` as something waiting on him.
- While the disk stays under 100 GB he is not texted again the next night or the night after: one alarm per low-disk episode. `needs list --all` shows a single alarm need for that episode, not one per day.
- If free space recovers above 100 GB and later drops under it again, that is a new episode and he gets one new text.
- The alarm never fires between 22:00 and 07:00 Eastern; a drop overnight is texted at or after 07:00, and it is still one text.
- Each alarm is about one Mac only and says which ("home Mac" / "the Air"); the home Mac's alarm never goes silent because the Air is fine, and vice versa.
- The alarm text is short: title under 80 characters, body readable on one screen, delivered as one Telegram message.
- A brief dip under 100 GB during a build that recovers before the next check does not produce a text; the low reading has to hold at the next check.

- With the shared target under its cap and every fleet clean, but the disk still under 100 GB because of something outside this work (Docker, the HF hub, Mail), the alarm text still names those consumers, so Keenan knows the reaper is not the problem.
- The first alarm after deploy is proven end-to-end without waiting for a real low-disk day: a dry run with a forced free-space number under 100 GB produces the exact text body (title, the "what is growing" line, the "If no answer" line), and it is read against the queue's own text rules.

## A2. Keenan — the reaper's failure digest

Channel: Telegram text; `needs list --all`.

- On a night when the reaper freed what it should and refused nothing unexpected, he gets no text at all. Silence means it worked.
- On a night when the reaper could not free something it expected to (a removal failed, a safety check refused a candidate over 5 GB, or the job itself crashed), he gets exactly one text marked FAILURE that says in plain words what it could not free and why (for example "Refused 3 worktrees: one still has unsaved work, two are in use by a running seat").
- The failure text says how much it did free that night and how much it could not, in GB.
- The failure text also arrives as the spoken Pulse line every FAILURE need gets today.
- A refused item is texted once: a worktree the reaper keeps for real uncommitted work does not produce a new text every night, only when it changes (grows by more than 5 GB) or 30 days pass. A crashed job is different: it texts once per night it crashes, and the second night's text says it is a repeat.
- A reaper failure text and a disk-alarm text on the same night are two separate texts.
- Nothing from the reaper ever asks him a question; no reaper text ends in "Reply yes/no". Decisions about a refused item are his to make at his own time, never on the phone.

## A3. Keenan — the disk he can see

Channel: `df -g /` and Finder's "Available" number.

- Once the change has landed and the first nightly run has completed, `df -g /` on the home Mac shows more than 100 GB free on every morning across four straight weeks of both fleets working, with Keenan running no cleanup command and answering no cleanup question.
- Keenan never has to run `prune`, `git worktree remove`, `rm -rf`, `cargo clean`, `docker prune` or the `_FLEETPRUNE` skill by hand to keep the machine working; the reaper's log plus each fleet's cleanup log account for every removal in that period, and no removal in those logs is marked manual.
- No commander ever opens a need or sends a Teams message asking him to approve a routine cleanup; the only cleanup-related texts he receives are the alarm and the failure digest above.
- The one-time cleanup of 2026-09-29 (66 GB to 197 GB free) is never repeated by hand; the free-space number stays in that range on its own.

## A4. Keenan — things that must stay as they are

Channel: his phone; `needs health`.

- Every other need still reaches his phone the same way: a fleet approval, a promise, the Monday scoreboard fyi and the 07:00 morning brief arrive on the same schedule and in the same shape as before.
- `needs health` prints `OK` at the start of its line on the home Mac before and after the change, and the open-need count it reports is not inflated by disk needs (an alarm auto-closes once sent).
- On the Air, the same alarm and failure texts reach him through the home Mac's queue (the Air opens needs over the tunnel); if the tunnel is down when the Air's reaper wants to text, the text arrives once the tunnel is back rather than being lost, and he never gets two copies.
- His Telegram stays his channel: no disk text goes to Teams, email or iMessage unless Telegram texting is genuinely down by the queue's own two-check rule.

---

- The Air's disk is smaller than the home Mac's; the 100 GB threshold is applied there unchanged unless Keenan sets a per-Mac number, and the first Air alarm (or dry-run body) names the Air's real free space so he can judge the threshold.

---

## B. Fleet commanders and seats — one worktree per seat, cleanup on bead close

Channel: `git worktree list`, `bun seats/prune.ts scan`, `ls .wheelhouse-runs`, a seat's log, `bd show <bead>`, the fleet's cleanup log, the commander's transcript. Facts: Parslee has 8 seats plus a commander (cap 10); car has 7 plus a commander (cap 9); today car's adapter and `reap.ts` carry a hard-coded cap of 15 and reap on every settle, while Parslee caps at 45 and never prunes on its own.

### B1. Worktrees and the cap

- After a full day of fleet work, `git worktree list` in the Parslee-AI root shows at most 10 entries under `.wheelhouse-worktrees` (8 seats + 2), and in the car root at most 9 (7 seats + 2); the number never climbs past that cap no matter how many beads closed that day.
- Each seat's worktree is named for the seat, not the bead, lives under `.wheelhouse-worktrees/`, and the same directory carries the seat through consecutive beads: `git -C <seat worktree> branch --show-current` reads the current bead's branch, and the previous bead's branch still exists as a ref with its commits. The reviewer cleanup guard, the adapter's cwd resolver and `wheelhouse/fleet/WORKER.md` all agree on the new path, and the reviewer-worktree-guard selftest still blocks a reviewer from deleting inside `.wheelhouse-worktrees/`.
- A seat starting a new bead does not get a fresh checkout: the worktree's path is unchanged from the previous bead, so a warm build continues instead of a cold one (the seat log shows no full rebuild on the second bead of the day).
- A seat is moved to its next bead only after the previous bead's branch has been pushed; if the push fails (remote down, auth expired), the seat log records the refusal in plain words, the old branch and its commits stay checked out, and the seat is not dispatched onto a new bead until a later push succeeds.
- When a bead needs a different base than the seat's current one (a mayline/main bead after an origin/main bead), the seat's worktree switches base cleanly; `git status` in the worktree is clean and `git log -1` shows the expected base tip.
- The cap is the number of seats in that fleet's `seats.json` plus 2; adding a seat raises the cap by one without anyone editing a number, and the adapter prints the count and the cap when it refuses a dispatch. Seats that run from the repo root (reviewers, the verifier) do not consume a slot, so their unused slots are headroom.
- With every seat busy and the cap reached, a dispatch for a new bead is refused with a message that names the count, the cap and which seat to wait for; it is never refused because closed beads' worktrees are still sitting around.
- The car fleet's cap and reaper agree with the template's: car no longer carries its own hard-coded 15, and its reap tool reports the same cap the adapter enforces.
- Resuming a seat after cleanup works: `bun seats/adapter.ts resume` for a seat whose old bead worktree was removed does not fail on a missing cwd, and the seat's next turn runs from a real directory.

- A seat's saved session cwd (`seats/state.json`) resolves to its seat worktree after the change; `bun seats/adapter.ts resume` for every seat in `seats.json` starts in that directory with no "cwd does not exist" line in its log.
- The `.pruned-placeholder` flow still works: a seat worktree that was pruned and left a placeholder is recreated on the next dispatch with no manual step, and a placeholder directory containing anything else is refused with the same message as today.

### B2. Cleanup on bead close

- On bead close, `bun seats/prune.ts scan` lists that bead's run folder, any per-bead build folder and (if one still exists) its per-bead worktree as prunable within minutes, and after the automatic cleanup runs, `ls .wheelhouse-runs` no longer shows the bead and `git worktree list` no longer shows it.
- A bead that was squash-merged (its merge commit is on origin/main and the head branch was deleted on GitHub) counts as done; its worktree is removed even though the branch tip is no longer an ancestor of main.
- A car bead whose commits landed on `origin/fleet/ootb-agent` counts as done; `prune.ts scan` on car names that ref in its reason line instead of "no merged PR/ancestry".
- An open bead whose worktree has zero commits of its own beyond its base, no uncommitted changes and no seat sitting in it is listed prunable by `prune.ts scan` with a reason that says so, and removing it costs nothing because the branch ref stays.
- A run folder under `.wheelhouse-runs` is kept while any live process has its cwd inside it or its bead is still open; after that seat moves on and the bead closes, the next cleanup removes it.
- Two beads closing in the same minute are both cleaned up; neither cleanup fails because the other holds the state lock or the build lock, and the cleanup log has one line per bead with its outcome.
- When a bead-close cleanup or the nightly cleanup removes something, one line per item appears in the fleet's cleanup log (path, category, bytes freed, reason), and a stranger can match each line to a directory that no longer exists.
- The commander's routine has no manual `rm -rf` or `git worktree remove` step; COMMANDER.md tells the commander that cleanup happens on bead close and nightly, and a stranger reading it finds no instruction to prune by hand except the reviewed `prune.ts` path for exceptions.

- car's settle-time reaper (`reap.ts --stale`, today with its own cap of 15) is either retired or reads the seats+2 cap; after a settle the log shows one reap line naming the same cap the adapter prints, and never two reapers (settle reap and bead-close cleanup) acting on the same path within the same minute.
- A bead closed while its seat is mid-push (push started, not finished) is not cleaned up until the push completes or fails; the cleanup log shows "deferred: push in progress" and the worktree is still present until the next cleanup.
- A single oversized worktree (over 20 GB from leftover in-tree build output) is cleaned up by the same rules as any other; size alone never makes an item "needs review".

### B3. Never lose work

- Removing a worktree never deletes a branch ref: after cleanup, `git branch --list 'fleet/*'` still shows the closed bead's branch, and `git log fleet/<bead>` shows its commits.
- A worktree whose commits are on no remote ref is never removed without an archive tag first; after cleanup, `git tag --list 'archive/*'` contains a tag pointing at the old tip.
- A worktree with real uncommitted changes (a modified source file, an untracked source file) is never removed; `prune.ts scan` lists it as needs-review with "uncommitted changes", and it is still present after every automatic cleanup and every nightly run. (On 2026-09-29 this kept `crocodil-1042` with 94 real lines.)
- A worktree whose only "changes" are deletions of build output that was once committed (the 1,008-file phantom diff) is treated as clean for cleanup purposes; `prune.ts scan` marks it prunable and says the diff is build output only.
- A seat whose shell cwd is inside a worktree never finds that directory gone: either the cleanup skips the worktree (`prune.ts scan` says a live process has its cwd there) or the seat is re-homed to a valid directory before removal, and the seat's next bash command in its log succeeds. (On 2026-09-29 this kept the jn7a run folder.)
- A seat that crashed mid-bead leaves a worktree that is kept until the bead is closed or the seat is reset; nothing about a crash alone makes the worktree prunable, and `bd show <bead>` still shows the bead in progress.
- A bead reopened after close is not stranded: the seat that takes it again gets a worktree on the same branch with the old commits present (`git log fleet/<bead>` unchanged), even if the old worktree was already removed.
- Seat anchors are never removed: every worktree named in `seats/state.json` or in a seat's saved session cwd is listed as `seat-anchor` by `prune.ts scan` and is present after every cleanup.
- Integration worktrees named in `wheelhouse/ISA.md` are never removed, whatever their bead status.
- A cleanup that cannot verify something (lsof unavailable, unreadable ISA, git status timed out) removes nothing for that row and says why in its scan output; it never fails open.

- Interactive worktrees under `.worktrees/` (car-fcrp-kimi-auditor with an open PR and live processes, car-0zkz.26-replays with 641 untracked files) and checkouts outside every fleet root are never touched by bead-close cleanup or the nightly reaper: they are outside `.wheelhouse-worktrees/`, have no closed bead, or hold uncommitted or unpushed work, and every one is still in `git worktree list` after a week.
- Two seats can never be dispatched into the same worktree: a second dispatch targeting a worktree another seat's record already names is refused with a message naming the occupying seat.
- A worktree path containing spaces or a symlink component is handled without deleting the wrong thing: the cleanup resolves the real path, compares it against the registered path, and refuses (logging "path mismatch") if they differ.

### B4. Two fleets at once

- Two fleets building at the same moment (Parslee and car) take turns on the one build lock: `~/.cache/car-build.lock.log` shows one acquiring after the other releases, and neither seat's build fails with a "file in use", a missing artifact or a foreign-branch compile error.
- A seat dispatched while a cleanup is running in the same fleet is not broken by it: its worktree is created or reused normally, its first command succeeds, and the cleanup log shows the cleanup skipped anything that seat touched.



### B5. Template and the Air

- The seat-worktree change lands in the wheelhouse template first; an installed fleet (Parslee, car, a MoreBetter fleet on the Air) that syncs from the template gets identical behaviour, and `wheelhouse/.template-source` in each install records the template commit that carries it.
- `.wheelhouse-runs/` and `.wheelhouse-worktrees/` are listed in the template's tracked `.gitignore`, so a fresh install has them ignored without touching `.git/info/exclude`; `git check-ignore .wheelhouse-runs/x` in a fresh install prints the path.
- Every existing seats selftest passes in the template and in each install after the change: `seats/prune.selftest.sh`, `seats/adapter.selftest.sh`, the reviewer-worktree-guard selftest and `seats/worktree-root.selftest.sh` exit 0.
- A new selftest proves the never-lose-work rules: it seeds a worktree with a real uncommitted change, one with only phantom build-output deletions, one with commits on no remote, and one occupied by a live process, runs the cleanup, and checks that only the phantom one is removed and the unpushed one gets an archive tag.

- A fresh install with zero worktrees runs the cleanup and the cap check without error: `bun seats/prune.ts scan` prints an empty result and the adapter's first dispatch creates the first seat worktree.

---

## C. Forge/Codex dispatches

Channel: `ls ~/.cache`, `lsof`, the lock log `~/.cache/car-build.lock.log`, the helper's stdout JSON, `forge-events.jsonl`, `ls ~/.codex/sessions`. Facts: today `~/.cache` also holds `cargo-target-kimi-auditor` and `car-main-daemon-target` beyond the four in the report, and 297 `car-home-*` test scratch folders; `~/.codex/config.toml` sets `default_permissions = ":danger-full-access"`, which the helper's `--sandbox workspace-write` overrides only for helper-launched runs.

### C1. Building

- A build-mode Forge dispatch that compiles Rust from a car worktree writes its artifacts into `~/.cache/cargo-target` and nowhere else: after the dispatch, `ls ~/.cache` shows no new `car-*-target`, `cargo-target-*` or other target folder, and no `target/` directory appears inside the worktree.
- The private targets that exist today (`car-fcrp-target`, `cargo-target-fcrp-headless`, `cargo-target-kimi-auditor`, `car-main-daemon-target`) are gone once their PRs are merged or their branches abandoned, and a week later `ls ~/.cache | grep -i target` lists only `cargo-target`.
- A build-mode dispatch's Codex sandbox can write to `~/.cache/cargo-target` and `~/.cache/car-build.lock` (and the lock's `.holder` and `.log` beside it): a `cargo build` inside the dispatch succeeds instead of failing with a permission or read-only error, and that run's `forge-events.jsonl` contains no "read-only file system" or "operation not permitted" text for those paths.
- A build-mode dispatch's sandbox is still `workspace-write`, not full access: `ps -o command= -p <pid>` for the running `codex exec` shows `--sandbox workspace-write`, and a probe dispatch asked to write a file under `~/Documents` outside its worktree is refused.
- Inside a dispatch, `command -v cargo` resolves to the fleet shim (`seats/bin/cargo`) rather than `~/.cargo/bin/cargo`, and `cargo --contract` run from within the dispatch prints `lock=~/.cache/car-build.lock`, `jobs=8`, `test_threads=4`, `reentry=CAR_BUILD_LOCK_HELD`.
- Every compiling cargo call a dispatch makes appears in `~/.cache/car-build.lock.log` as a wait or acquire line followed by a child-exit line with the same pid, so a stranger can trace the dispatch's builds by pid.
- A dispatch that exports `CARGO_TARGET_DIR` pointing anywhere other than `~/.cache/cargo-target` does not get a private target: the shim redirects the build into the shared target (or refuses with a one-line message naming it), and `ls ~/.cache` afterwards shows no folder by the requested name.
- Two dispatches (or a dispatch and a fleet seat) that both compile at the same time serialize on the lock: the lock log shows a wait then an acquire for the second, both builds exit 0, and neither reports a corrupted or phantom-error artifact (no E0004/E0063-style errors quoting the other checkout's source).
- The shim's cross-worktree cache guard runs for a dispatch exactly as it does for a seat: when a dispatch builds from checkout B after checkout A last built, the lock log records the guard's invalidation line, and the build from B compiles B's source (a symbol that exists only in B resolves).
- A dispatch that only runs read-only cargo verbs (`fmt --check`, `metadata`, `tree`) never waits on the lock; the log shows the read-only passthrough for them.
- Forge's own instructions name the shared target rule: `~/.claude/agents/Forge.md` tells a build-mode dispatch to build into `~/.cache/cargo-target` through the shim and never to set a private `CARGO_TARGET_DIR`, in one sentence a stranger can find with `grep -n cargo-target ~/.claude/agents/Forge.md`.

### C2. Ending, killing, cleaning

- When the helper hits its cap (300 s default) or is sent SIGTERM/SIGKILL, no lock holder survives: within 10 s, `~/.cache/car-build.lock.holder` is absent (or names a live pid that is not codex/cargo), `lsof ~/.cache/car-build.lock` lists no dead-dispatch pid, and the next fleet `cargo build` acquires without waiting.
- A killed dispatch leaves no half-written private target folder and no cargo `.cargo-lock` that blocks the next build: the next `cargo build` in the shared target starts compiling without "Blocking waiting for file lock on build directory" for more than 60 s.
- The helper's stdout contract is unchanged: its last line is exactly one JSON object with the keys `verdict`, `exit_code`, `events_file`, `final_file`, `duration_ms`, `final_message` (or the `unavailable` form when codex is missing), and a trivial `bun ForgeProgress.ts --slug x --prompt 'say ok'` still returns that line with `verdict: "success"`.
- Audit-mode dispatches are untouched: a `--sandbox read-only` run makes no entry in the lock log, creates no folder under `~/.cache`, and writes nothing into any worktree (`git status --porcelain` in the worktree is identical before and after).
- A dispatch's code changes survive its build output being throwaway: after a dispatch, `git -C <worktree> status --porcelain` shows the files Codex edited, and after the shared target is trimmed those same files are still present with the same content (`git diff` unchanged).
- Nothing a live dispatch is using is removed by any cleanup: while a dispatch's codex pid is alive, the nightly reaper's log lists its worktree, its `MEMORY/WORK/<slug>/forge-*` files and its `~/.codex/sessions` file of that day as kept, with the reason "process has files open" or "newer than 30 days".
- A worktree that is reclaimed after a dispatch's parent session has finished keeps the dispatch's work: every commit the dispatch made is on a pushed branch or an `archive/` tag before the worktree goes (`git branch -r --contains <sha>` or `git tag --contains <sha>`); a worktree whose dispatch left uncommitted edits is kept and named in the reaper log as "uncommitted work".
- Codex session logs older than 30 days are gone and newer ones stay: `find ~/.codex/sessions -type f -mtime +30 | wc -l` prints 0 the morning after the first nightly run (10,366 today), `find ~/.codex/sessions -type f -mtime -30 | wc -l` is unchanged from the evening before (886 today), and the folder is under 2 GB instead of 15 GB.
- The 30-day session sweep never deletes today's or a running dispatch's session: a dispatch started at 23:55 has its session file present at 00:10, and `forge-events.jsonl` for that run is intact.
- `~/.codex/.tmp` (3.7 GB today) entries older than 30 days are removed by the same sweep, and an entry belonging to a live codex pid (found via `lsof +D ~/.codex/.tmp`) is kept.
- A dispatch still works when the shared target has just been trimmed under it: the next `cargo build` in a dispatch after a trim rebuilds what was swept and exits 0, with no "no such file" errors for `deps/` entries.

---

## D. The machine — the build cache, the daemon, git hygiene, the nightly reaper, tests

Channel: test names, `du`/psize output, `lsof`, `launchctl list`, the Pulse job log, `git status --porcelain`, `git check-ignore`. Facts: three hand-started `car do --serve` processes run today from the (now deleted) `~/.cache/cargo-target/release/car` binary and one from a private target (the launchd daemon plist already runs a copied `car-server` binary); `com.keenan.disk-reaper` (hourly), `ai.parslee.car.fleet-disk-guard` (every 10 min) and `ai.parslee.car.fleet-target-clean` (02:30, `cargo clean` of the whole shared target) are all still loaded; no Pulse job touches disk today; no local Time Machine snapshots exist.

### D1. One shared Rust build folder, capped and never held open

- `du -sk ~/.cache/cargo-target` reads at or below 40 GB after the first build or nightly run following the cap landing, and stays at or below 40 GB on every later daily reading for a week while both fleets build.
- When the shared target is over 40 GB, the sweep removes only artifacts whose last use is older than 48 hours, and the shim log (`~/.cache/car-build.lock.log`) shows one sweep line with bytes freed and the size before and after.
- The sweep is one routine with two callers: the shim runs it after a build when the target is over the cap, holding the lock; the nightly reaper runs it only if it can take the lock without waiting, and otherwise logs "shared target skipped: lock held". Nothing else ever trims the shared target.
- A second cargo started during a sweep waits on the lock and then builds successfully (its output has no "No such file" or fingerprint error).
- Nothing ever runs `cargo clean` on the whole shared target; after a sweep, a rebuild of the car workspace reuses registry dependencies (the build log shows `Fresh` for registry crates, not a recompile from zero).
- A sweep under the cap is a no-op: with the target under 40 GB, the shim log shows no sweep line and the build starts immediately.
- If the sweep cannot determine an artifact's last-use time, it leaves that artifact alone and logs it; it never falls back to deleting by name.
- Every process holding a file open under `~/.cache/cargo-target` is a cargo or rustc child of a shim that currently holds the lock; `lsof +D ~/.cache/cargo-target/release` prints nothing when no build is running.
- No `car do --serve`, `car-server` or CarHost process has `~/.cache/cargo-target` in its command path: `ps -o args -p <pid>` for every such process shows a copied binary outside the shared target.
- The copied daemon binary is refreshed from `release/car` on every successful release build, and `shasum` of the copy equals `shasum` of the target's `release/car` at that moment; a sweep of the shared target does not stop the daemon (its pid is unchanged before and after, and `car status` still answers).
- The cross-worktree cache guard still protects correctness: after worktree A builds, a build from worktree B of the same repo never reports `Fresh` for a workspace crate compiled from A's source (the existing `cache-guard.selftest.sh` passes).
- No new per-checkout target folder appears under `~/.cache` after a week of fleet and Forge work: `ls ~/.cache | grep -E '^(car-.*-target|cargo-target-.+)$'` prints nothing.
- The shim's `--contract` output is byte-identical between the car copy and the Parslee copy, and `CONTRACT_VERSION` was bumped in both in the same change (the parity selftests in both fleets pass).
- A CAR release build that takes the lock for up to its 30-minute budget is never interrupted by any reaper or sweep: its log shows no "killed" or missing-artifact error, and the tag-publish-verify sequence completes. (Today `com.keenan.disk-reaper` wipes the shared target mid-build.)

- The hand-started `car do --serve` processes (three on the deleted shared-target binary, one on a private target today; not the launchd plist's) are restarted from the copied binary, and the instruction that starts a daemon by hand names the copied binary path; after that, `lsof +D ~/.cache/cargo-target/release` is empty with both daemons up.
- The `CAR_BUILD_LOCK_HELD` re-entrancy guard still works with the sweep: a cargo spawned by a test that is itself running under the lock never triggers a sweep of its own and never deadlocks; `build-governor.selftest.sh` passes.
- `seats/verify.ts` and the seat launch environment still put `seats/bin` first on PATH after the change; a seat's `command -v cargo` and a verify run's `command -v cargo` both print the shim path.

### D2. Merge-driver builds and git hygiene

- `~/.cache/car-regen` holds at most one build folder per live checkout, and entries older than 24 hours are gone the next time the merge driver or the nightly reaper runs; `du -sk ~/.cache/car-regen` stays under 6 GB.
- `git -C car check-ignore -v .wheelhouse-runs/x` names a line in the tracked `.gitignore` (not `.git/info/exclude`) in car, in Parslee-AI and in the wheelhouse template.
- `git -C car diff --cached --name-only | wc -l` prints 0 (the 302 staged run logs are unstaged, and none of those files is deleted from disk).
- After a full car test run, the index holds no `.wheelhouse-runs` path: the test that ran `git add -A` in a non-repo temp folder now initialises its own repository, and a new test proves that running it with a parent repo present stages nothing in that parent.
- The folder literally named `~/.rustup CARGO_HOME=/Users/theleafnode/.cargo` does not exist, and the line that created it is fixed at its source; after one fleet build and one Forge dispatch, `ls -d ~/.rustup*` prints only `~/.rustup`.
- The "1,008 uncommitted changes" phantom is gone: no fleet worktree shows deletions of build output under `.cargo-target-shared/` or `car-rs/.wt-target/` in `git status`, because those paths are neither tracked nor present.

- Parslee's fork integration ref (`mayline/main`) keeps working as proof of done alongside car's `origin/fleet/ootb-agent`; `prune.ts scan` on Parslee still marks a mayline-merged bead's worktree `merged-worktree`.

### D3. The nightly Pulse reaper

- `~/.claude/LIFEOS/USER/CONFIG/PULSE.user.toml` has one enabled `[[job]]` for the reaper on a nightly schedule, and the Pulse board (or `manage.sh status`) lists it with its last run time and exit code.
- Each nightly run writes one log line per item it removed, with the path class (worktree, run folder, private target, car-regen entry, Codex session, tmp scratch), the reason it qualified, and the bytes actually freed by APFS private-size accounting; a closing line gives the total freed and free space before and after.
- The reaper's total matches reality: free space from `df -k /` after the run is within 5% of before plus the total the log claims.
- A run on a machine where everything is already clean frees 0 bytes, logs "nothing to reclaim" and exits 0; running it twice in a row produces that on the second run.
- The reaper removes only items that pass every check the 2026-09-29 manual prune used: no open files (`lsof`), no launchd plist or fleet config referencing the path, commits on a remote ref or an `archive/<name>` tag created first, no open bead, no seat whose registered cwd is inside the path, and a clean tree (or only phantom build-output deletions).
- For a worktree with real uncommitted changes (like `crocodil-1042-3ce602d7-claude` on 2026-09-29), the reaper leaves it in place and logs "kept: uncommitted work (N files)".
- For a run folder whose seat is still active (like `Parslee-AI-jn7a` on 2026-09-29), the reaper leaves it and logs "kept: live seat".
- The reaper never removes: the shared target other than through the capped sweep above; anything under `~/.cache/huggingface/hub`; a worktree named as an integration anchor in any fleet's `wheelhouse/ISA.md`; a seat-anchored worktree; `~/.car-fleet/upgrade-backups`; the main checkouts; toolchains. A dry-run log after a week lists none of these as candidates.
- Orphaned private targets (`~/.cache/car-*-target`, `~/.cache/cargo-target-*`) are removed only when no process has files open under them, no process environment names them in `CARGO_TARGET_DIR`, and the branch they served is merged, archive-tagged or gone; a target touched in the last 24 hours is kept.
- Codex session files under `~/.codex/sessions` older than 30 days are deleted and newer ones untouched (the counts in C2 hold).
- Stale scratch is reaped by age and liveness only: `$TMPDIR/review-*-wt.*` and `/private/tmp/car-*` folders older than 6 hours with no open files and no seat cwd are removed; anything newer or open stays.
- If the private-size probe (psize / getattrlistbulk) is unavailable, the reaper still runs, reports sizes as "allocated (private size unavailable)" in the log, and its deletion decisions do not change.
- If a local Time Machine snapshot exists, the log says so on its first line and reports private size as "freed now" separately from allocated size, so a run that frees little is explained rather than silent.
- The reaper killed mid-run (SIGTERM) leaves no half-state: no worktree is unregistered while its directory remains, no directory remains after `git worktree remove` began, and the next run completes normally.
- On a night the disk starts under 20 GB free, the reaper still completes within its Pulse `timeout_ms`; it never blocks waiting for the build lock.
- The reaper exits non-zero only on a real failure (a removal that threw, a git command that failed, a config it could not parse); a refusal to delete is logged and exits 0.
- The same job loads on the MacBook Air and exits 0 there: car and Parslee paths that do not exist are logged as "not present" and skipped, and the Air's MoreBetter fleet worktrees and run folders are handled with the same checks.
- Old reapers no longer fight the new one: `launchctl list` shows `com.keenan.disk-reaper` unloaded (or its target list excludes `~/.cache/cargo-target` and every fleet path), `ai.parslee.car.fleet-target-clean` unloaded (no nightly `cargo clean` of the shared target), and `ai.parslee.car.fleet-disk-guard` either unloaded or reduced to what the nightly reaper does not cover; after a week, no log from any of them shows a deletion under the shared target or a fleet worktree.

- The first nightly run against the backlog (about 64 old worktrees across both fleets, the six private targets, `car-regen`, the old Codex sessions) finishes within the Pulse `timeout_ms` or stops cleanly at the deadline with every completed removal logged and no half-removed worktree; what it did not reach is taken the next night.
- Two reaper runs cannot overlap: a second start while one is running (Pulse retry, manual run) exits immediately with "already running" and removes nothing.
- The reaper and a bead-close cleanup acting on the same path at the same moment do not corrupt git's worktree registry: one wins, the other logs "already removed", and `git worktree prune` afterwards finds nothing to prune.
- The 297 `~/.cache/car-home-*` test scratch folders are a reaper category (older than 6 hours, no open files); after the first run `ls -d ~/.cache/car-home-* | wc -l` prints 0 and stays near 0 after a week.
- The `disk-reaper` project's own LaunchAgent (`com.keenan.disk-reaper`, hourly) is unloaded and its plist removed or disabled in that project's install script, so a reinstall of that project cannot reload it; `launchctl list | grep disk-reaper` prints nothing.

### D4. Tests and logs

- Every existing selftest in `car/seats/*.selftest.sh` (38 files today) and `Parslee-AI/seats/*.selftest.sh` (30 files today) passes, including `build-governor`, `cache-guard`, `disk-guard`, `prune` and `target-clean` (or the last two are deleted together with the jobs they tested).
- A new selftest proves the cap sweep: a fake target over the cap with old and new artifacts loses only the old ones, and a fake target under the cap loses nothing.
- A new selftest proves the daemon path: a fake `release/car` is copied and the launch path points at the copy; the shared target can then be emptied while the copy still runs.
- A new selftest proves each reaper refusal (uncommitted work, live seat cwd, open file, integration anchor, launchd reference, lock held) against fixtures, and each refusal reason appears verbatim in the log.
- A new selftest proves idempotence: two consecutive runs on the same fixture, the second frees 0.
- The reaper's log rotates or is bounded (under 10 MB after a month), and the shim log `~/.cache/car-build.lock.log` stays under 10 MB.
- The HF model hub (`~/.cache/huggingface/hub`, about 24 GB) is byte-identical before and after a week of nightly runs.

---

## E. Shipping it

Channel: `git log`, `wheelhouse/.template-source`, `launchctl list`, the Pulse board and job log, the adapter's and shim's own output, `df -g /`, the first real text.

- The change is merged on the wheelhouse template's main branch, and `wheelhouse/.template-source` in Parslee-AI, in car and in each MoreBetter fleet on the Air records a template commit at or after that merge.
- Each installed fleet is proven to run the new code: the adapter refuses an over-cap dispatch printing the seats+2 number for that fleet, and `seats/bin/cargo --contract` in car and in Parslee prints the bumped `CONTRACT_VERSION` line identically.
- The Forge agent file and the ForgeProgress helper on the home Mac are the versions that carry the shared-target rule (`grep -n cargo-target ~/.claude/agents/Forge.md` finds it; the helper's dispatch line shows the writable roots).
- The Pulse reaper job is loaded (`manage.sh restart` done, the Pulse board lists it) and its first scheduled run exited 0 with a log a verifier read top to bottom.
- `com.keenan.disk-reaper` and `ai.parslee.car.fleet-target-clean` are unloaded, and `ai.parslee.car.fleet-disk-guard` is unloaded or reduced, confirmed by `launchctl list` before and after.
- Both `car do --serve` daemons and the launchd `car-server` are running from a copied binary, and `lsof +D ~/.cache/cargo-target/release` prints nothing.
- The one-time backlog was cleared by the new rules, not by hand: the first nightly log accounts for the remaining old fleet worktrees, the six private targets, `car-regen`, the old Codex sessions and the `car-home-*` scratch, each with its category and bytes freed.
- The 302 staged run logs are unstaged, the malformed `~/.rustup CARGO_HOME=…` folder is gone, and `.wheelhouse-runs/` is in the tracked `.gitignore` of car, Parslee-AI and the template.
- Existing data is untouched after the first nightly run: the HF hub checksum, the main checkouts' `git status`, every seat-anchored and ISA-integration worktree, every open-PR interactive worktree, and `crocodil-1042-3ce602d7-claude` with its 94 uncommitted lines are all exactly as before.
- Every existing selftest in both fleets passes after deploy, and the new ones (cap sweep, daemon path, reaper refusals, idempotence, never-lose-work) pass in the template and in each install.
- The first bead close after deploy was looked at: the seat moved to its next bead in the same worktree, the old branch was pushed, and the run folder and any per-bead build folder were removed with one log line each.
- The first Forge build-mode dispatch after deploy was looked at: it built into `~/.cache/cargo-target` under the lock, `ls ~/.cache` gained no target folder, and its stdout JSON contract was intact.
- The first alarm text (real, or a forced dry-run body) was read and met every A-group rule; if no low-disk day occurred in the first week, the dry run stands in and is recorded as such.
- The first reaper failure digest (real, or forced with a fixture refusal over 5 GB) was read and met every A2 rule.
- Seven mornings after deploy, `df -g /` on the home Mac reads more than 100 GB free on every one of them, with `du -sk ~/.cache/cargo-target` at or below 40 GB, and no manual prune in any fleet or reaper log.
- The Air's first nightly run exited 0, logged the absent car/Parslee paths as "not present", and handled the MoreBetter fleet's worktrees with the same rules.
- The ISA's Decisions section records every contradiction settled in this file, and its Verification section holds one provenance stub per ISC.

---

## Contradictions settled between slices

Each was settled on the primary; the losing bullet was removed. They are logged in `../../ISA.md` Decisions.

1. **Worktree cap: all seats + 2, or only worktree-owning seats + 2?** Slice B deferred persistent worktrees for reviewer/verifier seats, which made "seats+2" ambiguous. Settled: the cap is every seat in `seats.json` plus 2 (Keenan's number); root-running seats simply do not use their slot, which leaves headroom for interactive and review worktrees.
2. **A second "critical" text at 50 GB.** Slice A proposed it. Cut: Keenan approved ONE text under 100 GB. If he wants a second threshold he can say so after the first alarm.
3. **The 297 `~/.cache/car-home-*` test scratch folders.** Slice C deferred them; slice D already reaps `/private/tmp/car-*` scratch by the same rule. Settled: they are a reaper category.
4. **"Free space does not drift more than 20 GB in a week."** A legitimate week (a 24 GB model download, a release build) fails it with nothing wrong. Dropped; the 100 GB floor is the promise.
5. **"Finder agrees with df within 5 GB."** Finder counts purgeable space differently and the verifier cannot drive it. Dropped; `df -g /` is the number.
6. **Who trims the shared target: the shim after a build, or the nightly reaper?** Both slices claimed it. Settled: one sweep routine, two callers; the shim runs it under the lock when over the cap, the reaper runs it only if it can take the lock without waiting.
7. **Failure digest nagging.** Slice A said one text per night while a refusal persists; that becomes a nightly nag for a worktree Keenan is deliberately keeping. Settled: a refused item is texted once (again only if it grows by more than 5 GB or 30 days pass); a crashed job texts once per night it crashes.
8. **Where these files live.** The morebetterltd/wheelhouse template has no local clone on this Mac, so the outcomes and ISA live under `~/.config/LIFEOS/USER/CUSTOMIZATIONS/disk-hygiene/` rather than in the template repo. The build should copy `docs/outcomes/disk-hygiene-outcomes.md` into the template repo on its feature branch when the clone exists.

---

## Not in this version

- No daily "disk is fine" text; silence is the signal. No free-space graph or dashboard; `df` is the surface.
- No per-item approval flow on the phone ("delete X? yes/no"); the reaper acts on its rules or leaves the item and reports.
- No threshold other than 100 GB, and no second "critical" text (see contradiction 2). No per-Mac threshold for the Air until its first alarm shows its real number.
- Docker/OrbStack reclaim (`docker builder prune`, the corrupted container DB) stays with `docker-reclaim-audit`. Hugging Face caches, Superhuman, Mail, the Claude desktop VM, `~/.nuget`, `~/.npm`, `~/.rustup`, `~/.dotnet`, `~/.nvm` are not reaped; the alarm may name them as "what is growing".
- The idle `~/.cache/sccache` (10 GB) is a one-time manual delete, not a reaper category; no sccache or remote-cache adoption.
- `~/.car-fleet/upgrade-backups` (13 GB) and `~/.car-fleet/ootb-before` (5 GB) are kept until Keenan decides.
- The four `~/Documents/Codex/car-merge-20260912/worktrees/fix-*` checkouts on `fleet/car-saea.*` branches (2 GB) are outside every fleet root; pushing or dropping them is Keenan's call, never the reaper's.
- The live car Claude session's scratchpad (`fake-home*`, 17 GB) is not deleted before that session ends.
- No Time Machine local-snapshot handling beyond reporting it (the Mac has none today).
- Reviewer and verifier seats keep running from the repo root; persistent worktrees for them are not in this version.
- No automatic close of open zero-commit beads; they become reclaimable, but closing or retargeting a bead stays the commander's call.
- No cleanup of Xcode DerivedData or the crocodil bake-off directories from the fleet tooling (the nightly reaper covers what the 2026-09-29 pass approved).
- No push-to-Air automation beyond the existing template-sync path; no per-host scoping in Pulse itself (the reaper tolerates the Air by skipping absent paths).
- car's GitHub-PR-based `reap-worktrees.ts` is retired in favour of the template's prune rules, not ported.
- No change to `~/.codex/config.toml`'s global `default_permissions` for interactive Codex use outside the helper; no per-dispatch build cap; no archive of deleted Codex sessions; no Forge audit-mode changes.
- The two hand-started `car do --serve` daemons are moved onto the copied binary only; rewriting them as launchd jobs is separate work.
- No LLM-driven "Disk Reaper v2" agent; the nightly job is deterministic rules only. No extra serialisation of heavy `dotnet` builds beyond the existing shim contract.

## Needs Keenan's decision

- Whether the deploy may unload `com.keenan.disk-reaper` itself (it is his `disk-reaper` project's LaunchAgent), or whether he unloads it once by hand at deploy. The outcome assumes the deploy does it.
- Whether the 100 GB threshold also applies on the Air (assumed yes until the first Air alarm shows its number).
- `~/.car-fleet/upgrade-backups` and `ootb-before` (18 GB): keep or drop.
- The four `car-merge-20260912` fix checkouts (2 GB): push or drop.
