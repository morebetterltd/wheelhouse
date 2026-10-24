---
name: verify-five-features
description: 'Launch, check, drive and retain HTTP evidence for the five-features fixture when verifying its public features.'
version: 1.0.0
---

# Verify five-features

## Launch

Requirements: Bun, curl, Bash and ps. Working directory: the `five-features`
product directory containing `server.ts`; from the template root it is
`seats/fixtures/verification/five-features`. No install, account or database is
needed. Use one Bash session for launch, drive and cleanup. The counter is
process-local; each new instance starts at zero. Leave `EXTRA_FEATURES` unset
for the five-feature baseline. A requested broken launch must be reported,
not repaired by clearing its environment.

The caller supplies two absolute paths beneath its own scratch/retention root:
`RUN_DIR` for disposable run records, and `EVIDENCE_DIR` for retained proof.
They must be new, distinct directories. Keep both outside the product tree.
Run these commands from the product directory:

```bash
: "${RUN_DIR:?set a new absolute run directory}"
: "${EVIDENCE_DIR:?set a new absolute evidence directory}"
test ! -e "$RUN_DIR" && test ! -e "$EVIDENCE_DIR" || exit 2
mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
PORT=0 bun server.ts > "$RUN_DIR/server.stdout" 2> "$RUN_DIR/server.stderr" &
APP_PID=$!
printf '%s\n' "$APP_PID" > "$RUN_DIR/server.pid"
until grep -q '^listening on http://127.0.0.1:[0-9][0-9]*$' "$RUN_DIR/server.stdout"; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    cat "$RUN_DIR/server.stderr" >&2
    LAUNCH_STATUS=0
    wait "$APP_PID" || LAUNCH_STATUS=$?
    printf '%s\n' "$LAUNCH_STATUS" > "$RUN_DIR/launch.status"
    exit 1
  fi
  sleep 0.05
done
ps -ww -p "$APP_PID" -o pid=,ppid=,uid=,lstart=,command= > "$RUN_DIR/server.identity" || exit 2
BASE_URL="$(awk '/^listening on / { print $3; exit }' "$RUN_DIR/server.stdout")"
export BASE_URL EVIDENCE_DIR
printf '%s\n' "$BASE_URL" > "$EVIDENCE_DIR/endpoint.txt"
```

`PORT=0` requests an unused non-production port. The first `listening on` line
names this run's endpoint; do not guess it or use another instance. Keep the
recorded identity for Cleanup. A readiness wait is bounded by the caller's run
containment, not an arbitrary startup speed assumption. If launch fails, retain
both streams and its exit status; never stop another service to free a port.

## Doctor

Before the first drive, on a fresh session and after a surprising action:

```bash
curl -fsS "$BASE_URL/health" > "$EVIDENCE_DIR/doctor.json" 2> "$EVIDENCE_DIR/doctor.stderr"
printf '%s\n' "$?" > "$EVIDENCE_DIR/doctor.status"
cat "$EVIDENCE_DIR/doctor.json"
```

Require exit 0 and exactly `{"ok":true}` from the recorded endpoint. Check that
`ps -ww -p "$APP_PID" -o pid=,ppid=,uid=,lstart=,command=` still equals the saved
identity. A healthy response is only permission to drive, not proof of a feature.

## Drive

Use the recorded `BASE_URL`, never a hard-coded shared port. These are consumer
HTTP routes; a browser can follow the same visible links and forms.

- Home: `GET /`; see `Five features` and the five navigation links.
- Health: `GET /health`; see the exact JSON body from Doctor.
- Echo: open `GET /echo`, submit its `Text` field to `POST /echo`, and read back
  the submitted text in `Echo result`.
- Counter: open `GET /counter`, submit `Increment` to
  `POST /counter/increment`, then read the changed value at `GET /counter`.
- About: `GET /about`; see `About` and the fixture description.

The map is `features/README.md`; each feature file gives labelled actions and
observable end states. To prove the counter, follow `features/counter.md` in the
same shell after Launch and Doctor. Do not reset state with an internal setter;
start a new owned instance if its baseline was already changed.

## Evidence

Use the caller's retained `EVIDENCE_DIR`, separate from `RUN_DIR`. For each
feature, create `"$EVIDENCE_DIR/<feature>"` and capture HTTP response bodies,
headers, stderr and command exit statuses in distinct files. Keep action
responses AND a later read-only result; a ready line or a 200 alone is not a
completed journey. Counter's file gives concrete capture commands. Record this
run's endpoint, launch streams and identity beside the feature evidence.

After Cleanup, inspect the retained files and their expected contents. Do not
claim an inaccessible route worked through a different entry point.

## Cleanup

In the original launch shell, re-read the process identity BEFORE signalling:

```bash
if kill -0 "$APP_PID" 2>/dev/null; then
  CURRENT="$(ps -ww -p "$APP_PID" -o pid=,ppid=,uid=,lstart=,command=)" || exit 2
  test "$CURRENT" = "$(cat "$RUN_DIR/server.identity")" || { echo 'STOP: process identity changed' >&2; exit 2; }
  kill -TERM "$APP_PID"
fi
STOP_STATUS=0
wait "$APP_PID" || STOP_STATUS=$?
printf '%s\n' "$STOP_STATUS" > "$EVIDENCE_DIR/cleanup.status"
cp "$RUN_DIR/server.stdout" "$RUN_DIR/server.stderr" "$RUN_DIR/server.identity" "$EVIDENCE_DIR/"
test -s "$EVIDENCE_DIR/doctor.json"
```

A normal TERM exit is 143; an already-finished process can have a different
recorded status. Stop only this PID with its saved birth/owner/command, never by
process name. Waiting joins the owned child and disposes its in-memory state.
Leave both directories in place so failed-attempt diagnostics and evidence
survive. If ownership cannot be confirmed, stop and report the unknown state
instead of killing a replacement. Inspect the feature evidence after teardown.
