#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
CHANNELS="${1:-$HERE/channels.ts}"
EXAMPLE="$HERE/channels.json.example"
[ -f "$CHANNELS" ] || { echo "selftest: not found: $CHANNELS" >&2; exit 2; }
[ -f "$EXAMPLE" ] || { echo "selftest: not found: $EXAMPLE" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }

FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-channels-selftest.XXXXXX")" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM

mkroot(){ local r="$1"; mkdir -p "$r/seats"; selftest_copy_seat_runtime "$r" "$HERE"; }
run(){ local r="$1"; shift; RC=0; OUT="$(WHEELHOUSE_COMMS_ROOT="$r" bun "$r/seats/channels.ts" "$@" 2>&1)" || RC=$?; }
write_json(){ local r="$1" body="$2"; mkdir -p "$r/seats"; printf '%s\n' "$body" > "$r/seats/channels.json"; }

phase 'example parses and lists three declared channels'
ROOT1="$FIX/example"; mkroot "$ROOT1"; cp "$EXAMPLE" "$ROOT1/seats/channels.json"
run "$ROOT1" list
if [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q '^principal-telegram telegram principal .* read=no members=0$' && printf '%s\n' "$OUT" | grep -q '^stakeholders-slack slack stakeholders C0EXAMPLE read=yes members=2$' && printf '%s\n' "$OUT" | grep -q '^stakeholders-teams teams stakeholders .* read=no members=0$'; then
  pass 'example file parses and list prints the three expected rows'
else fail "example list wrong rc=$RC: $OUT"; fi

phase 'absent and empty files are principal-only'
ROOT2="$FIX/absent"; mkroot "$ROOT2"; run "$ROOT2" check
[ "$RC" -eq 0 ] && [ "$OUT" = 'channels: none declared (principal-only)' ] && pass 'absent file is principal-only' || fail "absent check rc=$RC: $OUT"
ROOT3="$FIX/empty"; mkroot "$ROOT3"; write_json "$ROOT3" '{"channels":{}}'; run "$ROOT3" check
[ "$RC" -eq 0 ] && [ "$OUT" = 'channels: none declared (principal-only)' ] && pass 'empty channels object is principal-only' || fail "empty check rc=$RC: $OUT"

phase 'invalid files STOP with exit 2'
ROOT4="$FIX/bad-json"; mkroot "$ROOT4"; printf '{"version":1,"channels":' > "$ROOT4/seats/channels.json"; run "$ROOT4" check
[ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q '^STOP: seats/channels.json:' && pass 'malformed JSON exits 2 with STOP' || fail "malformed JSON rc=$RC: $OUT"
ROOT5="$FIX/two-principals"; mkroot "$ROOT5"; write_json "$ROOT5" '{"version":1,"channels":{"one":{"kind":"telegram","destination":"@one","audience":"principal"},"two":{"kind":"slack","destination":"C0EXAMPLE","audience":"principal"}}}' ; run "$ROOT5" check
[ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'at most one channel' && pass 'two principal channels exit 2' || fail "two principals rc=$RC: $OUT"
ROOT6="$FIX/token"; mkroot "$ROOT6"; TOKEN="$(printf 'xox%s-%s-%s' b 123456789012 secret)"; write_json "$ROOT6" "{\"version\":1,\"channels\":{\"bad\":{\"kind\":\"slack\",\"destination\":\"$TOKEN\",\"audience\":\"stakeholders\"}}}"; run "$ROOT6" check
if [ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q '^STOP: seats/channels.json:' && ! printf '%s\n' "$OUT" | grep -qF "$TOKEN"; then pass 'credential-shaped xoxb destination exits 2 without echoing the token'; else fail "credential leak/rc wrong rc=$RC: $OUT"; fi
ROOT7="$FIX/discord"; mkroot "$ROOT7"; write_json "$ROOT7" '{"version":1,"channels":{"bad":{"kind":"discord","destination":"D0EXAMPLE","audience":"stakeholders"}}}'; run "$ROOT7" check
[ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'kind must be' && pass 'unknown kind discord exits 2' || fail "discord rc=$RC: $OUT"
ROOT8="$FIX/reed"; mkroot "$ROOT8"; write_json "$ROOT8" '{"version":1,"channels":{"bad":{"kind":"slack","destination":"C0EXAMPLE","audience":"stakeholders","reed":true}}}'; run "$ROOT8" check
[ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'unknown key.*reed' && pass 'unknown channel key reed exits 2' || fail "reed rc=$RC: $OUT"

phase 'canary: duplicate-principal leg catches a broken loader'
SAB="$FIX/channels-no-dup-check.ts"
perl -0pe 's/if \(principalCount > 1\) fail\("at most one channel may have audience principal"\);/\/\/ duplicate principal check removed by canary/ or die "canary replacement missed\n"' "$CHANNELS" > "$SAB" || exit 2
ROOT9="$FIX/canary"; mkdir -p "$ROOT9/seats"; selftest_copy_seat_runtime "$ROOT9" "$HERE"; cp "$SAB" "$ROOT9/seats/channels.ts"; write_json "$ROOT9" '{"version":1,"channels":{"one":{"kind":"telegram","destination":"@one","audience":"principal"},"two":{"kind":"slack","destination":"C0EXAMPLE","audience":"principal"}}}' ; run "$ROOT9" check
if [ "$RC" -eq 0 ]; then pass 'canary: removing duplicate-principal check makes the planted duplicate leg fail'
else fail "canary did not produce the expected broken-loader false pass rc=$RC: $OUT"; fi

if [ "$FAILED" -eq 0 ]; then
  echo 'channels.selftest: PASS'
  exit 0
fi
printf 'channels.selftest: FAIL (%s failure(s))\n' "$FAILED"
exit 1
