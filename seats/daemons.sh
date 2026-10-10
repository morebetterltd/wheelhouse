#!/usr/bin/env bash
# Shared daemon launch helpers for cockpit.sh and supervisor.sh.
# bash 3.2 compatible; sourcing has no side effects.

: "${WHEELHOUSE_DAEMONS_ROOT:=}"
if [ -n "$WHEELHOUSE_DAEMONS_ROOT" ]; then
  DAEMONS_ROOT="$WHEELHOUSE_DAEMONS_ROOT"
else
  DAEMONS_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  DAEMONS_ROOT="$(cd "$DAEMONS_HERE/.." && pwd -P)"
fi
DAEMONS_SEATS="$DAEMONS_ROOT/seats"
DAEMONS_RUN="$DAEMONS_SEATS/run"
DAEMONS_LOGS="$DAEMONS_SEATS/logs"

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
daemon_alive() { pid_alive "$(cat "$DAEMONS_RUN/$1.pid" 2>/dev/null || true)"; }

wait_pid_file() {
  file="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$file" ] && break; sleep 0.05; done
}

principal_channel_declared() {
  (cd "$DAEMONS_ROOT" && bun -e 'const fs=require("fs"); let j={}; try{j=JSON.parse(fs.readFileSync("seats/channels.json","utf8"));}catch{} process.exit(Object.values(j.channels||{}).some(c=>c&&c.audience==="principal") ? 0 : 1);' >/dev/null 2>&1)
}

start_herald() {
  if [ ! -f "$DAEMONS_SEATS/herald.ts" ]; then echo "herald not installed beside cockpit; skipping dispatch herald"; return 0; fi
  command -v bun >/dev/null 2>&1 || { echo "STOP: bun is required to run the dispatch herald" >&2; return 1; }
  mkdir -p "$DAEMONS_RUN" "$DAEMONS_LOGS"
  pid_file="$DAEMONS_RUN/herald.pid"
  if daemon_alive herald; then echo "herald already running: pid $(cat "$pid_file")"; return 0; fi
  old="$(cat "$pid_file" 2>/dev/null || true)"; [ -n "$old" ] && echo "herald dead: pid $old; restarting"
  rm -f "$pid_file"; tmp="$pid_file.$$"; rm -f "$tmp"
  ( cd "$DAEMONS_ROOT" || exit 1; exec </dev/null >> "$DAEMONS_LOGS/herald.out.log" 2>> "$DAEMONS_LOGS/herald.stderr.log"; WHEELHOUSE_TMUX_SOCKET="${WHEELHOUSE_TMUX_SOCKET:-}" WHEELHOUSE_HERALD_ROOT="$DAEMONS_ROOT" nohup bun "$DAEMONS_SEATS/herald.ts" & echo $! > "$tmp"; disown $! 2>/dev/null || true ) </dev/null >/dev/null 2>/dev/null &
  disown $! 2>/dev/null || true; wait_pid_file "$tmp"; [ -s "$tmp" ] && mv -f "$tmp" "$pid_file"
  new="$(cat "$pid_file" 2>/dev/null || true)"; sleep 0.2
  if pid_alive "$new"; then echo "herald started: pid $new"; return 0; fi
  echo "STOP: herald failed to start; see $DAEMONS_LOGS/herald.stderr.log" >&2; return 1
}

start_desk() {
  if [ ! -f "$DAEMONS_SEATS/desk.ts" ]; then echo "desk not installed beside cockpit; skipping needs desk"; return 0; fi
  command -v bun >/dev/null 2>&1 || { echo "STOP: bun is required to run the needs desk" >&2; return 1; }
  mkdir -p "$DAEMONS_RUN" "$DAEMONS_LOGS"
  pid_file="$DAEMONS_RUN/desk.pid"
  if daemon_alive desk; then url="$(cat "$DAEMONS_RUN/desk.port" 2>/dev/null || true)"; echo "desk already running: pid $(cat "$pid_file")${url:+ — $url}"; return 0; fi
  old="$(cat "$pid_file" 2>/dev/null || true)"; [ -n "$old" ] && echo "desk dead: pid $old; restarting"
  rm -f "$pid_file"; tmp="$pid_file.$$"; rm -f "$tmp"
  ( cd "$DAEMONS_ROOT" || exit 1; exec </dev/null >> "$DAEMONS_LOGS/desk.out.log" 2>> "$DAEMONS_LOGS/desk.stderr.log"; WHEELHOUSE_DESK_ROOT="$DAEMONS_ROOT" nohup bun "$DAEMONS_SEATS/desk.ts" & echo $! > "$tmp"; disown $! 2>/dev/null || true ) </dev/null >/dev/null 2>/dev/null &
  disown $! 2>/dev/null || true; wait_pid_file "$tmp"; [ -s "$tmp" ] && mv -f "$tmp" "$pid_file"
  new="$(cat "$pid_file" 2>/dev/null || true)"; for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$DAEMONS_RUN/desk.port" ] && pid_alive "$new" && break; sleep 0.1; done
  url="$(cat "$DAEMONS_RUN/desk.port" 2>/dev/null || true)"
  if pid_alive "$new"; then echo "desk started: pid $new${url:+ — $url}"; return 0; fi
  echo "STOP: desk failed to start; see $DAEMONS_LOGS/desk.stderr.log" >&2; return 1
}

start_courier() {
  if [ ! -f "$DAEMONS_SEATS/courier.ts" ]; then echo "courier skipped: no declared principal channel"; return 0; fi
  command -v bun >/dev/null 2>&1 || { echo "STOP: bun is required to run the courier" >&2; return 1; }
  mkdir -p "$DAEMONS_RUN" "$DAEMONS_LOGS"
  if ! principal_channel_declared; then echo "courier skipped: no declared principal channel"; return 0; fi
  pid_file="$DAEMONS_RUN/courier.pid"
  if daemon_alive courier; then echo "courier already running: pid $(cat "$pid_file")"; return 0; fi
  old="$(cat "$pid_file" 2>/dev/null || true)"; [ -n "$old" ] && echo "courier dead: pid $old; restarting"
  rm -f "$pid_file"; tmp="$pid_file.$$"; rm -f "$tmp"
  ( cd "$DAEMONS_ROOT" || exit 1; exec </dev/null >> "$DAEMONS_LOGS/courier.out.log" 2>> "$DAEMONS_LOGS/courier.stderr.log"; WHEELHOUSE_COURIER_ROOT="$DAEMONS_ROOT" nohup bun "$DAEMONS_SEATS/courier.ts" & echo $! > "$tmp"; disown $! 2>/dev/null || true ) </dev/null >/dev/null 2>/dev/null &
  disown $! 2>/dev/null || true; wait_pid_file "$tmp"; [ -s "$tmp" ] && mv -f "$tmp" "$pid_file"
  new="$(cat "$pid_file" 2>/dev/null || true)"; sleep 0.2
  if pid_alive "$new"; then echo "courier started: pid $new"; return 0; fi
  echo "STOP: courier failed to start; see $DAEMONS_LOGS/courier.stderr.log" >&2; return 1
}
