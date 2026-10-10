#!/usr/bin/env bash
#
# cockpit.sh — build the bridge: one tmux window per project.
#
#   session  wh-<namespace>       (namespace = arg 1, default: project dirname)
#   window   0:bridge
#     left pane   the COMMANDER seat. This script does NOT launch claude —
#                 the commander is interactive and the human launches it; the
#                 pane prints the instructions and hands you a shell.
#     right pane  seats/floor.ts full height. The spotlight AND the rail are
#                 one program, so the right side is one pane, not two.
#
# Idempotent: if wh-<ns> already exists, re-running attaches to it (or prints
# the attach command when there is no terminal) and creates no duplicate
# sessions. If the bridge window lost its floor pane, re-running rebuilds that
# pane before attaching.
#
# Hermetic testing hook: WHEELHOUSE_TMUX_SOCKET names a private tmux socket
# (-L) so the selftest can build and destroy sessions without touching yours.
#
# bash 3.2 compatible (macOS /bin/bash).

set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
SELF="$HERE/$(basename "$0")"

tmx() {
  if [ -n "${WHEELHOUSE_TMUX_SOCKET:-}" ]; then
    command tmux -L "$WHEELHOUSE_TMUX_SOCKET" "$@"
  else
    command tmux "$@"
  fi
}

pid_alive() {
  [ -n "$1" ] || return 1
  kill -0 "$1" 2>/dev/null
}

json_string() {
  printf '%s' "$1" | bun -e 'const chunks=[]; process.stdin.on("data", c=>chunks.push(c)); process.stdin.on("end",()=>process.stdout.write(JSON.stringify(Buffer.concat(chunks).toString())));'
}

cockpit_recovery_note() {
  mkdir -p "$HERE/logs"
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$HERE/logs/cockpit-recovery.log"
}

append_seat_recovery_event() {
  seat_log="$1"
  message="$2"
  [ -n "$seat_log" ] || return 0
  mkdir -p "$(dirname "$seat_log")" 2>/dev/null || return 0
  msg_json="$(json_string "$message" 2>/dev/null || printf '"cockpit recovery event"')"
  printf '{"type":"wheelhouse_note","source":"cockpit","message":%s,"at":"%s"}\n' "$msg_json" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$seat_log" 2>/dev/null || true
}

bead_is_closed() {
  bead="$1"
  [ -n "$bead" ] || return 1
  command -v bd >/dev/null 2>&1 || return 1
  (cd "$ROOT" && bd list --status=closed --json --limit 5000 2>/dev/null) | bun -e 'const id=process.argv[1]; let s=""; process.stdin.on("data", c=>s+=c); process.stdin.on("end",()=>{ try { const rows=JSON.parse(s||"[]"); process.exit(rows.some(r=>String(r && r.id)===id) ? 0 : 1); } catch { process.exit(1); } });' "$bead"
}

cwd_has_no_uncommitted_or_unpushed_work() {
  cwd="$1"
  [ -n "$cwd" ] && [ -d "$cwd" ] || return 1
  git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  [ -z "$(git -C "$cwd" status --porcelain 2>/dev/null)" ] || return 1
  head_sha="$(git -C "$cwd" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$head_sha" ] || return 1
  if git -C "$cwd" branch -r --contains "$head_sha" 2>/dev/null | grep -v -- '->' | grep -q '[^[:space:]]'; then
    return 0
  fi
  upstream="$(git -C "$cwd" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  [ -n "$upstream" ] || return 1
  counts="$(git -C "$cwd" rev-list --left-right --count "$upstream...HEAD" 2>/dev/null || true)"
  behind="$(printf '%s\n' "$counts" | awk '{print $1}')"
  ahead="$(printf '%s\n' "$counts" | awk '{print $2}')"
  [ "${ahead:-1}" = "0" ]
}

recover_dead_seats() {
  [ "${WHEELHOUSE_COCKPIT_RECOVERY:-1}" = "0" ] && return 0
  [ -f "$HERE/adapter.ts" ] || return 0
  [ -f "$HERE/state.json" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  mkdir -p "$HERE/run" "$HERE/logs"
  lock="$HERE/run/cockpit-recovery.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    cockpit_recovery_note "cockpit recovery already running; skipping this pass"
    return 0
  fi
  trap 'rm -rf "$lock"' RETURN
  bun -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const [name,r] of Object.entries(s.seats||{})) console.log([name, r&&r.pid!=null?String(r.pid):"", r&&r.lastBead?String(r.lastBead):"", r&&r.cwd?String(r.cwd):"", r&&r.log?String(r.log):""].map(x=>x.replace(/\t|\n/g," ")).join("\t"));' "$HERE/state.json" 2>/dev/null |
  while IFS="$(printf '\t')" read -r seat pid bead cwd seat_log; do
    [ -n "$seat" ] || continue
    [ -n "$pid" ] || continue
    if pid_alive "$pid"; then
      continue
    fi
    out="$HERE/logs/cockpit-recovery.$seat.resume.out"
    if (cd "$ROOT" && bun "$HERE/adapter.ts" resume "$seat") > "$out" 2>&1; then
      cockpit_recovery_note "seat $seat resumed after dead pid $pid"
      continue
    fi
    if ! grep -q 'brief changed; reset instead of resume' "$out"; then
      msg="seat $seat resume failed and was not changed-brief recovery: $(tail -n 1 "$out" 2>/dev/null)"
      echo "$msg" >&2
      cockpit_recovery_note "$msg"
      append_seat_recovery_event "$seat_log" "$msg"
      continue
    fi
    reason=""
    if bead_is_closed "$bead"; then
      reason="recorded bead $bead is closed"
    elif cwd_has_no_uncommitted_or_unpushed_work "$cwd"; then
      reason="recorded cwd has no uncommitted or unpushed work"
    fi
    if [ -n "$reason" ]; then
      reset_out="$HERE/logs/cockpit-recovery.$seat.reset.out"
      if (cd "$ROOT" && bun "$HERE/adapter.ts" reset "$seat") > "$reset_out" 2>&1; then
        msg="seat $seat cold-reset after changed brief ($reason)"
        echo "$msg"
        cockpit_recovery_note "$msg"
        append_seat_recovery_event "$seat_log" "$msg"
      else
        msg="seat $seat changed-brief cold reset failed after $reason: $(tail -n 1 "$reset_out" 2>/dev/null)"
        echo "$msg" >&2
        cockpit_recovery_note "$msg"
        append_seat_recovery_event "$seat_log" "$msg"
      fi
    else
      msg="seat $seat left dead after changed brief; recorded bead ${bead:-unknown} is not closed and recorded cwd has uncommitted or unpushed work"
      echo "$msg" >&2
      cockpit_recovery_note "$msg"
      append_seat_recovery_event "$seat_log" "$msg"
    fi
  done
  rm -rf "$lock"
  trap - RETURN
}

ensure_commander_poll() {
  if [ ! -x "$HERE/commander-inbox-poll.sh" ]; then
    echo "commander inbox poll not installed beside cockpit; skipping pane poll"
    return 0
  fi
  mkdir -p "$HERE/run" "$HERE/logs"
  poll_pid_file="$HERE/run/commander-inbox-poll.pid"
  if [ -f "$poll_pid_file" ]; then
    poll_pid="$(cat "$poll_pid_file" 2>/dev/null || true)"
    if pid_alive "$poll_pid"; then
      echo "commander inbox poll already running: pid $poll_pid"
      return 0
    fi
    rm -f "$poll_pid_file"
  fi
  (cd "$ROOT" && WHEELHOUSE_COMMANDER_POLL_ROOT="$ROOT" "$HERE/commander-inbox-poll.sh" >> "$HERE/logs/commander-inbox-poll.out.log" 2>> "$HERE/logs/commander-inbox-poll.stderr.log" & echo $! > "$poll_pid_file")
  echo "commander inbox poll started: pid $(cat "$poll_pid_file" 2>/dev/null || echo '?')"
}

ensure_herald() { WHEELHOUSE_DAEMONS_ROOT="$ROOT" . "$HERE/daemons.sh"; start_herald || exit $?; }
ensure_desk() { WHEELHOUSE_DAEMONS_ROOT="$ROOT" . "$HERE/daemons.sh"; start_desk || exit $?; }
ensure_courier() { WHEELHOUSE_DAEMONS_ROOT="$ROOT" . "$HERE/daemons.sh"; start_courier || exit $?; }
stop_legacy_watchdog() {
  name="$1"; f="$HERE/run/$name-watchdog.pid"
  [ -f "$f" ] || return 0
  pid="$(cat "$f" 2>/dev/null || true)"
  if pid_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    cockpit_recovery_note "stopped legacy $name-watchdog pid $pid"
    echo "legacy $name watchdog stopped: pid $pid"
  fi
  rm -f "$f"
}
ensure_supervisor() {
  if [ ! -x "$HERE/supervisor.sh" ]; then echo "supervisor not installed beside cockpit; skipping daemon supervision"; return 0; fi
  mkdir -p "$HERE/run" "$HERE/logs"
  stop_legacy_watchdog desk
  stop_legacy_watchdog courier
  pid_file="$HERE/run/supervisor.pid"
  if [ -f "$pid_file" ]; then
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if pid_alive "$old_pid"; then echo "supervisor already running: pid $old_pid"; return 0; fi
    echo "supervisor dead: pid ${old_pid:-?}; restarting"; rm -f "$pid_file"
  fi
  (cd "$ROOT" && WHEELHOUSE_SUPERVISOR_ROOT="$ROOT" nohup "$HERE/supervisor.sh" >> "$HERE/logs/supervisor.out.log" 2>> "$HERE/logs/supervisor.stderr.log" & echo $! > "$pid_file")
  new_pid="$(cat "$pid_file" 2>/dev/null || true)"; sleep 0.2
  if pid_alive "$new_pid"; then echo "supervisor started: pid $new_pid"; return 0; fi
  echo "STOP: supervisor failed to start; see $HERE/logs/supervisor.stderr.log" >&2; exit 1
}

usage() {
  cat >&2 <<EOF
usage: seats/cockpit.sh [namespace]
       seats/cockpit.sh --herald [namespace]
       seats/cockpit.sh --desk [namespace]
       seats/cockpit.sh --courier [namespace]
       seats/cockpit.sh --pane-commander
       seats/cockpit.sh --pane-floor
EOF
}

refuse_arg() {
  echo "STOP: invalid cockpit argument: ${1:-<empty>}" >&2
  usage
  exit 2
}

# --- internal pane commands (tmux runs this script back) ---------------------
case "${1:-}" in
  --herald)
    S="wh-${2:-$(basename "$ROOT")}" ensure_herald
    exit 0
    ;;
  --desk)
    S="wh-${2:-$(basename "$ROOT")}" ensure_desk
    exit 0
    ;;
  --courier)
    S="wh-${2:-$(basename "$ROOT")}" ensure_courier
    exit 0
    ;;
  --pane-commander)
    mkdir -p "$HERE/run"
    pane_id="$(tmx display-message -p -t "${TMUX_PANE:-}" '#{pane_id}' 2>/dev/null || printf '%s' "${TMUX_PANE:-}")"
    pane_session="$(tmx display-message -p -t "${TMUX_PANE:-}" '#{session_name}' 2>/dev/null || true)"
    ROOT_JSON="$(printf '%s' "$ROOT" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    PANE_JSON="$(printf '%s' "$pane_id" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    SESSION_JSON="$(printf '%s' "$pane_session" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{ "paneId": "%s", "session": "%s", "root": "%s", "writtenAt": "%s" }\n' "$PANE_JSON" "$SESSION_JSON" "$ROOT_JSON" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$HERE/run/commander-pane.json"
    ensure_commander_poll
    cat <<EOF

  ┌─ COMMANDER PANE ──────────────────────────────────────────────┐
  │ This is the commander's seat. Launch your interactive         │
  │ commander here yourself — the cockpit never does it for you.  │
  │ cockpit has started commander-inbox-poll.sh for visual hints; │
  │ drain with: bun seats/herald.ts --drain                       │
  │ Needs desk: ${DESK_URL:-not started}                          │
  │                                                               │
  │     cd $ROOT
  │     claude                                                    │
  │                                                               │
  │ The pane to the right is the floor viewer (spotlight + rail): │
  │   1-9 pin a seat   0 pin STATUS   f follow   o/q overview     │
  │ Scroll with the wheel, or prefix [ then arrows/PageUp, q out. │
  │ With mouse on, hold Option/Shift to select text on macOS.      │
  └───────────────────────────────────────────────────────────────┘

EOF
    exec "${SHELL:-/bin/bash}"
    ;;
  --pane-floor)
    if command -v bun >/dev/null 2>&1; then
      exec bun "$HERE/floor.ts"
    fi
    echo "floor viewer needs bun on PATH — install bun, then run: bun $HERE/floor.ts"
    exec "${SHELL:-/bin/bash}"
    ;;
esac

# --- main --------------------------------------------------------------------
case "${1-}" in
  --*) refuse_arg "$1" ;;
esac
case "${1-$(basename "$ROOT")}" in
  ""|-*|*[[:space:]]*) refuse_arg "${1-}" ;;
esac

command -v tmux >/dev/null 2>&1 || {
  echo "STOP: tmux is required for the bridge and is not on PATH" >&2
  exit 1
}

NS="${1:-$(basename "$ROOT")}"
S="wh-$NS"

recover_dead_seats
ensure_desk
ensure_courier
ensure_supervisor
DESK_URL="$(cat "$HERE/run/desk.port" 2>/dev/null || true)"
export DESK_URL

attach() {
  if [ ! -t 0 ]; then
    echo "session $S is up; attach with: tmux ${WHEELHOUSE_TMUX_SOCKET:+-L $WHEELHOUSE_TMUX_SOCKET }attach -t $S"
    return 0
  fi
  if [ -n "${TMUX:-}" ]; then
    exec tmux switch-client -t "$S"
  fi
  # exec through tmx is not possible with the function; expand it here.
  if [ -n "${WHEELHOUSE_TMUX_SOCKET:-}" ]; then
    exec tmux -L "$WHEELHOUSE_TMUX_SOCKET" attach-session -t "$S"
  fi
  exec tmux attach-session -t "$S"
}

QSELF="$(printf '%q' "$SELF")"
QBRIDGE_GUARD="$(printf '%q' "$HERE/bridge-guard.sh")"
COMMANDER_PANE_PERCENT="${WHEELHOUSE_COCKPIT_COMMANDER_PERCENT:-55}"

install_session_options() {
  tmx set-option -t "$S" history-limit 50000
  if [ "${WHEELHOUSE_COCKPIT_MOUSE:-1}" = "0" ]; then
    tmx set-option -t "$S" mouse off
  else
    tmx set-option -t "$S" mouse on
  fi
  # Bridge stays two panes: a harness that splits subagent panes into the
  # current window (Claude Code teammateMode auto) gets each one moved to its
  # own window instead. See seats/bridge-guard.sh.
  tmx set-hook -t "$S" after-split-window "run-shell 'WHEELHOUSE_TMUX_SOCKET=${WHEELHOUSE_TMUX_SOCKET:-} bash $QBRIDGE_GUARD $S $COMMANDER_PANE_PERCENT'"
}

install_resize_hook() {
  # Detached new-session starts at tmux's default 80 columns. Size after a real
  # client attaches so the floor pane does not inherit every added column.
  local prefix="tmux"
  if [ -n "${WHEELHOUSE_TMUX_SOCKET:-}" ]; then
    prefix="tmux -L $WHEELHOUSE_TMUX_SOCKET"
  fi
  tmx set-hook -t "$S" client-attached "run-shell 'sleep 0.1; $prefix resize-pane -t ${S}:bridge.0 -x ${COMMANDER_PANE_PERCENT}%'"
}

spawn_floor_pane() {
  # Right pane, full height: the floor (spotlight + rail in one program).
  # -l N% needs tmux >= 3.1; fall back to an even split if it is refused.
  mkdir -p "$HERE/run"
  local err="$HERE/run/floor-pane.err"
  rm -f "$err"
  if tmx split-window -h -l '45%' -t "${S}:bridge" -c "$ROOT" "$QSELF --pane-floor" 2>"$err"; then
    return 0
  fi
  if tmx split-window -h -t "${S}:bridge" -c "$ROOT" "$QSELF --pane-floor" 2>>"$err"; then
    return 0
  fi
  echo "STOP: could not create bridge floor pane in ${S}:bridge; $(tail -n 1 "$err" 2>/dev/null || echo 'tmux split-window failed')" >&2
  return 1
}

if tmx has-session -t "=$S" 2>/dev/null; then
  if tmx list-windows -t "$S" -F '#{window_name}' 2>/dev/null | grep -qx 'bridge'; then
    PANES="$(tmx list-panes -t "${S}:bridge" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$PANES" = "1" ]; then
      echo "bridge floor pane missing in ${S}:bridge; respawning it"
      spawn_floor_pane || exit 1
      tmx select-pane -t "${S}:bridge.0"
    fi
  fi
  install_resize_hook
  install_session_options
  ensure_herald
  ensure_supervisor
  echo "bridge already built: $S (re-run is attach, never a duplicate)"
  attach
  exit 0
fi

# Window 0:bridge — left pane is the commander seat.
tmx new-session -d -s "$S" -n bridge -c "$ROOT" "$QSELF --pane-commander"

spawn_floor_pane || exit 1
ensure_herald
ensure_supervisor
install_resize_hook

# Status bar: project on the left, the key hints on the right.
tmx set-option -t "$S" status on
tmx set-option -t "$S" status-left-length 30
tmx set-option -t "$S" status-right-length 100
tmx set-option -t "$S" status-left "[$S] "
tmx set-option -t "$S" status-right "desk ${DESK_URL:-?}  1-9 pin  0 status  f follow  o/q overview"
install_session_options

# Land focus on the commander pane.
tmx select-pane -t "${S}:bridge.0"

echo "bridge built: session $S, window 0:bridge (commander left, floor right)"
attach
