Trace: contract parser fixture
Integration: fleet/fixture-goal
Signal: isa-gap: K1
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Make the verification result understandable to the people and tools that meet it. They need to know whether the promised result actually holds.

Outcomes:
- O1 A visitor can open the result page and see the verdict.
  consumer: person-on-surface — the visitor using the result page
  surface: the result page
  check: walk — open the page and inspect the displayed verdict
- O2 A maintainer can follow the verification guide.
  consumer: person-reading — the maintainer reading the guide
  surface: verification guide
  check: read — read the guide top to bottom and run its commands
- O3 The result command returns the verdict.
  consumer: machine — the verification runner
  surface: result command stdout
  check: run — invoke the command and compare its literal output
