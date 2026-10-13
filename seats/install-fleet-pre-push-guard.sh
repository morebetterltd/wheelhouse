#!/usr/bin/env bash
set -eu

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "install-fleet-pre-push-guard: not in a git repository" >&2; exit 1; }
HOOKS_PATH=$(git -C "$ROOT" config --get core.hooksPath || true)
if [ -z "$HOOKS_PATH" ]; then
  GIT_DIR=$(git -C "$ROOT" rev-parse --git-dir)
  case "$GIT_DIR" in /*) HOOKS_DIR="$GIT_DIR/hooks" ;; *) HOOKS_DIR="$ROOT/$GIT_DIR/hooks" ;; esac
else
  case "$HOOKS_PATH" in /*) HOOKS_DIR="$HOOKS_PATH" ;; *) HOOKS_DIR="$ROOT/$HOOKS_PATH" ;; esac
fi
mkdir -p "$HOOKS_DIR"
git -C "$ROOT" config core.hooksPath "$HOOKS_DIR"
HOOK="$HOOKS_DIR/pre-push"
PREV="$HOOKS_DIR/pre-push.before-wheelhouse-fleet-guard"
GUARD="$ROOT/seats/fleet-pre-push-guard.sh"
MARKER="wheelhouse fleet pre-push guard"

if [ -f "$HOOK" ] && grep -q "$MARKER" "$HOOK" 2>/dev/null; then
  exit 0
fi

if [ -e "$HOOK" ]; then
  if [ -e "$PREV" ]; then
    PREV="$HOOKS_DIR/pre-push.before-wheelhouse-fleet-guard.$(date +%s)"
  fi
  mv -f "$HOOK" "$PREV"
fi

cat > "$HOOK" <<HOOK
#!/usr/bin/env bash
set -eu
# wheelhouse fleet pre-push guard
PREV="$PREV"
GUARD="$GUARD"
TMP=\$(mktemp "\${TMPDIR:-/tmp}/wheelhouse-pre-push.XXXXXX")
trap 'rm -f "\$TMP"' EXIT INT TERM HUP
cat > "\$TMP"
"\$GUARD" "\$@" < "\$TMP"
if [ -x "\$PREV" ]; then
  "\$PREV" "\$@" < "\$TMP"
fi
HOOK
chmod +x "$HOOK"
