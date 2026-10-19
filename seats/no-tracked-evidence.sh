#!/usr/bin/env bash
# Task reports belong on the bead, never in the public source tree.
# Check both the index (including forced adds) and HEAD (including staged
# deletions). Ignored, untracked local captures are not published artifacts.
set -eu

[ "$#" -le 1 ] || { echo 'usage: no-tracked-evidence.sh [repo-or-subdirectory]' >&2; exit 2; }
repo="${1:-$(cd "$(dirname "$0")/.." && pwd -P)}"
tracked_index="$(git -C "$repo" ls-files -- ':(top,literal)evidence/')" || {
  echo 'STOP: cannot inspect the Git index for tracked evidence/' >&2
  exit 2
}
tracked_head="$(git -C "$repo" ls-tree -r --full-tree --name-only HEAD -- evidence/)" || {
  echo 'STOP: cannot inspect HEAD for tracked evidence/' >&2
  exit 2
}
if [ -n "$tracked_index" ] || [ -n "$tracked_head" ]; then
  echo 'STOP: tracked evidence/ is forbidden; post task reports and decisive output on the bead, not in the repository.' >&2
  exit 1
fi
