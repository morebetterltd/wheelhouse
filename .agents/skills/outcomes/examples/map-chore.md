Trace: invented evidence-directory documentation chore for the five-feature fixture
Signal: sig-mapc
Skills: intent@1.0.0 outcomes@1.1.0

Intent:
Clarify in the fixture README that the caller chooses the directory where verification evidence is retained. This is a wording correction only; the application's routes, commands, navigation and visible end states do not change.

Outcomes:
- O1 A maintainer reading the README can identify who chooses the retained evidence directory.
  consumer: person-reading — the maintainer following the fixture README
  surface: README.md
  check: read — read README.md top to bottom and run its commands; it says the caller chooses the retained evidence directory without prescribing a new product journey
