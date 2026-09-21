#!/usr/bin/env bash
set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="${WHEELHOUSE_COURIER_ROOT:-$(cd "$HERE/.." && pwd -P)}"
RUN="$ROOT/seats/run"
LOGS="$ROOT/seats/logs"
PID_FILE="$RUN/courier.pid"
WATCHDOG_PID_FILE="$RUN/courier-watchdog.pid"
INTERVAL="${WHEELHOUSE_COURIER_WATCHDOG_SECONDS:-10}"

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

mkdir -p "$RUN" "$LOGS"
printf '%s\n' $$ > "$WATCHDOG_PID_FILE"
trap 'rm -f "$WATCHDOG_PID_FILE"; exit 0' INT TERM
trap 'rm -f "$WATCHDOG_PID_FILE"' EXIT

start_courier() {
  (
    cd "$ROOT" || exit 1
    exec </dev/null >> "$LOGS/courier.out.log" 2>> "$LOGS/courier.stderr.log"
    WHEELHOUSE_COURIER_ROOT="$ROOT" nohup bun "$ROOT/seats/courier.ts" &
    courier_pid=$!
    printf '%s\n' "$courier_pid" > "$PID_FILE"
    disown "$courier_pid" 2>/dev/null || true
  ) </dev/null >/dev/null 2>/dev/null
}

while :; do
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if ! pid_alive "$pid"; then
    {
      printf '%s courier dead: pid %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${pid:-?}"
      tail -20 "$LOGS/courier.stderr.log" 2>/dev/null || true
    } >> "$LOGS/courier.out.log"
    rm -f "$PID_FILE"
    start_courier
    new_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    printf '%s courier restarted: pid %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${new_pid:-?}" >> "$LOGS/courier.out.log"
  fi
  sleep "$INTERVAL"
done
