Trace: ISA F2 W12 machine-only merge gate.
Signal: isa-gap: W12
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Pure machinery can merge on reviewed literal evidence without inventing a consumer walk.

Outcomes:
- O1 The command succeeds.
  consumer: machine — the command caller
  surface: the command's status and literal output
  check: run — observe status zero and the expected output
- O2 The file is well formed.
  consumer: machine — the file parser
  surface: the generated file
  check: run — parse the file and inspect its fields
