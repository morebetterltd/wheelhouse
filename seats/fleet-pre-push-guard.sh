#!/usr/bin/env bash
set -eu

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

# All discovery is local. Never source install data or query a remote's HEAD.
DEFAULT=""
if [ -f "$ROOT/wheelhouse/.template-source" ]; then
  DEFAULT=$(awk '/^merge-target=/ {sub(/^merge-target=/, ""); sub(/\r$/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); if (length) {print; exit}}' "$ROOT/wheelhouse/.template-source")
fi
if [ -z "$DEFAULT" ]; then
  DEFAULT=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
fi
normalize_ref() {
  case "$1" in
    refs/heads/*) printf '%s\n' "$1" ;;
    refs/remotes/*) local short="${1#refs/remotes/}"; printf 'refs/heads/%s\n' "${short#*/}" ;;
    origin/*) printf 'refs/heads/%s\n' "${1#origin/}" ;;
    *) printf 'refs/heads/%s\n' "$1" ;;
  esac
}
if [ -n "$DEFAULT" ]; then DEFAULT=$(normalize_ref "$DEFAULT"); fi
is_integration_ref() {
  [ -z "$DEFAULT" ] || [ "$1" != "$DEFAULT" ] || return 0
  if [ -f "$ROOT/seats/integration-refs.txt" ]; then
    local entry
    while IFS= read -r entry || [ -n "$entry" ]; do
      entry=$(printf '%s\n' "$entry" | awk '{sub(/#.*/, ""); sub(/\r$/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print}')
      [ -z "$entry" ] || [ "$(normalize_ref "$entry")" != "$1" ] || return 0
    done < "$ROOT/seats/integration-refs.txt"
  fi
  return 1
}

allowed="${WHEELHOUSE_INTEGRATOR_PUSH:-}"
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/fleet/*)
      if [ "$allowed" != "1" ]; then
        printf '%s\n' "wheelhouse pre-push guard: refusing push to $remote_ref; fleet/* branches may be published only by the commander/integrator path (WHEELHOUSE_INTEGRATOR_PUSH=1)." >&2
        exit 1
      fi
      ;;
  esac
  # The fleet publication license above never licenses missing merge evidence.
  case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac # deletion has no new commits
  if ! is_integration_ref "$remote_ref"; then
    if [ -z "$DEFAULT" ]; then
      case "$remote_ref" in refs/heads/fleet/*) continue ;; esac
      printf '%s\n' "wheelhouse pre-push guard: REFUSED: cannot identify the default integration line from local metadata, so cannot safely check this branch push. Fix locally with 'git remote set-head origin <default-branch>' (no network), or set merge-target=<default-branch> in wheelhouse/.template-source." >&2
      exit 1
    fi
    continue
  fi
  case "$remote_sha" in
    *[!0]*) merges=$(git rev-list --first-parent --merges "$local_sha" "^$remote_sha" --) ;;
    *) merges=$(git rev-list --first-parent --merges "$local_sha" --) ;;
  esac
  for merge in $merges; do
    subject=$(git show -s --format=%s "$merge")
    bead_pattern='fleet/([A-Za-z0-9][A-Za-z0-9._-]*)'
    if [[ "$subject" =~ $bead_pattern ]]; then
      bead="${BASH_REMATCH[1]}"
      parents=$(git show -s --format=%P "$merge")
      # Ordered parents from Git: the second is the exact work tip integrated.
      read -r first tip remaining <<< "$parents"
      if [ -z "$tip" ] || ! bun "$ROOT/seats/merge-gate-receipt.ts" "$ROOT/seats/verdicts/$bead.merge-gate.json" "$bead" "$tip"; then
        printf '%s\n' "wheelhouse pre-push guard: REFUSED: $bead merged tip $tip at $merge has no passing merge-gate receipt. Run: bun seats/merge-gate.ts $bead $tip --repo <pushed-repository> before publishing $remote_ref." >&2
        exit 1
      fi
    fi
  done
done
