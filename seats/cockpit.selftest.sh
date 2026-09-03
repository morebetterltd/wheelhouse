#!/usr/bin/env bash
# cockpit.selftest.sh — hermetic checks for cockpit tmux sizing and respawn.
# Uses a private tmux socket and a temp project; never touches live sessions.

set -u

command -v tmux >/dev/null 2>&1 || { echo "selftest: tmux is required" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v script >/dev/null 2>&1 || { echo "selftest: script is required" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd -P)"
COCKPIT="$HERE/cockpit.sh"
[ -x "$COCKPIT" ] || { echo "selftest: not executable: $COCKPIT" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-cockpit-selftest.XXXXXX")"
SOCK="wheelhouse-cockpit-selftest.$$"
PASS=0
FAIL=0
cleanup() {
  tmux -L "$SOCK" kill-server >/dev/null 2>&1 || true
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

run_cockpit() {
  WHEELHOUSE_TMUX_SOCKET="$SOCK" WHEELHOUSE_COCKPIT_COMMANDER_PERCENT=55 "$PROJ/seats/cockpit.sh" ratio > "$FIX/cockpit.out" 2>&1
}

pane_width() { tmux -L "$SOCK" display-message -p -t "wh-ratio:bridge.$1" '#{pane_width}'; }
window_width() { tmux -L "$SOCK" display-message -p -t 'wh-ratio:bridge' '#{window_width}'; }
pane_count() { tmux -L "$SOCK" list-panes -t 'wh-ratio:bridge' 2>/dev/null | wc -l | tr -d ' '; }

attach_at_152() {
  # Attach through a pseudo-terminal whose size is explicitly wider than tmux's
  # detached default; the client-attached hook should then resize pane 0.
  ( sleep 0.5; tmux -L "$SOCK" detach-client -s wh-ratio >/dev/null 2>&1 || true ) &
  script -q /dev/null sh -c "stty cols 152 rows 40; tmux -L '$SOCK' attach-session -t wh-ratio" > "$FIX/script.out" 2> "$FIX/script.err" || true
  sleep 0.2
}

run_cockpit
if grep -q 'bridge built: session wh-ratio' "$FIX/cockpit.out" && [ "$(pane_count)" = 2 ]; then
  pass "cockpit builds one bridge window with two panes on a private tmux socket"
else
  fail "cockpit did not build the bridge: $(cat "$FIX/cockpit.out" 2>/dev/null) panes=$(pane_count)"
fi

attach_at_152
CW="$(pane_width 0)"; FW="$(pane_width 1)"; WW="$(window_width)"
if [ "$WW" -gt 80 ] && [ "$CW" -ge 75 ] && [ "$CW" -le 90 ] && [ "$CW" -gt "$FW" ]; then
  pass "client-attached resize keeps commander pane near its ratio on a ${WW}-column attach (commander=$CW floor=$FW)"
else
  fail "commander pane did not hold ratio after attach (window=$WW commander=$CW floor=$FW)"
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

if [ $FAIL -eq 0 ]; then
  echo "cockpit.selftest: PASS ($PASS checks)"
  exit 0
fi

echo "cockpit.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2
exit 1
