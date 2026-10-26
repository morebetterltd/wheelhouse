#!/usr/bin/env bash
# Isolated hook protocol fixtures; never runs Claude or edits installed settings.
set -eu
STARTED=$SECONDS
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "$TMPDIR/wheelhouse-inbox-hook.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/inbox-hook.ts" "$HERE" "$FIX/cases"
if [ -f "$HERE/../BOOTSTRAP.md" ] && [ -f "$HERE/../generated/CLAUDE.md.example" ]; then
  bun "$HERE/fixtures/inbox-hook-docs.ts" "$HERE/.."
else
  echo 'inbox-hook: installed seats copy; template-only documentation assertions not present (consumer checks above still ran)'
fi
ELAPSED=$((SECONDS - STARTED))
printf 'inbox-hook.selftest: admitted payload elapsed=%ss (FIFO wait excluded)\n' "$ELAPSED"
[ "$ELAPSED" -lt 60 ] || { echo 'FAIL O8: admitted hook suite exceeded 60s' >&2; exit 1; }
echo 'inbox-hook.selftest: PASS'
