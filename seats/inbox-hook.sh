#!/usr/bin/env bash
# Claude Code SessionStart/UserPromptSubmit/PostToolUse(Bash) context carrier.
# Anchor on this installed copy, never on stdin cwd or the caller's directory.
set +e
exec 2>/dev/null
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)" || exit 0
ROOT="$(cd "$HERE/.." 2>/dev/null && pwd -P)" || exit 0
INBOX="$ROOT/seats/inbox.jsonl"
[ -f "$INBOX" ] || exit 0
cursor=0
if [ -f "$ROOT/seats/inbox.cursor" ]; then
  IFS= read -r cursor < "$ROOT/seats/inbox.cursor"
fi
case "$cursor" in ''|*[!0-9]*) cursor=0 ;; esac
bytes="$(LC_ALL=C wc -c < "$INBOX" 2>/dev/null)" || exit 0
bytes="${bytes//[[:space:]]/}"
[ "$bytes" != "$cursor" ] || exit 0
command -v bun >/dev/null 2>&1 || exit 0
[ -f "$HERE/herald.ts" ] || exit 0
WHEELHOUSE_HERALD_ROOT="$ROOT" bun "$HERE/herald.ts" --hook 2>/dev/null || true
exit 0
