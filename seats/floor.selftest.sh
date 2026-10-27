#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
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
DAEMONS="$HERE/daemons.sh"
SUPERVISOR="$HERE/supervisor.sh"
BRIDGE_GUARD="$HERE/bridge-guard.sh"
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
FLOOR_SOCKET_CLAIMED=0
FLOOR_SOCKET_PATH=""
FLOOR_SOCKET_ID=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

floor_pin_socket() {
  [ -z "$FLOOR_SOCKET_ID" ] || return 0
  local actual pane_root
  # A catchable signal may arrive while the first cockpit command returns.
  # Pin the immutable creation path, with a fully qualified native pane target.
  pane_root="$(tmux -L "$SOCK" display-message -p -t '=wh-tfix:bridge.0' '#{pane_start_path}')" || return 2
  [ "$pane_root" = "$PROJ" ] || { echo 'STOP: floor socket pane is not this fixture' >&2; return 2; }
  actual="$(tmux -L "$SOCK" display-message -p '#{socket_path}')" || return 2
  case "${actual##*/}" in "$SOCK"|"$SOCK.sock") ;; *) echo 'STOP: unexpected floor socket address' >&2; return 2 ;; esac
  FLOOR_SOCKET_ID="$(bun "$HERE/selftest-floor-socket.ts" pin "$actual")" || return 2
  FLOOR_SOCKET_PATH="$actual"
}
cleanup() {
  local cleanup_rc=0 socket_stopped=0
  if [ "$FLOOR_SOCKET_CLAIMED" = 1 ]; then
    floor_pin_socket || cleanup_rc=2
    if [ -n "$FLOOR_SOCKET_ID" ] && bun "$HERE/selftest-floor-socket.ts" check "$FLOOR_SOCKET_PATH" "$FLOOR_SOCKET_ID"; then
      if tmux -S "$FLOOR_SOCKET_PATH" kill-server > "$FIX/floor-stop.stdout" 2> "$FIX/floor-stop.stderr"; then
        socket_stopped=1
      else
        cat "$FIX/floor-stop.stderr" >&2
        cleanup_rc=2
      fi
    else
      cleanup_rc=2
    fi
  fi
  # Never hand an unclaimed/replaced address to shared socket-based cleanup.
  selftest_cleanup_fixture_processes "${FIX:-}" || cleanup_rc=1
  if [ "$socket_stopped" = 1 ]; then
    bun "$HERE/selftest-floor-socket.ts" unlink "$FLOOR_SOCKET_PATH" "$FLOOR_SOCKET_ID" || cleanup_rc=2
  fi
  [ -z "$FIX" ] || selftest_remove_fixture_dir "$FIX" || cleanup_rc=1
  return "$cleanup_rc"
}
selftest_install_cleanup_traps cleanup

# Keep the complete runtime, then select the caller's floor for every fixture.
# Render, repaint, PTY, derived copies and cockpit all use this installed file.
install_floor_runtime() {
  selftest_copy_seat_runtime "$1" "$HERE" || return 2
  cp -f -- "$FLOOR" "$1/seats/floor.ts" || return 2
}

# --- fixture -----------------------------------------------------------------
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-floor-selftest.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"   # macOS: /var/... is really /private/var/...
PROJ="$FIX/proj"
mkdir -p "$PROJ/seats/logs" "$FIX/bin"
install_floor_runtime "$PROJ" || exit 2

# Stub bd: two ready beads, so idle-with-ready-work has work to point at.
cat > "$FIX/bin/bd" <<'EOF'
#!/bin/sh
[ "$1" = "ready" ] || exit 1
case " $* " in *" --json "*) printf '[{"id":"wh-001","title":"first waiting bead","status":"open"},{"id":"wh-002","title":"second waiting bead","status":"open"}]\n'; exit 0 ;; esac
echo "wh-001  P2  ready  first waiting bead"
echo "wh-002  P2  ready  second waiting bead"
EOF
chmod +x "$FIX/bin/bd"

LOGS="$PROJ/seats/logs"
VDIR="$PROJ/seats/verdicts"
mkdir -p "$VDIR"
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
{"type":"tool_execution_update","output":"short prefix\n[wheelhouse log truncated 12345 bytes; full output remains in the pi session file]","wheelhouse_truncated_bytes":12345,"timestamp":"$RECENT_ISO"}
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
EOF
printf 'HTTP 401 Unauthorized: token expired - login required\n' > "$LOGS/authless.stderr.log"

# Seat "quota": alive, but cannot take work.
cat > "$LOGS/quota.jsonl" <<EOF
{"type":"agent_start"}
{"type":"response","command":"prompt","success":false,"error":"usage limit reached: quota exhausted until reset"}
EOF

# Seat "reviewer": a verdict landed.
cat > "$LOGS/reviewer.jsonl" <<EOF
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"SCOPE: OK — scripted frame fixture\nINTEGRITY: OK — scripted frame fixture\nSAFETY: OK — private fixture\nHEALTH: OK — frame protocol checked\nVERDICT: APPROVE - evidence attached\nPUSH: NOT CONSIDERED"}]}}
{"type":"agent_end","messages":[1]}
EOF

# Seat "bounced": review blocked on a BOUNCE.
cat > "$LOGS/bounced.jsonl" <<EOF
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"SCOPE: OK — scripted frame fixture\nINTEGRITY: DEFECT — scripted blocked-review fixture\nSAFETY: OK — private fixture\nHEALTH: OK — frame protocol checked\nVERDICT: BOUNCE - two defects listed\nPUSH: NOT CONSIDERED"}]}}
{"type":"agent_end","messages":[1]}
EOF

# Seat "unsat": a BOUNCE verdict whose evidence floor failed must not be
# collapsed into a generic REVIEW BLOCKED line.
cat > "$LOGS/unsat.jsonl" <<EOF
{"type":"agent_start"}
{"type":"agent_end","messages":[]}
EOF
cat > "$VDIR/wh-unsat-1.md" <<EOF
# Verdict — bead wh-unsat-1

- verdict: BOUNCE

## Evidence checks
- proof/shot.png — missing — UNSATISFIED (source: branch)
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
    "unsat":    { "role": "reviewer", "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/unsat" } },
    "nolog":    { "role": "worker",   "provider": "openai-codex", "model": "gpt-5.5", "account": { "dir": "$FIX/acct/nolog" } },
    "verifier": { "role": "verifier", "provider": "anthropic", "model": "claude-fable-5", "account": { "dir": "$FIX/acct/verifier", "label": "verify-account" } }
  }
}
EOF

# The floor now checks seat identity, not just kill(0). Seed actual native birth
# for our live holder rather than the historical display-only timestamp.
STARTED_AT="$(bun - "$ME" <<'JS'
import { spawnSync } from 'node:child_process';
const r=spawnSync('ps',['-p',process.argv[2],'-o','lstart='],{encoding:'utf8'});
console.error('CAPTURE floor fixture ps '+JSON.stringify({status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr}));
if(r.status!==0||r.error||r.signal)process.exit(2);
console.log(new Date(Date.parse(r.stdout.trim())).toISOString());
JS
)" || exit 2
seat_rec() { # name pid extra-json
  printf '"%s":{"pid":%s,"startedAt":"%s","accountDir":"%s","role":"worker","roleBrief":"x","fifo":"%s","log":"%s","sessionId":"s-%s","sessionFile":null%s}' \
    "$1" "$2" "$STARTED_AT" "$FIX/acct/$1" "$PROJ/seats/run/$1.stdin" "$LOGS/$1.jsonl" "$1" "${3:-}"
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
  seat_rec unsat    "$ME"   ',"lastBead":"wh-unsat-1"'
  printf ','
  seat_rec nolog    "$ME"
  printf '}}\n'
} > "$PROJ/seats/state.json"

cat > "$LOGS/transcript.jsonl" <<'EOF'
{"type":"message_start","message":{"role":"assistant","content":[]}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"The"}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\"path\""}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"please inspect the fixture"}]}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"checking the fixture"},{"type":"toolCall","id":"tc-1","name":"read","arguments":{"path":"README.md"}},{"type":"text","text":"The fix is complete and ready for review."}]}}
{"type":"tool_execution_start","toolCallId":"tc-1","toolName":"read","args":{"path":"README.md"}}
{"type":"tool_execution_update","toolCallId":"tc-1","toolName":"read","partialResult":{"content":[{"type":"text","text":"streaming chunk that must not render"}]}}
{"type":"tool_execution_end","toolCallId":"tc-1","toolName":"read","result":{"content":[{"type":"text","text":"# Fixture title\nbody"}],"isError":false}}
{"type":"agent_end","messages":[1]}
EOF
node -e 'const fs=require("fs"); const [rosterFile,stateFile,fix,log,pid,startedAt]=process.argv.slice(1); const roster=JSON.parse(fs.readFileSync(rosterFile,"utf8")); roster.seats.transcript={role:"worker",provider:"openai-codex",model:"gpt-5.5",account:{dir:`${fix}/acct/transcript`}}; fs.writeFileSync(rosterFile, JSON.stringify(roster,null,2)+"\n"); const state=JSON.parse(fs.readFileSync(stateFile,"utf8")); state.seats.transcript={pid:Number(pid),startedAt,accountDir:`${fix}/acct/transcript`,role:"worker",roleBrief:"x",fifo:`${fix}/proj/seats/run/transcript.stdin`,log,sessionId:"s-transcript",sessionFile:null}; fs.writeFileSync(stateFile, JSON.stringify(state,null,2)+"\n");' "$PROJ/seats/seats.json" "$PROJ/seats/state.json" "$FIX" "$LOGS/transcript.jsonl" "$ME" "$STARTED_AT"

RUN_PATH="$FIX/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin"
render() { # floor-file args...
  local f="$1"; shift
  RC=0; OUT="$(env PATH="$RUN_PATH" COLUMNS=180 LINES=70 NO_COLOR=1 FLOOR_NOW_MS="$NOW_MS" bun "$f" --once "$@" 2>&1)" || RC=$?
}
has() { grep -q "$1" <<< "$OUT"; }

# --- phase 1: pinned seat's events render, humanized -------------------------
phase "phase 1: spotlight renders the pinned seat's events"
render "$PROJ/seats/floor.ts" --pin 1
[ $RC -eq 0 ] && pass "--once --pin 1 exits 0" || fail "--once exited ${RC}: $OUT"
has "SPOTLIGHT"            && pass "spotlight header present"        || fail "no SPOTLIGHT header"
has "busy"                 && pass "pin 1 is seat busy"              || fail "busy not in frame"
has '\[tool\] bash'        && pass "[tool] line humanized"           || fail "no [tool] bash line"
[ $RC -eq 0 ] && pass "truncated tool_execution_update payload shape does not break floor rendering" || fail "truncated tool update shape broke floor output"
has '\[think\]'            && pass "[think] line humanized"          || fail "no [think] line"
if has '\[turn_end\]' || has '\[turn\] agent started'; then
  fail "spotlight rendered raw turn event rows: $OUT"
else
  pass "spotlight omits raw turn start/end event rows"
fi
render "$PROJ/seats/floor.ts" --pin busy
[ $RC -eq 0 ] && has '\[tool\] bash' && pass "--pin by seat name works" || fail "--pin busy failed: $OUT"

phase "phase 1b: follow pane renders transcript, not streaming event rows"
render "$PROJ/seats/floor.ts" --pin transcript
EMPTY_SAY_ROWS="$(printf '%s\n' "$OUT" | grep -Ec '^\[say\][[:space:]]*$' || true)"
TOOL_ROWS="$(printf '%s\n' "$OUT" | grep -Ec '^\[tool\]' || true)"
if [ "$EMPTY_SAY_ROWS" = 0 ]; then pass "transcript has zero empty [say] rows"
else fail "transcript rendered empty [say] rows: $EMPTY_SAY_ROWS"; fi
if [ "$TOOL_ROWS" = 1 ] && has '\[tool\] read README.md.*# Fixture title'; then pass "transcript has one updated row for the tool call"
else fail "transcript tool rows wrong (count=$TOOL_ROWS): $(printf '%s\n' "$OUT" | grep '\[tool\]' || true)"; fi
has 'The fix is complete and ready for review\.' && pass "assistant prose appears verbatim" || fail "assistant prose missing from transcript: $OUT"
if grep -q 'streaming chunk that must not render\|text_delta\|toolcall_delta\|message_update' <<< "$OUT"; then
  fail "streaming/delta frame rendered as its own row: $OUT"
else
  pass "streaming/delta frames do not render rows"
fi

# --- phase 2: the rail shows every seat with the right cue -------------------
phase "phase 2: rail — all seats, distinct failure lines, never silence"
render "$PROJ/seats/floor.ts" --pin 1
for s in busy quiet idle gone authless quota reviewer bounced unsat nolog verifier; do
  has "$s" && pass "rail lists $s" || fail "rail is missing seat $s"
done
has 'busy.*worker.*openai-codex/gpt-5.5.*busy@example.*wh-busy-1.*12s ago' \
  && pass "row shape includes role, provider/model, account label, active bead, and humanized age" \
  || fail "busy row is missing one-glance columns: $(printf '%s\n' "$OUT" | grep busy | sed -n '1p')"
has 'idle.*anthropic/claude-fable-5.*| - |' \
  && pass "missing account.label renders as dash" \
  || fail "idle row did not render a dash for absent account.label: $(printf '%s\n' "$OUT" | grep idle | sed -n '1p')"
has 'quiet.*QUIET.*wh-quiet-1.*11m ago' \
  && pass "old running seat is flagged QUIET with humanized age" \
  || fail "quiet row missing QUIET/11m age: $(printf '%s\n' "$OUT" | grep quiet | sed -n '1p')"
has 'verifier.*verifier.*anthropic/claude-fable-5.*verify-account.*| .*off.* - | - | -' \
  && pass "rostered verifier absent from state renders as a seat row with state dash" \
  || fail "absent verifier row wrong: $(printf '%s\n' "$OUT" | grep verifier | sed -n '1p')"
has "PROCESS GONE"        && pass "gone: PROCESS GONE line (red)"     || fail "no PROCESS GONE line"
has "AUTH DEAD"           && pass "authless: AUTH DEAD line (red)"    || fail "no AUTH DEAD line"
has "PARKED/QUOTA"        && has "bun seats/adapter.ts probe quota" && pass "quota: PARKED/QUOTA line names the re-probe command" || fail "no PARKED/QUOTA line with re-probe command"
has "IDLE with ready work.*2 bead" && pass "idle: IDLE-with-ready-work counts bd ready" || fail "no idle-with-ready-work line"
has 'busy.*RUNNING.*working' && pass 'mid-tool seat is visibly RUNNING' || fail 'busy seat lost RUNNING activity field'
for terminal in agent_end turn_end agent_settled; do
  printf '{"type":"agent_start"}\n{"type":"%s"}\n{"type":"response","command":"get_state","success":true}\n' "$terminal" > "$LOGS/idle.jsonl"
  render "$PROJ/seats/floor.ts" --pin 0
  has 'idle.*SETTLED.*IDLE with ready work' && pass "$terminal plus transport metadata remains SETTLED in STATUS/rail" || fail "$terminal settlement missing: $OUT"
done
printf '{"type":"agent_settled"}\n{"type":"agent_start"}\n{"type":"tool_execution_start"}\n' > "$LOGS/idle.jsonl"
render "$PROJ/seats/floor.ts" --pin idle
has 'idle.*RUNNING.*working' && pass 'next turn leaves SETTLED display immediately on work evidence' || fail "next turn still settled: $OUT"
printf '{"type":"agent_end"}\n' > "$LOGS/idle.jsonl"
render "$PROJ/seats/floor.ts" --pin 1
has "VERDICT LANDED — APPROVE" && pass "reviewer: VERDICT LANDED (green)" || fail "no VERDICT LANDED line"
has "REVIEW BLOCKED.*BOUNCE"   && pass "bounced: REVIEW BLOCKED line"     || fail "no REVIEW BLOCKED line"
has "EVIDENCE UNSATISFIED.*wh-unsat-1" && pass "unsat: BOUNCE with failed evidence-floor renders EVIDENCE UNSATISFIED" || fail "no EVIDENCE UNSATISFIED line"
has "no event log yet"    && pass "nolog: missing log is a named line"    || fail "missing log line absent"
POOL_PROJ="$FIX/poolproj"; mkdir -p "$POOL_PROJ" "$FIX/pool-home/.pi-seats-poolfloor/e1"
cp -R "$PROJ/seats" "$POOL_PROJ/seats"
mkdir -p "$POOL_PROJ/seats/logs" "$POOL_PROJ/seats/run" "$POOL_PROJ/wheelhouse"
printf 'namespace=poolfloor\n' > "$POOL_PROJ/wheelhouse/.template-source"
printf '{"version":1,"seats":{}}\n' > "$POOL_PROJ/seats/seats.json"
cat > "$POOL_PROJ/seats/pool.json" <<'JSON'
{"version":1,"entries":{"e1":{"harness":"codex","provider":"openai","models":["m1"],"account":{"dir":"~/.pi-seats-poolfloor/e1","label":"pool-label","authRoute":"env"}}},"roles":{"workers":{"min":1,"max":1,"entries":["e1"],"model":"m1"}}}
JSON
printf '{"version":1,"seats":{"worker-e1":{"role":"worker","entry":"e1","addedAt":"2026-01-01T00:00:00Z"}},"rateLimited":{}}\n' > "$POOL_PROJ/seats/staffing.json"
printf '{"seats":{"worker-e1":{"pid":%s,"startedAt":"2026-08-29T00:00:00Z","role":"worker","fifo":"%s","log":"%s","sessionId":"pool"}}}\n' "$$" "$POOL_PROJ/seats/run/worker-e1.stdin" "$POOL_PROJ/seats/logs/worker-e1.jsonl" > "$POOL_PROJ/seats/state.json"
printf '{"type":"agent_end","timestamp":"2026-08-29T00:00:00Z"}\n' > "$POOL_PROJ/seats/logs/worker-e1.jsonl"
HOME="$FIX/pool-home" render "$POOL_PROJ/seats/floor.ts" --pin 0
has 'worker-e1.*pool-label (pool)' && pass "staffed seat rail marks pool subscription" || fail "pool marker missing from floor rail: $OUT"
AUTH_SHAPES=(
  'HTTP 401 Unauthorized'
  'HTTP 403 Forbidden'
  'status 401 from provider'
  'status code: 403'
  'Unauthorized'
  'invalid_grant'
  'token expired'
  'token revoked'
  'login required'
)
for shape in "${AUTH_SHAPES[@]}"; do
  printf '%s\n' "$shape" > "$LOGS/authless.stderr.log"
  render "$PROJ/seats/floor.ts" --pin 1
  if has "AUTH DEAD"; then pass "auth stderr shape renders AUTH DEAD: $shape"
  else fail "auth stderr shape did not render AUTH DEAD ($shape): $OUT"; fi
done
printf 'waitpid: pid 401 exited for author worker; authority unchanged\n' > "$LOGS/authless.stderr.log"
render "$PROJ/seats/floor.ts" --pin 1
if has "AUTH DEAD"; then fail "waitpid/author/authority false-positive rendered AUTH DEAD: $OUT"
else pass "waitpid pid 401 and author/authority do not render AUTH DEAD"; fi
printf 'HTTP 401 Unauthorized: token expired - login required\n' > "$LOGS/authless.stderr.log"
render "$PROJ/seats/floor.ts" --pin 1
has " RED"   && has " AMBER" && has " GREEN" \
  && pass "cue words RED/AMBER/GREEN all present" || fail "cue words missing"
has '\[0\] STATUS' && pass "rail has the [0] STATUS cell" || fail "no [0] STATUS row"
if grep -Eq '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T' <<< "$OUT"; then
  fail "rail exposed raw epoch or ISO timestamps: $(printf '%s\n' "$OUT" | grep -E '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T' | sed -n '1p')"
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
if grep -Eq '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T' <<< "$OUT"; then
  fail "STATUS exposed raw epoch or ISO timestamps: $(printf '%s\n' "$OUT" | grep -E '[0-9]{10,}|20[0-9]{2}-[0-9]{2}-[0-9]{2}T' | sed -n '1p')"
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
EMPTY="$FIX/empty"; mkdir -p "$EMPTY/seats"; install_floor_runtime "$EMPTY" || exit 2
render "$EMPTY/seats/floor.ts"
[ $RC -eq 0 ] && has "no seats" && pass "no roster/state degrades to a named line" || fail "empty project: rc=${RC}: $OUT"

# --- phase 5: interactive repaint is in-place, not append-only ---------------
phase "phase 5: repaint — repeated frames return home and clear to end"
CAPTURE_FILE="$FIX/repaint.capture"
env PATH="$RUN_PATH" COLUMNS=180 LINES=24 NO_COLOR=1 FLOOR_NOW_MS="$NOW_MS" bun "$PROJ/seats/floor.ts" > "$CAPTURE_FILE" 2> "$FIX/repaint.stderr" &
FLOOR_PID=$!
# Observe the actual second repaint; the admitted suite owns named3600s
# containment, with the helper's last count/file/producer printed before wait.
if ! bun "$HERE/fixtures/adapter-selftest-signals.ts" count "$CAPTURE_FILE" $'\033[H\033[J' 0 "$FLOOR_PID" 2; then
  fail 'floor producer exited before its second repaint'
fi
kill "$FLOOR_PID" 2>/dev/null
wait "$FLOOR_PID" 2>/dev/null
CAPTURE="$(cat "$CAPTURE_FILE")"
if [ -s "$CAPTURE_FILE" ]; then pass "multi-frame capture produced output before the scripted stop"
else fail "multi-frame capture produced no output"; fi
HOME_CLEAR_COUNT="$(printf '%s' "$CAPTURE" | bun -e 'console.log((await import("node:fs")).default.readFileSync(0,"utf8").split("\x1b[H\x1b[J").length-1)')"
if [ "$HOME_CLEAR_COUNT" -ge 2 ]; then pass "multi-frame capture contains repeated cursor-home + clear-to-end repaint sequences"
else fail "multi-frame capture did not show repeated in-place repaint sequences (count=$HOME_CLEAR_COUNT)"; fi
if printf '%s' "$CAPTURE" | bun -e 'const frames=(await import("node:fs")).default.readFileSync(0,"utf8").replace(/\r\n?/g,"\n").split("\x1b[H\x1b[J").filter(Boolean); process.exit(frames.length&&Math.max(...frames.map(f=>f.split("\n").length-1))<=24?0:1);'; then
  pass "multi-frame capture stays within the terminal height per frame — no scroll drift"
else
  fail "multi-frame capture grew past the terminal height, indicating scroll drift"
fi

# --- phase 6: interactive q returns to overview, not process exit ------------
phase "phase 6: interactive keys — q keeps the pane alive by returning to overview"
if ! command -v expect >/dev/null 2>&1; then
  skip "expect not on PATH — q key pty leg not run"
else
  QCAP="$FIX/q.expect"; QSCRIPT="$FIX/q.exp"
  cat > "$QSCRIPT" <<EOF
# Named outer PTY resource containment, not a startup/repaint SLA.
set timeout 1800
fconfigure stdout -buffering none
spawn bun "$PROJ/seats/floor.ts" --pin 1
# Bind the timeout to the spawned PTY, not the caller's closed stdin.
expect_before timeout { puts stderr "INCOMPLETE floor PTY outer30min bound; last_seen=\$expect_out(buffer)"; exit 124 }
puts stderr "WAIT floor PTY SPOTLIGHT"
# Expect's multiline pattern list is significant: a one-line brace block
# is a single literal glob, not separate pattern/action pairs.
expect {
  "SPOTLIGHT" {}
  eof { puts stderr "FAIL floor exited before SPOTLIGHT"; exit 1 }
}
send "q"
puts stderr "WAIT floor PTY OVERVIEW after q"
expect {
  "OVERVIEW" {}
  eof { puts stderr "FAIL floor exited before OVERVIEW"; exit 1 }
}
send "1"
puts stderr "WAIT floor PTY SPOTLIGHT after return key (q must not exit)"
expect {
  "SPOTLIGHT" {}
  eof { puts stderr "FAIL q exited instead of keeping floor alive"; exit 1 }
}
send "\003"
expect eof
EOF
  QRC=0
  env PATH="$RUN_PATH" COLUMNS=180 LINES=24 NO_COLOR=1 FLOOR_NOW_MS="$NOW_MS" bun - "$HERE/completed-command.ts" "$QSCRIPT" "$QCAP" <<'JS' || QRC=$?
import fs from 'node:fs';
const [module,script,capture]=process.argv.slice(2),{completedCommand}=await import(module);
const native=completedCommand('expect',[script]);
fs.writeFileSync(capture,native.stdout);fs.writeFileSync(capture+'.stderr',native.stderr);
console.log('CAPTURE floor PTY native '+JSON.stringify(native));
process.exit(native.error||native.signal||native.status===null?1:native.status);
JS
  printf 'CAPTURE floor PTY harness exit=%s\n' "$QRC"
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
  . "$HERE/fixtures/readiness.sh"
  floor_pane_frame() {
    local pane="$1" label="$2"
    # A pane exists before its shell/Bun/imports run. Its own first frame, not
    # pane count or a sleep, proves the producer ran before we destroy it.
    if ! tmux -L "$SOCK" capture-pane -p -t "$pane" > "$FIX/floor-$label.capture" 2> "$FIX/floor-$label.stderr"; then
      cat "$FIX/floor-$label.stderr" >&2
      return 2
    fi
    # Narrow tmux panes can wrap the rail header into history; the final
    # status row remains in the viewport and witnesses the same real frame.
    grep -Fq '[0] STATUS' "$FIX/floor-$label.capture"
  }
  floor_pane_ready() {
    local label="$1" pane
    pane="$(tmux -L "$SOCK" display-message -p -t wh-tfix:bridge.1 '#{pane_id}')" || return 2
    case "$pane" in %*) ;; *) echo "STOP: no native floor pane for $label" >&2; return 2 ;; esac
    printf 'WAIT floor %s frame pane=%s\n' "$label" "$pane"
    # Use the existing enclosing suite containment, not a new startup SLA.
    fixture_wait "floor $label frame pane=$pane" "" floor_pane_frame "$pane" "$label"
  }
  SOCKET_BASE="$(cd "${TMUX_TMPDIR:-/tmp}" && pwd -P)" || exit 2
  FLOOR_SOCKET_UID="$(id -u)" || exit 2
  FLOOR_SOCKET_PATH="$SOCKET_BASE/tmux-$FLOOR_SOCKET_UID/$SOCK"
  bun "$HERE/selftest-floor-socket.ts" absent "$FLOOR_SOCKET_PATH" || exit 2
  FLOOR_SOCKET_CLAIMED=1
  crun() {
    RC=0
    out_file="$FIX/cockpit-crun.out"
    env PATH="${RUN_PATH}:$(dirname "$(command -v tmux)")" WHEELHOUSE_TMUX_SOCKET="$SOCK" WHEELHOUSE_COCKPIT_DAEMONS=0 WHEELHOUSE_COCKPIT_RECOVERY=0 TMUX= "$PROJ/seats/cockpit.sh" tfix < /dev/null > "$out_file" 2>&1 || RC=$?
    floor_pin_socket || exit 2
    OUT="$(cat "$out_file" 2>/dev/null || true)"
  }
  crun
  [ $RC -eq 0 ] && has "bridge built" && pass "first run builds the bridge" || fail "first run: rc=${RC}: $OUT"
  if tmux -L "$SOCK" has-session -t "=wh-tfix" 2>/dev/null; then pass "session wh-tfix exists"
  else fail "session wh-tfix missing"; fi
  WN="$(tmux -L "$SOCK" list-windows -t wh-tfix -F '#{window_name}' 2>/dev/null)"
  [ "$WN" = "bridge" ] && pass "single window named bridge" || fail "windows: $WN"
  PANES="$(tmux -L "$SOCK" list-panes -t wh-tfix:bridge 2>/dev/null | wc -l | tr -d ' ')"
  [ "$PANES" = "2" ] && pass "bridge has exactly 2 panes (commander + floor)" || fail "pane count: $PANES"
  floor_pane_ready initial || fail "initial floor pane exited before its first frame"
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
  floor_pane_ready repaired || fail "repaired floor pane exited before its first frame"
  SESSN="$(tmux -L "$SOCK" list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  [ "$SESSN" = "1" ] && pass "still exactly 1 session after pane repair" || fail "session count after pane repair: $SESSN"
  # EXIT owns server retirement and exact-inode unlink on every exit path.
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
