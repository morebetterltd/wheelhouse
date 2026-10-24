Trace: Invented Basket Ledger goal fixture: coordinate a household shopping trip without buying the same groceries twice.
Signal: sig-b101
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Give people sharing a grocery list a clear view of what still needs buying. In Basket Ledger, household members need to coordinate their shopping so they can cover the list without buying the same groceries twice.

Outcomes:
- O1 The household's grocery-list document distinguishes items still needing purchase from items already bought.
  consumer: person-reading — a household member reading the shared grocery-list document before a shopping trip
  surface: the household's shared grocery-list document in Basket Ledger
  check: read — read the list document top to bottom and run every command it contains; with milk not yet bought and bread already bought, the document must label milk as still needed and bread as bought, so the reader does not put bread on the remaining shopping list
