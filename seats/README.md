# Seats — the roster, and how a seat comes to exist

A seat is an account with a name. The fleet's workers and reviewer run on the
Pi coding agent, and Pi keeps an account's identity — `auth.json`, settings,
sessions, extensions — in one agent directory (`~/.pi/agent` by default).
`PI_CODING_AGENT_DIR` relocates that whole tree per process, and that is the
entire isolation mechanism: one directory per seat, one account per directory.
Two processes pointed at different directories cannot share or clobber each
other's identity, and a reviewer seat on its own directory is what makes
"never the author's account" a fact on disk rather than a policy.

Two files live here:

- `seats.json.example` — the roster format. Copy it to `seats.json` and edit.
- `seat-env.sh` — creates one seat's directory, pre-grants trust for the
  project root, and prints the export line and the one-time login command.

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

## Proving it still works

```bash
bash seats/seat-env.selftest.sh
```

Hermetic — it builds seats in a temp HOME with a stub `pi`, and your real
seats are never touched. It ends with a canary phase that breaks a copy of
the script and checks the tests notice; if the canary survives, the selftest
fails even when everything else passed. `seats/logs/` is where seat runtime
logs land; it is per-machine noise and git ignores it.
