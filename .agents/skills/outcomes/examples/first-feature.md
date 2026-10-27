Trace: invented first-feature signal for the no-surface fixture
Signal: isa-gap: V5
Skills: intent@1.0.0 outcomes@1.1.0

Intent:
This repository has nothing to launch yet. Readers need its first public page at /reports to show an activity summary, reached directly by that route, so they can review their activity in one place.

Outcomes:
- O1 A reader can open the reports page and see the activity summary.
  consumer: person-on-surface — the reader opening reports
  surface: /reports
  check: walk — open /reports in a real browser session and inspect the visible activity summary; an absent page or missing summary disproves this claim
- O2 The verification manual has Launch, Doctor, Drive, Evidence and Cleanup sections for no-surface.
  consumer: machine — the verifier reading the manual
  surface: .agents/skills/verify-no-surface/SKILL.md
  check: run — bun seats/manual.ts check --repo seats/fixtures/verification/no-surface prints manual ok: 1 features, not manual ok: no surface
- O3 The feature map has an entry for reports with its public reach and visible end state.
  consumer: machine — the verifier reading the map
  surface: .agents/skills/verify-no-surface/features/reports.md
  check: run — bun seats/manual.ts features --repo seats/fixtures/verification/no-surface --json lists reports with /reports in its reach and the activity summary in its end state
