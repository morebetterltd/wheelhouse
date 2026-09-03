#!/usr/bin/env bash
# specimen-leak.selftest.sh — prove BOOTSTRAP's specimen grep rejects only specimen leaks.
#
# The specimen-leak list in BOOTSTRAP.md is hand-maintained. Every term in it
# must be checked against current contracts/ and runbooks/ before shipping:
# a term that appears in copied contract prose false-fails every correct
# install. This test keeps that rule executable for the current verifier prose.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "specimen-leak.selftest: missing executable seats/evidence-scrub.sh" >&2; exit 2; }
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-specimen-leak.XXXXXX")"
cleanup() { rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

PATTERN='Ebb|ebb|Tideline|tideline|cordova|headless emulator|app-review|com\.example\.app|learn what a good one looks like|take it when the reviewer starts waiting'
run_grep() {
  grep -rnwE "$PATTERN" CLAUDE.md AGENTS.md wheelhouse/ 2>&1
}

INSTALL="$FIX/install"
mkdir -p "$INSTALL/wheelhouse/crew" "$INSTALL/wheelhouse/fleet"
printf '# Consumer CLAUDE\n\nNo specimen project here.\n' > "$INSTALL/CLAUDE.md"
printf '# Consumer AGENTS\n\nNo specimen project here.\n' > "$INSTALL/AGENTS.md"
cp -R "$ROOT/contracts" "$INSTALL/wheelhouse/contracts"
cp -R "$ROOT/runbooks" "$INSTALL/wheelhouse/runbooks"
cp "$ROOT/contracts/VERIFIER.md" "$INSTALL/wheelhouse/crew/VERIFIER.md"
cp "$ROOT/contracts/WORKER.md" "$INSTALL/wheelhouse/fleet/WORKER.md"

printf 'specimen-leak selftest: current install fixture\n'
(
  cd "$INSTALL" || exit 2
  set +e
  OUT="$(run_grep)"
  RC=$?
  set -e
  if [ "$RC" -eq 1 ]; then
    pass "prescribed grep passes with current VERIFIER.md mentioning an emulator command"
  else
    printf '%s\n' "$OUT"
    fail "prescribed grep false-failed on current contracts/runbooks (exit $RC)"
  fi
)

PLANTED="$FIX/planted"
cp -R "$INSTALL" "$PLANTED"
cp "$ROOT/generated/CLAUDE.md.example" "$PLANTED/wheelhouse/crew/CLAUDE.md"
printf '\nspecimen-leak selftest: planted whole-file specimen copy\n'
(
  cd "$PLANTED" || exit 2
  set +e
  OUT="$(run_grep)"
  RC=$?
  set -e
  if [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -Eq 'Ebb|Tideline'; then
    pass "prescribed grep bites a planted whole-file generated specimen copy"
  else
    printf '%s\n' "$OUT"
    fail "prescribed grep missed planted specimen copy (exit $RC)"
  fi
)

if [ "$FAILED" -eq 0 ]; then
  echo "specimen-leak.selftest: PASS (2 legs)"
  exit 0
fi
printf 'specimen-leak.selftest: FAIL (%s failure(s))\n' "$FAILED"
exit 1
