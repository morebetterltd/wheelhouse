Trace: Invented Basket Ledger report fixture: a bought-item mark disappeared after closing and returning to the shared grocery notebook.
Signal: sig-b102
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Make bought-item marks dependable when people return to their shared grocery list. People using Basket Ledger need to trust the list's record of what has already been bought, rather than lose that information and buy the same groceries again.

Outcomes:
- O1 Milk still appears bought after the person who marked it closes the notebook and returns to the same shared list.
  consumer: person-on-surface — the household member marking groceries as bought and returning to the list
  surface: the bought-item marks on Basket Ledger's shared grocery list
  check: walk — open a list containing milk in a real session, mark milk bought, close the notebook and reopen that list; milk must still visibly be marked bought rather than needing purchase
- O2 The saved bought status read on reopening a list retains the last bought mark for that item.
  consumer: machine — the list-loading component reading saved bought-item statuses
  surface: the saved bought status that Basket Ledger reads when opening the shared list
  check: run — save fixture item milk as bought, close and reopen its list, then read the saved status used to load milk; expect bought, not still-needed
