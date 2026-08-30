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
  project root, and prints the export line and the one-time login command.
- `adapter.ts` — runs the seats: spawn, dispatch, steer, status, stop, resume.
- `verify.ts` — dispatches the EPHEMERAL verifier pass on a finished branch
  and maps its verdict to an exit code.

`seats.json` holds NO tokens, keys, or secrets — ever. Identity lives in each
seat's `auth.json`, which only `pi /login` writes and which never enters git.
The roster is safe to commit precisely because it records only names and
paths; the moment a credential appears in it, that stops being true.

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
| `role` | What the seat does: `worker`, `reviewer`, `verifier`. Free-form string; the crew briefs in `contracts/` define what each role means. |
| `provider` | Whose model the seat runs (`anthropic`, `openai`, ...). Recorded so the roster answers "which vendor is this seat" without starting the seat. |
| `model` | The model the seat is pinned to, in the provider's own id format. |
| `account.dir` | The seat's agent directory — the value `PI_CODING_AGENT_DIR` is set to. By convention `~/.pi-seats-<namespace>/<seat-name>`, where the namespace is this project's (recorded as `namespace=` in `wheelhouse/.template-source`). This field is the record; the convention just explains where it came from. |

The reviewer's `account.dir` must differ from every worker's. Same directory
means same `auth.json` means same account, and a review from the author's own
account is not a review.

## Creating a seat

```bash
seats/seat-env.sh <namespace> <seat-name> [project-root]
```

For each seat in the roster, once. The script:

1. checks `pi` is on PATH — a MISSING line is a STOP;
2. creates `$HOME/.pi-seats-<namespace>/<seat-name>/`;
3. writes `trust.json` pre-granting the project root. Trust has to exist
   before the first run because a headless run without it does not stall or
   error — it silently SKIPS the project's `.pi/` resources (config,
   `SYSTEM.md`), and nothing in the output says so: the seat just behaves as
   if the project had none, which is far worse than a loud failure. The root
   is canonicalized (`pwd -P`) before it is written, because pi matches
   trust keys against the canonicalized cwd — a symlinked path like `/tmp`
   vs `/private/tmp` would write a key pi never matches, the same silent
   skip by another door;
4. prints the `export PI_CODING_AGENT_DIR=...` line and, if the seat has no
   `auth.json` yet, the one-time login command.

Run the login command it prints, sign in with the account that seat should
BE, and the seat exists. Re-running the script for an existing seat changes
nothing and exits 0.

What the script refuses to do, and why:

- It never writes or touches `auth.json`. That file is the seat's identity;
  a re-login can replace it with a different account, and there is no undo.
  To re-login deliberately, remove the file yourself first. Existence alone
  is not identity, though: pi auto-creates an empty `{}` auth.json on a
  first headless run, and the script treats that as not-logged-in — the
  login command still prints, and `pi /login` fills the file in place.
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
bun seats/adapter.ts spawn    <seat>                    # start it
bun seats/adapter.ts dispatch <seat> <bead-id> <text>   # hand it a bead
bun seats/adapter.ts steer    <seat> <text>             # redirect mid-turn
bun seats/adapter.ts status                             # liveness, every seat
bun seats/adapter.ts stop     <seat>                    # graceful; session kept
bun seats/adapter.ts resume   <seat>                    # reattach that session
```

`spawn` reads the seat's roster entry, refuses a seat whose directory or
login is missing (it prints the exact `seat-env.sh` or `pi /login` command
instead), and starts one long-lived `pi --mode rpc` process: agent directory
from `account.dir`, provider and model pinned from the roster, and the
role's crew brief — `contracts/<ROLE>.md` — appended to the system prompt at
launch, which is the only time Pi takes configuration. The process outlives
the adapter: its stdin is a FIFO under `seats/run/`, its stdout appends raw
to `seats/logs/<seat>.jsonl` (every event, one JSON line each; stderr lands
beside it in `<seat>.stderr.log`). A later command opens the FIFO, writes
one line, and reads the response out of the log.

`dispatch` prefixes the message with `Bead <bead-id>` and queues behind the
current turn if the seat is mid-stream; redirecting the CURRENT turn is what
`steer` is for. `stop` is SIGTERM — Pi's graceful path — and deliberately
never escalates to SIGKILL: a seat that ignores SIGTERM is worth looking at,
not shooting. The session survives a stop, and `resume` respawns the seat
attached to it (`--session`), so the context it built up comes back warm.

What the adapter is NOT: a supervisor. Nothing restarts a dead seat, meters
quota, or retries. It runs seats; noticing them is the commander's job.

## Verifying a branch

```bash
bun seats/verify.ts <bead-id> <branch> <author-seat> [verifier-seat]
```

One invocation = one verdict. Unlike the seats above, the verifier is
EPHEMERAL: `verify.ts` spawns one `pi -p --no-session` on the verifier
seat's account — no session saved, nothing to resume — with
`contracts/VERIFIER.md` appended to the system prompt, hands it the bead
claim (via `bd show` when `bd` is reachable, otherwise the verifier reads
the bead itself) and the branch's tip SHA, and parses the single
`VERDICT:` line out of the reply.

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
own `pi /login` inside the temp fixture; each prints a SKIP line (and still
passes) if `pi` or the login is missing, or if `WHEELHOUSE_SKIP_REAL_PI=1`.
A login whose OAuth refresh token has gone stale is NOT skipped: the real
leg fails the same way every real `pi` run on the machine would, and the
fix is `pi /login`, not a looser test. `seats/logs/` is where seat
runtime logs land; it is per-machine noise and git ignores it.
