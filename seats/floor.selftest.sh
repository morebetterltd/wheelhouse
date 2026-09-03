#!/usr/bin/env bash
#
# floor.selftest.sh — does floor.ts still render what seats/README.md's
# "The bridge" section claims, on THIS machine?
#
# Hermetic: every phase runs against a synthetic fixture — a fake project
# with hand-written seats.json, state.json, and event logs, plus a stub `bd`
# on a private PATH — rendered through floor.ts --once (one frame to stdout,
# no terminal needed). Your real seats, logs, and tmux are never touched.
#
# The canary phase sabotages COPIES of floor.ts — once with the PROCESS GONE
# detection cut out, once with the missing-log named line cut out — and
# checks these tests notice. Each sabotage is guarded with cmp: if the sed
# no longer bites, the canary says so instead of proving nothing.
#
# The tmux leg is SKIPped when tmux is absent; when present it builds the
# bridge on a PRIVATE tmux socket (WHEELHOUSE_TMUX_SOCKET) and proves
# cockpit.sh is idempotent, then kills that server.
#
# Usage: floor.selftest.sh [path-to-floor.ts]
#
# Exit 0 = the floor works here. Non-zero = read the FAIL lines: a canary
# failure means these checks cannot be trusted to tell you either way.

set -uo pipefail   # deliberately not -e: sabotaged runs are meant to differ

HERE="$(cd "$(dirname "$0")" && pwd -P)"
FLOOR="${1:-$HERE/floor.ts}"
COCKPIT="$HERE/cockpit.sh"
[ -f "$FLOOR" ] || { echo "selftest: not found: $FLOOR" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required to run floor.ts" >&2; exit 2; }

SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
# Selftest output is commonly redirected into committed evidence; scrub it as
# it is written so temp dirs, home dirs, and usernames never enter captures.
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
FIX=""
SOCK=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  if [ -n "$SOCK" ]; then tmux -L "$SOCK" kill-server 2>/dev/null; fi
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- fixture -----------------------------------------------------------------
FIX="$(mktemp -d)"
FIX="$(cd "$FIX" && pwd -P)"   # macOS: /var/... is really /private/var/...
PROJ="$FIX/proj"
mkdir -p "$PROJ/seats/logs" "$FIX/bin"
cp "$FLOOR" "$PROJ/seats/floor.ts"
[ -f "$COCKPIT" ] && cp "$COCKPIT" "$PROJ/seats/cockpit.sh" && chmod +x "$PROJ/seats/cockpit.sh"

# Stub bd: two ready beads, so idle-with-ready-work has work to point at.
cat > "$FIX/bin/bd" <<'EOF'
#!/bin/sh
[ "$1" = "ready" ] || exit 1
echo "wh-001  P2  ready  first waiting bead"
echo "wh-002  P2  ready  second waiting bead"
EOF
chmod +x "$FIX/bin/bd"

LOGS="$PROJ/seats/logs"
ME=$$   # a pid that is definitely alive while this test runs
GONE=3999999   # far above macOS/Linux pid ranges: definitely not alive

NOW_MS=1893456000000 # 2030-01-01T00:00:00Z, fixed so ages are deterministic
RECENT_ISO="2029-12-31T23:59:48Z"
OLD_ISO="2029-12-31T23:49:00Z"

# Seat "busy": a full humanizable turn, currently mid-turn on a tool.
cat > "$LOGS/busy.jsonl" <<EOF
{"type":"agent_start","timestamp":"$RECENT_ISO"}
{"type":"thinking","text":"pondering the diff","timestamp":"$RECENT_ISO"}
{"type":"tool_execution_start","toolName":"bash","args":{"cmd":"git status"},"timestamp":"$RECENT_ISO"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]},"timestamp":"$RECENT_ISO"}
{"type":"agent_end","messages":[1,2,3],"timestamp":"$RECENT_ISO"}
{"type":"agent_start","timestamp":"$RECENT_ISO"}
{"type":"tool_execution_start","toolName":"read","args":{"path":"README.md"},"timestamp":"$RECENT_ISO"}
EOF

# Seat "quiet": alive and mid-turn, but the newest event is older than the
# default 10m threshold, so it must be visually flagged.
cat > "$LOGS/quiet.jsonl" <<EOF
{"type":"agent_start","timestamp":"$OLD_ISO"}
{"type":"tool_execution_start","toolName":"bash","args":{"cmd":"long bench"},"timestamp":"$OLD_ISO"}
EOF

# Seat "idle": turn finished, nothing in flight — with ready work waiting.
cat > "$LOGS/idle.jsonl" <<EOF
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}
{"type":"agent_end","messages":[1]}
EOF

# Seat "gone": state says a pid, the pid is dead, nobody stopped it.
cat > "$LOGS/gone.jsonl" <<EOF
{"type":"agent_start"}
EOF

# Seat "authless": the process answers, but its identity is dead.
cat > "$LOGS/authless.jsonl" <<EOF
{"type":"agent_start"}
{"type":"response","command":"prompt","success":false,"error":"401 Unauthorized: token expired - login required"}
EOF

# Seat "quota": alive, but cannot take work.
cat > "$LOGS/quota.jsonl" <<EOF
{"type":"agent_start"}
{"type":"response","command":"prompt","success":false,"error":"usage limit reached: quota exhausted until reset"}
EOF

# Seat "reviewer": a verdict landed.
cat > "$LOGS/reviewer.jsonl" <<EOF
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"VERDICT: APPROVE - evidence attached"}]}}
{"type":"agent_end","messages":[1]}
EOF

# Seat "bounced": review blocked on a BOUNCE.
cat > "$LOGS/bounced.jsonl" <<EOF
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"VERDICT: BOUNCE - two defects listed"}]}}
{"type":"agent_end","messages":[1]}
EOF

# Seat "nolog": in the roster and state, but no event log exists at all.

cat > "$PROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "busy":     { "role": "worker",   "provider": "openai-codex", "model": "gpt-5.5", "account": { "dir": "$FIX/acct/busy", "label": "busy@example" } },
    "quiet":    { "role": "worker",   "provider": "openai-codex", "model": "gpt-5.5", "account": { "dir": "$FIX/acct/quiet", "label": "quiet@example" } },
    "idle":     { "role": "worker",   "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/idle" } },
    "gone":     { "role": "worker",   "provider": "openai-codex", "model": "gpt-5.4", "account": { "dir": "$FIX/acct/gone" } },
    "authless": { "role": "worker",   "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/authless" } },
    "quota":    { "role": "worker",   "provider": "openai-codex", "model": "gpt-5.5", "account": { "dir": "$FIX/acct/quota" } },
    "reviewer": { "role": "reviewer", "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/reviewer", "label": "review-account" } },
    "bounced":  { "role": "reviewer", "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/bounced" } },
    "nolog":    { "role": "worker",   "provider": "openai-codex", "model": "gpt-5.5", "account": { "dir": "$FIX/acct/nolog" } },
    "verifier": { "role": "verifier", "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/verifier", "label": "verify-account" } }
  }
}
EOF

seat_rec() { # name pid extra-json
  printf '"%s":{"pid":%s,"startedAt":"2026-08-29T00:00:00Z","accountDir":"%s","role":"worker","roleBrief":"x","fifo":"%s","log":"%s","sessionId":"s-%s","sessionFile":null%s}' \
    "$1" "$2" "$FIX/acct/$1" "$PROJ/seats/run/$1.stdin" "$LOGS/$1.jsonl" "$1" "${3:-}"
}
{
  printf '{"seats":{'
  seat_rec busy     "$ME"   ',"lastBead":"wh-busy-1"'
  printf ','
  seat_rec quiet    "$ME"   ',"lastBead":"wh-quiet-1"'
  printf ','
  seat_rec idle     "$ME"
  printf ','
  seat_rec gone     "$GONE"
  printf ','
  seat_rec authless "$ME"
  printf ','
  seat_rec quota    "$ME"
  printf ','
  seat_rec reviewer "$ME"   ',"lastBead":"wh-rev-9"'
  printf ','
  seat_rec bounced  "$ME"   ',"lastBead":"wh-rev-8"'
  printf ','
  seat_rec nolog    "$ME"
  printf '}}\n'
} > "$PROJ/seats/state.json"

RUN_PATH="$FIX/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin"
render() { # floor-file args...
  local f="$1"; shift
  OUT="$(env PATH="$RUN_PATH" COLUMNS=180 LINES=70 NO_COLOR=1 FLOOR_NOW_MS="$NOW_MS" bun "$f" --once "$@" 2>&1)"
  RC=$?
}
has() { printf '%s\n' "$OUT" | grep -q "$1"; }

# --- phase 1: pinned seat's events render, humanized -------------------------
phase "phase 1: spotlight renders the pinned seat's events"
render "$PROJ/seats/floor.ts" --pin 1
[ $RC -eq 0 ] && pass "--once --pin 1 exits 0" || fail "--once exited ${RC}: $OUT"
has "SPOTLIGHT"            && pass "spotlight header present"        || fail "no SPOTLIGHT header"
has "busy"                 && pass "pin 1 is seat busy"              || fail "busy not in frame"
has '\[tool\] bash'        && pass "[tool] line humanized"           || fail "no [tool] bash line"
has '\[think\]'            && pass "[think] line humanized"          || fail "no [think] line"
has '\[turn_end\].*3 message' && pass "[turn_end] carries stats"     || fail "no [turn_end] with stats"
render "$PROJ/seats/floor.ts" --pin busy
[ $RC -eq 0 ] && has '\[tool\] bash' && pass "--pin by seat name works" || fail "--pin busy failed: $OUT"

# --- phase 2: the rail shows every seat with the right cue -------------------
phase "phase 2: rail — all seats, distinct failure lines, never silence"
render "$PROJ/seats/floor.ts" --pin 1
for s in busy quiet idle gone authless quota reviewer bounced nolog verifier; do
  has "$s" && pass "rail lists $s" || fail "rail is missing seat $s"
done
has 'busy.*worker.*openai-codex/gpt-5.5.*busy@example.*wh-busy-1.*12s ago' \
  && pass "row shape includes role, provider/model, account label, active bead, and humanized age" \
  || fail "busy row is missing one-glance columns: $(printf '%s\n' "$OUT" | grep busy | head -1)"
has 'idle.*anthropic/claude-fable-5.*| - |' \
  && pass "missing account.label renders as dash" \
  || fail "idle row did not render a dash for absent account.label: $(printf '%s\n' "$OUT" | grep idle | head -1)"
has 'quiet.*QUIET.*wh-quiet-1.*11m ago' \
  && pass "old running seat is flagged QUIET with humanized age" \
  || fail "quiet row missing QUIET/11m age: $(printf '%s\n' "$OUT" | grep quiet | head -1)"
has 'verifier.*verifier.*anthropic/claude-fable-5.*verify-account.*| .*off.* - | - | -' \
  && pass "rostered verifier absent from state renders as a seat row with state dash" \
  || fail "absent verifier row wrong: $(printf '%s\n' "$OUT" | grep verifier | head -1)"
has "PROCESS GONE"        && pass "gone: PROCESS GONE line (red)"     || fail "no PROCESS GONE line"
has "AUTH DEAD"           && pass "authless: AUTH DEAD line (red)"    || fail "no AUTH DEAD line"
has "PARKED/QUOTA"        && has "bun seats/adapter.ts probe quota" && pass "quota: PARKED/QUOTA line names the re-probe command" || fail "no PARKED/QUOTA line with re-probe command"
has "IDLE with ready work.*2 bead" && pass "idle: IDLE-with-ready-work counts bd ready" || fail "no idle-with-ready-work line"
has "VERDICT LANDED — APPROVE" && pass "reviewer: VERDICT LANDED (green)" || fail "no VERDICT LANDED line"
has "REVIEW BLOCKED.*BOUNCE"   && pass "bounced: REVIEW BLOCKED line"     || fail "no REVIEW BLOCKED line"
has "no event log yet"    && pass "nolog: missing log is a named line"    || fail "missing log line absent"
has " RED"   && has " AMBER" && has " GREEN" \
  && pass "cue words RED/AMBER/GREEN all present" || fail "cue words missing"
has '\[0\] STATUS' && pass "rail has the [0] STATUS cell" || fail "no [0] STATUS row"
if printf '%s\n' "$OUT" | grep -Eq '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T'; then
  fail "rail exposed raw epoch or ISO timestamps: $(printf '%s\n' "$OUT" | grep -E '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T' | head -1)"
else
  pass "rail exposes humanized ages, not raw epoch/ISO timestamps"
fi

# --- phase 3: 0 pins STATUS; overview renders --------------------------------
phase "phase 3: STATUS cell and overview grid"
render "$PROJ/seats/floor.ts" --pin 0
[ $RC -eq 0 ] && has "STATUS" && pass "--pin 0 renders STATUS"  || fail "pin 0 did not render STATUS: $OUT"
has "bd ready: 2"   && pass "STATUS shows bd ready count"       || fail "no bd ready count in STATUS"
has "last bead wh-rev-9" && pass "STATUS shows per-seat detail" || fail "no per-seat detail in STATUS"
has "last activity 12s ago" && pass "STATUS uses humanized last-activity age" || fail "STATUS did not show humanized last activity"
if printf '%s\n' "$OUT" | grep -Eq '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T'; then
  fail "STATUS exposed raw epoch or ISO timestamps: $(printf '%s\n' "$OUT" | grep -E '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T' | head -1)"
else
  pass "STATUS exposes humanized ages, not raw epoch/ISO timestamps"
fi
render "$PROJ/seats/floor.ts" --overview
[ $RC -eq 0 ] && has "OVERVIEW" && pass "--overview renders the grid" || fail "overview failed: $OUT"
has '\[tool\] read' && pass "overview shows recent events per seat"   || fail "overview missing events"

# --- phase 4: degradation, not crashes ---------------------------------------
phase "phase 4: missing pieces degrade with named lines"
render "$PROJ/seats/floor.ts" --pin nolog   # nolog seat in the spotlight
[ $RC -eq 0 ] && pass "spotlight on log-less seat exits 0" || fail "crashed on missing log: $OUT"
has "no event log yet for nolog" && pass "spotlight names the missing log" || fail "no named missing-log line"
EMPTY="$FIX/empty"; mkdir -p "$EMPTY/seats"; cp "$FLOOR" "$EMPTY/seats/floor.ts"
render "$EMPTY/seats/floor.ts"
[ $RC -eq 0 ] && has "no seats" && pass "no roster/state degrades to a named line" || fail "empty project: rc=${RC}: $OUT"

# --- phase 5: interactive repaint is in-place, not append-only ---------------
phase "phase 5: repaint — repeated frames return home and clear to end"
CAPTURE_FILE="$FIX/repaint.capture"
env PATH="$RUN_PATH" COLUMNS=180 LINES=24 NO_COLOR=1 FLOOR_NOW_MS="$NOW_MS" bun "$PROJ/seats/floor.ts" > "$CAPTURE_FILE" 2>&1 &
FLOOR_PID=$!
sleep 2
kill "$FLOOR_PID" 2>/dev/null
wait "$FLOOR_PID" 2>/dev/null
CAPTURE="$(cat "$CAPTURE_FILE")"
if [ -s "$CAPTURE_FILE" ]; then pass "multi-frame capture produced output before the scripted stop"
else fail "multi-frame capture produced no output"; fi
HOME_CLEAR_COUNT="$(printf '%s' "$CAPTURE" | python3 -c 'import sys; s=sys.stdin.read(); print(s.count("\x1b[H\x1b[J"))')"
if [ "$HOME_CLEAR_COUNT" -ge 2 ]; then pass "multi-frame capture contains repeated cursor-home + clear-to-end repaint sequences"
else fail "multi-frame capture did not show repeated in-place repaint sequences (count=$HOME_CLEAR_COUNT)"; fi
if printf '%s' "$CAPTURE" | python3 -c 'import sys; frames=[f for f in sys.stdin.read().split("\x1b[H\x1b[J") if f]; raise SystemExit(0 if frames and max(x.count("\n") for x in frames) <= 24 else 1)'; then
  pass "multi-frame capture stays within the terminal height per frame — no scroll drift"
else
  fail "multi-frame capture grew past the terminal height, indicating scroll drift"
fi

# --- phase 6: interactive q returns to overview, not process exit ------------
phase "phase 6: interactive keys — q keeps the pane alive by returning to overview"
if ! command -v expect >/dev/null 2>&1; then
  skip "expect not on PATH — q key pty leg not run"
else
  QCAP="$FIX/q.expect"
  env PATH="$RUN_PATH" COLUMNS=180 LINES=24 NO_COLOR=1 FLOOR_NOW_MS="$NOW_MS" expect > "$QCAP" 2>&1 <<EOF
set timeout 5
spawn bun "$PROJ/seats/floor.ts"
expect "RAIL"
send "q"
expect "OVERVIEW"
send "\003"
expect eof
EOF
  QRC=$?
  if [ $QRC -eq 0 ]; then pass "q changes the live floor to OVERVIEW before Ctrl-C exits"
  else fail "q did not reach OVERVIEW in the live floor: $(cat "$QCAP")"; fi
fi

# --- phase 7: canaries (guarded with cmp) ------------------------------------
phase "phase 7: canaries — sabotage a copy, checks must notice"
SAB1="$PROJ/seats/floor-sab1.ts"
sed '/PROCESS GONE/d' "$PROJ/seats/floor.ts" > "$SAB1"
if cmp -s "$PROJ/seats/floor.ts" "$SAB1"; then
  fail "canary 1: sed no longer bites (no PROCESS GONE lines to cut) — fix this test"
else
  render "$SAB1" --pin 1
  if has "PROCESS GONE"; then fail "canary 1: PROCESS GONE survived its removal — these checks prove nothing"
  else pass "canary 1: cutting PROCESS GONE detection is caught by phase 2's check"; fi
fi
SAB2="$PROJ/seats/floor-sab2.ts"
sed '/no event log yet/d' "$PROJ/seats/floor.ts" > "$SAB2"
if cmp -s "$PROJ/seats/floor.ts" "$SAB2"; then
  fail "canary 2: sed no longer bites (no missing-log lines to cut) — fix this test"
else
  render "$SAB2" --pin 8
  if has "no event log yet"; then fail "canary 2: missing-log line survived its removal — these checks prove nothing"
  else pass "canary 2: cutting the missing-log line is caught by phase 4's check"; fi
fi

# --- phase 8: tmux leg — cockpit.sh idempotency on a private socket ----------
phase "phase 8: cockpit.sh (tmux leg)"
if ! command -v tmux >/dev/null 2>&1; then
  skip "tmux not on PATH — cockpit leg not run (floor checks above still decide)"
elif [ ! -f "$PROJ/seats/cockpit.sh" ]; then
  skip "cockpit.sh not found beside floor.ts — leg not run"
else
  SOCK="whfloor$$"
  crun() { OUT="$(env PATH="${RUN_PATH}:$(dirname "$(command -v tmux)")" WHEELHOUSE_TMUX_SOCKET="$SOCK" TMUX= "$PROJ/seats/cockpit.sh" tfix < /dev/null 2>&1)"; RC=$?; }
  crun
  [ $RC -eq 0 ] && has "bridge built" && pass "first run builds the bridge" || fail "first run: rc=${RC}: $OUT"
  if tmux -L "$SOCK" has-session -t "=wh-tfix" 2>/dev/null; then pass "session wh-tfix exists"
  else fail "session wh-tfix missing"; fi
  WN="$(tmux -L "$SOCK" list-windows -t wh-tfix -F '#{window_name}' 2>/dev/null)"
  [ "$WN" = "bridge" ] && pass "single window named bridge" || fail "windows: $WN"
  PANES="$(tmux -L "$SOCK" list-panes -t wh-tfix:bridge 2>/dev/null | wc -l | tr -d ' ')"
  [ "$PANES" = "2" ] && pass "bridge has exactly 2 panes (commander + floor)" || fail "pane count: $PANES"
  crun
  [ $RC -eq 0 ] && has "already built" && pass "re-run attaches, never duplicates" || fail "re-run: rc=${RC}: $OUT"
  SESSN="$(tmux -L "$SOCK" list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  [ "$SESSN" = "1" ] && pass "still exactly 1 session after re-run" || fail "session count after re-run: $SESSN"
  tmux -L "$SOCK" kill-pane -t wh-tfix:bridge.1 2>/dev/null
  PANES="$(tmux -L "$SOCK" list-panes -t wh-tfix:bridge 2>/dev/null | wc -l | tr -d ' ')"
  [ "$PANES" = "1" ] && pass "simulated dead floor leaves only the commander pane" || fail "pane count after killing floor: $PANES"
  crun
  [ $RC -eq 0 ] && has "floor pane missing" && pass "re-run notices the missing floor pane" || fail "missing-floor re-run did not say it repaired the pane: rc=${RC}: $OUT"
  PANES="$(tmux -L "$SOCK" list-panes -t wh-tfix:bridge 2>/dev/null | wc -l | tr -d ' ')"
  [ "$PANES" = "2" ] && pass "re-run respawns the floor pane after pane death" || fail "pane count after missing-floor repair: $PANES"
  SESSN="$(tmux -L "$SOCK" list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  [ "$SESSN" = "1" ] && pass "still exactly 1 session after pane repair" || fail "session count after pane repair: $SESSN"
  tmux -L "$SOCK" kill-server 2>/dev/null
  SOCK=""
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "floor.ts works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If a failure is in phases 1-6 or 8, the floor or cockpit broke (or their"
echo "wording moved). If a failure is in phase 7, fix this test first."
exit 1
