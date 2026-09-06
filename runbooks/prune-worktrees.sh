#!/usr/bin/env bash
# Compatibility pointer: pruning now lives in the template-owned Bun tool.
set -eu
cat >&2 <<'EOF'
runbooks/prune-worktrees.sh is retired.
Use the canonical tool from the install root:
  bun seats/prune.ts scan > prune.tsv
  bun seats/prune.ts prune --from-file prune.tsv --yes --categories merged-worktree,orphaned-worktree,build-cache
Review the scan before adding --yes; prune is dry-run by default.
EOF
exit 64
