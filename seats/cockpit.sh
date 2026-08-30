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
# the attach command when there is no terminal) and creates nothing.
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
  │   1-9 pin a seat   0 pin STATUS   f follow   o overview   q   │
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

if tmx has-session -t "=$S" 2>/dev/null; then
  echo "bridge already built: $S (re-run is attach, never a duplicate)"
  attach
  exit 0
fi

QSELF="$(printf '%q' "$SELF")"

# Window 0:bridge — left pane is the commander seat.
tmx new-session -d -s "$S" -n bridge -c "$ROOT" "$QSELF --pane-commander"

# Right pane, full height: the floor (spotlight + rail in one program).
# -l N% needs tmux >= 3.1; fall back to an even split if it is refused.
tmx split-window -h -l '45%' -t "$S:bridge" -c "$ROOT" "$QSELF --pane-floor" 2>/dev/null ||
  tmx split-window -h -t "$S:bridge" -c "$ROOT" "$QSELF --pane-floor"

# Status bar: project on the left, the key hints on the right.
tmx set-option -t "$S" status on
tmx set-option -t "$S" status-left-length 30
tmx set-option -t "$S" status-right-length 60
tmx set-option -t "$S" status-left "[$S] "
tmx set-option -t "$S" status-right "1-9 pin  0 status  f follow  o overview  q quit"

# Land focus on the commander pane.
tmx select-pane -t "$S:bridge.0"

echo "bridge built: session $S, window 0:bridge (commander left, floor right)"
attach
