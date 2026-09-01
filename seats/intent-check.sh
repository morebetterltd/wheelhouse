#!/bin/sh
# Intent gate for integrate/close.
#
# Read-only by construction: this script runs only git log/rev-parse/show,
# bd list/show/comments, and shell text processing. It never writes to the graph,
# the ISA, or any repository.
#
# What it cannot distinguish: a present `Trace: ` line that is false, an ISA
# Claim appended without real evidence, or a merge whose `no claim moved,
# because ...` comment is wrong. It checks presence and motion, not truth.

set -eu

UNRUNNABLE=2
failures=0

say() { printf '%s\n' "$*"; }
fail() { failures=$((failures + 1)); say "FAIL: $*"; }

find_root() {
  dir=${1:-$(pwd)}
  while :; do
    if [ -f "$dir/wheelhouse/ISA.md" ] && [ -d "$dir/.beads" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    parent=$(dirname "$dir")
    [ "$parent" != "$dir" ] || return 1
    dir=$parent
  done
}

root=$(find_root "$(pwd)") || {
  say "UNRUNNABLE: cannot find install root containing wheelhouse/ISA.md and .beads from $(pwd)"
  exit "$UNRUNNABLE"
}
cd "$root"

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  say "UNRUNNABLE: install root is not in a git repository, so wheelhouse/ISA.md history cannot be checked"
  exit "$UNRUNNABLE"
fi
if ! git ls-files --error-unmatch wheelhouse/ISA.md >/dev/null 2>&1; then
  say "UNRUNNABLE: wheelhouse/ISA.md is not committed/tracked here; .git/info/exclude-style installs cannot prove claim movement from git history"
  exit "$UNRUNNABLE"
fi
isa_commit=$(git log -n 1 --format=%H -- wheelhouse/ISA.md || true)
if [ -z "$isa_commit" ]; then
  say "UNRUNNABLE: wheelhouse/ISA.md has no committed history; cannot check merges since the last ISA movement"
  exit "$UNRUNNABLE"
fi
isa_time=$(git show -s --format=%cI "$isa_commit")

repo_list=$(mktemp)
merge_list=$(mktemp)
issue_list=$(mktemp)
closed_review_list=$(mktemp)
id_list=$(mktemp)
show_json=$(mktemp)
comments_json=$(mktemp)
trap 'rm -f "$repo_list" "$merge_list" "$issue_list" "$closed_review_list" "$id_list" "$show_json" "$comments_json"' EXIT HUP INT TERM

if [ "$#" -gt 0 ]; then
  for repo in "$@"; do
    printf '%s\n' "$repo" >>"$repo_list"
  done
elif [ -f wheelhouse/.template-source ] && grep -Eq '^(repo|repos|product_repo|product_repos)=' wheelhouse/.template-source; then
  sed -n 's/^repo=//p; s/^repos=//p; s/^product_repo=//p; s/^product_repos=//p' wheelhouse/.template-source |
    tr ',:' '\n\n' |
    sed '/^[[:space:]]*$/d' >"$repo_list"
elif git rev-parse --show-toplevel >/dev/null 2>&1; then
  git rev-parse --show-toplevel >"$repo_list"
else
  find . -mindepth 1 -maxdepth 2 \( -name .git -type d -o -name .git -type f \) -print |
    sed 's|/\.git$||' >"$repo_list"
fi

while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    fail "not a git repository: $repo"
    continue
  fi
  branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  if [ -z "$branch" ]; then
    fail "cannot determine merge target branch for $repo (detached HEAD); pass a checked-out target repository"
    continue
  fi
  git -C "$repo" log --merges --since="$isa_time" --format='%H%x09%s' "$branch" >"$merge_list"
  while IFS="$(printf '\t')" read -r merge subject; do
    [ -n "$merge" ] || continue
    case "$merge" in "$isa_commit") continue ;; esac
    bead=$(printf '%s\n' "$subject" | sed -n 's/.*fleet\/\([^: ]*\).*/\1/p' | head -1)
    if [ -z "$bead" ]; then
      fail "merge $merge on $repo/$branch is after ISA commit $isa_commit and its subject names no fleet/<bead-id>"
      continue
    fi
    if ! bd comments "$bead" --json >"$comments_json" 2>/dev/null; then
      fail "merge $merge names $bead, but bd comments for that bead could not be read"
      continue
    fi
    if ! grep -qi 'no claim moved, because' "$comments_json"; then
      fail "merge $merge ($bead) landed after ISA commit $isa_commit without ISA movement and without a 'no claim moved, because' bead comment"
    fi
  done <"$merge_list"
done <"$repo_list"

if ! bd list --status closed --label needs-review --limit 0 --json >"$closed_review_list"; then
  say "UNRUNNABLE: bd list --status closed --label needs-review --json failed; cannot check review-queue closure discipline"
  exit "$UNRUNNABLE"
fi
sed -n 's/^[[:space:]]*"id": "\([^"]*\)".*/\1/p' "$closed_review_list" >"$id_list"
while IFS= read -r id; do
  [ -n "$id" ] || continue
  fail "bead $id is closed while still labelled needs-review; only the commander/integrator closes after review and must drop the review-queue label in the same breath"
done <"$id_list"

if ! bd list --status open,in_progress --limit 0 --json >"$issue_list"; then
  say "UNRUNNABLE: bd list --json failed; cannot check Trace: presence"
  exit "$UNRUNNABLE"
fi
sed -n 's/^[[:space:]]*"id": "\([^"]*\)".*/\1/p' "$issue_list" >"$id_list"
while IFS= read -r id; do
  [ -n "$id" ] || continue
  if ! bd show "$id" --json >"$show_json"; then
    fail "could not read bead $id with bd show --json"
    continue
  fi
  if grep -q '"description": .*Trace: ' "$show_json"; then
    continue
  fi
  if awk '
    /^[[:space:]]*"dependencies": \[/ { exit }
    /^[[:space:]]*"labels": \[/ { in_labels=1; next }
    in_labels && /^[[:space:]]*\]/ { in_labels=0 }
    in_labels && /"wheelhouse-bootstrap"|"wheelhouse-smoke"/ { found=1 }
    END { exit(found ? 0 : 1) }
  ' "$show_json"; then
    continue
  fi
  if grep -q '"title": "Report [^"]* issue:' "$show_json"; then
    continue
  fi
  title=$(sed -n 's/^[[:space:]]*"title": "\([^"]*\)".*/\1/p' "$show_json" | head -1)
  fail "bead $id has no literal Trace: line in its description: $title"
done <"$id_list"

if [ "$failures" -ne 0 ]; then
  say "intent-check: FAIL ($failures finding(s))"
  exit 1
fi

say "intent-check: PASS"
exit 0
