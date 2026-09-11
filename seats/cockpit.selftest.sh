#!/usr/bin/env bash
# cockpit.selftest.sh — hermetic checks for cockpit tmux sizing and respawn.
# Uses a private tmux socket and a temp project; never touches live sessions.

set -u

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

command -v tmux >/dev/null 2>&1 || { echo "selftest: tmux is required" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd -P)"
COCKPIT="$HERE/cockpit.sh"
[ -x "$COCKPIT" ] || { echo "selftest: not executable: $COCKPIT" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-cockpit-selftest.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
SOCK="wheelhouse-cockpit-selftest.$$"
PASS=0
FAIL=0
cleanup() {
  tmux -L "$SOCK" kill-server >/dev/null 2>&1 || true
  selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null || true
  pids=""
  for pid_file in "$FIX"/project/seats/run/*.pid; do
    [ -f "$pid_file" ] || continue
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    [ -n "$pid" ] && pids="$pids $pid"
  done
  [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  pkill -f "$FIX/project/seats/herald.ts" >/dev/null 2>&1 || true
  pkill -f "$FIX/project/seats/commander-inbox-poll.sh" >/dev/null 2>&1 || true
  sleep 0.2
  for pid in $pids; do
    kill -0 "$pid" >/dev/null 2>&1 && kill -9 "$pid" >/dev/null 2>&1 || true
  done
  pkill -9 -f "$FIX/project/seats/herald.ts" >/dev/null 2>&1 || true
  pkill -9 -f "$FIX/project/seats/commander-inbox-poll.sh" >/dev/null 2>&1 || true
  rm -rf "$FIX"
}
trap cleanup EXIT INT TERM
pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail() { FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }

PROJ="$FIX/project"
mkdir -p "$PROJ/seats" "$PROJ/contracts"
cp "$COCKPIT" "$PROJ/seats/cockpit.sh"
chmod +x "$PROJ/seats/cockpit.sh"
cat > "$PROJ/seats/floor.ts" <<'EOF'
setInterval(() => {}, 1000);
EOF
cat > "$PROJ/seats/herald.ts" <<'EOF'
setInterval(() => {}, 1000);
EOF
cat > "$PROJ/seats/commander-inbox-poll.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "poll-root=${WHEELHOUSE_COMMANDER_POLL_ROOT:-}" >> "$(dirname "$0")/logs/poll.fixture.log"
while :; do sleep 1; done
EOF
chmod +x "$PROJ/seats/commander-inbox-poll.sh"

run_cockpit() {
  WHEELHOUSE_TMUX_SOCKET="$SOCK" WHEELHOUSE_COCKPIT_COMMANDER_PERCENT=55 "$PROJ/seats/cockpit.sh" ratio > "$FIX/cockpit.out" 2>&1
}
run_cockpit_no_mouse() {
  WHEELHOUSE_TMUX_SOCKET="$SOCK" WHEELHOUSE_COCKPIT_COMMANDER_PERCENT=55 WHEELHOUSE_COCKPIT_MOUSE=0 "$PROJ/seats/cockpit.sh" nomouse > "$FIX/cockpit-nomouse.out" 2>&1
}

pane_width() { tmux -L "$SOCK" display-message -p -t "wh-ratio:bridge.$1" '#{pane_width}'; }
window_width() { tmux -L "$SOCK" display-message -p -t 'wh-ratio:bridge' '#{window_width}'; }
pane_count() { tmux -L "$SOCK" list-panes -t 'wh-ratio:bridge' 2>/dev/null | wc -l | tr -d ' '; }
opt_value() { tmux -L "$SOCK" show-options -v -t "$1" "$2"; }

attach_at_152() {
  # Drive a real tmux client of a known size instead of relying on the tool
  # shell's pseudo-terminal timing. The inner cockpit session still sees a
  # client attach; the outer fixture session pins that client's TTY to 152x40.
  local client_sock="${SOCK}-client"
  tmux -L "$client_sock" kill-server >/dev/null 2>&1 || true
  tmux -L "$client_sock" new-session -d -x 152 -y 40 -s wh-client -c "$PROJ" "tmux -L '$SOCK' attach-session -t wh-ratio" > "$FIX/client.out" 2> "$FIX/client.err" || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ "$(pane_count)" = 2 ] && [ "$(window_width)" = 152 ] && break
    sleep 0.1
  done
  tmux -L "$client_sock" kill-server >/dev/null 2>&1 || true
  sleep 0.1
}

PATH="/usr/bin:/bin:$(dirname "$(command -v bun)")" "$PROJ/seats/cockpit.sh" --herald > "$FIX/herald-only.out" 2>&1
HERALD_ONLY_RC=$?
HERALD_ONLY_PID="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"
if [ $HERALD_ONLY_RC -eq 0 ] && [ -n "$HERALD_ONLY_PID" ] && kill -0 "$HERALD_ONLY_PID" 2>/dev/null && grep -q 'herald started' "$FIX/herald-only.out" && ! grep -q 'bridge built\|session .* is up' "$FIX/herald-only.out"; then
  pass "cockpit --herald starts only the herald without building or attaching tmux"
else
  fail "cockpit --herald did not run standalone (rc=$HERALD_ONLY_RC pid=${HERALD_ONLY_PID:-none} out=$(cat "$FIX/herald-only.out" 2>/dev/null))"
fi
kill "$HERALD_ONLY_PID" 2>/dev/null || true
rm -f "$PROJ/seats/run/herald.pid"

WHEELHOUSE_TMUX_SOCKET="$SOCK" tmux -L "$SOCK" new-session -d -s wh-pane -n bridge -c "$PROJ" "$PROJ/seats/cockpit.sh --pane-commander"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  POLL_PID="$(cat "$PROJ/seats/run/commander-inbox-poll.pid" 2>/dev/null || true)"
  [ -n "$POLL_PID" ] && kill -0 "$POLL_PID" 2>/dev/null && grep -q "poll-root=$PROJ" "$PROJ/seats/logs/poll.fixture.log" 2>/dev/null && break
  sleep 0.1
done
POLL_PID="$(cat "$PROJ/seats/run/commander-inbox-poll.pid" 2>/dev/null || true)"
if [ -n "$POLL_PID" ] && kill -0 "$POLL_PID" 2>/dev/null && grep -q "poll-root=$PROJ" "$PROJ/seats/logs/poll.fixture.log" 2>/dev/null; then
  pass "cockpit --pane-commander starts commander-inbox-poll.sh bound to the pane"
else
  fail "cockpit --pane-commander did not start poll (pid=${POLL_PID:-none} log=$(cat "$PROJ/seats/logs/poll.fixture.log" 2>/dev/null || echo none))"
fi
tmux -L "$SOCK" kill-session -t wh-pane >/dev/null 2>&1 || true
kill "$POLL_PID" 2>/dev/null || true
rm -f "$PROJ/seats/run/commander-inbox-poll.pid"

( cd "$PROJ" && timeout 5 bash -c 'bash seats/cockpit.sh --herald piped | cat' ) > "$FIX/herald-piped.out" 2>&1
PIPED_RC=$?
PIPED_PID="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"
PIPED_LINES="$(wc -l < "$FIX/herald-piped.out" | tr -d ' ')"
if [ $PIPED_RC -eq 0 ] && [ -n "$PIPED_PID" ] && kill -0 "$PIPED_PID" 2>/dev/null && [ "$PIPED_LINES" = 1 ] && grep -Eq '^herald started: pid [0-9]+$' "$FIX/herald-piped.out"; then
  pass "cockpit --herald exits under a stdout pipe and leaves a live herald pid"
else
  fail "cockpit --herald pipe run failed (rc=$PIPED_RC pid=${PIPED_PID:-none} lines=$PIPED_LINES out=$(cat "$FIX/herald-piped.out" 2>/dev/null))"
fi
kill "$PIPED_PID" 2>/dev/null || true
rm -f "$PROJ/seats/run/herald.pid"

PLANTED_BIN="$FIX/planted-bin"
mkdir -p "$PLANTED_BIN"
cat > "$PLANTED_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-L" ]; then shift 2; fi
case "${1:-}" in
  has-session) exit 1 ;;
  new-session|set-option|select-pane) exit 0 ;;
  split-window) echo 'fixture split-window failed' >&2; exit 1 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$PLANTED_BIN/tmux"
PATH="$PLANTED_BIN:$(dirname "$(command -v bun)"):/usr/bin:/bin" "$PROJ/seats/cockpit.sh" planted > "$FIX/planted-floor-fail.out" 2>&1
PLANTED_RC=$?
if [ $PLANTED_RC -ne 0 ] && grep -q 'STOP: could not create bridge floor pane in wh-planted:bridge' "$FIX/planted-floor-fail.out" && grep -q 'fixture split-window failed' "$FIX/planted-floor-fail.out"; then
  pass "planted floor-pane split failure STOPs loudly"
else
  fail "planted floor-pane split failure did not STOP loudly (rc=$PLANTED_RC out=$(cat "$FIX/planted-floor-fail.out" 2>/dev/null))"
fi

run_cockpit
if grep -q 'bridge built: session wh-ratio' "$FIX/cockpit.out" && [ "$(pane_count)" = 2 ]; then
  pass "cockpit builds one bridge window with two panes on a private tmux socket"
else
  fail "cockpit did not build the bridge: $(cat "$FIX/cockpit.out" 2>/dev/null) panes=$(pane_count)"
fi
if [ "$(opt_value wh-ratio mouse)" = "on" ] && [ "$(opt_value wh-ratio history-limit)" = "50000" ]; then
  pass "fresh cockpit session enables mouse and sets history-limit 50000"
else
  fail "fresh cockpit options wrong: mouse=$(opt_value wh-ratio mouse) history=$(opt_value wh-ratio history-limit)"
fi

if attach_at_152; then
  CW="$(pane_width 0 2>/dev/null || echo missing)"; FW="$(pane_width 1 2>/dev/null || echo missing)"; WW="$(window_width 2>/dev/null || echo missing)"; PC="$(pane_count)"
  if [ "$PC" = 2 ] && [ "$WW" = 152 ] && [ "$CW" -ge 75 ] && [ "$CW" -le 90 ] && [ "$FW" -ge 60 ] && [ "$FW" -le 75 ] && [ "$CW" -gt "$FW" ]; then
    pass "known-size attached tmux client creates a split bridge and keeps commander pane near its ratio (window=$WW commander=$CW floor=$FW)"
  else
    fail "known-size attached tmux client did not produce the expected split ratio (panes=$PC window=$WW commander=$CW floor=$FW client_err=$(cat "$FIX/client.err" 2>/dev/null))"
  fi
else
  fail "could not create known-size attached tmux client: $(cat "$FIX/client.err" 2>/dev/null)"
fi

# c8m regression guard: re-running cockpit after the floor pane dies rebuilds
# the pane rather than creating a duplicate session or leaving one pane.
tmux -L "$SOCK" kill-pane -t 'wh-ratio:bridge.1'
if [ "$(pane_count)" = 1 ]; then pass "fixture floor pane killed for respawn check"
else fail "could not reduce bridge to one pane before respawn check"; fi
run_cockpit
if grep -q 'bridge floor pane missing in wh-ratio:bridge; respawning it' "$FIX/cockpit.out" && [ "$(pane_count)" = 2 ]; then
  pass "re-running cockpit respawns a missing floor pane"
else
  fail "cockpit did not respawn missing floor pane: $(cat "$FIX/cockpit.out" 2>/dev/null) panes=$(pane_count)"
fi
if [ "$(opt_value wh-ratio mouse)" = "on" ] && [ "$(opt_value wh-ratio history-limit)" = "50000" ]; then
  pass "cockpit re-run leaves mouse/history options idempotently set"
else
  fail "re-run cockpit options wrong: mouse=$(opt_value wh-ratio mouse) history=$(opt_value wh-ratio history-limit)"
fi

run_cockpit_no_mouse
if grep -q 'bridge built: session wh-nomouse' "$FIX/cockpit-nomouse.out" && [ "$(opt_value wh-nomouse mouse)" = "off" ] && [ "$(opt_value wh-nomouse history-limit)" = "50000" ]; then
  pass "WHEELHOUSE_COCKPIT_MOUSE=0 leaves mouse off while preserving history-limit"
else
  fail "mouse opt-out options wrong: out=$(cat "$FIX/cockpit-nomouse.out" 2>/dev/null) mouse=$(opt_value wh-nomouse mouse 2>/dev/null || true) history=$(opt_value wh-nomouse history-limit 2>/dev/null || true)"
fi

if [ $FAIL -eq 0 ]; then
  echo "cockpit.selftest: PASS ($PASS checks)"
  exit 0
fi

echo "cockpit.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
