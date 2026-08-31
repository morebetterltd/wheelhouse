# Seats — the roster, and how a seat comes to exist

A seat is an account with a name. The fleet's workers and reviewer run on the
Pi coding agent, and Pi keeps an account's identity — `auth.json`, settings,
sessions, extensions — in one agent directory (`~/.pi/agent` by default).
`PI_CODING_AGENT_DIR` relocates that whole tree per process, and that is the
entire isolation mechanism: one directory per seat, one account per directory.
Two processes pointed at different directories cannot share or clobber each
other's identity, and a reviewer seat on its own directory is what makes
"never the author's account" a fact on disk rather than a policy.

Four files live here:

- `seats.json.example` — the roster format. Copy it to `seats.json` and edit.
- `seat-env.sh` — creates one seat's directory, pre-grants trust for the
  project root, and prints the export line and the one-time credential flow.
- `adapter.ts` — runs the seats: spawn, dispatch, steer, status, stop, resume.
- `verify.ts` — dispatches the EPHEMERAL verifier pass on a finished branch
  and maps its verdict to an exit code.

`seats.json` holds NO tokens, keys, or secrets — ever. Identity lives in each
seat's `auth.json`, written either by OAuth `/login` inside the interactive Pi
REPL or by an operator placing an api_key entry; it never enters git. The
roster is safe to commit precisely because it records only names, paths, and
optional non-secret human labels; the moment a credential appears in it, that
stops being true.

## The roster format

`seats.json` is plain JSON with no comments, so its fields are documented
here instead.

Top level:

| Field | What it is |
|---|---|
| `commander` | The commander's entry. Marked `"external": true` because the commander is not a Pi seat — it runs on its own harness (`"runtime": "claude-code"`) and provisions nothing here. It is in the roster so the roster is the complete crew list, not just the part this directory manages. |
| `seats` | Map of seat name → seat entry. The name is the key; it is also the directory name `seat-env.sh` uses. |

Each seat entry:

| Field | What it is |
|---|---|
| `role` | What the seat does: `worker`, `reviewer`, `verifier`. Free-form string; the crew briefs define what each role means. Installed fleets read `wheelhouse/fleet/WORKER.md` for workers and `wheelhouse/crew/<ROLE>.md` for other roles, with `contracts/<ROLE>.md` retained as the template-tree fallback. |
| `provider` | Whose model the seat runs (`anthropic`, `openai`, ...). Recorded so the roster answers "which vendor is this seat" without starting the seat. |
| `model` | The model the seat is pinned to, in the provider's own id format. Pin reasoning effort by appending Pi's thinking-level suffix to this same string, for example `gpt-5.6-sol:high`. |
| `account.dir` | The seat's agent directory — the value `PI_CODING_AGENT_DIR` is set to. By convention `~/.pi-seats-<namespace>/<seat-name>`, where the namespace is this project's (recorded as `namespace=` in `wheelhouse/.template-source`). This field is the record; the convention just explains where it came from. |
| `account.label` | Optional free-form, human-meaningful account label (`kk-personal-anthropic`, `work-chatgpt-2`) printed in status/provisioning/error output so an operator can tell which real account backs the seat. It is NEVER a secret: do not put tokens, keys, passwords, emails you would not commit, or other credentials here. Omit it freely; existing rosters without labels stay valid. |

Two gotchas about `provider` + `model`. The set of valid model ids depends on
the ACCOUNT behind the seat, not just the provider — e.g. Codex via a ChatGPT
account (`openai-codex`) rejects ids an API key accepts — so check
`pi --list-models` on the machine and account that will run the seat before
pinning. Reasoning effort is pinned only through Pi's `:<thinking>` model suffix:
`"model": "gpt-5.6-sol:high"`, not a separate roster field. That keeps the
roster to one spelling for one Pi CLI input: the adapter passes the full
`model` value verbatim to pi's `--model` flag. Pi owns model and thinking-level
validation; if the suffix is malformed or unsupported for the selected model,
spawn fails loudly because the adapter cannot get the initial `get_state` reply
and prints pi's stderr tail. And always pin provider and model together: a
`--provider` given to pi WITHOUT a `--model` does not pick that provider's
default — it silently falls back to the default provider entirely, and the seat
runs on a different vendor than the roster says.

The reviewer's `account.dir` must differ from every worker's. Same directory
means same `auth.json` means same account, and a review from the author's own
account is not a review.

## Creating a seat

```bash
seats/seat-env.sh <namespace> <seat-name> [project-root]
```

For each seat in the roster, once. The script:

1. checks `pi` is on PATH — a MISSING line is a STOP;
2. creates `$HOME/.pi-seats-<namespace>/` and its `<seat-name>/` child;
3. writes `$HOME/.pi-seats-<namespace>/.project`, a backlink with the
   canonical absolute project root (`project=...`) and `written_at=...`. The
   backlink is idempotent: a rerun for the same root leaves it untouched, while
   a different root is a loud STOP because it means two projects are trying to
   share one namespace root;
4. writes `trust.json` pre-granting the project root. Trust has to exist
   before the first run because a headless run without it does not stall or
   error — it silently SKIPS the project's `.pi/` resources (config,
   `SYSTEM.md`), and nothing in the output says so: the seat just behaves as
   if the project had none, which is far worse than a loud failure. The root
   is canonicalized (`pwd -P`) before it is written, because pi matches
   trust keys against the canonicalized cwd — a symlinked path like `/tmp`
   vs `/private/tmp` would write a key pi never matches, the same silent
   skip by another door;
5. prints the `export PI_CODING_AGENT_DIR=...` line and, if the seat has no
   `auth.json` yet, the one-time credential flow.

For OAuth seats, launch the REPL exactly as printed with `PI_CODING_AGENT_DIR`
set, type `/login` inside the REPL, complete the browser flow, then type
`/exit`; that writes the seat's `auth.json`. For an `api_key` seat, either
write the provider entry into `auth.json` yourself or export the provider's env
var in the shell that spawns the seat; the file route survives new shells, and
the env-var route writes nothing to disk. Re-running the script for an existing
seat changes nothing and exits 0.

What the script refuses to do, and why:

- It never writes or touches `auth.json`. That file is the seat's identity;
  a re-login can replace it with a different account, and there is no undo.
  To re-login deliberately, remove the file yourself first. Existence alone
  is not identity, though: pi auto-creates an empty `{}` auth.json on a
  first headless run, and the script treats that as not-logged-in — the
  credential flow still prints, and OAuth `/login` inside the REPL (or the
  api_key file route) fills the file in place.
- It will not reuse a namespace root whose `.project` backlink names a
  different project root. That STOP is the cross-fleet collision the namespace
  exists to prevent; choose a different namespace or inspect the existing
  `$HOME/.pi-seats-<namespace>/` before proceeding.
- It will not rewrite a `trust.json` it did not write. The file may carry
  grants an operator added by hand, and shell is the wrong tool to edit
  JSON — if the project root is missing from an existing trust file, the
  script stops and tells you the exact entry to add.

One thing trust-to-the-project-root does not cover: workers run in worktrees
under `.wheelhouse-worktrees/`, which on most layouts sits INSIDE the project
root and is covered by the grant. If your worktrees live elsewhere, add that
directory to the seat's `trust.json` by hand — a flat JSON map of absolute
directory → `true`. Use the physical path (`pwd -P` in that directory): pi
matches trust keys against the canonicalized cwd, so a key written through a
symlink is a grant pi never matches.

## Running a seat

```bash
bun seats/adapter.ts spawn    <seat> [bead-id]          # start it
bun seats/adapter.ts dispatch <seat> <bead-id> <text>   # hand it a bead
bun seats/adapter.ts steer    <seat> <text>             # redirect mid-turn
bun seats/adapter.ts status                             # liveness, every seat
bun seats/adapter.ts stop     <seat>                    # graceful; session kept
bun seats/adapter.ts resume   <seat>                    # reattach that session
```

`spawn` reads the seat's roster entry, refuses a seat whose directory or
login is missing (it prints the exact `seat-env.sh` command or login flow,
with `account.label` when the roster has one, instead), and starts one
long-lived `pi --mode rpc` process: agent directory
from `account.dir`, provider and model pinned from the roster, and the
role's crew brief appended to the system prompt at launch, which is the only
time Pi takes configuration. Brief resolution prefers the installed fleet
layout (`wheelhouse/fleet/WORKER.md` for workers, `wheelhouse/crew/<ROLE>.md`
for other roles) and falls back to the template layout (`contracts/<ROLE>.md`).
The process outlives
the adapter: its stdin is a FIFO under `seats/run/`, its stdout appends raw
to `seats/logs/<seat>.jsonl` (every event, one JSON line each; stderr lands
beside it in `<seat>.stderr.log`). A later command opens the FIFO, writes
one line, and reads the response out of the log.

The seat's process cwd is the bead's worktree by construction, not a prompt
telling it to `cd` there. Without a bead id, `spawn` starts the seat rooted
at the project root; with one, or on `dispatch` for a bead the seat is not
already sitting in, cwd resolves to `.wheelhouse-worktrees/<bead-id>` — which
has to exist already (a worker's own claim, or whoever dispatches) — and a
missing worktree is a loud STOP, never a silent fall-back to the root.
`dispatch` transparently stops and relaunches the seat, attached to the same
session, when its cwd does not already match the bead being dispatched.

`dispatch` prefixes the message with `Bead <bead-id>` and queues behind the
current turn if the seat is mid-stream; redirecting the CURRENT turn is what
`steer` is for. `stop` is SIGTERM — Pi's graceful path — and deliberately
never escalates to SIGKILL: a seat that ignores SIGTERM is worth looking at,
not shooting. The session survives a stop, and `resume` respawns the seat
attached to it (`--session`), rooted back in the same cwd it was running in,
so the context it built up comes back warm.

What the adapter is NOT: a supervisor. Nothing restarts a dead seat, meters
quota, or retries. It runs seats; noticing them is the commander's job.

## Verifying a branch

```bash
bun seats/verify.ts <bead-id> <branch> <author-seat> [verifier-seat]
```

One invocation = one verdict. Unlike the seats above, the verifier is
EPHEMERAL: `verify.ts` spawns one `pi -p --no-session` on the verifier
seat's account — no session saved, nothing to resume — with
the resolved VERIFIER brief appended to the system prompt, hands it the bead
claim (via `bd show` when `bd` is reachable, otherwise the verifier reads
the bead itself) and the branch's tip SHA, and parses the single
`VERDICT:` line out of the reply.

Unlike a worker seat, the verifier's process cwd is never a bead's
worktree — but as of this bead it is not the project root either. The
one-shot `pi` spawn gets a THROWAWAY scratch worktree (`makeScratchCwd()`
in verify.ts): a real `git worktree add --detach <tmp-path> HEAD` against
`ROOT`, created right before the spawn and removed on every exit path via
`process.on("exit", ...)`. This closes the same hazard class adapter.ts's
per-bead cwd construction (see "Running a seat" above) closes for a
confused worker: `VERIFIER.md` says "read-only on the work," but that is a
rule the model can ignore, and a confused or adversarial turn
that runs a bare `write`/`edit` against a relative path needs somewhere
harmless to land, not the live checkout every other seat and the commander
depend on.

It has to be a real worktree of THIS repository, not an arbitrary empty
directory, because the verifier's own default reading mechanism
(`VERIFIER.md`, "Reading a branch without disturbing it") is bare
`git diff <base> <sha>` and `git show <sha>:<path>` with no `-C`
flag — those read the object database directly and do not care which
directory they run in, as long as it is a clone that has the branch's
ref, but an unrelated directory with no `.git` in its ancestry fails
every one of them before the verifier reads a single line. Detached at
`ROOT`'s own `HEAD` (an arbitrary, always-resolvable commit): the
checked-out content is never read by anyone, it exists purely so the
directory both IS a valid git working directory and is disposable.

`verify.ts` itself never touches this scratch worktree, or any worktree,
for its OWN git calls — those are unaffected by any of this and keep
explicit `cwd: ROOT` regardless of where the spawned `pi` process runs:
branch resolution (`git rev-parse --verify`) and evidence reads
(`git cat-file blob <tip>:<path>`, see "Evidence the bead names" below)
run from verify.ts's own Node process via `execFileSync(..., { cwd: ROOT
})`, which has nothing to do with the separate child process cwd the
spawned `pi` binary gets. GRAPH.md names the bead and a committed path as
the only two evidence homes, and neither a worker's worktree nor the
verifier's own scratch worktree is either. On the rare turn where the
verifier genuinely needs a real working tree beyond its scratch cwd — to
build, to run the thing — its own brief still tells it to create one of
its own (`git worktree add <its-own-path> <sha>`) rather than reuse
anyone else's, because "never run `git checkout` in a directory you did
not create" rules out standing in a worker's worktree even for that.

So a worker's cwd needs to BE the bead; the verifier's cwd only needs to
be A repository the bead's ref resolves from, which any worktree of this
repository is — the scratch one included, and disposable specifically
because nothing about it matters except that it exists and is not the
live checkout.

`process.on("exit", ...)` cannot run on SIGKILL, so killing the dispatcher
process mid-verification leaves the scratch worktree (and its `git
worktree` registration) behind — same gap class recover.ts's fixture
sweep exists for elsewhere in this codebase. `sweepStaleScratchWorktrees()`
closes it: run once at the start of every `verify.ts` invocation, it asks
`git worktree list --porcelain` which worktrees are actually registered
against `ROOT` (never guesses from a directory listing — a shared
`os.tmpdir()` can hold same-prefixed scratch dirs from an unrelated
project's `verify.ts` on the same machine), filters to the
`wheelhouse-verify-<pid>-*` naming `makeScratchCwd()` uses, and reclaims
only the ones whose stamped owning pid is no longer alive. Unlike
recover.ts's sweep, it never needs an fd-based cross-check against pid
reuse: that sweep KILLS live processes, so a reused pid is a real hazard;
this one only ever removes a directory and a worktree registration, and a
dead pid means the run that made it has already exited — full stop,
whatever the OS later did with that pid number.

The verifier seat comes from the roster: the one entry with
`"role": "verifier"`, or the optional fourth argument when there are
several. Before ANYTHING spawns, `verify.ts` compares the author seat's
`account.dir` (roster first, `seats/state.json` as fallback for a retired
seat) against the verifier's, both canonicalized — the same directory
means the same `auth.json` means the same account, and that is a loud
STOP, not a warning. "Never verify what you authored" is enforced on disk
here, before the model ever runs.

The exit code IS the verdict, so the commander's scripts can branch on it:

| exit | meaning |
|---|---|
| `0` | APPROVE — the bead's done holds, evidence in the output. May carry the brief's `— NOT BENCHED: <gap>` qualifier, preserved in the verdict file: read it before merging on a partial-coverage approval. |
| `2` | BOUNCE — defects listed; redispatch to the author |
| `3` | DISCOVER — the bead itself needs the commander's judgment |
| `1` | error — no verdict exists: a STOP, a dead pi, or output with no (or an ambiguous) `VERDICT:` line. Never treat as a verdict. |

DISCOVER files no beads. The verifier's proposal is recorded for the
commander, who decides what the graph should say about it — a verifier
that wrote to the graph would be deciding, not reporting.

The full verifier output lands in `seats/verdicts/<bead-id>.md`. That file
is a WORKING COPY for the commander, and git ignores it deliberately:
`wheelhouse/GRAPH.md` ("Where evidence lives") admits exactly two evidence
homes — the bead itself, or a committed path the bead names — and a
tracked verdicts directory would invite citing a third that dies with the
checkout. Transcribe the decisive extract onto the bead before citing the
verdict; the file is where you transcribe FROM.

### Evidence the bead names

When the bead's done requires artifacts beside a code/test outcome — a
screenshot, a bench log, a deployment probe's captured output — the
commander names them at dispatch, and they become part of the verdict
contract:

```bash
bun seats/verify.ts <bead-id> <branch> <author-seat> --evidence <path>[,<path>...]
```

Paths are repo-relative and read from the TIP SHA (`git cat-file blob
<tip>:<path>`), never from a checkout: `wheelhouse/GRAPH.md` admits a
committed path the bead names as an evidence home, and a file that exists
only in someone's worktree is not one. The WORKER produces the evidence
and commits it on the branch; the verifier collects and judges it —
nothing here drives a browser or an emulator.

Before the verifier spawns, `verify.ts` runs a FLOOR check per artifact —
exists at the SHA, non-empty, type-probed (`.png` gets magic bytes plus
IHDR dimensions; every other extension gets the non-empty floor) — and
hands the results to the verifier in the prompt. The floor is not the
judgment: a valid PNG of the wrong screen is a BOUNCE only the verifier's
reading can produce. The checks land in the verdict file under
`## Evidence checks`.

The gate mirrors the NOT BENCHED parser rule: an APPROVE while any named
artifact fails the floor is MALFORMED — exit 1, never a clean 0 a merge
script could act on — while BOUNCE and DISCOVER pass through unchanged
(a failed floor check is a fine BOUNCE reason, and the record still
carries the checks). Why a flag rather than parsing `Evidence:` lines out
of `bd show`: the bead text here is a human rendering, and `bd` may be
unreachable from the dispatcher (which the bead-claim embed already
tolerates); the commander reads the bead and restates its requirement as
arguments — the same relationship the bead claim itself has to the
dispatch.

### state.json

`seats/state.json` is the seat ↔ process ↔ session record, one entry per
seat name, written by the adapter and read by every later invocation:

| Field | What it is |
|---|---|
| `pid` | The running `pi` process, or `null` after a stop. |
| `startedAt` / `stoppedAt` | ISO timestamps of the last spawn / stop. |
| `accountDir` | The agent directory the process was pointed at. |
| `role` / `roleBrief` | The roster role and the brief file injected at launch. |
| `fifo` / `log` | Where commands go in and events come out. |
| `sessionId` / `sessionFile` | Pi's session, as `get_state` reported it; `sessionFile` is what `resume` reattaches. |
| `model` | The roster's model pin at launch, if any. |
| `lastBead` / `lastDispatchAt` | The most recent dispatch, for `status`. |

Like the roster, it holds NO tokens — names, paths, pids, and session ids
only. It is per-machine runtime state, not product, and git ignores it along
with `seats/run/` and `seats/logs/`.

`sessionId` is NOT stable across a seat's lifetime, and nothing here relies
on it being so — only `sessionFile` is the continuity key. Pi hands back a
fresh `sessionId` on every relaunch attached via `--session <file>`
(`resume`, and `dispatch`'s cwd-mismatch relaunch alike — confirmed on a
real-pi leg, not just the cwd-changing case), even though it keeps
appending to the SAME session file and the conversation carries forward.
`sessionId` is stored and printed purely as a point-in-time label for a
human reading `status`, `spawn`/`stop`/`resume`'s console output, or
`floor`'s per-seat block — none of it is compared against a prior value.
Continuity is asserted and enforced entirely through `sessionFile`:
`resume` and the relaunch inside `dispatch` both pass the RECORDED
`sessionFile` to `--session`, and `recover.ts`'s printed resume suggestions
key off `sessionFile` (existence, and a same-file RUNNING match for the
double-resume refusal) and `lastBead`, never `sessionId`. `verify.ts`
never reads `sessionId` at all — author/verifier distinctness there is
`account.dir`, not the session.

## Proving it still works

```bash
bash seats/seat-env.selftest.sh
bash seats/adapter.selftest.sh
bash seats/verify.selftest.sh
```

Hermetic — all three build seats in a temp HOME with a stub `pi`, and your
real seats are never touched. Each has a canary phase that breaks a copy of
the thing under test and checks the tests notice; if a canary survives, the
selftest fails even when everything else passed. The adapter and verify
selftests each add one real-pi smoke leg at the end — the adapter's runs
spawn, dispatch, agent_end, resume, and the session file growing; verify's
runs one scripted-reply verdict through the real binary — borrowing your
own interactive `pi` login inside the temp fixture; each prints a SKIP line
(and still passes) if `pi` or the login is missing, or if
`WHEELHOUSE_SKIP_REAL_PI=1`. A login whose OAuth refresh token has gone stale
is NOT skipped: the real leg fails the same way every real `pi` run on the
machine would, and the fix is `pi`, then `/login` inside the REPL, not a
looser test. `seats/logs/` is where seat runtime logs land; it is per-machine
noise and git ignores it.

Two more real-leg notes. When the login that works on this machine is NOT
pi's default provider, pin the real legs explicitly — set BOTH
`WHEELHOUSE_REAL_PI_PROVIDER` and `WHEELHOUSE_REAL_PI_MODEL` (together,
per the roster gotcha above); unset, the legs run whatever the login's
default resolves to. And a selftest killed with SIGKILL cannot run its
cleanup trap, so it can leave its temp fixture — and, for the adapter
selftest, a live detached stub seat — behind. Fixture dirs are pid-stamped
(`wheelhouse-{adapter,verify}-selftest.<pid>.*` under `$TMPDIR`), and every
later run starts by sweeping stale ones: it kills only pids the fixture's
own `state.json` records AND that still hold files open under that fixture
(the same fd-based identity rule `recover.ts` uses), removes the dir, and
prints what it swept. SIGKILL residue therefore lasts only until the next
run; to clean it by hand, those pid-stamped dirs are the whole footprint.

## The bridge

The bridge is how a human looks at the fleet: ONE tmux window per project,
built by `seats/cockpit.sh` and viewed through `seats/floor.ts`.

```bash
seats/cockpit.sh [namespace]     # builds (or re-attaches to) session wh-<ns>
```

Session `wh-<namespace>` (default namespace: the project dirname), window
`0:bridge`, two panes:

- **Left — the commander seat.** The cockpit does NOT launch the commander;
  it prints the launch instructions and hands you a shell. The commander is
  interactive and the human starts it.
- **Right — the floor**, full height: `bun seats/floor.ts`. Spotlight and
  rail are one program, so the right side is one pane.

Re-running `cockpit.sh` attaches to the existing session — it never builds a
duplicate. The tmux status bar carries the project name and the key hints.

### The floor

`floor.ts` is READ-ONLY: it reads `state.json`, `seats.json`,
`seats/logs/*.jsonl`, and `seats/verdicts/*.md`, and never writes to a FIFO
or to state. Two regions:

- **Spotlight** (top): pinned to ONE seat, that seat's event log humanized —
  `[tool]`, `[think]`, `[say]`, `[turn_end]` with turn stats. The spotlight
  moves ONLY on your keys; nothing steals it.
- **Rail** (bottom): one line per seat, `[1]`..`[9]`, plus `[0] STATUS`, each
  with an attention cue:

  | cue | meaning |
  |---|---|
  | red | AUTH DEAD (credential flow shown) or PROCESS GONE (pid died) |
  | amber | QUOTA EXHAUSTED, IDLE with ready work (`bd ready` count), REVIEW BLOCKED (a BOUNCE waiting), EVIDENCE UNSATISFIED (a verdict whose evidence floor checks failed), VERDICT UNREADABLE (a verdict file with no parseable verdict line — routed to human), or a missing event log |
  | green | VERDICT LANDED (APPROVE/DISCOVER seen in the seat's output) |

  Failure states are DISTINCT named lines, never silence: a dead process, a
  dead login, an exhausted quota, a blocked review, unsatisfied evidence,
  an unreadable verdict, and a missing log each say exactly what they are.
  The STATUS view (`0`) leads with an `ALERTS` roll-up listing every red or
  amber seat, so no failure needs scrolling to find.

Keys: `1`-`9` pin a seat, `0` pins the full STATUS view, `f` toggles
follow-mode (OFF by default; when on, the spotlight tracks the most recently
active log), `o` toggles an overview grid of every seat, `q` quits.

`--once` renders a single frame to stdout and exits — what the selftest and
any script uses; `--pin <1-9|0|seat-name>` and `--overview` set the view.

### Proving the bridge still works

```bash
bash seats/floor.selftest.sh
```

Hermetic: synthetic logs and state in a temp fixture, a stub `bd`, frames
rendered with `--once` — your real seats and your tmux are untouched. Covers
every rail cue above, the STATUS cell, the missing-log degradation, and two
cmp-guarded canaries. The tmux leg builds the bridge on a private tmux
socket and proves `cockpit.sh` idempotent; it prints a SKIP line (and still
passes) when tmux is not installed.

<!-- ===== recovery (bead wheelhouse-project-98m) — new section starts here ===== -->

## Recovering after an interruption

```bash
bun seats/recover.ts
```

Run it at commander start — after a commander restart, a killed Pi process,
or a machine reboot — and it tells you what survived. It reads three things
and nothing else: `seats/state.json`, `seats/run/`, and each candidate
process's open-file table (`lsof`). Every recorded seat comes back as one of:

| class | meaning |
|---|---|
| `RUNNING` | The recorded pid is alive AND holds this seat's FIFO open — so it is our process, whatever its ps line says. |
| `DEAD` | The process is gone, or the pid is alive but does not hold the FIFO (reused/foreign), while the session file is intact. Resumable: if a bead was in flight, the seat line names it and the EXACT resume command is printed beneath. |
| `STALE` | A state entry with no session artifacts on disk. Nothing to resume; spawn fresh when the seat is needed. |

Identity is established by file descriptors, never by command lines. Pi
rewrites its process title: a live seat's ps line is exactly `pi` — no role
brief, no session path, no argv at all (verified against pi 0.84.x; the
selftest's real-binary probe re-checks this premise on your machine). So
anything that greps `ps` for a seat's paths calls every live real seat dead,
resumes over it, and unlinks the FIFO it is reading. What a live seat cannot
hide is its open fds: the adapter starts every seat with stdin opened
read-write on `seats/run/<seat>.stdin`, so a process that holds that FIFO IS
that seat, and one that does not — whatever its pid or title — is not.

The same mechanism answers the machine-restart story. After a reboot every
pid in `state.json` is stale, and some of those numbers come back alive as
unrelated processes — pids are dense and recycled. `kill -0` alone would
call such a seat RUNNING, skip the resume, and strand its bead. Holding the
seat's FIFO is a test a recycled pid cannot pass, and a `tail -f` or editor
that merely carries a seat path in its argv cannot pass it either. The seat
classifies DEAD — resumable, because the session file is what holds the
seat's memory, and it survived the reboot even though the process did not.

What recover will and will not do:

- **It never resumes anything itself.** Resuming is a commander decision;
  recover puts the command and the bead id in front of you and stops. Its
  only writes are FIFO removals under `seats/run/` for seats that are not
  RUNNING — each one printed — and the adapter recreates a missing FIFO at
  the next spawn or resume, so cleanup never costs you a seat. It does not
  touch `state.json`, spawn `pi`, or call `bd`: recovering must never
  re-dispatch or re-integrate work that already happened, so the tool that
  runs first after an interruption is structurally unable to.
- **It refuses a double-resume.** If a DEAD seat's session is already
  attached — another recorded seat RUNNING on the same session file, or any
  live process holding that file open — recover prints
  `REFUSED double-resume` naming the holder instead of a resume command.
  One session with two writers is corruption with extra steps. (The
  open-file check is best-effort for resumes the state never recorded; the
  state-based check covers everything the adapter did record.)
- **It requires `lsof`** (present on macOS and virtually every Linux) and
  STOPs honestly without it rather than guessing identity from `ps`.

The forced-interruption exercise is `seats/recover.selftest.sh`. Phases 1-5
and the canaries are hermetic, against a stub `pi` that rewrites its process
title to bare `pi` exactly like the real binary — so the hermetic suite
classifies the same argv-less process shape the real fleet presents. They
SIGKILL a seat mid-turn and prove the DEAD classification, the named bead,
and that the printed resume command re-attaches the SAME session file;
simulate a commander restart (fresh process, `state.json` only) including
the reused-pid and argv-spoof cases; prove the double-resume refusal on both
detection paths; prove orphaned-FIFO cleanup removes only what is dead; and
assert the no-duplicate-integration guard — `state.json` byte-identical,
zero `pi` spawns, zero `bd` calls — with cmp-guarded canaries checking that
the checks themselves still bite. Phase 6 then probes the REAL binary,
login-free (a dummy env API key; no request is made and no login is
touched): it asserts pi's ps title is bare and that pi holds its stdin FIFO
where `lsof` sees it — the premise and the mechanism, re-verified against
the pi actually installed. That probe SKIPs, with the reason printed, only
when `pi` is absent.

<!-- ===== project isolation (bead wheelhouse-project-4pk) — new section starts here ===== -->

## Project isolation — what is guaranteed, and what is not

Two fleets on one machine must not be able to reach into each other: one
project's worker must not mutate another project's beads, worktree, or
evidence. That holds — but it is important to be precise about WHY it holds,
because the honest answer is not "the operating system prevents it".

```bash
bash seats/isolation.selftest.sh
```

Hermetic like the others: two complete fixture projects (A and B), each with
its own seat namespace root, roster, graph dir, and worktrees dir, built in a
temp HOME with a stub `pi` and a logging fake `bd`. Only A's machinery ever
runs; B exists to be reached for. It proves three different kinds of thing:

**What IS guaranteed — by construction.** Every durable path the machinery
writes is derived from the project's own tree: `state.json`, `run/`, `logs/`,
and `verdicts/` all join from the directory `adapter.ts`/`verify.ts` live in,
and the seat directories live under `$HOME/.pi-seats-<namespace>/`, one
namespace per project. A's `trust.json` grants A's project root and nothing
else; no B path appears in A's roster or state. The selftest asserts each of
these from the code and from the artifacts a hard run leaves behind, and
asserts B's entire tree and seat root are byte-identical after A spawns,
dispatches, stops, resumes, and makes a bead-graph call.

**What IS guaranteed — by contract at the doors.** The arguments that could
smuggle a foreign path in are either refused or inert: a seat name is
validated to a single path segment (a name like `../projB` is a loud STOP),
and a bead id is never used as a path — it rides in the prompt text and in
`state.json`'s `lastBead` field as data, verbatim. `bd` scopes itself by
walking up from the cwd the adapter chose, which is the project's own root,
so a seat's graph calls resolve to its own store. The selftest probes each
door with B-shaped arguments and watches nothing land.

**What is NOT guaranteed — OS enforcement.** All seats on a machine run as
one user with no sandbox. The selftest's hostile leg dispatches a stub seat
that deliberately attempts four cross-project writes — appending to B's log,
overwriting B's `state.json`, creating a file in B's worktree, touching B's
graph dir — and on a default setup all four SUCCEED. The test reports that
truthfully instead of pretending otherwise. The boundary statement it prints:

> Isolation between projects is by construction and contract, not OS
> enforcement: every path the wheelhouse machinery writes is derived from
> the project's own root and its namespaced seat root, and path-shaped
> arguments are refused — but the processes all run as one user with no
> sandbox, so the operating system does not forbid a hostile or compromised
> seat from writing into another project. This selftest proves no wheelhouse
> code path takes a foreign path even when handed one; it also proves,
> honestly, that the OS would permit one.

Two consequences worth keeping in view. First, the roster is trusted,
commander-authored configuration: an operator who writes another project's
directory into `account.dir` will be obeyed — the machinery defends against
its own arguments and code paths, not against its own configuration. Second,
if a project ever needs isolation against a *hostile* seat process rather
than a confused one, that is an OS-level control (separate users, sandboxing)
and out of scope for this template; what the template guarantees is that its
own machinery, contracts, and validated arguments never take a foreign path.

<!-- ===== two-seat concurrency + capacity (bead wheelhouse-project-41h) — new section starts here ===== -->

## Running the concurrency exercise

```bash
bash seats/concurrency.selftest.sh
```

Two seats from one roster, worked as one exercise: both spawned, handed
DISTINCT beads back-to-back (the second dispatch goes out before the first
turn is waited on), and proven not to touch each other. The assertions, in
order: overlapping RUNNING (both `state.json` pids alive with both turns in
flight at the same moment — `agent_start` seen, no `agent_end` yet, in both
logs); each seat's events land ONLY in its own log; no cross-talk on FIFOs
(each seat has its own, and the log check doubles as the FIFO check — a
crossed FIFO would land a response in the wrong log); worktree isolation
(the exercise builds two scratch git worktrees on distinct `fleet/<bead>`
branches, points each seat's bead at its own, and asserts each bead's work
footprint landed only there — the same one-worktree-per-bead contract
`contracts/WORKER.md` binds real workers to); and both seats stopping
cleanly.

Hermetic like the other selftests: a stub `pi` in a temp HOME, your real
seats untouched, cmp-guarded canaries (one merges both seats into a shared
log, one cuts the capacity stamp) proving the checks still bite. One
real-pi leg at the end spawns TWO real seats borrowing your login,
dispatches trivial prompts concurrently, and asserts both `agent_end`s
arrive with disjoint logs; the same `WHEELHOUSE_REAL_PI_PROVIDER` +
`WHEELHOUSE_REAL_PI_MODEL` pin (always both together) and the same SKIP
rules as the adapter selftest's real leg apply.

## Capacity events

Visibility only — the adapter still meters nothing and brokers nothing.
When a `dispatch` fails and the failure looks like an account limit
(quota / usage limit / 429 / rate limit, in the response error or the
seat's stderr tail), the adapter stamps the seat's `state.json` entry:

```json
"lastCapacityEvent": { "at": "<ISO time>", "detail": "<the error text>" }
```

Three places read the stamp: `adapter.ts status` prints a `CAPACITY:` line
under the seat; the floor's rail renders the AMBER `QUOTA EXHAUSTED` cue
from it (the raw-stream scan the floor already did remains, as the fallback
for limit noise the adapter never saw); and the floor's STATUS cell shows a
per-seat `capacity` line — `ok (no recorded capacity event)` or the stamped
event. A later dispatch that LANDS clears the stamp, so a stale event
cannot outlive the evidence for it. What none of this does, on purpose:
predict resets, count tokens, or route work — the commander reads the
amber line and decides; a broker would be deciding for them.

<!-- ===== failure legibility (bead wheelhouse-project-045) — new section starts here ===== -->

## Failure legibility — every failure class is its own visible state

```bash
bash seats/legibility.selftest.sh
```

The claim this exercise proves: quota exhaustion, auth failure, a dead
process, a blocked review, and unsatisfied evidence are DISTINCT visible
states in the floor and in `adapter.ts status`, and none of them can render
as completion. Each class is injected — through the real machinery where it
has a door (a quota-shaped dispatch failure through the stub seat, a spawn
refusal on an empty `{}` auth.json, a SIGKILLed pid, a real `verify.ts`
run), deterministically simulated where it does not — and then asserted
against the actual rendered output:

| class | injected via | must render as |
|---|---|---|
| quota exhaustion | stub seat answers a dispatch with a 429-shaped error | amber `QUOTA EXHAUSTED` naming the failed dispatch; `status` prints `CAPACITY:` |
| auth failure | empty `{}` auth.json (spawn refused) + a 401 in the event stream | red `AUTH DEAD` with the exact login flow — never the quota line |
| dead process | SIGKILL a running stub seat | red `PROCESS GONE` naming the `.stderr.log`; `status` prints `DIED` (never the calm `STOPPED` a graceful stop earns); `recover.ts` classifies it `DEAD` |
| blocked review | real `verify.ts` run whose verdict is BOUNCE | amber `REVIEW BLOCKED` naming the bead — never green, never idle |
| unsatisfied evidence | real `verify.ts` run with a bead-named artifact missing at the tip | `verify.ts` refuses APPROVE-over-failed-floor (exit 1, nothing recorded); a recorded BOUNCE with failed checks renders amber `EVIDENCE UNSATISFIED` naming the bead; a verdict file with no parseable verdict line renders `VERDICT UNREADABLE — routed to human` |

The cross-check stages every class at once across separate seats and asserts
the rail and the STATUS `ALERTS` roll-up list each one distinctly, with no
success rendering (`VERDICT LANDED`, `GREEN`, idle, working) anywhere on an
afflicted seat. The canaries are cmp-guarded like the other selftests', and
include a cue-conflation canary: a floor copy sabotaged so auth renders with
the quota wording must be CAUGHT by the distinctness checks — two failure
classes collapsing into one line is exactly the illegibility this exercise
exists to prevent.
