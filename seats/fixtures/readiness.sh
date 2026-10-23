# Fixture-only event predicates. The enclosing canonical suite deadline remains
# the stuck-fixture bound; no short sleep/count establishes success or absence.
fixture_wait() {
  local label="$1" child="$2" rc; shift 2
  while :; do
    if "$@"; then break; else rc=$?; [ "$rc" = 1 ] || return "$rc"; fi
    if [ -n "$child" ] && ! kill -0 "$child" 2>/dev/null; then
      echo "STOP: original fixture child $child exited before $label" >&2; return 1
    fi
    sleep 0.05
  done
  printf 'OBSERVED %s\n' "$label"
}
fixture_wait_exit() {
  local child="$1"
  case "$child" in ''|*[!0-9]*|0|1) echo "STOP: invalid original fixture PID: $child" >&2; return 2 ;; esac
  while kill -0 "$child" 2>/dev/null; do sleep 0.05; done
  printf 'OBSERVED original fixture process exit pid=%s\n' "$child"
}
fixture_wait_json() {
  local file="$1" child="$2"
  fixture_wait "complete JSON publication $file" "$child" bun -e 'import fs from "node:fs"; try { const s=fs.readFileSync(process.argv[1],"utf8"); if(!s.endsWith("\n"))process.exit(1); const j=JSON.parse(s); process.exit(j&&typeof j.paneId==="string"&&j.paneId?0:1); }catch{process.exit(1);}' "$file"
}
