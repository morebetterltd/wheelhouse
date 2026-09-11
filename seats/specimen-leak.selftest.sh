#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
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

FAILED=0
SKIPPED=0
scrub() { "$SCRUB"; }
say() { printf '%s\n' "$*" | scrub; }
pass() { printf '  ok    %s\n' "$*" | scrub; }
fail() { printf '  FAIL  %s\n' "$*" | scrub; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*" | scrub; SKIPPED=$((SKIPPED + 1)); }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-specimen-leak.XXXXXX")"
cleanup() { selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

PATTERN='Ebb|ebb|Tideline|tideline|cordova|headless emulator|app-review|com\.example\.app|learn what a good one looks like|take it when the reviewer starts waiting'
if [ "${WHEELHOUSE_SPECIMEN_LEAK_FORCE_MISS:-}" = 1 ]; then
  PATTERN='THIS_PATTERN_SHOULD_NOT_MATCH_THE_PLANTED_SPECIMEN'
fi
run_grep() {
  grep -rnwE "$PATTERN" CLAUDE.md wheelhouse/ 2>&1
}

require_template_fixture() {
  local missing=0
  for p in "$ROOT/contracts/VERIFIER.md" "$ROOT/contracts/WORKER.md" "$ROOT/runbooks" "$ROOT/generated/CLAUDE.md.example"; do
    if [ ! -e "$p" ]; then
      skip "template fixture input missing: $p (run from a template checkout to exercise specimen planting)"
      missing=1
    fi
  done
  return "$missing"
}

build_install_fixture() {
  local install="$1"
  mkdir -p "$install/wheelhouse/crew" "$install/wheelhouse/fleet"
  printf '# Consumer CLAUDE\n\nNo specimen project here.\n' > "$install/CLAUDE.md"
  printf '# Product AGENTS\n\nThe product owns this root file.\n' > "$install/AGENTS.md"
  printf '# Wheelhouse AGENTS\n\nNo specimen project here.\n' > "$install/wheelhouse/AGENTS.md"
  cp -R "$ROOT/contracts" "$install/wheelhouse/contracts" || return 1
  cp -R "$ROOT/runbooks" "$install/wheelhouse/runbooks" || return 1
  cp "$ROOT/contracts/VERIFIER.md" "$install/wheelhouse/crew/VERIFIER.md" || return 1
  cp "$ROOT/contracts/WORKER.md" "$install/wheelhouse/fleet/WORKER.md" || return 1
}

run_current_leg() {
  local install="$1" old rc out
  say 'specimen-leak selftest: current install fixture'
  old="$PWD"
  cd "$install" || { fail "could not cd to current install fixture: $install"; return; }
  set +e
  out="$(run_grep)"
  rc=$?
  set -e
  cd "$old" || exit 2
  if [ "$rc" -eq 1 ]; then
    pass "prescribed grep passes with current VERIFIER.md mentioning an emulator command"
  else
    printf '%s\n' "$out" | scrub
    fail "prescribed grep false-failed on current contracts/runbooks (exit $rc)"
  fi
}

run_planted_leg() {
  local install="$1" planted="$2" old rc out
  cp -R "$install" "$planted" || { fail "could not copy planted fixture"; return; }
  cp "$ROOT/generated/CLAUDE.md.example" "$planted/wheelhouse/crew/CLAUDE.md" || { fail "could not plant generated/CLAUDE.md.example"; return; }
  printf '\n' | scrub
  say 'specimen-leak selftest: planted whole-file specimen copy'
  old="$PWD"
  cd "$planted" || { fail "could not cd to planted fixture: $planted"; return; }
  set +e
  out="$(run_grep)"
  rc=$?
  set -e
  cd "$old" || exit 2
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -Eq 'Ebb|Tideline'; then
    pass "prescribed grep bites a planted whole-file generated specimen copy"
  else
    printf '%s\n' "$out" | scrub
    fail "prescribed grep missed planted specimen copy (exit $rc)"
  fi
}

run_negative_control() {
  local out rc
  [ "${WHEELHOUSE_SPECIMEN_LEAK_FORCE_MISS:-}" = 1 ] && return 0
  printf '\n' | scrub
  say 'specimen-leak selftest: negative control — planted specimen with forced miss'
  set +e
  out="$(WHEELHOUSE_SPECIMEN_LEAK_FORCE_MISS=1 bash "$0" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'FAIL  prescribed grep missed planted specimen copy'; then
    pass "forced-miss planted specimen exits non-zero and prints FAIL"
  else
    printf '%s\n' "$out" | scrub
    fail "forced-miss planted specimen did not fail honestly (exit $rc)"
  fi
}

if require_template_fixture; then
  INSTALL="$FIX/install"
  if build_install_fixture "$INSTALL"; then
    run_current_leg "$INSTALL"
    run_planted_leg "$INSTALL" "$FIX/planted"
    run_negative_control
  else
    fail "could not build install fixture from template contracts/runbooks"
  fi
fi

if [ "$FAILED" -eq 0 ] && [ "$SKIPPED" -eq 0 ]; then
  say "specimen-leak.selftest: PASS (3 legs)"
  exit 0
fi
if [ "$FAILED" -eq 0 ]; then
  say "specimen-leak.selftest: SKIP ($SKIPPED skipped fixture input(s))"
  exit 0
fi
printf 'specimen-leak.selftest: FAIL (%s failure(s), %s skipped)\n' "$FAILED" "$SKIPPED" | scrub
exit 1
