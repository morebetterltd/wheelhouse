# About

## What it is

A consumer reads the fixture's identity and short description.

## How to get to it

Choose About from Home or request `GET /about` at the owned `BASE_URL`.

## How to drive it

After Launch and Doctor, run `mkdir -p "$EVIDENCE_DIR/about"`, then
`curl -fsS -D "$EVIDENCE_DIR/about/headers" "$BASE_URL/about" > "$EVIDENCE_DIR/about/page.html" 2> "$EVIDENCE_DIR/about/stderr"`.
Record its exit status in `"$EVIDENCE_DIR/about/status"`. Return Home using
its URL and confirm that the same instance still answers Doctor.

## What proves it works

Require exit0/HTTP200, heading `About` and the text
`A small verification fixture with five public features.`. Retain the body
and headers and inspect them after Cleanup. A generic server-ready page or a
response from another port does not prove this identity.
