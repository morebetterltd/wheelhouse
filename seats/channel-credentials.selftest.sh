#!/usr/bin/env bash
# Only fake credentials, isolated runtime/state, and no external API calls.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
SOURCE="${1:-$HERE}"
[ -f "$SOURCE/channels.ts" ] || { echo 'selftest: missing runtime' >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo 'selftest: bun required' >&2; exit 2; }
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-channel-credentials-selftest.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"' EXIT
FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
# Do not print captured output on failure: a broken reader may expose a token.
fail(){ printf '  FAIL  %s (rc=%s; output withheld)\n' "$*" "${RC:-n/a}"; FAILED=$((FAILED+1)); }
clean_env(){ env -u BEADS_ACTOR -u BASH_ENV -u ENV -u WHEELHOUSE_SLACK_TOKEN -u WHEELHOUSE_TEAMS_TOKEN -u WHEELHOUSE_TELEGRAM_TOKEN -u WHEELHOUSE_TEAMS_TOKEN_CMD HOME="$FIX/home" WHEELHOUSE_COMMS_ROOT="$ROOT" WHEELHOUSE_SLACK_API_BASE=http://127.0.0.1:0 WHEELHOUSE_TEAMS_API_BASE=http://127.0.0.1:0 WHEELHOUSE_TELEGRAM_API_BASE=http://127.0.0.1:0 "$@"; }
run_check(){ RC=0; OUT="$(clean_env "$@" bun "$ROOT/seats/channels.ts" check --credentials 2>&1)" || RC=$?; }
has(){ case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }
no_value(){
  ! has "$FAKE" || return 1
  FAKE_CHECK_VALUE="$FAKE" CHECK_ROOT="$ROOT" bun -e '
    const fs=require("fs"), path=require("path"), root=process.env.CHECK_ROOT, token=process.env.FAKE_CHECK_VALUE;
    const files=["seats/channels.json","seats/seats.json"].map(p=>path.join(root,p));
    if(files.some(p=>!fs.existsSync(p))) process.exit(1);
    const ledger=path.join(root,"seats/comms.jsonl"); if(fs.existsSync(ledger)) files.push(ledger);
    function logs(dir){ if(!fs.existsSync(dir)) return; for(const f of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,f.name); if(f.isDirectory()) logs(p); else if(f.isFile()) files.push(p); } }
    logs(path.join(root,"seats/logs"));
    if(files.some(p=>fs.readFileSync(p,"utf8").includes(token))) process.exit(1);
  ' >/dev/null 2>&1
}
fix_named(){ has "$KEY" && has "seats/run/$KIND.token" && has 'mode 0600'; }
mkroot(){
  ROOT="$FIX/$1"; mkdir -p "$ROOT/seats/run" "$FIX/home"; selftest_copy_seat_runtime "$ROOT" "$SOURCE"
  printf '%s\n' '{"commander":{"external":true,"role":"commander"},"seats":{}}' > "$ROOT/seats/seats.json"
}

for KIND in slack teams telegram; do
  mkroot "$KIND"
  printf '{"version":1,"channels":{"sample-%s":{"kind":"%s","destination":"fixture-id","audience":"stakeholders","read":false}}}\n' "$KIND" "$KIND" > "$ROOT/seats/channels.json"
  FAKE="fake-70h7-$KIND-$RANDOM-$RANDOM"
  KEY="WHEELHOUSE_$(printf '%s' "$KIND" | tr '[:lower:]' '[:upper:]')_TOKEN"
  run_check
  if [ "$RC" -eq 2 ] && has "channel sample-$KIND ($KIND)" && fix_named && no_value; then pass "$KIND missing credential STOP names environment and mode-0600 file"; else fail "$KIND missing credential check"; fi
  run_check "$KEY=$FAKE"
  if [ "$RC" -eq 0 ] && has "channel sample-$KIND ($KIND): credential present" && no_value; then pass "$KIND environment credential passes without printing value"; else fail "$KIND environment credential check"; fi
  printf '%s\n' "$FAKE" > "$ROOT/seats/run/$KIND.token"; chmod 600 "$ROOT/seats/run/$KIND.token"
  run_check
  if [ "$RC" -eq 0 ] && has "channel sample-$KIND ($KIND): credential present" && no_value; then pass "$KIND mode-0600 credential file passes without printing value"; else fail "$KIND file credential check"; fi
  chmod 644 "$ROOT/seats/run/$KIND.token"; run_check
  if [ "$RC" -eq 2 ] && fix_named && no_value; then pass "$KIND wrong-mode credential fails without printing value"; else fail "$KIND wrong-mode credential check"; fi
  chmod 600 "$ROOT/seats/run/$KIND.token"; printf '   \n' > "$ROOT/seats/run/$KIND.token"; run_check
  if [ "$RC" -eq 2 ] && has 'empty' && fix_named && no_value; then pass "$KIND empty credential file fails with named fix"; else fail "$KIND empty credential check"; fi
  rm -f "$ROOT/seats/run/$KIND.token"; run_check "$KEY=   "
  if [ "$RC" -eq 2 ] && fix_named && no_value; then pass "$KIND whitespace environment credential is not presence"; else fail "$KIND whitespace credential check"; fi
  if [ "$KIND" = slack ]; then
    RC=0; OUT="$(printf 'hello\n' | clean_env bun "$ROOT/seats/comms.ts" send sample-slack --from-stdin 2>&1)" || RC=$?
    if [ "$RC" -eq 1 ] && has 'STOP: no slack token configured' && fix_named && no_value; then pass 'Slack sanctioned send STOP names both credential routes'; else fail 'Slack send diagnostic'; fi
  fi
done

mkroot multiple
printf '%s\n' '{"version":1,"channels":{"one":{"kind":"slack","destination":"C0ONE","audience":"principal"},"two":{"kind":"slack","destination":"C0TWO","audience":"stakeholders"},"three":{"kind":"teams","destination":"chats/three","audience":"stakeholders"},"four":{"kind":"telegram","destination":"123","audience":"stakeholders"}}}' > "$ROOT/seats/channels.json"
FAKE="fake-70h7-all-$RANDOM-$RANDOM"
run_check "WHEELHOUSE_SLACK_TOKEN=$FAKE" "WHEELHOUSE_TEAMS_TOKEN=$FAKE"
if [ "$RC" -eq 2 ] && has 'channel four (telegram)' && has 'WHEELHOUSE_TELEGRAM_TOKEN' && no_value; then pass 'every declaration checked: later missing kind blocks completion'; else fail 'all-declarations missing credential'; fi
run_check "WHEELHOUSE_SLACK_TOKEN=$FAKE" "WHEELHOUSE_TEAMS_TOKEN=$FAKE" "WHEELHOUSE_TELEGRAM_TOKEN=$FAKE"
if [ "$RC" -eq 0 ] && has 'channel one (slack): credential present' && has 'channel two (slack): credential present' && has 'channel three (teams): credential present' && has 'channel four (telegram): credential present' && has 'channels: 4 declared' && no_value; then pass 'principal, stakeholder, read-false and same-kind channels all have presence rows'; else fail 'all-declarations success'; fi

mkroot command
printf '%s\n' '{"channels":{"graph":{"kind":"teams","destination":"chats/fixture","audience":"stakeholders"}}}' > "$ROOT/seats/channels.json"
FAKE="fake-70h7-command-$RANDOM-$RANDOM"
run_check "FAKE_COMMAND_TOKEN=$FAKE" 'WHEELHOUSE_TEAMS_TOKEN_CMD=printf "%s" "$FAKE_COMMAND_TOKEN"; printf "%s" "$FAKE_COMMAND_TOKEN" >&2'
if [ "$RC" -eq 0 ] && has 'channel graph (teams): credential present' && no_value; then pass 'Teams command credential passes with stdout/stderr values suppressed'; else fail 'Teams command success'; fi
run_check 'WHEELHOUSE_TEAMS_TOKEN_CMD=exit 0'
if [ "$RC" -eq 2 ] && has 'returned no token' && has 'WHEELHOUSE_TEAMS_TOKEN_CMD' && no_value; then pass 'Teams empty command output is not presence'; else fail 'Teams empty command'; fi
BAD_CMD='printf "%s" "$FAKE_COMMAND_TOKEN"; printf "%s" "$FAKE_COMMAND_TOKEN" >&2; exit 7'
run_check "FAKE_COMMAND_TOKEN=$FAKE" "WHEELHOUSE_TEAMS_TOKEN_CMD=$BAD_CMD"
if [ "$RC" -eq 2 ] && has 'teams token command failed' && has 'WHEELHOUSE_TEAMS_TOKEN_CMD' && no_value; then pass 'Teams failed command reveals neither command stdout nor stderr'; else fail 'Teams command failure'; fi
RC=0; OUT="$(clean_env "FAKE_COMMAND_TOKEN=$FAKE" "WHEELHOUSE_TEAMS_TOKEN_CMD=$BAD_CMD" bun "$ROOT/seats/comms.ts" send graph hello 2>&1)" || RC=$?
if [ "$RC" -eq 1 ] && has 'teams token command failed' && no_value && [ -f "$ROOT/seats/comms.jsonl" ] && ! grep -Fq "$FAKE" "$ROOT/seats/comms.jsonl" && ! grep -Fq "$FAKE" "$ROOT/seats/channels.json" && ! grep -Fq "$FAKE" "$ROOT/seats/seats.json"; then pass 'A2: failed send logs and records no command credential value'; else fail 'Teams failed-send credential leak'; fi

if [ "$FAILED" -eq 0 ]; then echo 'channel-credentials.selftest: PASS'; exit 0; fi
printf 'channel-credentials.selftest: FAIL (%s failure(s))\n' "$FAILED"
exit 1
