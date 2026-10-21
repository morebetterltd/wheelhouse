Trace: duplicate ids fixture

Intent:
Make the verification result understandable to the tools that meet it.

Outcomes:
- O1 The command prints the result.
  consumer: machine — verification runner
  surface: command stdout
  check: run — compare literal output
- O1 The command prints a status.
  consumer: machine — verification runner
  surface: command exit status
  check: run — compare exit code
