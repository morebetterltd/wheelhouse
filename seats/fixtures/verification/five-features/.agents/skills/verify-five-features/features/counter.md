# Counter

## What it is

A consumer increments a process-local count with the visible Increment form.
A new process starts at zero. Reading the page does not increment it.

## How to get to it

From Home choose Counter, or open `GET /counter` at the `BASE_URL` recorded by
Launch. The visible button submits `POST /counter/increment`; that endpoint
returns a 303 redirect to `/counter`.

## How to drive it

Preconditions: follow Launch and Doctor in `SKILL.md`, in the same Bash shell.
Use the fresh instance, not an already-used counter. Keep its `BASE_URL`,
`APP_PID`, `RUN_DIR` and caller-provided `EVIDENCE_DIR`.

**Baseline action:** capture the initial page and require zero:

```bash
mkdir -p "$EVIDENCE_DIR/counter"
curl -fsS -D "$EVIDENCE_DIR/counter/before.headers" "$BASE_URL/counter" > "$EVIDENCE_DIR/counter/before.html" 2> "$EVIDENCE_DIR/counter/before.stderr"
printf '%s\n' "$?" > "$EVIDENCE_DIR/counter/before.status"
grep -Fq '<output id="count">0</output>' "$EVIDENCE_DIR/counter/before.html" || exit 1
```

**Mutation actions:** submit Increment twice and retain each redirect. Do not
follow the redirect invisibly; record the action's actual status separately.

```bash
for STEP in 1 2; do
  HTTP_CODE="$(curl -sS -X POST -D "$EVIDENCE_DIR/counter/increment-$STEP.headers" -o "$EVIDENCE_DIR/counter/increment-$STEP.body" -w '%{http_code}' "$BASE_URL/counter/increment" 2> "$EVIDENCE_DIR/counter/increment-$STEP.stderr")"
  STATUS=$?
  printf '%s\n' "$STATUS" > "$EVIDENCE_DIR/counter/increment-$STEP.status"
  printf '%s\n' "$HTTP_CODE" > "$EVIDENCE_DIR/counter/increment-$STEP.http-status"
  test "$STATUS" = 0 && test "$HTTP_CODE" = 303 || exit 1
done
```

**Read-back action:** independently fetch the page twice; each must still show
exactly two. The second GET proves that a read does not mutate the count.

```bash
for VIEW in after unchanged; do
  curl -fsS -D "$EVIDENCE_DIR/counter/$VIEW.headers" "$BASE_URL/counter" > "$EVIDENCE_DIR/counter/$VIEW.html" 2> "$EVIDENCE_DIR/counter/$VIEW.stderr"
  STATUS=$?
  printf '%s\n' "$STATUS" > "$EVIDENCE_DIR/counter/$VIEW.status"
  test "$STATUS" = 0 || exit 1
  grep -Fq '<output id="count">2</output>' "$EVIDENCE_DIR/counter/$VIEW.html" || exit 1
done
```

A browser reader may instead open Counter, confirm zero, choose Increment twice
and see two. Use the HTTP read-back above as the second consumer-facing view.
If the baseline is not zero, stop and relaunch only your owned instance; do not
change the expected value or reset state through an internal route.

## What proves it works

The retained `before.html` contains `<output id="count">0</output>`, both POSTs
have exit0/HTTP303 and a Location ending `/counter`, and both `after.html` and
`unchanged.html` contain `<output id="count">2</output>` with exit0. The final
visible end state is **Counter = 2**. A listening process, a successful POST or
a redirect alone is insufficient.

Run Cleanup from `SKILL.md`, then inspect those files again. Evidence must remain
under `EVIDENCE_DIR/counter/` after the owned server exits; never delete the proof
as disposable application state.
