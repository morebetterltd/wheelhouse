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

json_string() {
  printf '%s' "$1" | bun -e 'const chunks=[]; process.stdin.on("data", c=>chunks.push(c)); process.stdin.on("end",()=>process.stdout.write(JSON.stringify(Buffer.concat(chunks).toString())));'
}

cockpit_recovery_note() {
  mkdir -p "$DAEMONS_LOGS"
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$DAEMONS_LOGS/cockpit-recovery.log"
}

append_seat_recovery_event() {
  seat_log="$1"
  message="$2"
  [ -n "$seat_log" ] || return 0
  mkdir -p "$(dirname "$seat_log")" 2>/dev/null || return 0
  msg_json="$(json_string "$message" 2>/dev/null || printf '"cockpit recovery event"')"
  printf '{"type":"wheelhouse_note","source":"cockpit","message":%s,"at":"%s"}\n' "$msg_json" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$seat_log" 2>/dev/null || true
}

bead_is_closed() {
  bead="$1"
  [ -n "$bead" ] || return 1
  command -v bd >/dev/null 2>&1 || return 1
  (cd "$DAEMONS_ROOT" && bd list --status=closed --json --limit 5000 2>/dev/null) | bun -e 'const id=process.argv[1]; let s=""; process.stdin.on("data", c=>s+=c); process.stdin.on("end",()=>{ try { const rows=JSON.parse(s||"[]"); process.exit(rows.some(r=>String(r && r.id)===id) ? 0 : 1); } catch { process.exit(1); } });' "$bead"
}

cwd_has_no_uncommitted_or_unpushed_work() {
  cwd="$1"
  [ -n "$cwd" ] && [ -d "$cwd" ] || return 1
  git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  [ -z "$(git -C "$cwd" status --porcelain 2>/dev/null)" ] || return 1
  head_sha="$(git -C "$cwd" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$head_sha" ] || return 1
  if git -C "$cwd" branch -r --contains "$head_sha" 2>/dev/null | grep -v -- '->' | grep -q '[^[:space:]]'; then
    return 0
  fi
  upstream="$(git -C "$cwd" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  [ -n "$upstream" ] || return 1
  counts="$(git -C "$cwd" rev-list --left-right --count "$upstream...HEAD" 2>/dev/null || true)"
  behind="$(printf '%s\n' "$counts" | awk '{print $1}')"
  ahead="$(printf '%s\n' "$counts" | awk '{print $2}')"
  [ "${ahead:-1}" = "0" ]
}

recover_dead_seats() {
  [ "${WHEELHOUSE_COCKPIT_RECOVERY:-1}" = "0" ] && return 0
  [ -f "$DAEMONS_SEATS/adapter.ts" ] || return 0
  [ -f "$DAEMONS_SEATS/state.json" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  mkdir -p "$DAEMONS_RUN" "$DAEMONS_LOGS"
  lock="$DAEMONS_RUN/cockpit-recovery.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    cockpit_recovery_note "cockpit recovery already running; skipping this pass"
    return 0
  fi
  trap 'rm -rf "$lock"' RETURN
  sep="$(printf '\037')"
  bun -e 'import fs from "node:fs"; const sep="\x1f"; const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const [name,r] of Object.entries(s.seats||{})) console.log([name, r&&r.pid!=null?String(r.pid):"", r&&r.lastBead?String(r.lastBead):"", r&&r.cwd?String(r.cwd):"", r&&r.log?String(r.log):""].map(x=>x.replace(/\x1f|\n/g," ")).join(sep));' "$DAEMONS_SEATS/state.json" 2>/dev/null |
  while IFS="$sep" read -r seat pid bead cwd seat_log; do
    [ -n "$seat" ] || continue
    [ -n "$pid" ] || continue
    if pid_alive "$pid"; then
      continue
    fi
    out="$DAEMONS_LOGS/cockpit-recovery.$seat.resume.out"
    if (cd "$DAEMONS_ROOT" && bun "$DAEMONS_SEATS/adapter.ts" resume "$seat") > "$out" 2>&1; then
      cockpit_recovery_note "seat $seat resumed after dead pid $pid"
      continue
    fi
    if ! grep -q 'brief changed; reset instead of resume' "$out"; then
      msg="seat $seat resume failed and was not changed-brief recovery: $(tail -n 1 "$out" 2>/dev/null)"
      echo "$msg" >&2
      cockpit_recovery_note "$msg"
      append_seat_recovery_event "$seat_log" "$msg"
      continue
    fi
    reason=""
    if bead_is_closed "$bead"; then
      reason="recorded bead $bead is closed"
    elif cwd_has_no_uncommitted_or_unpushed_work "$cwd"; then
      reason="recorded cwd has no uncommitted or unpushed work"
    fi
    if [ -n "$reason" ]; then
      reset_out="$DAEMONS_LOGS/cockpit-recovery.$seat.reset.out"
      if (cd "$DAEMONS_ROOT" && bun "$DAEMONS_SEATS/adapter.ts" reset "$seat") > "$reset_out" 2>&1; then
        msg="seat $seat cold-reset after changed brief ($reason)"
        echo "$msg"
        cockpit_recovery_note "$msg"
        append_seat_recovery_event "$seat_log" "$msg"
      else
        msg="seat $seat changed-brief cold reset failed after $reason: $(tail -n 1 "$reset_out" 2>/dev/null)"
        echo "$msg" >&2
        cockpit_recovery_note "$msg"
        append_seat_recovery_event "$seat_log" "$msg"
      fi
    else
      msg="seat $seat left dead after changed brief; recorded bead ${bead:-unknown} is not closed and recorded cwd has uncommitted or unpushed work"
      echo "$msg" >&2
      cockpit_recovery_note "$msg"
      append_seat_recovery_event "$seat_log" "$msg"
    fi
  done
  rm -rf "$lock"
  trap - RETURN
}

wait_pid_file() {
  file="$1"
  for _ in $(seq 1 50); do [ -s "$file" ] && break; sleep 0.1; done
}

principal_channel_declared() {
  (cd "$DAEMONS_ROOT" && bun -e 'import fs from "node:fs"; let j={}; try{j=JSON.parse(fs.readFileSync("seats/channels.json","utf8"));}catch{} process.exit(Object.values(j.channels||{}).some(c=>c&&c.audience==="principal") ? 0 : 1);' >/dev/null 2>&1)
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
  new="$(cat "$pid_file" 2>/dev/null || true)"; for _ in $(seq 1 50); do pid_alive "$new" && break; sleep 0.1; done
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
  new="$(cat "$pid_file" 2>/dev/null || true)"; for _ in $(seq 1 50); do [ -s "$DAEMONS_RUN/desk.port" ] && pid_alive "$new" && break; sleep 0.1; done
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
  new="$(cat "$pid_file" 2>/dev/null || true)"; for _ in $(seq 1 50); do pid_alive "$new" && break; sleep 0.1; done
  if pid_alive "$new"; then echo "courier started: pid $new"; return 0; fi
  echo "STOP: courier failed to start; see $DAEMONS_LOGS/courier.stderr.log" >&2; return 1
}
