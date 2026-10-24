# Create a note

## What it is

A consumer saves a titled note from the browser or command interface, cancels an
unfinished draft, and confirms persistence from a second consumer-facing view.
Cover opening an editor, saving title/body, cancelling, and command creation.

## How to get to it

- Choose `New note` in the browser toolbar.
- Press `n` while focus is outside an editable field.
- Run `notes create --title <title> --body <body>` in a terminal.

## How to drive it

Preconditions: the run-owned Notes instance is healthy at the chosen test
endpoint; no note is titled `Release checklist`; `control-notes doctor` reports
the expected endpoint and disposable data directory. See the index for setup.

- **Open editor.** Run `control-notes browser click --role button --name "New note"`.
  A form named `Note editor` appears with focus in the `Title` textbox. Repeat
  through the `n` entry point from a non-editable focus target.
- **Enter content.** Run `control-notes browser fill --role textbox --name "Title" --value "Release checklist"`
  and `control-notes browser fill --role textbox --name "Body" --value "Tag and publish"`.
  `Save note` becomes enabled.
- **Save.** Run `control-notes browser click --role button --name "Save note"`.
  Status `Note saved` appears and the heading reads `Release checklist`.
- **Confirm persistence.** Run `control-notes browser click --role link --name "All notes"`
  then `control-notes browser click --role link --name "Release checklist"`.
  The editor shows both stored values.
- **Cancel.** Open a new note, enter `Discard me`, then choose `Cancel` with
  `control-notes browser click --role button --name "Cancel"`. The note list
  returns without a `Discard me` entry.
- **Command entry.** Run `control-notes cli -- notes create --title "CLI note" --body "Created from terminal" --format json`.
  Require status 0 and a new note ID/title in stdout; retain stderr separately.

## What proves it works

Reopen both saved notes through `All notes`; both values persist and the
cancelled draft is absent. Capture the action, read-back state and command result.
Use `control-notes browser snapshot --aria --path artifacts/create-note/list.aria.txt`
and `control-notes browser screenshot --path artifacts/create-note/list.png`
under the named evidence location. The artifacts identify Notes and both saved
notes. Remove test notes during cleanup, but inspect these artifacts afterward.

Pressing `n` in a textbox types a character rather than opening an editor.
Titles are trimmed on save; assert the rendered value. A save status alone does
not prove persistence: reopening from the list is required.
