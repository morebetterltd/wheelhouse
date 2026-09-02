#!/usr/bin/env bash
# fleet-gate.sh — commander liveness/dispatch nudge (a UserPromptSubmit hook).
#
# Prints, on every commander turn: how many rostered seats are live, how much
# work is ready, how much is in progress — and a loud line when seats are
# cold while ready work exists. wheelhouse/runbooks/RUNNING_THE_LOOP.md's
# "Next morning" section states the order this hook exists to enforce: seats
# up and dispatched come before any commander-owned chore (machinery sync,
# selftests, upgrades, ISA edits). This is the deterministic tooth for that
# rule — a real 2026-09-02 incident on this template's own fleet was a
# commander reading a handoff's numbered chores as its own to-do list and
# spending dozens of tool calls on one before a single seat was spawned.
#
# Degrades gracefully by design: a project with no bd, no bun, or no
# seats/adapter.ts (roster not yet provisioned, or this hook copied
# somewhere it doesn't belong) prints nothing and exits 0. This hook must
# never block or error a commander turn — it is a nudge, not a gate.
#
# Wire it as a UserPromptSubmit hook in .claude/settings.json:
#   { "hooks": { "UserPromptSubmit": [ { "matcher": "",
#       "hooks": [ { "type": "command", "command": "bash seats/fleet-gate.sh" } ] } ] } }
# generated/CLAUDE.md.example's "Standing behavior" section and
# BOOTSTRAP.md step 5 both point installers here.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
cd "$ROOT" || exit 0

command -v bd >/dev/null 2>&1 || exit 0
command -v bun >/dev/null 2>&1 || exit 0
[ -f "$HERE/adapter.ts" ] || exit 0

status="$(bun "$HERE/adapter.ts" status 2>/dev/null)" || exit 0
live=$(printf '%s\n' "$status" | grep -c ' RUNNING ')
total=$(printf '%s\n' "$status" | grep -c -E ' (RUNNING|DIED|STOPPED) ')

# Counted from --json rather than the pretty-printed listing: the display is
# not the data (wheelhouse/fleet/WORKER.md), and bd's rendered glyphs are not
# a contract this hook can lean on across builds. One "id" field per issue —
# `grep -o | wc -l` counts occurrences rather than matching LINES, so this
# still works whether the JSON is pretty-printed (one field per line, bd's
# own shape) or compact (everything on one line, as fixtures may write it).
ready=$(bd ready --json 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')
inprog=$(bd list --status in_progress --limit 0 --json 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')

line="🚢 FLEET: ${live}/${total} seats live · ${ready} ready · ${inprog} in progress"
if [ "$live" -eq 0 ] && [ "$ready" -gt 0 ]; then
  line="$line — SEATS COLD WITH READY WORK. Spawn/resume seats and dispatch FIRST. No commander chore (machinery sync, selftests, upgrades, ISA edits) before a seat holds a bead."
fi
echo "$line"
