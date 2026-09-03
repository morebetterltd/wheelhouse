#!/usr/bin/env bash
# placeholder-grep.selftest.sh — prove BOOTSTRAP's placeholder grep is text-only.
#
# A clean install can carry binary evidence under wheelhouse/evidence. The
# placeholder check must not let grep's "Binary file ... matches" rendering turn
# bytes inside a PNG into an unfilled text placeholder.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "placeholder-grep.selftest: missing executable seats/evidence-scrub.sh" >&2; exit 2; }
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-placeholder-grep.XXXXXX")"
cleanup() { rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

run_placeholder_check() {
  grep -rIn "{{" CLAUDE.md wheelhouse/ 2>&1 | grep -v "^wheelhouse/runbooks/"
}

INSTALL="$FIX/install"
mkdir -p "$INSTALL/wheelhouse/evidence" "$INSTALL/wheelhouse/runbooks"
printf '# Consumer CLAUDE\n\nNo placeholder here.\n' > "$INSTALL/CLAUDE.md"
printf '# copied runbook may mention {{DOUBLE_BRACE}} and is excluded\n' > "$INSTALL/wheelhouse/runbooks/NOTE.md"
# PNG signature + bytes that include the placeholder opener. This is not a text
# file and must not make grep print "Binary file ... matches".
printf '\211PNG\r\n\032\n\000\000binary {{ bytes inside committed evidence\000\377\n' > "$INSTALL/wheelhouse/evidence/brace-pair.png"

printf 'placeholder grep selftest: binary evidence fixture\n'
(
  cd "$INSTALL" || exit 2
  set +e
  OUT="$(run_placeholder_check)"
  RC=$?
  set -e
  if [ "$RC" -eq 1 ] && [ -z "$OUT" ]; then
    pass "text-only grep ignores a PNG carrying the {{ byte pair"
  else
    printf '%s\n' "$OUT"
    fail "binary evidence tripped the placeholder grep (exit $RC)"
  fi
)

printf 'this is a real {{TEXT_PLACEHOLDER}}\n' > "$INSTALL/wheelhouse/CLAIM.md"
printf '\nplaceholder grep selftest: planted text placeholder\n'
(
  cd "$INSTALL" || exit 2
  set +e
  OUT="$(run_placeholder_check)"
  RC=$?
  set -e
  if [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'wheelhouse/CLAIM.md:1:this is a real {{TEXT_PLACEHOLDER}}'; then
    pass "text placeholder still fails the prescribed check"
  else
    printf '%s\n' "$OUT"
    fail "planted text placeholder did not trip the check (exit $RC)"
  fi
)

if [ "$FAILED" -eq 0 ]; then
  echo "placeholder-grep.selftest: PASS (2 legs)"
  exit 0
fi
printf 'placeholder-grep.selftest: FAIL (%s failure(s))\n' "$FAILED"
exit 1
