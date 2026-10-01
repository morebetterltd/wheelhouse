Branch: fleet/wheelhouse-project-uz5w.7
Base: fleet/stakeholder-channels e4c90fcb20850dda47815c6192c6b25743c42ea5
Head: see bead comment final report.

Changed:
- BOOTSTRAP.md adds question 10 for stakeholder channels, writes seats/channels.json, updates copy-list and verification checks.
- contracts/INTEGRATOR.md records how declared channels narrow the reserved outside-team communication action.
- contracts/bench.sh.stub now has install/upgrade fixture modes proving channel write/read-back and no upgrade-created channels; without --mode it remains the project bench stub.

Evidence from committed tree:

```text
bash_install=0
channels: 2 declared
channels: none declared (principal-only)
ok install fixture records stakeholder channels and no-channels variant
sh_install=0
channels: 2 declared
channels: none declared (principal-only)
ok install fixture records stakeholder channels and no-channels variant
bash_upgrade=0
ok no seats/channels.json invented by upgrade copy
bootstrap_rg_rc=0
150:Everything in this list is copied whole and unedited. The interview-derived content — every `## This project` fill, `CLAUDE.md`, the ISA, `STARTUP.md`, `seats/seats.json`, `seats/channels.json` — is written in steps 3 and 5, not here; what this step lands is the half that is byte-identical in every project.
159:- Copy the whole `seats/` directory from the template to `seats/` at the install root, scripts kept executable (`cp -R "$TEMPLATE/seats" seats`). This is the machinery every seat runs on — `seat-env.sh` (provisioning), `adapter.ts` (spawn/dispatch/status/stop/resume), `verify.ts` (the reviewer bead-verdict dispatcher), `walk.ts` (the consumer-surface verifier walk), `needs.ts` (durable human requests), `desk.ts` (the local needs/board web desk), `principal-sentinel.sh` (Claude Code Stop hook for `@principal:`), `courier.ts`, `channels.ts`, `comms.ts`, `seats/channels.json.example` plus `transports/` (optional off-machine replies and stakeholder channels across Telegram, Slack and Teams), `prune.ts` (safe worktree/cache pruning), `floor.ts` and `cockpit.sh` (the bridge), `recover.ts` (post-interruption triage), their selftests, and `seats/README.md`, which documents every command. It lands at the ROOT rather than under `wheelhouse/` because every path the contracts and runbooks print — `seats/seat-env.sh`, `bun seats/adapter.ts ...` — is root-relative, and a copy that lands anywhere else breaks each of them. `seats/seats.json.example` arrives with it as the roster format's reference; the real `seats.json` is written by step 3's interview.
303:10. **Stakeholder channels — where the commander may speak outside the team.** Ask after the runtime questions because this is a project communication boundary, not a seat property. Default first: "My default is none: the commander reaches only you, through the local desk and the optional courier, and never posts anywhere else. Do your stakeholders talk somewhere the commander should be able to speak — Telegram, Slack, or Teams?" With `AskUserQuestion`, offer a multi-select whose labels are exactly `No stakeholder channels`, `Telegram`, `Slack`, and `Teams`.
305:   For each selected kind, walk one channel at a time and collect exactly the fields `seats/channels.json` records: `name` (short, `[a-z0-9-]`, for example `partners` or `dev`), `kind` (the selected Telegram/Slack/Teams value), `destination`, `audience`, `members`, and `read`.
307:   Say credentials once per kind selected, and do not ask for tokens: the token goes in `seats/run/<kind>.token` mode `0600` or the `WHEELHOUSE_<KIND>_TOKEN` environment variable; Teams may instead name `WHEELHOUSE_TEAMS_TOKEN_CMD`. Credentials never go in `seats/channels.json`, never in `seats/seats.json`, and never in git.
329:**Then `seats/channels.json`, from question 10's read-back table** — the channel machine record, in the format `seats/channels.json.example` shows.
643:  `channels.selftest.sh` proves the declared-channel file shape in `seats/channels.json`, including the no-channels record; `transports.selftest.sh` proves Telegram, Slack, and Teams can post/read-back/read against fakes without credential literals; `comms.selftest.sh` proves the single send gate.
secret_history_grep_rc=1

## fleet/wheelhouse-project-uz5w.7
fleet/wheelhouse-project-uz5w.7
HEAD/branch equality was rechecked in final bead-comment report.
integration=e4c90fcb20850dda47815c6192c6b25743c42ea5
```

Notes:
- The bead text named wheelhouse/crew/bench.sh and wheelhouse/crew/interview-bench/run.ts, but those paths do not exist in this repository checkout. The template source equivalent is contracts/bench.sh.stub, so the fixture mode was implemented there. No interview-bench file was changed because there is no such file in the committed tree.
- Public-template secret hygiene checked branch history with `git grep -nE "(xox[abpr]-[0-9]|[0-9]{6,}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{20,})" $(git rev-list fleet/stakeholder-channels..HEAD) -- .`; exit 1 with no output means no matches.
