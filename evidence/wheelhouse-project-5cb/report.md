Bead wheelhouse-project-5cb report

Branch: fleet/wheelhouse-project-5cb

Changed in the committed tree:
- seats/verify.ts accepts `--repo <path-to-branch-repo>`; omitted `--repo` defaults to ROOT for zero-config single-repo installs.
- Branch resolution, scratch verifier worktree creation/sweeping, and evidence floor checks run against the resolved branch repo.
- Evidence paths remain repo-relative to the branch/product repo and are still read from the tip SHA with `git cat-file blob <tip>:<path>`.
- The same-account STOP guard remains before branch resolution/spawn, and the APPROVE-over-unsatisfied-evidence gate remains exit 1.
- seats/verify.selftest.sh now includes an umbrella fixture where `seats/verify.ts` lives at an umbrella root and the branch/evidence live in a nested product git repo.

Canonical design selected:
- `--repo <path-to-branch-repo>` is the canonical multi-repo selector.

Rejected options:
- Roster/project field: rejected because branch ownership is per dispatch and a roster is seat/account configuration; using it would require every single-repo install to carry product metadata or add more implicit state.
- Bead-carried repo: rejected because verify.ts already treats bead text as a human rendering and does not parse `bd show`; making repo resolution depend on bead prose would repeat the problem the `--evidence` argument avoids.
- Auto-discovery from branch name: rejected because the same branch name can exist in multiple product repos and absence would still be ambiguous in an umbrella root.

Committed evidence paths:
- evidence/wheelhouse-project-5cb/verify-selftest.log (scrubbed: usernames and machine temp paths replaced).
- evidence/wheelhouse-project-5cb/report.md

Validation excerpts:

```
$ git symbolic-ref --short HEAD && test "$(git rev-parse HEAD)" = "$(git rev-parse fleet/wheelhouse-project-5cb)" && echo branch-tip-ok-before-commit
fleet/wheelhouse-project-5cb
branch-tip-ok-before-commit
```

```
$ WHEELHOUSE_REAL_PI_PROVIDER=openai-codex WHEELHOUSE_REAL_PI_MODEL=gpt-5.4 bash seats/verify.selftest.sh

multi-repo umbrella layout — --repo selects the product repository
  ok    umbrella layout: APPROVE exits 0 when --repo names the product repo
  ok    umbrella layout: verdict records the product repo and product-relative evidence floor check
  ok    umbrella layout: omitting --repo still measures the umbrella root and refuses the product branch
...
11. real pi — one smoke leg through the actual binary (SKIP-able)
  ok    real: one-shot spawn/parse/record round-trips through the real pi
  ok    real: verdict file recorded
  ok    real: no auth material in the verdict record before fixture deletion

verify.ts works on this machine.
```

```
$ git status --short --branch && git rev-parse HEAD && git rev-parse fleet/wheelhouse-project-5cb
## fleet/wheelhouse-project-5cb
<same head SHA printed twice; exact SHA is in the bead comment>
<same head SHA printed twice; exact SHA is in the bead comment>
```
