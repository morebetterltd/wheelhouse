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

ensure_herald() {
  if [ ! -f "$HERE/herald.ts" ]; then
    echo "herald not installed beside cockpit; skipping dispatch herald"
    return 0
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "STOP: bun is required to run the dispatch herald" >&2
    exit 1
  fi
  mkdir -p "$HERE/run" "$HERE/logs"
  pid_file="$HERE/run/herald.pid"
  if [ -f "$pid_file" ]; then
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if pid_alive "$old_pid"; then
      echo "herald already running: pid $old_pid"
      return 0
    fi
    echo "herald dead: pid ${old_pid:-?}; restarting"
    rm -f "$pid_file"
  fi
  (cd "$ROOT" && WHEELHOUSE_HERALD_TMUX_SESSION="$S" WHEELHOUSE_HERALD_TMUX_PANE="${S}:bridge.0" WHEELHOUSE_TMUX_SOCKET="${WHEELHOUSE_TMUX_SOCKET:-}" nohup bun "$HERE/herald.ts" >> "$HERE/logs/herald.out.log" 2>> "$HERE/logs/herald.stderr.log" & echo $! > "$pid_file")
  new_pid="$(cat "$pid_file" 2>/dev/null || true)"
  sleep 0.2
  if pid_alive "$new_pid"; then
    echo "herald started: pid $new_pid"
    return 0
  fi
  echo "STOP: herald failed to start; see $HERE/logs/herald.stderr.log" >&2
  exit 1
}

# --- internal pane commands (tmux runs this script back) ---------------------
case "${1:-}" in
  --pane-commander)
    cat <<EOF

  ┌─ COMMANDER PANE ──────────────────────────────────────────────┐
  │ This is the commander's seat. Launch your interactive         │
  │ commander here yourself — the cockpit never does it for you:  │
  │                                                               │
  │     cd $ROOT
  │     claude                                                    │
  │                                                               │
  │ The pane to the right is the floor viewer (spotlight + rail): │
  │   1-9 pin a seat   0 pin STATUS   f follow   o/q overview     │
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
command -v tmux >/dev/null 2>&1 || {
  echo "STOP: tmux is required for the bridge and is not on PATH" >&2
  exit 1
}

NS="${1:-$(basename "$ROOT")}"
S="wh-$NS"

ensure_herald

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
COMMANDER_PANE_PERCENT="${WHEELHOUSE_COCKPIT_COMMANDER_PERCENT:-55}"

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
  tmx split-window -h -l '45%' -t "${S}:bridge" -c "$ROOT" "$QSELF --pane-floor" 2>/dev/null ||
    tmx split-window -h -t "${S}:bridge" -c "$ROOT" "$QSELF --pane-floor"
}

if tmx has-session -t "=$S" 2>/dev/null; then
  if tmx list-windows -t "$S" -F '#{window_name}' 2>/dev/null | grep -qx 'bridge'; then
    PANES="$(tmx list-panes -t "${S}:bridge" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$PANES" = "1" ]; then
      echo "bridge floor pane missing in ${S}:bridge; respawning it"
      spawn_floor_pane
      tmx select-pane -t "${S}:bridge.0"
    fi
  fi
  install_resize_hook
  echo "bridge already built: $S (re-run is attach, never a duplicate)"
  attach
  exit 0
fi

# Window 0:bridge — left pane is the commander seat.
tmx new-session -d -s "$S" -n bridge -c "$ROOT" "$QSELF --pane-commander"

spawn_floor_pane
install_resize_hook

# Status bar: project on the left, the key hints on the right.
tmx set-option -t "$S" status on
tmx set-option -t "$S" status-left-length 30
tmx set-option -t "$S" status-right-length 60
tmx set-option -t "$S" status-left "[$S] "
tmx set-option -t "$S" status-right "1-9 pin  0 status  f follow  o/q overview"

# Land focus on the commander pane.
tmx select-pane -t "${S}:bridge.0"

echo "bridge built: session $S, window 0:bridge (commander left, floor right)"
attach
