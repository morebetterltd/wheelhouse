Trace: invented reports-page signal for the five-feature fixture
Signal: sig-mapn
Skills: intent@1.0.0 outcomes@1.1.0

Intent:
Readers need a reports page at /reports that shows a summary of their activity. It is a new public page, reached directly by that route. The existing five pages and their journeys stay unchanged.

Outcomes:
- O1 A reader can open the reports page and see the activity summary.
  consumer: person-on-surface — the reader opening reports
  surface: /reports
  check: walk — open /reports in a real browser session and inspect the visible activity summary; an absent page or missing summary disproves this claim
- O2 The feature map has an entry for reports with its public reach and visible end state.
  consumer: machine — the verifier reading the map
  surface: .agents/skills/verify-five-features/features/reports.md
  check: run — bun seats/manual.ts features --repo seats/fixtures/verification/five-features --json lists reports with /reports in its reach and the activity summary in its end state
