# Seat Discovery

Giving each seat its own `CLAUDE_CONFIG_DIR` is what lets one seat equal one subscription. It also isolates each seat's session registry, so by default the commander cannot see or message any seat, and no seat can answer by name.

This runbook is the workaround.

> **Version-stamped, and read this before trusting it.** This procedure depends on where and how Claude Code writes session registrations — internals that can change without notice. It was verified working in August 2026. If discovery does not work after following it, check the current layout before assuming you mis-followed the steps. This is a workaround, not an interface.
>
> A workaround with no upstream report becomes permanent. If you install this, file the issue too.

## What it does

Copies each seat's session registration into the commander's registry, and the commander's into each seat's, so both directions resolve by name.

Use plain `cp`. Symlinks are ignored by discovery.

## Procedure

Run from the project root after launching or relaunching any seat.

Seat names come from the roster in `wheelhouse/fleet/SEATS.md`, which is the one authoritative list. Do not invent names here or copy them from an example: a seat whose name does not match its roster entry is a seat the commander cannot address, and the failure looks exactly like an idle seat.

```bash
PROJECT_ROOT="$PWD"
SEATS="{{SEAT_NAMES}}"   # space-separated; from the roster in wheelhouse/fleet/SEATS.md
MAIN_REG="$HOME/.claude/sessions"
SEAT_REG_BASE="$HOME/.claude-seats"

# The commander is the newest LIVE registration whose cwd is this project root.
# Other sessions may share the cwd, so liveness and recency both matter.
CMD_PID=$(ls -t $(grep -l "\"cwd\":\"$PROJECT_ROOT\"" "$MAIN_REG"/*.json) \
  | xargs -n1 basename | cut -d. -f1 \
  | while read -r p; do kill -0 "$p" 2>/dev/null && echo "$p"; done | head -1)

for seat in $SEATS; do
  # forward: the commander can see the seat
  for f in "$SEAT_REG_BASE/$seat/sessions/"*; do
    cp -p "$f" "$MAIN_REG/$(basename "$f")"
  done
  # reverse: the seat can resolve the commander by name
  cp -p "$MAIN_REG/$CMD_PID."* "$SEAT_REG_BASE/$seat/sessions/"
done
```

Registrations are per-process, so re-run this whenever a seat restarts. Stale copies of dead processes are harmless.

## Verify, do not assume

Ask the commander to list the agents it can reach, then round-trip a message to each seat. A seat that does not answer has not been wired — relaunch it and re-run the procedure.

Verifying matters more here than elsewhere: a seat that cannot be reached looks identical to a seat that is idle, and the commander will wait on it indefinitely.
