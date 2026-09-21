#!/usr/bin/env bash
# commander-inbox-poll.sh — wrapper-independent Dispatch Office fallback.
#
# Run inside the commander pane at startup. It does not inspect tmux, send
# keystrokes, or depend on a prompt shape: if seats/inbox.cursor lags
# seats/inbox.jsonl, it prints the same wake phrase the herald uses and drains
# the durable inbox. Need rows are still drained here (so settle/distress rows
# do not accumulate indefinitely), but after the drain the poll reprints the
# unread-needs phrase. Correctness does not depend on pane scrollback: the same
# unread count is recomputed by fleet-gate.sh on every commander turn until
# `bun seats/needs.ts show <id>` marks the need read.
# The herald poke stays a low-latency hint; this poll is the correctness
# fallback for wrapped commander sessions.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="${WHEELHOUSE_COMMANDER_POLL_ROOT:-$(cd "$HERE/.." && pwd -P)}"
HERALD="$ROOT/seats/herald.ts"
INTERVAL="${WHEELHOUSE_COMMANDER_INBOX_POLL_SECONDS:-120}"
PHRASE="check the fleet inbox"

inbox_lags() {
  local inbox="$ROOT/seats/inbox.jsonl" cursor_file="$ROOT/seats/inbox.cursor" size cursor
  [ -f "$inbox" ] || return 1
  size="$(wc -c < "$inbox" | tr -d ' ')"
  cursor=0
  [ -f "$cursor_file" ] && cursor="$(cat "$cursor_file" 2>/dev/null || echo 0)"
  case "$cursor" in ''|*[!0-9]*) cursor=0 ;; esac
  [ "$size" -gt "$cursor" ]
}

unread_needs_count() {
  [ -f "$ROOT/seats/needs.ts" ] || { echo 0; return; }
  WHEELHOUSE_NEEDS_ROOT="$ROOT" bun "$ROOT/seats/needs.ts" list --unread 2>/dev/null | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' '
}

drain_if_lagging() {
  if inbox_lags; then
    printf '\n%s\n' "$PHRASE"
    WHEELHOUSE_HERALD_ROOT="$ROOT" bun "$HERALD" --drain
    unread="$(unread_needs_count)"
    case "$unread" in ''|*[!0-9]*) unread=0 ;; esac
    if [ "$unread" -gt 0 ] 2>/dev/null; then
      printf '%s answer(s) waiting to be read — bun seats/needs.ts list --unread\n' "$unread"
    fi
    return 0
  fi
  return 1
}

case "${1:-}" in
  --once)
    drain_if_lagging
    exit 0
    ;;
  --help|-h)
    echo "usage: WHEELHOUSE_COMMANDER_INBOX_POLL_SECONDS=120 seats/commander-inbox-poll.sh [--once]"
    exit 0
    ;;
esac

while :; do
  drain_if_lagging || true
  sleep "$INTERVAL"
done
