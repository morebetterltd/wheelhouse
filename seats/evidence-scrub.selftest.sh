#!/usr/bin/env bash
# evidence-scrub.selftest.sh — proves the evidence scrubber redacts planted
# machine-shaped paths before a capture is written.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRUB="${1:-$HERE/evidence-scrub.sh}"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }

FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-evidence-scrub-selftest.$$.XXXXXX")"
trap 'rm -rf "$FIX"' EXIT INT TERM
OUT="$FIX/capture.txt"

USER_RAW="$(id -un 2>/dev/null || true)"
HOME_RAW="${HOME:-/Users/$USER_RAW}"
TMP_RAW="${TMPDIR:-/tmp}"

"$SCRUB" -o "$OUT" -- bash -c 'printf "tmp=%s\nvar=%s\nhome=%s\nuser=%s\n" "$1" "/var/folders/zz/planted/path/file.log" "$2/Library/planted" "$3"' _ "$TMP_RAW/wheelhouse.planted/file.log" "$HOME_RAW" "$USER_RAW"
RC=$?
if [ $RC -eq 0 ] && [ -s "$OUT" ]; then pass "capture command writes a non-empty scrubbed evidence file"
else fail "capture command failed or wrote no evidence (rc=$RC)"; fi

if grep -q '\[tmpdir\]' "$OUT" && grep -q '\[home\]' "$OUT" && grep -q '\[user\]' "$OUT"; then
  pass "planted tmp, home, and username values are redacted"
else
  fail "scrubbed capture is missing one or more placeholders: $(tr '\n' ' ' < "$OUT")"
fi

LEAKS=0
[ -n "$USER_RAW" ] && grep -qF "$USER_RAW" "$OUT" && LEAKS=$((LEAKS + 1))
grep -qF "$HOME_RAW" "$OUT" && LEAKS=$((LEAKS + 1))
grep -qF "/var/folders/zz/planted/path" "$OUT" && LEAKS=$((LEAKS + 1))
grep -qF "$TMP_RAW/wheelhouse.planted" "$OUT" && LEAKS=$((LEAKS + 1))
if [ $LEAKS -eq 0 ]; then pass "scrubbed capture contains none of the planted raw values"
else fail "scrubbed capture leaked $LEAKS planted raw value(s): $(tr '\n' ' ' < "$OUT")"; fi

if [ $FAILED -eq 0 ]; then
  printf '\nevidence-scrub.selftest: PASS\n'
  exit 0
fi
printf '\nevidence-scrub.selftest: FAIL (%s)\n' "$FAILED"
exit 1
