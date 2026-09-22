#!/usr/bin/env bash
# bridge-guard.sh — keep the cockpit's bridge window at exactly two panes.
#
# Claude Code's teammateMode "auto" splits a NEW PANE INTO THE CURRENT WINDOW
# for every subagent it spawns from the commander seat, which wedges the
# commander/floor split. Subagents are welcome; the bridge layout is not theirs
# to change. Wired as a tmux after-split-window hook by cockpit.sh: every pane
# past index 1 in <session>:bridge is broken out into its own window, detached
# (focus stays where it was), and the configured split is restored. Idempotent
# and silent when the bridge is already two panes.
set -uo pipefail
S="${1:?session}"
PCT="${2:-55}"

tmx() {
  if [ -n "${WHEELHOUSE_TMUX_SOCKET:-}" ]; then
    command tmux -L "$WHEELHOUSE_TMUX_SOCKET" "$@"
  else
    command tmux "$@"
  fi
}

extra="$(tmx list-panes -t "${S}:bridge" -F '#{pane_index} #{pane_current_command}' 2>/dev/null | awk '$1 >= 2' | sort -rn)"
[ -n "$extra" ] || exit 0
while read -r idx cmd; do
  [ -n "$idx" ] || continue
  tmx break-pane -d -s "${S}:bridge.${idx}" -n "agent-${cmd:-pane}" 2>/dev/null || true
done <<EOF2
$extra
EOF2
tmx select-layout -t "${S}:bridge" even-horizontal 2>/dev/null || true
tmx resize-pane -t "${S}:bridge.0" -x "${PCT}%" 2>/dev/null || true
exit 0
