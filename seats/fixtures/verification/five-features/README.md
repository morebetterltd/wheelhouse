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

For the feature-confirmation interview bench, the owner's launch note sets
`EXTRA_FEATURES=reports` (`PORT=0 EXTRA_FEATURES=reports bun server.ts`). The
sixth feature, **reports at `/reports`**, is the feature an owner names in that
bench run: it is not one of the five static navigation/route entries above.
The installer first presents those five found features and asks question 2e;
the scripted owner adds: "Reports at /reports is missing. Launch with
EXTRA_FEATURES=reports, then open /reports directly." Record that reach as the
owner's words in `wheelhouse/interview/features.md` and the reports entry's
`## How to get to it`. Do not copy the five-entry oracle unchanged: the accepted
interview has six features, so the generated index and map must include reports
and `manual.ts check` must print `manual ok: 6 features`. The default no-extra
fixture and its hand-written five-feature oracle remain unchanged.

## Prove the manual during install

For BOOTSTRAP.md step 6, use the scratch install's generated manual, not a
running copy of another fixture. With the baseline map, its first entry is
`home`: follow Launch, Doctor and the home entry's Drive, writing retained
proof under the scratch install root's
`evidence/install/verify-five-features/home/`. Supply distinct absolute
`RUN_DIR` and `EVIDENCE_DIR` paths, with `EVIDENCE_DIR` set to that retained
`verify-five-features` base, outside disposable run state. Bound the whole run
and every helper, use `PORT=0`, and stop/join only the process you started.
After the manual's Cleanup, inspect the home response for `Five features` and
all five navigation links, paste the evidence listing, then from the install
root run:

```bash
bun seats/manual.ts evidence home --repo "$repo" --dir evidence/install/verify-five-features
pgrep -f 'five-features/server.ts'
```

Here `repo` is the scratch product repo path. The evidence command must exit 0;
`pgrep` should print nothing and exit 1 when no other fixture run is active.
Launch from the product directory as the manual says (`bun server.ts`), so
also verify the saved PID/identity is gone: a name search alone may not match
that relative argv. Do not kill another run to make a global search empty.

For the broken-launch leg, start a fresh scratch attempt and put
`BROKEN_LAUNCH=1` in the owner's launch note: run
`PORT=0 BROKEN_LAUNCH=1 bun server.ts` instead of the normal Launch command.
Keep both output streams and the exit status. The expected stderr is
`fixture: launch broken on purpose`, with exit 1 and no ready line. The
installer must stop with:

```text
the manual's Launch step failed: fixture: launch broken on purpose
```

Still run failure-path Cleanup: join the failed child, retain its launch
streams/status, and confirm it left no process. Later-step doctor/identity
files may not exist on this path; their absence must not obscure the Launch
failure. Do not clear `BROKEN_LAUNCH`, continue to Doctor/Drive or the smoke
loop, or report the install finished. Keep a transcript showing that the next
action, `Run the smoke loop`, was not reached. This negative leg intentionally
produces no successful home proof.
