#!/usr/bin/env bash
# desk-watchdog.sh — keep the local human desk alive.
# bash 3.2 compatible.

set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="${WHEELHOUSE_DESK_ROOT:-$(cd "$HERE/.." && pwd -P)}"
INTERVAL="${WHEELHOUSE_DESK_WATCHDOG_SECONDS:-5}"
RUN="$HERE/run"
LOGS="$HERE/logs"
PID_FILE="$RUN/desk.pid"
WATCHDOG_PID_FILE="$RUN/desk-watchdog.pid"
STDERR_LOG="$LOGS/desk.stderr.log"
OUT_LOG="$LOGS/desk.out.log"

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

start_desk() {
  mkdir -p "$RUN" "$LOGS"
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  {
    printf '%s desk restart requested; previous pid %s was not alive\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${old_pid:-?}"
    if [ -s "$STDERR_LOG" ]; then
      printf '%s\n' 'desk crash tail before restart:'
      tail -20 "$STDERR_LOG" 2>/dev/null || true
    fi
  } >> "$STDERR_LOG"
  rm -f "$PID_FILE"
  (
    cd "$ROOT" || exit 1
    exec </dev/null >> "$OUT_LOG" 2>> "$STDERR_LOG"
    WHEELHOUSE_DESK_ROOT="$ROOT" nohup bun "$HERE/desk.ts" &
    desk_pid=$!
    printf '%s\n' "$desk_pid" > "$PID_FILE"
    disown "$desk_pid" 2>/dev/null || true
  ) </dev/null >/dev/null 2>/dev/null
  new_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  printf '%s desk restarted: pid %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${new_pid:-?}" >> "$STDERR_LOG"
  printf '%s\n' "desk restarted: pid ${new_pid:-?}"
}

mkdir -p "$RUN" "$LOGS"
printf '%s\n' $$ > "$WATCHDOG_PID_FILE"
trap 'rm -f "$WATCHDOG_PID_FILE"; exit 0' INT TERM
trap 'rm -f "$WATCHDOG_PID_FILE"' EXIT
while :; do
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if ! pid_alive "$pid"; then start_desk; fi
  sleep "$INTERVAL"
done
