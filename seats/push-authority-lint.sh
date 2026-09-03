#!/usr/bin/env bash
# push-authority-lint.sh — flag reviewer PUSH lines that contradict recorded authority.
# Usage: seats/push-authority-lint.sh [project-root] [verdict-file ...]
# If no verdict files are named, scans seats/verdicts/*.md when present.

set -u

ROOT="${1:-.}"
if [ $# -gt 0 ]; then shift; fi
INTEGRATOR="$ROOT/wheelhouse/INTEGRATOR.md"
[ -f "$INTEGRATOR" ] || INTEGRATOR="$ROOT/contracts/INTEGRATOR.md"
[ -f "$INTEGRATOR" ] || { echo "UNRUNNABLE: no wheelhouse/INTEGRATOR.md or contracts/INTEGRATOR.md under $ROOT" >&2; exit 2; }

PROJECT_SECTION=$(awk 'found {print} /^## This project$/ {found=1}' "$INTEGRATOR")
if printf '%s\n' "$PROJECT_SECTION" | grep -Eiq 'push(es|ing)?[[:space:]].*(main|origin|remote|repo|repositories)|standing[[:space:]-]+authori[sz].*push|commander.*pushes'; then
  GRANTS_PUSH=1
else
  GRANTS_PUSH=0
fi

FILES=""
if [ $# -gt 0 ]; then
  for f in "$@"; do FILES="$FILES
$f"; done
elif [ -d "$ROOT/seats/verdicts" ]; then
  FILES=$(find "$ROOT/seats/verdicts" -type f -name '*.md' -print | sort)
fi

FAIL=0
COUNT=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || { echo "UNRUNNABLE: verdict file not found: $f" >&2; exit 2; }
  COUNT=$((COUNT+1))
  if [ "$GRANTS_PUSH" -eq 1 ] && grep -nEi '^PUSH:[[:space:]]*HOLD.*principal[ -]?only|^PUSH:.*principal[ -]?only' "$f" >/tmp/push-authority-hit.$$; then
    while IFS= read -r hit; do
      printf 'FAIL push-authority: %s:%s contradicts INTEGRATOR.md project push grant\n' "$f" "$hit"
    done < /tmp/push-authority-hit.$$
    FAIL=1
  fi
  rm -f /tmp/push-authority-hit.$$
done <<EOF_FILES
$FILES
EOF_FILES

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
printf 'push-authority-lint: PASS (grant=%s, verdicts=%s)\n' "$GRANTS_PUSH" "$COUNT"
