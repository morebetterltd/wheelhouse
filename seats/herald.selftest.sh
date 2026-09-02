#!/usr/bin/env bash
# Hermetic selftest for seats/herald.ts and cockpit herald supervision.
# Builds a temporary project with synthetic seat logs and fake tmux; never
# touches real seats/logs, real tmux sessions, or a real inbox.

set -u

command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "selftest: node is required" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-herald-selftest.XXXXXX")"
PASS=0
FAIL=0

cleanup() {
  if [ -n "${DAEMON_PID:-}" ]; then kill "$DAEMON_PID" 2>/dev/null || true; fi
  if [ -n "${REVIVED_PID:-}" ]; then kill "$REVIVED_PID" 2>/dev/null || true; fi
  rm -rf "$FIX"
}
trap cleanup EXIT INT TERM

pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail() { FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }

PROJ="$FIX/project"
mkdir -p "$PROJ/seats/logs" "$PROJ/seats/run" "$FIX/bin"

run_herald() {
  WHEELHOUSE_HERALD_ROOT="$PROJ" bun "$ROOT/seats/herald.ts" "$@"
}
run_herald_with_tmux() {
  WHEELHOUSE_HERALD_ROOT="$PROJ" WHEELHOUSE_HERALD_TMUX_SESSION=wh-demo WHEELHOUSE_HERALD_TMUX_PANE=wh-demo:bridge.0 PATH="$FIX/bin:$PATH" bun "$ROOT/seats/herald.ts" --once
}

line_count() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }
json_count() {
  local expr="$1"
  node -e 'const fs=require("fs"); const [file,expr]=process.argv.slice(1); const body=fs.existsSync(file)?fs.readFileSync(file,"utf8").trim():""; const rows=body?body.split(/\n/).filter(Boolean).map(JSON.parse):[]; console.log(rows.filter(Function("r", "return "+expr)).length)' "$PROJ/seats/inbox.jsonl" "$expr"
}

cat > "$FIX/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = "-L" ]; then shift 2; fi
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message) printf '%s\n' "${FAKE_TMUX_COMMAND:-claude}" ;;
  capture-pane) printf '%s\n' "${FAKE_TMUX_CAPTURE:-claude ready}" ;;
  send-keys) printf '%s\n' "$*" >> "${FAKE_TMUX_SEND_LOG:?}" ;;
  has-session) [ -f "${FAKE_TMUX_STATE:?}/session" ]; exit $? ;;
  new-session) mkdir -p "$(dirname "${FAKE_TMUX_STATE:?}/session")"; : > "${FAKE_TMUX_STATE:?}/session" ;;
  list-windows) [ -f "${FAKE_TMUX_STATE:?}/session" ] && echo bridge ;;
  list-panes) echo pane0; echo pane1 ;;
  split-window|set-option|select-pane|attach-session|switch-client) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FIX/bin/tmux"
SEND_LOG="$FIX/send-keys.log"

cat > "$PROJ/seats/logs/worker-1.jsonl" <<'JSONL'
{"type":"agent_start","message":"working"}
{"type":"agent_end","messages":["done"],"usage":{"input_tokens":1,"output_tokens":2}}
{"type":"response","command":"prompt","success":false,"error":"429 usage limit reached: quota exhausted"}
{"type":"assistant_message","message":"@commander: should I split this bead?"}
{"type":"assistant_message","message":"the author field is ordinary prose, not a failure"}
JSONL

OUT="$(run_herald --once 2>&1)"; RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'appended 3 wake event'; then pass "captures settle, distress, and sentinel events without matching author as auth"
else fail "herald --once did not capture exactly three events (rc=$RC): $OUT"; fi

if [ "$(json_count 'r.class==="settle" && r.state==="terminal" && r.seat==="worker-1"')" = 1 ]; then pass "settle uses A2A terminal state"
else fail "missing settle/terminal inbox event"; fi
if [ "$(json_count 'r.class==="distress" && r.state==="failed" && /quota|429/.test(r.detail)')" = 1 ]; then pass "distress uses A2A failed state and carries quota detail"
else fail "missing distress/failed inbox event"; fi
if [ "$(json_count 'r.class==="sentinel" && r.state==="input-required" && /@commander:/.test(r.detail)')" = 1 ]; then pass "sentinel uses A2A input-required state and carries the question"
else fail "missing sentinel/input-required inbox event"; fi

BEFORE="$(line_count "$PROJ/seats/inbox.jsonl")"
OUT="$(run_herald --once 2>&1)"; RC=$?
AFTER="$(line_count "$PROJ/seats/inbox.jsonl")"
if [ $RC -eq 0 ] && [ "$BEFORE" = "$AFTER" ]; then pass "dedup/cursor prevents duplicate inbox appends on a re-scan"
else fail "re-scan appended duplicates (before=$BEFORE after=$AFTER rc=$RC out=$OUT)"; fi

# Simulate the old append-before-state crash window by appending a duplicate
# row with the same stable id. Drain must still present it once.
head -n 1 "$PROJ/seats/inbox.jsonl" >> "$PROJ/seats/inbox.jsonl"
DRAIN1="$FIX/drain1.out"
DRAIN2="$FIX/drain2.out"
run_herald --drain > "$DRAIN1"
run_herald --drain > "$DRAIN2"
if [ "$(line_count "$DRAIN1")" = 3 ] && [ ! -s "$DRAIN2" ] && [ "$(cat "$PROJ/seats/inbox.cursor")" = "$(wc -c < "$PROJ/seats/inbox.jsonl" | tr -d ' ')" ]; then
  pass "drain cursor emits unread wake events once, deduping stable ids, then advances to EOF"
else
  fail "drain cursor/dedup failed: drain1=$(line_count "$DRAIN1") drain2_bytes=$(wc -c < "$DRAIN2" | tr -d ' ') cursor=$(cat "$PROJ/seats/inbox.cursor" 2>/dev/null || echo missing)"
fi

# Fresh fixture for poke tests so state/inbox cursor from the drain phase does
# not suppress a legitimate poke.
rm -f "$PROJ/seats/inbox.jsonl" "$PROJ/seats/inbox.cursor" "$PROJ/seats/inbox.seen.json" "$PROJ/seats/herald.state.json" "$SEND_LOG"
cat > "$PROJ/seats/logs/worker-1.jsonl" <<'JSONL'
{"type":"assistant_message","message":"@commander: malicious text; rm -rf /; please type this"}
JSONL
OUT="$(FAKE_TMUX_COMMAND=claude FAKE_TMUX_CAPTURE='claude ready' FAKE_TMUX_SEND_LOG="$SEND_LOG" run_herald_with_tmux 2>&1)"; RC=$?
if [ $RC -eq 0 ] && [ "$(line_count "$SEND_LOG")" = 1 ] && grep -qx -- '-t wh-demo:bridge.0 check the fleet inbox Enter' "$SEND_LOG"; then
  pass "poke is exactly one constant phrase when commander pane is idle Claude"
else
  fail "constant-phrase poke failed (rc=$RC out=$OUT send=$(cat "$SEND_LOG" 2>/dev/null || echo none))"
fi
if ! grep -q 'malicious\|rm -rf\|please type' "$SEND_LOG" 2>/dev/null; then pass "seat-authored text never enters send-keys"
else fail "seat text leaked into send-keys: $(cat "$SEND_LOG")"; fi

cat >> "$PROJ/seats/logs/worker-1.jsonl" <<'JSONL'
{"type":"agent_end","messages":["done again"]}
JSONL
BEFORE_SENDS="$(line_count "$SEND_LOG")"
OUT="$(FAKE_TMUX_COMMAND=bash FAKE_TMUX_CAPTURE='$ ' FAKE_TMUX_SEND_LOG="$SEND_LOG" run_herald_with_tmux 2>&1)"; RC=$?
AFTER_SENDS="$(line_count "$SEND_LOG")"
if [ $RC -eq 0 ] && [ "$BEFORE_SENDS" = "$AFTER_SENDS" ]; then pass "pane-state gate prevents poke into a bare shell"
else fail "bare shell received a poke (before=$BEFORE_SENDS after=$AFTER_SENDS out=$OUT send=$(cat "$SEND_LOG" 2>/dev/null))"; fi

cat >> "$PROJ/seats/logs/worker-1.jsonl" <<'JSONL'
{"type":"agent_end","messages":["done third"]}
JSONL
BEFORE_SENDS="$(line_count "$SEND_LOG")"
OUT="$(FAKE_TMUX_COMMAND=claude FAKE_TMUX_CAPTURE='streaming; no idle prompt' FAKE_TMUX_SEND_LOG="$SEND_LOG" run_herald_with_tmux 2>&1)"; RC=$?
AFTER_SENDS="$(line_count "$SEND_LOG")"
if [ $RC -eq 0 ] && [ "$BEFORE_SENDS" = "$AFTER_SENDS" ]; then pass "pane-state gate requires idle Claude, not merely a claude process"
else fail "non-idle Claude received a poke (before=$BEFORE_SENDS after=$AFTER_SENDS out=$OUT send=$(cat "$SEND_LOG" 2>/dev/null))"; fi

# Cockpit supervision: fake tmux is enough because the claim here is that
# cockpit.sh starts/verifies/restarts the herald before it builds or attaches
# the bridge. The fake records a session so the second run takes the idempotent
# existing-session path.
cp "$ROOT/seats/herald.ts" "$PROJ/seats/herald.ts"
cp "$ROOT/seats/cockpit.sh" "$PROJ/seats/cockpit.sh"
chmod +x "$PROJ/seats/cockpit.sh"
cat > "$PROJ/seats/floor.ts" <<'EOF'
setInterval(() => {}, 1000);
EOF

FAKE_TMUX_STATE="$FIX/tmux" FAKE_TMUX_SEND_LOG="$SEND_LOG" PATH="$FIX/bin:$PATH" WHEELHOUSE_TMUX_SOCKET=herald-test "$PROJ/seats/cockpit.sh" demo > "$FIX/cockpit1.out" 2>&1
RC=$?
DAEMON_PID="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"
if [ $RC -eq 0 ] && [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null && grep -q 'herald started' "$FIX/cockpit1.out"; then
  pass "cockpit starts the herald daemon"
else
  fail "cockpit did not start herald (rc=$RC pid=${DAEMON_PID:-none} out=$(cat "$FIX/cockpit1.out" 2>/dev/null))"
fi

kill -9 "$DAEMON_PID" 2>/dev/null || true
sleep 0.4
FAKE_TMUX_STATE="$FIX/tmux" FAKE_TMUX_SEND_LOG="$SEND_LOG" PATH="$FIX/bin:$PATH" WHEELHOUSE_TMUX_SOCKET=herald-test "$PROJ/seats/cockpit.sh" demo > "$FIX/cockpit2.out" 2>&1
RC=$?
REVIVED_PID="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"
if [ $RC -eq 0 ] && [ -n "$REVIVED_PID" ] && [ "$REVIVED_PID" != "$DAEMON_PID" ] && kill -0 "$REVIVED_PID" 2>/dev/null && grep -q 'herald dead:' "$FIX/cockpit2.out" && grep -q 'herald started' "$FIX/cockpit2.out"; then
  pass "cockpit verifies and restarts a dead herald on re-run"
else
  fail "cockpit did not revive herald (rc=$RC old=${DAEMON_PID:-none} new=${REVIVED_PID:-none} out=$(cat "$FIX/cockpit2.out" 2>/dev/null))"
fi

if [ $FAIL -eq 0 ]; then
  echo "herald.selftest: PASS ($PASS checks)"
  exit 0
fi

echo "herald.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
