Trace: ISA F2 claim W11, fixture for a cold work walk.
Integration: fleet/fixture-goal
Signal: isa-gap: W11
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
A consumer can use the small application's counter, understand its README and check its health without knowing how it was built.

Outcomes:
- O1 The counter reaches two after two increments.
  consumer: person-on-surface — a consumer using the fresh counter
  surface: manual:counter
  check: walk — launch and doctor from the manual, drive the counter from its entry and retain the read-back of two after cleanup
    - WORK-WALK-CHECK-CONTINUATION: retain the counter read-back as part of this check.
- O2 The README names the five baseline features.
  consumer: person-reading — a reader learning how to launch the application
  surface: README.md
  check: read — read the README top to bottom, run its launch command in the isolated instance and identify the five named features
- O3 The health command prints the expected JSON.
  consumer: machine — curl against the owned instance
  surface: GET /health at the endpoint recorded by the manual
  check: run — curl the owned instance's health endpoint and require literal output {"ok":true} with exit0

Worker report:
WORKER-REPORT-SENTINEL: this paragraph must not enter a verifier prompt.
bd show fixture-bead
