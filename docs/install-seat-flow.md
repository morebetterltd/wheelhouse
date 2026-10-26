# Flow spec: install-time seat harness, model, and credential setup

This is a design spec for the template repo. It belongs under `docs/` because the template's durable design notes live there (for example `docs/outcomes/` records product-design outcomes), while `runbooks/` are operator procedures copied into installs and `seats/` is executable machinery. This file is not an install step yet and changes no code.

The flow stays standalone: it assumes only the Wheelhouse template, shell, git, bd, bun, and the selected harness CLIs. It does not depend on any outside personal-infrastructure layer.

## Relationship to the existing BOOTSTRAP interview

This flow **feeds** the existing `BOOTSTRAP.md` interview rather than replacing it.

- `BOOTSTRAP.md` still owns the install sequence, project survey, bench questions, authority questions, graph setup, and verification.
- This flow replaces the human shape of BOOTSTRAP question 7 and question 8 only: it produces the same read-back table those questions require and the same `seats/seats.json` record step 3 writes.
- A first implementation can be a helper the installer runs during BOOTSTRAP step 3, returning JSON plus a terminal transcript summary. Later it can become the default UI for the roster part of BOOTSTRAP.
- Re-running this flow after install edits one named seat and then hands control back to the existing provision/probe steps.

## Records and invariants

`seats/seats.json` remains the machine roster. It records:

- seat name;
- role;
- harness (`pi`, `claude-code`, `codex`; later `car` only after the adapter supports it);
- provider;
- model;
- `account.dir`;
- `account.authRoute`.

It never records a token, API key, OAuth code, browser session, password, refresh token, SSH key, or copied auth file. Credentials land only in the selected harness's own account directory or environment, under the principal's control.

`account.dir` is still one directory per seat, conventionally:

```text
~/.pi-seats-<namespace>/<seat-name>
```

The name is historical; every harness uses that root, but the adapter maps it to the correct environment variable:

- `pi` -> `PI_CODING_AGENT_DIR=<account.dir>`
- `claude-code` -> `CLAUDE_CONFIG_DIR=<account.dir>`
- `codex` -> `CODEX_HOME=<account.dir>`
- later `car` -> a future `CAR_HOME=<account.dir>` or driver-specific equivalent, not specified until the car harness exists.

## Step 0 — preflight and existing install check

Purpose: confirm the install context and explain that the flow writes roster metadata only.

Mock screen:

```text
Wheelhouse seat setup

Project root: /path/to/project-placeholder
Namespace: project-placeholder
Seat root: ~/.pi-seats-project-placeholder/

This wizard writes seats/seats.json and provisions per-seat account directories.
It never asks you to paste a secret into a visible prompt.
It never writes credentials to seats/seats.json.

Continue? [Y/n] y
```

If `seats/seats.json` exists, the flow switches to re-run mode and asks whether to edit a single seat or show the current roster. It does not rewrite every seat by default.

## Step 1 — pick seats

Purpose: choose which roles exist and how many named seats each role gets. This is BOOTSTRAP question 7 in terminal form.

Mock screen:

```text
Step 1 of 6 — Pick seats

Commander: always present; it is this Claude Code session and is external.

How many worker seats should the fleet have?
  0) none; commander does first implementation work
  1) one worker: worker-1
  2) two workers: worker-1, worker-2
  3) custom count
Choice [1]: 2

How many reviewer seats should gate diffs?
  0) none; principal/fresh session reviews manually
  1) one reviewer: reviewer-1
  2) two reviewers: reviewer-1, reviewer-2
Choice [1]: 1

Take verifier seat for consumer-surface walks?
  1) yes: verifier
  2) no
Choice [1]: 1

Take researcher seat?
  1) yes: researcher
  2) no
Choice [2]: 2

Producer is required. Which form should it take?
  1) standing producer seat
  2) producer subagent of the commander
Choice [2]: 2
```

Resulting provisional seat list:

```text
commander   external Claude Code session
producer    role=producer  external=true runtime=commander-subagent; reads PRODUCER.md
worker-1    role=worker    account.dir=~/.pi-seats-project-placeholder/worker-1
worker-2    role=worker    account.dir=~/.pi-seats-project-placeholder/worker-2
reviewer-1  role=reviewer  account.dir=~/.pi-seats-project-placeholder/reviewer-1
verifier    role=verifier  account.dir=~/.pi-seats-project-placeholder/verifier
```

Declined optional standing seats are recorded in the human roster section later, as BOOTSTRAP already requires. Producer has no opt-out: it judges signals and writes intent and outcomes; the commander never does. A commander-subagent producer is an explicit external entry under `seats`, without an account directory or Q8 provisioning round. After writing the roster, `bun seats/roster.ts check` refuses builder seats without a non-shadow producer.

## Step 2 — pick a harness per seat

Purpose: choose the runtime driver independently for every non-external seat. No provider, model, or credential route is asked on this screen.

Mock screen:

```text
Step 2 of 6 — Harness for each seat

worker-1: Which harness runs this seat?
  1) pi
  2) claude-code
  3) codex
  4) car (later; not supported by this template yet)
Choice: 2

worker-2: Which harness runs this seat?
  1) pi
  2) claude-code
  3) codex
  4) car (later; not supported by this template yet)
Choice: 3

reviewer-1: Which harness runs this seat?
  1) pi
  2) claude-code
  3) codex
  4) car (later; not supported by this template yet)
Choice: 1

verifier: Which harness runs this seat?
  1) pi
  2) claude-code
  3) codex
  4) car (later; not supported by this template yet)
Choice: 1
```

If the user picks `car` today, the flow stops for that seat:

```text
car is reserved for a future harness driver.
No seats.json row can be written with harness=car until the adapter supports it.
Pick pi, claude-code, or codex for this install, or leave this seat declined.
```

Later, after support exists, the same screen can enable `car` and continue to a car-specific provider/model/auth listing.

## Step 3 — pick provider per seat

Purpose: choose only providers that make sense for the selected harness. The UI narrows the list per seat.

Mock screen:

```text
Step 3 of 6 — Provider

worker-1 uses harness=claude-code.
Available providers:
  1) anthropic
Choice [1]: 1

worker-2 uses harness=codex.
Available providers:
  1) openai-codex  (ChatGPT subscription account)
  2) openai        (OpenAI API key account)
Choice [1]: 1

reviewer-1 uses harness=pi.
Available providers come from this seat's Pi model listing.
  1) anthropic
  2) openai
  3) openrouter
Choice: 3

verifier uses harness=pi.
Available providers come from this seat's Pi model listing.
  1) anthropic
  2) openai
  3) openrouter
Choice: 3
```

If a provider list cannot be loaded because the account is not logged in yet, the flow does not invent providers. It offers a login/provision step for that seat and then repeats the listing.

## Step 4 — pick auth route per seat

Purpose: choose how credentials will be established without echoing or committing them.

Auth route labels are user-facing; the `seats.json` record maps them to existing `account.authRoute` values:

| UI choice | `seats.json` value | Where the secret lives |
| --- | --- | --- |
| subscription login | `oauth` | harness account directory after the principal completes the harness login flow |
| API key on stdin | `api_key` | harness account directory or provider CLI secret store, written by the provisioning command from stdin; never echoed |
| existing account dir | existing route confirmed by probe: `oauth`, `api_key`, `env`, or `default` | already in that directory or environment; the flow records the directory, not the secret |

Mock screen:

```text
Step 4 of 6 — Auth route

worker-1 (claude-code / anthropic)
  1) subscription login: run Claude Code auth login in this seat directory
  2) API key on stdin: read once with terminal echo disabled
  3) existing account dir: use a directory that is already logged in
Choice [1]: 1

worker-2 (codex / openai-codex)
  1) subscription login: run Codex login in this seat directory
  2) API key on stdin: read once with terminal echo disabled
  3) existing account dir: use a directory that is already logged in
Choice [1]: 1

reviewer-1 (pi / openrouter)
  1) subscription login, if this provider supports OAuth for Pi
  2) API key on stdin: read once with terminal echo disabled
  3) existing account dir: use a directory that is already logged in
Choice [2]: 2

verifier (pi / openrouter)
  1) subscription login, if this provider supports OAuth for Pi
  2) API key on stdin: read once with terminal echo disabled
  3) existing account dir: use a directory that is already logged in
Choice [2]: 3
```

For API-key-on-stdin, the mock screen is explicit that nothing will be echoed:

```text
reviewer-1 API key setup

The next prompt reads from stdin with terminal echo disabled.
The key will not be printed, logged, written to seats.json, or stored in git.
It will be passed only to the selected harness/provider setup for:
  account.dir: ~/.pi-seats-project-placeholder/reviewer-1
  provider: openrouter

Paste API key: ********
Stored credential for reviewer-1 account directory.
```

For an existing account directory, the flow records only the directory path after proving it is inside the namespace root unless the principal explicitly confirms an unusual path:

```text
verifier existing account directory

Default: ~/.pi-seats-project-placeholder/verifier
Enter existing account dir, or press Enter for default:
> ~/.pi-seats-project-placeholder/verifier

Probe this account before writing seats.json? [Y/n] y
Probe result: OK
Detected auth route: api_key
```

The route written for an existing directory is not `existing`. It is the detected/confirmed route (`oauth`, `api_key`, `env`, or `default`) because the adapter needs to know how to probe/spawn the seat; `account.dir` is what records that this was an existing directory.

## Step 5 — pick model per seat

Purpose: pin a model from the selected harness/account's real listing or binding probe. The screen never offers a remembered global catalog.

Mock screen:

```text
Step 5 of 6 — Model

worker-1 uses claude-code / anthropic / oauth.
Listing source: claude-code alias plus binding probe.
  1) claude-sonnet-5
  2) claude-opus-5
Choice [1]: 1

worker-2 uses codex / openai-codex / oauth.
Listing source: codex app-server model/list under CODEX_HOME.
  1) gpt-5.5
  2) gpt-5.6-sol
  3) gpt-5.6-luna
Choice [1]: 1

reviewer-1 uses pi / openrouter / api_key.
Listing source: PI_CODING_AGENT_DIR + pi --list-models filtered to openrouter.
  1) z-ai/glm-5.3-flash
  2) anthropic/claude-sonnet-5
Choice [1]: 1

verifier uses pi / openrouter / api_key.
Listing source: PI_CODING_AGENT_DIR + pi --list-models filtered to openrouter.
  1) z-ai/glm-5.3-flash
  2) anthropic/claude-sonnet-5
Choice [1]: 1
```

If a model listing is empty, the flow stops for that seat:

```text
No models listed for verifier under PI_CODING_AGENT_DIR=~/.pi-seats-project-placeholder/verifier provider=openrouter.
Fix login/key/provisioning, then retry this seat. No remembered model ids will be written.
```

## Step 6 — read-back and write `seats/seats.json`

Purpose: show exactly what will be committed before writing it.

Mock screen:

```text
Step 6 of 6 — Read-back

seat       role      harness      provider       authRoute  model                 account.dir
commander  commander external     claude-code    -          -                     -
producer   producer  external     subagent       -          -                     -
worker-1   worker    claude-code  anthropic      oauth      claude-sonnet-5       ~/.pi-seats-project-placeholder/worker-1
worker-2   worker    codex        openai-codex   oauth      gpt-5.5               ~/.pi-seats-project-placeholder/worker-2
reviewer-1 reviewer  pi           openrouter     api_key    z-ai/glm-5.3-flash    ~/.pi-seats-project-placeholder/reviewer-1
verifier   verifier  pi           openrouter     api_key    z-ai/glm-5.3-flash    ~/.pi-seats-project-placeholder/verifier

Credentials are not shown because they were never stored in this roster.
Write seats/seats.json? [Y/n] y
```

Example output:

```json
{
  "commander": {
    "role": "commander",
    "external": true,
    "runtime": "claude-code"
  },
  "seats": {
    "producer": {
      "role": "producer",
      "external": true,
      "runtime": "commander-subagent"
    },
    "worker-1": {
      "role": "worker",
      "harness": "claude-code",
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "account": {
        "dir": "~/.pi-seats-project-placeholder/worker-1",
        "authRoute": "oauth"
      }
    },
    "worker-2": {
      "role": "worker",
      "harness": "codex",
      "provider": "openai-codex",
      "model": "gpt-5.5",
      "account": {
        "dir": "~/.pi-seats-project-placeholder/worker-2",
        "authRoute": "oauth"
      }
    },
    "reviewer-1": {
      "role": "reviewer",
      "harness": "pi",
      "provider": "openrouter",
      "model": "z-ai/glm-5.3-flash",
      "account": {
        "dir": "~/.pi-seats-project-placeholder/reviewer-1",
        "authRoute": "api_key"
      }
    },
    "verifier": {
      "role": "verifier",
      "harness": "pi",
      "provider": "openrouter",
      "model": "z-ai/glm-5.3-flash",
      "account": {
        "dir": "~/.pi-seats-project-placeholder/verifier",
        "authRoute": "api_key"
      }
    }
  }
}
```

Notice what is absent: no API key, no OAuth token, no account label copied from a real machine, and no provider-specific secret field.

## Step 7 — provision and probe selected accounts

Purpose: turn managed roster entries into real per-seat account directories and prove each binding. External commander and producer-subagent entries skip provisioning; the producer still reads PRODUCER.md on dispatch.

This step wraps today's `seats/seat-env.sh` behavior. The command creates/trusts the directory, prints the harness-specific environment variable and login/probe instructions, and refuses to overwrite an existing identity.

Mock screen:

```text
Provisioning worker-1
  account.dir: ~/.pi-seats-project-placeholder/worker-1
  harness: claude-code

Run this login if needed:
  CLAUDE_CONFIG_DIR=~/.pi-seats-project-placeholder/worker-1 claude auth login --claudeai

Probe:
  CLAUDE_CONFIG_DIR=~/.pi-seats-project-placeholder/worker-1 claude -p --output-format json --model claude-sonnet-5 "Reply with exactly the word OK. Use no tools." </dev/null

Result: OK
```

API-key-on-stdin provisioning still does not echo the key:

```text
Provisioning reviewer-1
  account.dir: ~/.pi-seats-project-placeholder/reviewer-1
  harness: pi
  provider: openrouter
  authRoute: api_key

Reading API key from stdin with echo disabled.
Paste API key: ********
Credential installed for this seat only.
Probe result: OK
```

Existing-account-dir provisioning probes without modifying the credential:

```text
Provisioning verifier
  account.dir: ~/.pi-seats-project-placeholder/verifier
  harness: pi
  provider: openrouter
  authRoute: api_key

Existing account dir selected; no login or key write will run.
Probe result: OK
```

## Re-run flow — edit a single seat

A re-run must not ask the whole interview again unless the principal requests it. It edits one named seat and leaves every other row byte-for-byte unchanged except for formatting if a JSON writer is used.

Mock screen:

```text
Wheelhouse seat setup found seats/seats.json.

What do you want to do?
  1) show roster
  2) edit one seat
  3) add a seat
  4) decline/remove a seat
Choice: 2

Which seat?
  1) worker-1
  2) worker-2
  3) reviewer-1
  4) verifier
Choice: 2

Editing worker-2 only.
Current row:
  role=worker
  harness=codex
  provider=openai-codex
  authRoute=oauth
  model=gpt-5.5
  account.dir=~/.pi-seats-project-placeholder/worker-2

What should change?
  1) harness/provider/auth/model together
  2) model only
  3) auth route only
  4) account dir only
Choice: 2
```

Model-only re-run:

```text
worker-2 model
Listing source: CODEX_HOME=~/.pi-seats-project-placeholder/worker-2 codex app-server model/list
  1) gpt-5.5
  2) gpt-5.6-sol
Choice [1]: 2

Read-back for worker-2 only:
  old model: gpt-5.5
  new model: gpt-5.6-sol
Write this single-seat edit? [Y/n] y
Probe result: OK
```

Harness change re-run:

```text
Changing harness may require a different login in the same seat account dir or a new account dir.
No credential will be copied from the old harness.

worker-2 new harness:
  1) pi
  2) claude-code
  3) codex
  4) car (later; not supported yet)
Choice: 1

New provider/auth/model questions will be asked for worker-2 only.
Other seats will not be changed.
```

If the principal chooses a new account directory for an existing seat, the old directory is not deleted by this flow. The screen says so and leaves cleanup to a separate explicit action:

```text
Old account dir remains on disk and is not deleted:
  ~/.pi-seats-project-placeholder/worker-2
New account dir to record:
  ~/.pi-seats-project-placeholder/worker-2-pi

Write account.dir change? [Y/n] y
```

## Failure and safety rules

- A blank model list stops that seat; no remembered catalog is substituted.
- A credential prompt always disables terminal echo and never logs input.
- A dry-run mode prints the `seats.json` diff with secrets absent by construction.
- A re-run records one-seat intent before editing and does not silently normalize unrelated seats.
- An unsupported future harness such as `car` is displayed as future work but cannot be written until the adapter and schema support it.
- Existing account directories are probed, not copied.
- The commander remains external and is not provisioned by the adapter.
