#!/usr/bin/env bash
# commander-voice-lint.sh — flag commander-facing prose that talks in fleet jargon instead of human tasks.
# Usage: seats/commander-voice-lint.sh <file> [file ...]

set -u

if [ "$#" -eq 0 ]; then
  echo "Usage: seats/commander-voice-lint.sh <file> [file ...]" >&2
  exit 2
fi

FAIL=0
for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "UNRUNNABLE: file not found: $file" >&2
    exit 2
  fi
  if grep -nEi '\bbeads?\b' "$file"; then
    echo "FAIL commander-voice: $file uses bead/beads; name the human task, intent, or outcome instead"
    FAIL=1
  fi
  if grep -nE '\b[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-z]{4}\b' "$file"; then
    echo "FAIL commander-voice: $file uses a bare work id; name the task or outcome instead"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "commander-voice-lint: PASS ($# file(s))"
