#!/usr/bin/env bash
# Controlled suite: the parent chooses when to signal a real wait for our child.
set -u
. "$SELFTEST_SIGNAL_LIB"
FIX="$(selftest_make_fixture_dir "$TMPDIR/wheelhouse-signal-child.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
CHILD=""
REENTERED=0
cleanup(){
  printf 'cleanup\n' >> "$SIGNAL_EVENTS"
  # Exercise a second signal *during* cleanup, without timing a race.
  if [ "${SIGNAL_REENTER:-0}" = 1 ] && [ "$REENTERED" = 0 ]; then
    REENTERED=1
    kill -TERM "$$"
  fi
  [ -z "$CHILD" ] || kill "$CHILD" 2>/dev/null || true
  [ -z "$CHILD" ] || wait "$CHILD" 2>/dev/null || true
  selftest_remove_fixture_dir "$FIX"
  return 0
}
if [ "${SIGNAL_OLD_TRAP:-0}" = 1 ]; then
  trap cleanup EXIT INT TERM
else
  selftest_install_cleanup_traps cleanup
fi
(cd "$FIX" && exec sleep 1000) & CHILD=$!
printf 'SIGNAL_READY %s %s\n' "$FIX" "$CHILD"
if [ "${SIGNAL_NORMAL:-}" != '' ]; then
  IFS= read -r command
  exit "$SIGNAL_NORMAL"
fi
wait "$CHILD"
printf 'CONTINUED\n' >> "$SIGNAL_EVENTS"
printf 'SIGNAL_CONTINUED\n'
IFS= read -r command
exit 0
