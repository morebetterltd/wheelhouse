Trace: invented counter-toolbar signal for the five-feature fixture
Signal: sig-mapm
Skills: intent@1.0.0 outcomes@1.1.0

Intent:
People should find Counter's Increment button inside an Actions toolbar at /counter#actions instead of the standalone form. This changes the button's reach, not the increment endpoint, redirect or final Counter = 2 result after two increments.

Outcomes:
- O1 A person can find Increment in the Actions toolbar and increment the counter twice.
  consumer: person-on-surface — the person using Counter
  surface: /counter#actions
  check: walk — open /counter#actions, find Increment inside Actions, choose it twice and independently reload Counter to see Counter = 2; an absent toolbar or a different count disproves the claim
- O2 The feature map entry counter is updated for the Actions toolbar reach.
  consumer: machine — the verifier reading the map
  surface: .agents/skills/verify-five-features/features/counter.md
  check: run — bun seats/manual.ts features --repo seats/fixtures/verification/five-features --json lists counter with /counter#actions and Actions toolbar in its reach and Counter = 2 in its end state
