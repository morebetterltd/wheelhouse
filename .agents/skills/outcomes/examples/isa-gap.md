Trace: Invented Basket Ledger claim GL7 fixture: a shared list still looks current after the connection is lost and the person returns to it.
Signal: sig-b103
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Make it clear when a shared grocery list may be out of date because the connection is lost. People using Basket Ledger need to distinguish an old view from current information so they can make shopping decisions without being misled about what others have changed.

Outcomes:
- O1 A person returning to a shared list without a connection sees that the list may be out of date.
  consumer: person-on-surface — a household member checking the shared grocery list while disconnected
  surface: the connection and freshness notice on Basket Ledger's shared grocery list
  check: walk — open a shared list in a real session, disconnect from the network and return to that list; the visible notice must say that the list may be out of date because the connection is lost, rather than presenting the old view as current
