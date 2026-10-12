#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }

FAILED=0
FIX=""
pass() { printf 'ok - %s\n' "$*"; }
fail() { printf 'not ok - %s\n' "$*"; FAILED=$((FAILED + 1)); }

cleanup() {
  [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-seat-worktree-selftest.$$.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
BIN="$FIX/bin"
mkdir -p "$BIN"
cat > "$BIN/bd" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "list" ]; then
  status=""
  for a in "$@"; do case "$a" in --status=*) status="${a#--status=}";; esac; done
  if [ "$status" = "closed" ] && [ -n "${FIXTURE_BD_CLOSED_FILE:-}" ]; then cat "$FIXTURE_BD_CLOSED_FILE"; else printf '[]\n'; fi
  exit 0
fi
printf '[]\n'
EOF
chmod +x "$BIN/bd"

REPO="$FIX/repo"
mkdir -p "$REPO/seats"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email seat-worktree-selftest@example.invalid
git -C "$REPO" config user.name 'Seat Worktree Selftest'
printf 'root\n' > "$REPO/README.md"
git -C "$REPO" add README.md && git -C "$REPO" commit -qm initial
printf '{"seats":{"worker-1":{"role":"worker"},"worker-2":{"role":"worker"}}}\n' > "$REPO/seats/seats.json"

run_bun() {
  env PATH="$BIN:$PATH" FIXTURE_BD_CLOSED_FILE="$FIX/closed.json" ROOT_UNDER_TEST="$REPO" MODULE="$ROOT/seats/seat-worktree.ts" bun -e "$1"
}

if run_bun '
const { ensureSeatWorktree, seatWorktreeDir } = await import(process.env.MODULE);
const root = process.env.ROOT_UNDER_TEST;
const target = seatWorktreeDir(root, "worker-1");
const notes = [];
const r = ensureSeatWorktree({ root, seat: "worker-1", beadId: "dead-claim", base: "main", roster: {"worker-1":{}, "worker-2":{}}, state: { seats: { "worker-2": { pid: 999999999, cwd: target, lastBead: "old" } } }, seatPush: "off", note: (s) => notes.push(s) });
if (r.target !== target) throw new Error(`target ${r.target} !== ${target}`);
'; then
  pass "dead seat recorded cwd does not occupy another seat's worktree"
else
  fail "dead seat recorded cwd still occupied another seat's worktree"
fi

if run_bun '
const { ensureSeatWorktree, seatWorktreeDir } = await import(process.env.MODULE);
const root = process.env.ROOT_UNDER_TEST;
const target = seatWorktreeDir(root, "worker-1");
let refused = false;
try {
  ensureSeatWorktree({ root, seat: "worker-1", beadId: "live-claim", base: "main", roster: {"worker-1":{}, "worker-2":{}}, state: { seats: { "worker-2": { pid: process.pid, cwd: target, lastBead: "old" } } }, seatPush: "off" });
} catch (e) {
  refused = String(e.message).includes("occupied by seat worker-2");
}
if (!refused) throw new Error("live recorded cwd was not refused");
'; then
  pass "live seat recorded cwd still protects a worktree from sharing"
else
  fail "live seat recorded cwd did not protect a worktree"
fi

# A stale recorded cwd for a CLOSED legacy bead must not override the seat's
# persistent worktree when dispatching a different bead.
printf '[{"id":"closed-old","status":"closed"}]\n' > "$FIX/closed.json"
if [ ! -e "$REPO/.wheelhouse-worktrees/worker-1/.git" ]; then
  git -C "$REPO" worktree add -q "$REPO/.wheelhouse-worktrees/worker-1" -b fleet/seat-old main
fi
git -C "$REPO" worktree add -q "$REPO/.wheelhouse-worktrees/closed-old" -b fleet/closed-old main
if run_bun '
import { execFileSync } from "node:child_process";
const { ensureSeatWorktree, seatWorktreeDir } = await import(process.env.MODULE);
const root = process.env.ROOT_UNDER_TEST;
const seatTarget = seatWorktreeDir(root, "worker-1");
const closed = `${root}/.wheelhouse-worktrees/closed-old`;
const r = ensureSeatWorktree({ root, seat: "worker-1", beadId: "new-bead", base: "main", roster: {"worker-1":{}}, state: { seats: { "worker-1": { pid: null, cwd: closed, lastBead: "closed-old" } } }, seatPush: "off" });
if (r.target !== seatTarget) throw new Error(`closed legacy target ${r.target} !== ${seatTarget}`);
const branch = execFileSync("git", ["-C", seatTarget, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
if (branch !== "fleet/new-bead") throw new Error(`branch ${branch}`);
'; then
  pass "closed legacy cwd does not override the new bead's seat worktree"
else
  fail "closed legacy cwd overrode the new bead's seat worktree"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "seat-worktree.selftest: PASS (3 checks)"
else
  echo "seat-worktree.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
