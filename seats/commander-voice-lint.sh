#!/usr/bin/env bash
# commander-voice-lint.sh — flag commander-facing prose that talks in fleet jargon instead of human tasks.
# Usage: seats/commander-voice-lint.sh <file> [file ...]

set -u

if [ "$#" -eq 0 ]; then
  echo "Usage: seats/commander-voice-lint.sh <file> [file ...]" >&2
  exit 2
fi

find_namespace() {
  local dir="$PWD" source prefix
  while :; do
    source="$dir/wheelhouse/.template-source"
    if [ -f "$source" ]; then
      prefix="$(awk -F= '$1=="namespace" {print $2; exit}' "$source")"
      if [ -n "$prefix" ]; then printf '%s\n' "$prefix"; return 0; fi
    fi
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done
  prefix="$(bd info 2>/dev/null | awk -F' = ' '$1 ~ /^[[:space:]]*issue_prefix$/ {print $2; exit}')"
  if [ -n "$prefix" ] && [ "$prefix" != "<none>" ]; then printf '%s\n' "$prefix"; return 0; fi
  return 1
}

regex_escape() {
  printf '%s' "$1" | sed 's/[][\\.^$*+?{}()|]/\\&/g'
}

NAMESPACE="$(find_namespace || true)"
if [ -z "$NAMESPACE" ]; then
  echo "UNRUNNABLE: could not determine graph namespace from wheelhouse/.template-source or bd info" >&2
  exit 2
fi
NS_RE="$(regex_escape "$NAMESPACE")"
ISSUE_SUFFIX='[0-9a-z]{3,8}(\.[0-9]+)?'
FULL_ID_RE="\\b${NS_RE}-${ISSUE_SUFFIX}\\b"
PAREN_BARE_ID_RE="\\(${ISSUE_SUFFIX}\\)"

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
  if grep -nE "$FULL_ID_RE|$PAREN_BARE_ID_RE" "$file"; then
    echo "FAIL commander-voice: $file uses a bare work id; name the task or outcome instead"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "commander-voice-lint: PASS ($# file(s), namespace=$NAMESPACE)"
