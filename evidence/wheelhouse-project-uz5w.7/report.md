Branch: fleet/wheelhouse-project-uz5w.7
Base: fleet/stakeholder-channels e4c90fcb20850dda47815c6192c6b25743c42ea5
Head: see bead comment final report.

Changed after re-scope:
- BOOTSTRAP.md adds question 10 for stakeholder channels, writes seats/channels.json, updates copy-list and verification checks.
- contracts/INTEGRATOR.md records how declared channels narrow the reserved outside-team communication action.
- contracts/bench.sh.stub is restored byte-for-byte to fleet/stakeholder-channels; umbrella bench proof moved to wheelhouse-project-uz5w.9.

Evidence from committed tree is in the bead comment final report. Expected checks:
- `git diff --exit-code fleet/stakeholder-channels -- contracts/bench.sh.stub` exits 0.
- `rg -n "question 10|Stakeholder channels|seats/channels.json" BOOTSTRAP.md` hits the copy-list, Q10, record-write, and verify-block locations.
- Public-template token-shaped history grep over `fleet/stakeholder-channels..HEAD` exits 1 with no output.
