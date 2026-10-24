# Home

## What it is

The fixture's front page identifies the application and offers its five baseline
navigation entries.

## How to get to it

Open `GET /` at the owned `BASE_URL` from Launch, in a browser or with curl.

## How to drive it

After Launch and Doctor, run `mkdir -p "$EVIDENCE_DIR/home"` then
`curl -fsS -D "$EVIDENCE_DIR/home/headers" "$BASE_URL/" > "$EVIDENCE_DIR/home/page.html" 2> "$EVIDENCE_DIR/home/stderr"`.
Record its exit status in `"$EVIDENCE_DIR/home/status"`. In a browser, choose
Health, Echo, Counter and About from the navigation, returning Home each time.

## What proves it works

Require exit0/HTTP200, the heading `Five features` and links to `/`, `/health`,
`/echo`, `/counter` and `/about`. Retain the response, not merely a status code;
inspect the files after Cleanup. An unrelated healthy page is not this feature.
