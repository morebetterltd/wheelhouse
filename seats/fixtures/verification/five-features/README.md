# Five features

A small dependency-free fixture for verification-manual checks, not an installed
service. It has five public features:

- Home: `GET /` and navigation.
- Health: `GET /health` returns `{"ok":true}`.
- Echo: `GET /echo` displays a form; `POST /echo` displays the submitted text.
- Counter: `GET /counter`; `POST /counter/increment` increments its value.
- About: `GET /about` describes the fixture.

From this directory, run `PORT=0 bun server.ts`. It binds loopback only and prints
`listening on http://127.0.0.1:<assigned-port>` as its first stdout line. Zero asks
the operating system for an unused test port; an explicit unused `PORT` also
works. All state belongs to this process and a fresh process starts at zero.
Stop only the process you started. Nothing is written to product files.

The hand-written manual is `.agents/skills/verify-five-features/SKILL.md`.
It is the shape oracle for an install following BOOTSTRAP.md steps 2, 3 and 5:
start a scratch product clone without that existing manual or its compatibility
link, scan the app, and generate a fresh manual with create-verification rather
than copying this oracle. Compare the five ordered sections (Launch, Doctor,
Drive, Evidence, Cleanup), the feature index and its five linked feature files,
and the resolving `.claude/skills/verify-five-features` relative symlink. Recipe
wording need not be identical; all five public features above must be covered.
`bun seats/manual.ts check --repo .` from the scratch install root must print
`manual ok: 5 features`; its local default-line commit starts with
`Add the verification manual`. This is the fixture for the umbrella bench's
install leg, not a reason to copy specimen manuals into real products.
