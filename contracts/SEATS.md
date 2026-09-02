# Fleet: Seats

A seat is a commander-owned process that holds a role. This file is the contract every seat operates under; your project's roster goes in the generated section at the end.

## Contract

Copied byte-for-byte into every project. Do not edit this section.

### What a seat is

A persistent Pi process the commander owns: one long-lived `pi --mode rpc` per seat, started and driven by the adapter (`seats/adapter.ts`), addressable by its roster name. Its identity is fixed before it starts, in two records. The roster (`seats/seats.json`) says what the seat IS — role, provider, model, and the agent directory that holds its account (`account.dir`). It optionally also carries `account.authRoute` — which of the three routes question 8 offers (`oauth`, `api_key`, `env`) gave the seat its identity — and `shadow`, a boolean marker for a mirror seat whose output is recorded but never gates or carries assigned work; both are durable and safe to commit because they are route/behavior names, never credentials, and a roster written before either field existed simply omits them. The runtime record (`seats/state.json`) says what currently embodies it — pid, session, log, FIFO — written by the adapter, never by hand. The role is injected at spawn: the adapter appends the role's crew brief (`contracts/<ROLE>.md`) to the system prompt via `--append-system-prompt`, which is the only moment Pi takes configuration. A running seat has its role already; nothing is pasted into it, and a seat behaving as if it had no brief was spawned wrong, not briefed wrong.

The commander is on the roster but is not a Pi seat: it runs on its own harness and is marked `"external": true` there, so the roster stays the complete crew list without pretending the adapter manages it.

### Lifecycle

A seat's session context is a CACHE. Everything durable lives on the graph, in the contracts, in git, and in the ISA — which is why reports go on the bead. A seat that loses its context loses nothing the fleet needs: at most one in-flight bead, which the commander re-dispatches. The context a seat holds across dispatches is a warm cache, nothing more.

That the cache is disposable is what makes the persistent shape cheap to run: the seat idles between dispatches holding its warm cache, and losing that cache is never a loss the fleet has to plan around. The session survives `stop` — the adapter's stop is SIGTERM, Pi's graceful path, and it deliberately never escalates to SIGKILL — and `resume` respawns the seat attached to the same session, context warm. When the cache is worthless — a new line of work, a context gone stale — spawn fresh instead of resuming; that is the whole reset, and it is a command, not a ritual: `seats/adapter.ts reset <seat>` stops the seat, discards its recorded session, and respawns it cold, as one call instead of a stop-then-spawn an operator could get wrong two ways.

Resetting a seat's context is a commander decision, not a worker one — a worker cannot see whether its own cache is still earning its keep. Three named triggers call for it: the initiative or hill-climb the seat was serving has closed, so nothing in the cache still applies to what comes next; context degradation signals — compaction thrash, or the seat visibly arguing from stale assumptions a fresh read of the graph would correct; or a plain operator call, made without either signal, because the commander judged the cache not worth keeping. `reset` refuses loudly instead of running if the seat is mid-turn — the same rule that governs `stop` above: never interrupt a running turn, only ever reset an idle one.

Between turns a seat is quiet, not inert, and the two halves of that are both measured (pi 0.84.1, 2026-08-30): an idle seat initiates nothing on its own — its event log, left alone, does not grow by a byte — but a process a turn put in the background keeps running after the turn ends, and a dispatch queued behind a busy seat fires the moment the current work drains, with nobody present. Two duties follow. A seat says in its report what it has left running or queued, because that part does not wait for anyone's next turn. And the commander stops a seat only when it is idle: a SIGTERM landing mid-turn takes the running tool's whole process tree with it, `nohup` included, while stopping an idle seat spares what earlier turns set in motion. A second killer is distinct from stop: on pi coding-agent CLI 0.84.4 / openai-codex gpt-5.5 (measured 2026-08-31), a tool-call TIMEOUT also killed a background `nohup ... &` chain that shared the tool shell's process group. In that same 0.84.4 measurement, a chain started through a double-fork Python `os.setsid()` wrapper — the portable stand-in for `setsid -f ...` on this macOS host — survived the timeout, and survived SIGTERM to a one-shot `pi -p --no-session` while the starting tool call was still sleeping. If a chain must outlive the tool call that starts it, isolate it into its own session before the long wait (`setsid -f ...` or an equivalent double-fork `setsid()` wrapper); if a consumer fleet sees a background process vanish without its own timeout line, check tool-call timeout/process-group reaping before debugging the bench itself. On any other runtime these are measurements to redo, not assumptions to import.

Nothing here supervises a seat. The adapter runs seats — spawn, dispatch, steer, status, stop, resume — and refuses to be more: it does not restart a dead seat, meter quota, or retry. Noticing seats is the commander's job, and seat health stays what the rules below say: probe once, nudge once — a dead seat and an idle seat look identical, which is why the probe exists. If both go unanswered, declare the seat dead, respawn it with the adapter (resume, if the session is worth keeping), and re-dispatch the in-flight bead. That is the entire recovery, because the cache was the only thing lost.

### Seat accounting

**One seat = one subscription = one human beneficiary. No seat serves anyone else.**

This is a licensing-compliance statement, not a preference or a scaling guideline. It does not change with the size of your fleet, and it is the reason each seat needs its own agent directory rather than sharing one: the directory holds the account's `auth.json`, so same directory means same login means one subscription serving more than one seat.

This has a collision consequence worth stating plainly: two seats — or two PROJECTS — pointed at the same agent directory share that directory's login, and the rule above stops being true of your fleet silently. The convention that prevents it is per-project seat roots (`$HOME/.pi-seats-<namespace>/<seat-name>`, the namespace recorded as `namespace=` in `wheelhouse/.template-source`), and the roster's `account.dir` field is the record of which directory each seat actually got.

How the subscriptions you hold get divided across several fleets on one machine is the operator's call, not this template's. The rule above says a seat is not shared; it says nothing about which wheelhouse a given seat belongs to, and that allocation is a decision about your own licences that no template is in a position to make for you.

One consequence is enforced rather than trusted: **the verifier's account must be distinct from the author's.** A review from the author's own account is not a review, so `seats/verify.ts` compares the author seat's `account.dir` against the verifier's — canonicalized, on disk, before any model runs — and a match is a loud STOP. Keep the reviewer's and verifier's directories different from every worker's, or the fleet has no reviewer it can use.

### Rules

- **One bead in flight per seat.** The graph is the single source of work state.
- **Report BEFORE going idle.** Finishing work and going quiet is the known failure mode of dispatched workers, and the role brief injected at spawn makes the report an explicit contract rather than a hope. The report includes what the seat left running or queued — per Lifecycle above, that part proceeds with nobody present.
- **The commander probes, then nudges once, on silence.** A seat that cannot be reached looks exactly like a seat that is idle.
- **Seats inherit the project's permissions.** Provisioning pre-grants trust for the project root and nothing else; per-seat escalations go to the principal.
- **A seat does only briefed work.** It never self-assigns from the graph without a dispatch.
- **A reviewer seat never reviews what it authored.** If the only available reviewer wrote the diff, the work waits. For the verifier this is enforced on disk, per Seat accounting above.

### Running a seat

Provision once, then run with the adapter; the commands and what each one does live in `seats/README.md`, and this paragraph is deliberately all this contract says about launching. Provisioning is `seats/seat-env.sh <namespace> <seat-name>` — it creates the seat's agent directory, pre-grants trust for the project root, and prints the one-time credential flow for the account that seat should BE: OAuth seats launch `PI_CODING_AGENT_DIR=... pi`, type `/login` inside the REPL, then `/exit`; api_key seats place the key by the recorded file or env-var route. From then on the seat is `bun seats/adapter.ts spawn <seat>` to start, `dispatch` to hand it a bead, `steer` to redirect mid-turn, `status` for liveness, `stop` and `resume` for the graceful stop and the warm reattach. A one-shot verifier pass is `bun seats/verify.ts <bead-id> <branch> <author-seat>`. If any of those refuse to run, the refusal names the provisioning step that was skipped; the refusal is the guard working.

### Minimum viable fleet

Commander + one worker + one reviewer. That is a working loop. Add seats when a specific role is the bottleneck, not to fill out a roster — see `wheelhouse/runbooks/PROMOTION.md`.

## This project

Generated at install.

### Roster

<!-- One line per seat this project took, mirroring seats/seats.json: the seat's
     name, which brief it reads, its provider and model, and its agent directory
     (account.dir). seats.json is the machine record and decides; this section is
     the human record and must agree with it. The commander is always here — it
     is the principal's own session, marked external in the roster, and was never
     a question at install. -->

### Declined seats

<!-- One line per seat that was offered at install and refused: the seat, the
     principal's reason, and the date. A seat that was considered and declined
     looks exactly like a seat nobody raised once both are simply absent, and this
     is the only section that can tell them apart. Add a line here when a seat is
     dropped later, too. -->
