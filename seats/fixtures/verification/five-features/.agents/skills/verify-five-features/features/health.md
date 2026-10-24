# Health

## What it is

A consumer can read a small health result from the exact instance being driven.
It is a read-only prerequisite, not proof that the other journeys work.

## How to get to it

Choose Health from Home, or request `GET /health` at the recorded `BASE_URL`.

## How to drive it

After Launch, run `mkdir -p "$EVIDENCE_DIR/health"`, then
`curl -fsS -D "$EVIDENCE_DIR/health/headers" "$BASE_URL/health" > "$EVIDENCE_DIR/health/body.json" 2> "$EVIDENCE_DIR/health/stderr"`.
Record the exit status in `"$EVIDENCE_DIR/health/status"`. Repeat the same GET;
no application state changes are expected.

## What proves it works

Require exit0, HTTP200 and exactly `{"ok":true}`. Retain both headers and body
and inspect them after Cleanup. Use only the endpoint from this run's ready
line; a different service's health response is not evidence for this instance.
