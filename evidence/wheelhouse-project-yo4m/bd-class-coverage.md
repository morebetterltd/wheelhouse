# Fixture bd metrics coverage (yo4m)

Inventory command: `rg -n '\bbd\b' seats/*.selftest.sh seats/selftest-lib.sh`.
All 22 matching suites are enumerated below. This is an execution-site inventory,
not a claim that every textual match invokes real bd.

`selftest_disable_bd_metrics` invokes the documented `bd metrics off` in an
owned fixture with an isolated HOME and exported, fixture-owned XDG_CONFIG_HOME.
Both HOME and XDG_CONFIG_HOME are pinned: bd 1.2.2 writes HOME/.config/bd
rather than a disjoint XDG_CONFIG_HOME. Tool subprocesses inherit both. These
real-bd sites do not subsequently switch to an unconfigured HOME. Prune's
fresh-home case has no .beads directory and performs no real graph command.
Setup runs before real bd init/commands, not after an asynchronous flusher
starts. `selftest_scratch_graph` does this before init and exports both HOME
and XDG config in its returned environment alongside its graph-pinning wrapper.

| Suite | Coverage |
| --- | --- |
| intent-check | Shared metrics setup before its two real bd init sites. |
| never-lose-work | Shared metrics setup before real bd init and graph operations. |
| prune | Shared metrics setup before all three real bd init sites; nested TMPDIR invocation allocates and configures its own fixture. Original two-worktree-removal assertion retained. |
| selftest-lib | Shared metrics setup before optional real install graph init; scratch-graph helper independently configures and exports its own metrics config. New disabled-config regression. |
| adapter | `$BIN/bd` and cleanup-report `fakebin/bd` are owned stubs, not real bd. Skip-bd/real-pi legs do not forward to real bd. |
| alerts | `$BIN/bd` stubs supply issue/status records; no real bd forwarding. |
| cockpit | Owned recovery bd stub; other bd references are asserted UI/command text. |
| desk | Owned `$PROJ/bin/bd` stub, also copied into its canaries. |
| digest | Owned project bd stub, copied into empty-install fixture; absent-bd leg does not invoke bd. |
| fleet-gate | Owned bd stubs in both phases. |
| fleet-snapshot | Owned `$BIN/bd` reads fixture JSON only. |
| floor | Owned `$FIX/bin/bd` stub. |
| herald | Owned `$FIX/bin/bd` stub. |
| isolation | Owned `$BIN/bd`; harness callback executes that stub on fixture PATH. |
| legibility | Owned `$BIN/bd` stub. |
| recover | Owned `$BIN/bd` stub; skip-bd adapter legs. |
| report-issues | Owned bd stub, also copied into no-gh fixture. |
| seat-worktree | Owned `$BIN/bd` stub. |
| staffing-live | Owned `$BIN/bd` stub; provider-only optional pi leg does not invoke real bd. |
| staffing | Owned `$BIN/bd` and `$REAL/bin/bd` stubs. |
| verify | Owned `$BIN/bd`; bench `WHEELHOUSE_REAL_BD` refers to that captured fixture stub, not the installed CLI. Sweep bd wrapper forwards to `STUB_SWEEP_BASE_BD=$BIN/bd`. |
| walk | Only textual `bd show` prompt-leak assertion; no bd execution site. |

Shared helper coverage does not alter installed bd configuration, disable Git
hooks, weaken prune live-cwd protection, or suppress any pruning assertion.
The native failing capture identified `bd send-metrics` (PPID 1) holding a
canonical `/Users/...` fixture cwd. It was not a /var spelling issue or a host
worktree-count leak. CLI help and native metrics-off config/status captures,
plus test/gate results, are posted on the bead rather than cited from scratch.
