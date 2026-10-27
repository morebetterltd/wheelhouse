Trace: invented displayed-count fix for the five-feature fixture
Signal: sig-mapu
Skills: intent@1.0.0 outcomes@1.1.0

Intent:
Correct the displayed count after incrementing so a person sees the value they just reached. Keep /counter, the existing Increment form, POST /counter/increment, its redirect and the Counter = 2 end state after two increments unchanged. No navigation or proof changes are intended.

Outcomes:
- O1 A person sees the correct count after two increments and an independent reload.
  consumer: person-on-surface — the person using the existing Counter form
  surface: /counter; proof: Counter = 2
  check: walk — open /counter, use the existing Increment form twice, then independently reload it and see Counter = 2; resetting or displaying a stale count disproves this claim
