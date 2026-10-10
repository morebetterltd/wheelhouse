#!/usr/bin/env bash
# commander-inbox-poll.sh — visual Dispatch Office wake hint.
#
# Run inside the commander pane at startup. It does not inspect tmux, send
# keystrokes, or depend on a prompt shape. If seats/inbox.cursor lags
# seats/inbox.jsonl, it prints the same wake phrase the herald uses, at most
# once per observed inbox size. It NEVER drains the inbox and never advances
# seats/inbox.cursor: only a commander-run `bun seats/herald.ts --drain` may
# mark rows delivered. Correctness depends on the durable inbox and commander
# drain, not on pane scrollback.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="${WHEELHOUSE_COMMANDER_POLL_ROOT:-$(cd "$HERE/.." && pwd -P)}"
STATE_FILE="$ROOT/seats/run/commander-inbox-poll.state"
INTERVAL="${WHEELHOUSE_COMMANDER_INBOX_POLL_SECONDS:-120}"
PHRASE="check the fleet inbox"

inbox_size_and_cursor() {
  local inbox="$ROOT/seats/inbox.jsonl" cursor_file="$ROOT/seats/inbox.cursor" size cursor
  [ -f "$inbox" ] || return 1
  size="$(wc -c < "$inbox" | tr -d ' ')"
  cursor=0
  [ -f "$cursor_file" ] && cursor="$(cat "$cursor_file" 2>/dev/null || echo 0)"
  case "$cursor" in ''|*[!0-9]*) cursor=0 ;; esac
  printf '%s %s\n' "$size" "$cursor"
}

last_hinted_size() {
  local v=0
  [ -f "$STATE_FILE" ] && v="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
  case "$v" in ''|*[!0-9]*) v=0 ;; esac
  printf '%s\n' "$v"
}

hint_if_lagging() {
  local pair size cursor last
  pair="$(inbox_size_and_cursor)" || return 1
  size="${pair%% *}"; cursor="${pair##* }"
  [ "$size" -gt "$cursor" ] || return 1
  last="$(last_hinted_size)"
  [ "$size" -gt "$last" ] || return 0
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '%s\n' "$size" > "$STATE_FILE"
  printf '\n%s\n' "$PHRASE"
  return 0
}

case "${1:-}" in
  --once)
    hint_if_lagging
    exit 0
    ;;
  --help|-h)
    echo "usage: WHEELHOUSE_COMMANDER_INBOX_POLL_SECONDS=120 seats/commander-inbox-poll.sh [--once]"
    exit 0
    ;;
esac

while :; do
  hint_if_lagging || true
  sleep "$INTERVAL"
done
