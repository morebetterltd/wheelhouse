> Intent: quoted example is not the contract
```text
Outcomes:
- O99 FENCED-PREAMBLE-MUST-NOT-ENTER
  check: run — a fenced example
```
Trace: indented outcome field continuation fixture
Signal: isa-gap: W11
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Every consumer receives the complete check, including its cases and disproof.

Outcomes:
- O1 The parser retains the details of each field.
  consumer: machine — a contract reader
    using the complete parsed fields
  surface: the parsed outcome
    and its continuation surface
  check: run — inspect these literal cases:
    - first case keeps its punctuation: [one].
      - second case follows the first.
    Disproved by: any missing or reordered continuation.
    > QUOTED-CHECK-MUST-NOT-ENTER
- O2 The following outcome remains separate.
  consumer: machine — a second reader
  surface: the second outcome
  check: run — require only the second check

Notes:
  check: run — COLUMN-ZERO-NOTE-MUST-NOT-ENTER
  consumer: person-reading — not a contract field here
