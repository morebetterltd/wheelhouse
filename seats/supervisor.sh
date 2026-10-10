#!/usr/bin/env bash
# supervisor.sh — one fixture-safe supervisor for herald, desk, and courier.
# bash 3.2 compatible.
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="${WHEELHOUSE_SUPERVISOR_ROOT:-$(cd "$HERE/.." && pwd -P)}"
SEATS="$ROOT/seats"; RUN="$SEATS/run"; LOGS="$SEATS/logs"; STATE="$RUN/supervisor.state.json"; PID_FILE="$RUN/supervisor.pid"; OUT_LOG="$LOGS/supervisor.out.log"
INTERVAL="${WHEELHOUSE_SUPERVISOR_SECONDS:-5}"
export WHEELHOUSE_DAEMONS_ROOT="$ROOT"
. "$SEATS/daemons.sh"

json_string(){ printf '%s' "$1" | bun -e 'const a=[]; process.stdin.on("data",c=>a.push(c)); process.stdin.on("end",()=>process.stdout.write(JSON.stringify(Buffer.concat(a).toString())));'; }
state_get(){ node -e 'const fs=require("fs"); const f=process.argv[1],d=process.argv[2]; let s={daemons:{}}; try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}; const x=s.daemons?.[d]||{}; console.log(JSON.stringify(x));' "$STATE" "$1"; }
state_set(){ node -e 'const fs=require("fs"),path=require("path"); const [f,d,json]=process.argv.slice(1); let s={daemons:{}}; try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}; s.daemons=s.daemons||{}; s.daemons[d]=JSON.parse(json); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");' "$STATE" "$1" "$2"; }
last_stderr(){ tail -5 "$LOGS/$1.stderr.log" 2>/dev/null || true; }
restart_cmd(){ case "$1" in herald) start_herald;; desk) start_desk;; courier) start_courier;; esac; }
should_run(){ [ "$1" != courier ] || principal_channel_declared; }

append_alert(){
  d="$1"; first="$2"; detail="$3"; mkdir -p "$SEATS"
  id="$(printf 'supervisor\0%s\0%s' "$d" "$first" | shasum -a 256 | awk '{print $1}')"
  if [ -f "$SEATS/inbox.jsonl" ] && grep -q "\"id\":\"$id\"" "$SEATS/inbox.jsonl" 2>/dev/null; then return 0; fi
  title="$d keeps dying"; body="$detail
Restart after fixing: seats/supervisor.sh reset $d"
  printf '{"id":"%s","at":"%s","seat":"supervisor","class":"daemon-down","state":"failed","title":%s,"detail":%s}\n' "$id" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(json_string "$title")" "$(json_string "$body")" >> "$SEATS/inbox.jsonl"
  if command -v bun >/dev/null 2>&1 && [ -f "$SEATS/needs.ts" ]; then
    (cd "$ROOT" && bun seats/needs.ts open --kind notify --source "supervisor:$d" --title "$title" --body "The $d service stopped repeatedly, so related fleet updates may stop flowing. Check the last stderr lines, fix the service, then run: seats/supervisor.sh reset $d" >/dev/null 2>&1) || true
  fi
}

tick_daemon(){
  d="$1"; should_run "$d" || return 0
  rec="$(state_get "$d")"; crash="$(printf '%s' "$rec" | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{let j=JSON.parse(s||"{}"); console.log(j.crashLoop?"1":"0")})')"
  [ "$crash" = 1 ] && return 0
  old="$(cat "$RUN/$d.pid" 2>/dev/null || true)"; if daemon_alive "$d"; then return 0; fi
  out="$(restart_cmd "$d" 2>&1 || true)"; new="$(cat "$RUN/$d.pid" 2>/dev/null || true)"; now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"; tail5="$(last_stderr "$d")"
  printf '%s %s restarted: pid %s (previous pid %s dead)\n%s\n' "$now" "$d" "${new:-?}" "${old:-?}" "$tail5" >> "$OUT_LOG"
  data="$(printf '%s' "$rec" | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{let j=JSON.parse(s||"{}"); let now=process.argv[1], pid=process.argv[2]; let cutoff=Date.now()-300000; let rs=(j.restarts||[]).filter(x=>Date.parse(x)>=cutoff); rs.push(now); j.restarts=rs; j.lastPid=pid; j.crashLoop=rs.length>=3; console.log(JSON.stringify(j));})' "$now" "$new")"
  state_set "$d" "$data"
  if printf '%s' "$data" | grep -q '"crashLoop":true'; then first="$(printf '%s' "$data" | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{let j=JSON.parse(s); console.log(j.restarts[0])})')"; append_alert "$d" "$first" "$tail5"; fi
}

tick(){ tick_daemon herald; tick_daemon desk; tick_daemon courier; }
status(){ for d in herald desk courier; do if ! should_run "$d"; then echo "$d SKIPPED"; continue; fi; rec="$(state_get "$d")"; crash="$(printf '%s' "$rec" | grep -q '"crashLoop":true' && echo 1 || echo 0)"; if [ "$crash" = 1 ]; then since="$(printf '%s' "$rec" | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{let j=JSON.parse(s||"{}"); console.log((j.restarts||[])[0]||"")})')"; echo "$d CRASH-LOOP since $since"; elif daemon_alive "$d"; then echo "$d RUNNING pid $(cat "$RUN/$d.pid")"; else echo "$d DEAD"; fi; done; }
resetd(){ d="$1"; state_set "$d" '{"restarts":[],"crashLoop":false}'; restart_cmd "$d"; }

case "${1:-}" in
  --once) tick ;;
  --status) status ;;
  reset) resetd "${2:?daemon required}" ;;
  "") mkdir -p "$RUN" "$LOGS"; echo $$ > "$PID_FILE"; trap 'rm -f "$PID_FILE"; exit 0' INT TERM; trap 'rm -f "$PID_FILE"' EXIT; while :; do tick; sleep "$INTERVAL"; done ;;
  *) echo "usage: seats/supervisor.sh [--once|--status|reset <daemon>]" >&2; exit 2 ;;
esac
