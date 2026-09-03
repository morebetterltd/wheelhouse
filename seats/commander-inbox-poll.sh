#!/usr/bin/env bash
# commander-inbox-poll.sh — wrapper-independent Dispatch Office fallback.
#
# Run inside the commander pane at startup. It does not inspect tmux, send
# keystrokes, or depend on a prompt shape: if seats/inbox.cursor lags
# seats/inbox.jsonl, it prints the same wake phrase the herald uses and drains
# the durable inbox. The herald poke stays a low-latency hint; this poll is the
# correctness fallback for wrapped commander sessions.

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

drain_if_lagging() {
  if inbox_lags; then
    printf '\n%s\n' "$PHRASE"
    WHEELHOUSE_HERALD_ROOT="$ROOT" bun "$HERALD" --drain
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
