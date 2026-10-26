#!/usr/bin/env bash
set -eu

die() { echo "install-fleet-pre-push-guard: $*" >&2; exit 1; }
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die 'not in a git repository'
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
GUARD="$SCRIPT_DIR/fleet-pre-push-guard.sh"
[ -x "$GUARD" ] || die "guard is not executable: $GUARD"
printf -v GUARD_Q '%q' "$GUARD"

# Resolve the product before changing either repository. Never source this data
# as shell, and never silently treat a missing product as the container.
PRODUCT=""
if [ -f "$ROOT/wheelhouse/.template-source" ]; then
  PRODUCT=$(awk '/^product-repo=/ {sub(/^product-repo=/, ""); sub(/\r$/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); if (length) {print; exit}}' "$ROOT/wheelhouse/.template-source")
fi
if [ -n "$PRODUCT" ]; then
  case "$PRODUCT" in /*) ;; *) PRODUCT="$ROOT/$PRODUCT" ;; esac
  PRODUCT=$(cd "$PRODUCT" 2>/dev/null && pwd -P) || die 'product-repo is not an accessible directory'
  PRODUCT_ROOT=$(git -C "$PRODUCT" rev-parse --show-toplevel 2>/dev/null) || die "product-repo is not a Git repository: $PRODUCT"
  [ "$PRODUCT" = "$(cd "$PRODUCT_ROOT" && pwd -P)" ] || die "product-repo must name a Git repository root: $PRODUCT"
fi

HOOK_TMP=""
trap '[ -z "$HOOK_TMP" ] || rm -f "$HOOK_TMP"' EXIT
install_repo() {
  local repo="$1" hooks_dir hook prev prev_q
  # --git-path handles default common hooks in linked worktrees as well as
  # core.hooksPath; normalize relative paths so seat worktrees share the hook.
  hooks_dir=$(git -C "$repo" rev-parse --git-path hooks)
  case "$hooks_dir" in /*) ;; *) hooks_dir="$repo/$hooks_dir" ;; esac
  mkdir -p "$hooks_dir"
  hooks_dir=$(cd "$hooks_dir" && pwd -P)
  git -C "$repo" config core.hooksPath "$hooks_dir"
  hook="$hooks_dir/pre-push"
  prev="$hooks_dir/pre-push.before-wheelhouse-fleet-guard"
  HOOK_TMP=$(mktemp "$hooks_dir/.wheelhouse-pre-push.XXXXXX")

  if [ -f "$hook" ] && grep -qxF '# wheelhouse fleet pre-push guard' "$hook"; then
    # Refresh an older wrapper's possibly dangling GUARD without wrapping it
    # again or losing its PREV (which may have a collision suffix). Shared
    # hooks paths reach this branch on the second repo and on every upgrade.
    GUARD_ASSIGNMENT="GUARD=$GUARD_Q" awk '
      /^GUARD=/ {print ENVIRON["GUARD_ASSIGNMENT"]; n++; next}
      {print}
      END {if (n != 1) exit 1}
    ' "$hook" > "$HOOK_TMP" || die "cannot refresh guard assignment in $hook"
  else
    if [ -e "$hook" ] || [ -L "$hook" ]; then
      [ -f "$hook" ] || [ -L "$hook" ] || die "pre-push is not a file: $hook"
      if [ -e "$prev" ] || [ -L "$prev" ]; then
        prev=$(mktemp "$hooks_dir/pre-push.before-wheelhouse-fleet-guard.XXXXXX")
      fi
      mv -f "$hook" "$prev"
    fi
    printf -v prev_q '%q' "$prev"
    cat > "$HOOK_TMP" <<HOOK
#!/usr/bin/env bash
set -eu
# wheelhouse fleet pre-push guard
PREV=$prev_q
GUARD=$GUARD_Q
TMP=\$(mktemp "\${TMPDIR:-/tmp}/wheelhouse-pre-push.XXXXXX")
trap 'rm -f "\$TMP"' EXIT INT TERM HUP
cat > "\$TMP"
"\$GUARD" "\$@" < "\$TMP"
if [ -x "\$PREV" ]; then
  "\$PREV" "\$@" < "\$TMP"
fi
HOOK
  fi
  chmod +x "$HOOK_TMP"
  mv -f "$HOOK_TMP" "$hook"
  HOOK_TMP=""
  printf 'fleet pre-push guard installed: repo=%s hook=%s guard=%s\n' "$repo" "$hook" "$GUARD"
}

install_repo "$ROOT"
if [ -n "$PRODUCT" ] && [ "$PRODUCT" != "$ROOT" ]; then
  install_repo "$PRODUCT"
fi
