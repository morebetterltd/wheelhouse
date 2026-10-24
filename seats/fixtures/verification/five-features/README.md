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
