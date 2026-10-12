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

state_get(){ node -e 'const fs=require("fs"); const f=process.argv[1],d=process.argv[2]; let s={daemons:{}}; try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}; const x=s.daemons?.[d]||{}; console.log(JSON.stringify(x));' "$STATE" "$1"; }
state_set(){ node -e 'const fs=require("fs"),path=require("path"); const [f,d,json]=process.argv.slice(1); let s={daemons:{}}; try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}; s.daemons=s.daemons||{}; s.daemons[d]=JSON.parse(json); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");' "$STATE" "$1" "$2"; }
supervisor_state_get(){ node -e 'const fs=require("fs"); let s={}; try{s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}; const v=s[process.argv[2]]; if(v!==undefined) console.log(String(v));' "$STATE" "$1"; }
supervisor_state_set(){ node -e 'const fs=require("fs"),path=require("path"); const [f,k,v]=process.argv.slice(1); let s={}; try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}; s[k]=v; fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");' "$STATE" "$1" "$2"; }
last_stderr(){ tail -5 "$LOGS/$1.stderr.log" 2>/dev/null || true; }
restart_cmd(){ case "$1" in herald) start_herald;; desk) start_desk;; courier) start_courier;; esac; }
should_run(){ [ "$1" != courier ] || principal_channel_declared; }
namespace(){ v="$(sed -n 's/^namespace=//p' "$ROOT/wheelhouse/.template-source" 2>/dev/null | tail -1)"; [ -n "$v" ] && printf '%s\n' "$v" || basename "$ROOT"; }
xml_escape(){ node -e 'const s=process.argv[1]||""; process.stdout.write(s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"));' "$1"; }

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

now_ms(){ node -e 'const v=process.env.WHEELHOUSE_SUPERVISOR_NOW; console.log(v ? Date.parse(v) : Date.now())'; }
local_day(){ node -e 'const d=new Date(Number(process.argv[1])); const p=n=>String(n).padStart(2,"0"); console.log(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`);' "$1"; }
local_hour(){ node -e 'const d=new Date(Number(process.argv[1])); console.log(String(d.getHours()).padStart(2,"0"));' "$1"; }
cleanup_enabled(){ v="$(sed -n 's/^cleanup=//p' "$ROOT/wheelhouse/.template-source" 2>/dev/null | tail -1)"; [ "$v" != off ]; }
tick_recovery(){
  command -v bun >/dev/null 2>&1 || return 0
  ms="$(now_ms)"; last="$(supervisor_state_get lastRecoveryMs)"; interval="${WHEELHOUSE_SEAT_RECOVERY_SECONDS:-60}"
  due="$(node -e 'const now=Number(process.argv[1]), last=Number(process.argv[2]||0), interval=Number(process.argv[3]||60)*1000; process.exit(!last || now-last>=interval ? 0 : 1)' "$ms" "$last" "$interval" >/dev/null 2>&1; echo $?)"
  [ "$due" = 0 ] || return 0
  recover_dead_seats >> "$OUT_LOG" 2>&1 || true
  supervisor_state_set lastRecoveryMs "$ms"
}
tick_cleanup(){
  cleanup_enabled || return 0
  [ -f "$SEATS/prune.ts" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  ms="$(now_ms)"; day="$(local_day "$ms")"; hour="$(local_hour "$ms")"; want="$(node -e 'const n=Number(process.argv[1]||3); console.log(String(Number.isFinite(n)?n:3).padStart(2,"0"));' "${WHEELHOUSE_CLEANUP_HOUR:-03}")"
  [ "$hour" = "$want" ] || return 0
  [ "$(supervisor_state_get lastCleanupDay)" != "$day" ] || return 0
  supervisor_state_set lastCleanupDay "$day"
  (cd "$ROOT" && exec </dev/null >> "$LOGS/prune-cleanup.out.log" 2>> "$LOGS/prune-cleanup.stderr.log"; WHEELHOUSE_PRUNE_ROOT="$ROOT" bun seats/prune.ts cleanup) &
  printf '%s cleanup started for %s (pid %s)\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$day" "$!" >> "$OUT_LOG"
}
tick(){ tick_daemon herald; tick_daemon desk; tick_daemon courier; tick_recovery; tick_cleanup; }
status(){ for d in herald desk courier; do if ! should_run "$d"; then echo "$d SKIPPED"; continue; fi; rec="$(state_get "$d")"; crash="$(printf '%s' "$rec" | grep -q '"crashLoop":true' && echo 1 || echo 0)"; if [ "$crash" = 1 ]; then since="$(printf '%s' "$rec" | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{let j=JSON.parse(s||"{}"); console.log((j.restarts||[])[0]||"")})')"; echo "$d CRASH-LOOP since $since"; elif daemon_alive "$d"; then echo "$d RUNNING pid $(cat "$RUN/$d.pid")"; else echo "$d DEAD"; fi; done; }
resetd(){ d="$1"; state_set "$d" '{"restarts":[],"crashLoop":false}'; restart_cmd "$d"; }
supervisor_holder_alive(){
  pid="$1"
  [ -n "${pid:-}" ] && [ "$pid" != "$$" ] || return 1
  pid_alive "$pid" || return 1
  stat="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
  case "$stat" in *Z*) return 1 ;; esac
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *"$SEATS/supervisor.sh"*) return 0 ;;
  esac
  return 1
}
wait_for_supervisor_holder(){
  pid="$1"
  echo "supervisor already running: pid $pid; waiting for it to exit"
  while supervisor_holder_alive "$pid"; do sleep "$INTERVAL"; done
  sleep 0.1
  echo "supervisor holder exited: pid $pid; taking over"
}
remove_supervisor_pid_file(){
  cur="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ "$cur" = "$$" ] && rm -f "$PID_FILE"
}

install_launchd(){
  home="$HOME"; print_plist=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --home) shift; home="${1:?--home requires a directory}" ;;
      --print) print_plist=1 ;;
      *) echo "usage: seats/supervisor.sh install-launchd [--home <dir>] [--print]" >&2; return 2 ;;
    esac
    shift
  done
  ns="$(namespace)"
  case "$ns" in ""|*/*|*" "*|*[!A-Za-z0-9_.-]*) echo "STOP: namespace must be one launchd-safe segment (A-Za-z0-9_.-), got: $ns" >&2; return 2 ;; esac
  label="com.wheelhouse.$ns.supervisor"
  plist_dir="$home/Library/LaunchAgents"; plist="$plist_dir/$label.plist"
  mkdir -p "$plist_dir" "$LOGS"
  eroot="$(xml_escape "$ROOT")"; elog="$(xml_escape "$LOGS")"; eplist="$(xml_escape "$plist")"; elabel="$(xml_escape "$label")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$elabel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$eroot/seats/supervisor.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$eroot</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$elog/supervisor.launchd.out.log</string>
  <key>StandardErrorPath</key><string>$elog/supervisor.launchd.err.log</string>
</dict>
</plist>
EOF
  echo "wrote $plist"
  if [ "$print_plist" = 1 ]; then
    echo "--- $plist ---"
    cat "$plist"
    echo "--- end plist ---"
  fi
  echo "To load:   launchctl bootstrap gui/$UID $plist"
  echo "To unload: launchctl bootout gui/$UID $plist"
}

print_systemd(){
  ns="$(namespace)"
  case "$ns" in ""|*/*|*" "*) echo "STOP: namespace must be one systemd-safe segment, got: $ns" >&2; return 2 ;; esac
  cat <<EOF
# Save as ~/.config/systemd/user/wheelhouse-$ns-supervisor.service
[Unit]
Description=Wheelhouse supervisor ($ns)

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/seats/supervisor.sh
Restart=always
RestartSec=5
StandardOutput=append:$LOGS/supervisor.systemd.out.log
StandardError=append:$LOGS/supervisor.systemd.err.log

[Install]
WantedBy=default.target
EOF
}

run_loop(){
  mkdir -p "$RUN" "$LOGS"
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "${WHEELHOUSE_SUPERVISOR_STARTED_BY_COCKPIT:-}" ] && [ -n "$old" ] && [ "$old" != "$$" ]; then
    if supervisor_holder_alive "$old"; then
      wait_for_supervisor_holder "$old"
    elif pid_alive "$old"; then
      echo "supervisor pid file names a non-supervisor process: pid $old; taking over"
    fi
  fi
  echo $$ > "$PID_FILE"
  trap 'remove_supervisor_pid_file; exit 0' INT TERM
  trap 'remove_supervisor_pid_file' EXIT
  while :; do tick; sleep "$INTERVAL"; done
}

case "${1:-}" in
  --once) tick ;;
  --status) status ;;
  install-launchd) shift; install_launchd "$@" ;;
  print-systemd) print_systemd ;;
  reset) resetd "${2:?daemon required}" ;;
  "") run_loop ;;
  *) echo "usage: seats/supervisor.sh [--once|--status|install-launchd [--home <dir>] [--print]|print-systemd|reset <daemon>]" >&2; exit 2 ;;
esac
