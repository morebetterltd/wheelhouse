# Search notes

## What it is

A consumer finds notes by title or body, opens a matching note, and distinguishes
no matches from an unavailable search. Cover search opening, matches, opening a
result, completed empty state, clearing, and command search.

## How to get to it

- Choose `Search` in the browser toolbar.
- Press `/` while focus is outside an editable field (a key press, not a command).
- Run `notes search <query>` in a terminal.

## How to drive it

Preconditions: a run-owned, doctor-checked Notes instance at the chosen test
endpoint; disposable data contains `Quarterly plan` with body `Draft budget`
and `Grocery list`. See the index for isolation and retained evidence.

- **Toolbar entry.** Run `control-notes browser click --role button --name "Search"`.
  A dialog named `Search notes` appears with focus in its searchbox.
- **Keyboard entry.** Close it, focus a non-editable part of the page, then run
  `control-notes browser press --key "/"`. The same dialog appears; no slash is
  inserted into editable content.
- **Title match.** Run `control-notes browser fill --role searchbox --name "Search notes" --value "quarterly"`.
  `Search results` contains `Quarterly plan` and not `Grocery list`.
- **Body match.** Replace the query with `budget`. The same note is visible with
  a body-match excerpt after the search completes.
- **Open result.** Run `control-notes browser click --role link --name "Quarterly plan"`.
  The dialog closes and the editor heading reads `Quarterly plan`.
- **Empty state.** Reopen search and enter `volcano`; require completed status
  `No matching notes`, not an intermediate loading state.
- **Clear.** Run `control-notes browser click --role button --name "Clear search"`.
  The empty searchbox and `Recent notes` region replace the result list.
- **Command match.** Run `control-notes cli -- notes search "quarterly" --format json`.
  Require status 0 and one object titled `Quarterly plan` in stdout.
- **Command miss.** Run `control-notes cli -- notes search "volcano" --format json`.
  Require status 0 and stdout `[]`, keeping stderr separate from the result.

## What proves it works

Capture the action and populated result, not just an empty screen. Use
`control-notes browser snapshot --aria --path artifacts/search/results.aria.txt`
and `control-notes browser screenshot --path artifacts/search/results.png`
under the named evidence location. Both identify Notes, the query and
`Quarterly plan`. Confirm search did not alter stored notes through a second
read-only view. Inspect retained evidence after teardown.

A focused textbox receives `/` as text. Wait for a result or completed empty
status, not a fixed sleep. Archived notes need `Include archived` enabled; a
missing prerequisite is not a pass. The command's default display is for people,
so use its structured-output option for stable assertions. Reopen search after
opening a result before proving a different query.
