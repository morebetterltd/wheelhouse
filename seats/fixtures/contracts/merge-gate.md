Trace: ISA F2 W12 merge gate.
Signal: isa-gap: W12

Intent:
A merge should include only work whose outcomes have been proved where their consumers meet them.

Outcomes:
- O1 The counter reaches two.
  consumer: person-on-surface — a person using the counter
  surface: the fixture counter page
  check: walk — increment twice and read back two
- O2 The health command reports success.
  consumer: machine — the health probe
  surface: the health command's literal output
  check: run — observe a successful status and the expected body
- O3 The instructions explain the counter.
  consumer: person-reading — a reader following the instructions
  surface: the fixture README
  check: read — read it top to bottom and run its commands
