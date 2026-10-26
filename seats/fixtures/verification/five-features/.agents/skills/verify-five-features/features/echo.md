# Echo

## What it is

A consumer submits text through a form and sees the same text rendered safely
in the response, rather than executing it as markup.

## How to get to it

Choose Echo from Home, or request `GET /echo`. The form's Text field submits
to `POST /echo` with a field named `text`.

## How to drive it

After Launch and Doctor, run `mkdir -p "$EVIDENCE_DIR/echo"`. Capture the form:
`curl -fsS "$BASE_URL/echo" > "$EVIDENCE_DIR/echo/form.html" 2> "$EVIDENCE_DIR/echo/form.stderr"`.
Record its exit status separately. Submit a distinctive value:
`curl -fsS -D "$EVIDENCE_DIR/echo/headers" --data-urlencode 'text=Hello <reader> & friends' "$BASE_URL/echo" > "$EVIDENCE_DIR/echo/result.html" 2> "$EVIDENCE_DIR/echo/stderr"`.
Record this exit status in `"$EVIDENCE_DIR/echo/status"`. A browser can submit
the same value using the Text field and Echo button.

## What proves it works

Require exit0/HTTP200, heading `Echo result` and visible text
`Hello <reader> & friends`. In the retained HTML, the output is
`<output id="echo">Hello &lt;reader&gt; &amp; friends</output>`; submitted markup
does not become an element. Retain form, action response and headers, then
inspect them after Cleanup. An empty successful response is not a read-back.
