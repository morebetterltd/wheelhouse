#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }

FAILED=0
FIX=""
pass() { printf 'ok - %s\n' "$*"; }
fail() { printf 'not ok - %s\n' "$*"; FAILED=$((FAILED + 1)); }

cleanup() {
  [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"
  return 0
}
selftest_install_cleanup_traps cleanup

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-seat-worktree-selftest.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
BIN="$FIX/bin"
mkdir -p "$BIN"
cat > "$BIN/bd" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "show" ] && [ "\$2" = "bead-integration" ]; then
  printf '%s\n' '{"id":"bead-integration","description":"Integration: fleet/goal\\n"}'
  exit 0
fi
if [ "\$1" = "list" ]; then
  status=""
  for a in "\$@"; do case "\$a" in --status=*) status="\${a#--status=}";; esac; done
  if [ "\$status" = "closed" ] && [ -n "\${FIXTURE_BD_CLOSED_FILE:-}" ]; then cat "\$FIXTURE_BD_CLOSED_FILE"; else printf '[]\n'; fi
  exit 0
fi
printf '{}\n'
EOF
chmod +x "$BIN/bd"

# Occupancy and closed-legacy cwd behaviour (dead-seat fix).
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

# Merge-target and remote-only Integration: base behaviour (#77).
SRC="$FIX/source"
ORIGIN="$FIX/origin.git"
INSTALL="$FIX/install"
mkdir -p "$SRC" "$INSTALL/wheelhouse"
git -C "$SRC" init -q -b main
git -C "$SRC" config user.email seat-worktree-selftest@example.invalid
git -C "$SRC" config user.name 'Seat Worktree Selftest'
printf 'main\n' > "$SRC/file.txt"
git -C "$SRC" add file.txt && git -C "$SRC" commit -qm main
git -C "$SRC" branch staging
STAGING_SHA="$(git -C "$SRC" rev-parse staging)"
git -C "$SRC" switch -q -c fleet/goal
printf 'goal integration\n' > "$SRC/goal.txt"
git -C "$SRC" add goal.txt && git -C "$SRC" commit -qm 'goal integration'
GOAL_SHA="$(git -C "$SRC" rev-parse fleet/goal)"
git -C "$SRC" switch -q main
printf 'default branch only\n' > "$SRC/default.txt"
git -C "$SRC" add default.txt && git -C "$SRC" commit -qm 'default branch moves ahead'
MAIN_SHA="$(git -C "$SRC" rev-parse main)"
git -C "$SRC" clone -q --bare . "$ORIGIN"
git --git-dir="$ORIGIN" symbolic-ref HEAD refs/heads/main

git -C "$INSTALL" clone -q "$ORIGIN" product
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$ORIGIN
commit=$MAIN_SHA
path=$SRC
product-repo=product
merge-target=staging
EOF

OUT="$FIX/resolve-base.out"
if env WHEELHOUSE_SKIP_BD=1 INSTALL="$INSTALL" MODULE="$ROOT/seats/seat-worktree.ts" EXPECT="$STAGING_SHA" bun -e '
const { ensureSeatWorktree, seatWorktreeDir } = await import(process.env.MODULE);
const { execFileSync } = await import("node:child_process");
const install = process.env.INSTALL;
const result = ensureSeatWorktree({ root: install, beadId: "merge-target-fixture", seat: "worker-1", state: { seats: {} }, roster: { "worker-1": {} }, seatPush: "off" });
const target = seatWorktreeDir(install, "worker-1");
if (result.base !== "origin/staging") throw new Error(`base ${result.base}`);
if (result.target !== target) throw new Error(`target ${result.target}`);
const head = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== process.env.EXPECT) throw new Error(`HEAD ${head} !== ${process.env.EXPECT}`);
console.log(JSON.stringify({ base: result.base, head }));
' > "$OUT" 2>&1; then
  pass "new seat branch starts from wheelhouse/.template-source merge-target before origin/HEAD"
else
  fail "new seat branch did not start from recorded merge target: $(cat "$OUT" 2>/dev/null)"
fi

OUT="$FIX/integration-base.out"
if env PATH="$BIN:$PATH" INSTALL="$INSTALL" MODULE="$ROOT/seats/seat-worktree.ts" EXPECT="$GOAL_SHA" bun -e '
const { ensureSeatWorktree, seatWorktreeDir } = await import(process.env.MODULE);
const { execFileSync } = await import("node:child_process");
const install = process.env.INSTALL;
const result = ensureSeatWorktree({ root: install, beadId: "bead-integration", seat: "worker-2", state: { seats: {} }, roster: { "worker-1": {}, "worker-2": {} }, seatPush: "off" });
const target = seatWorktreeDir(install, "worker-2");
if (result.base !== "origin/fleet/goal") throw new Error(`base ${result.base}`);
if (result.target !== target) throw new Error(`target ${result.target}`);
const head = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== process.env.EXPECT) throw new Error(`HEAD ${head} !== ${process.env.EXPECT}`);
console.log(JSON.stringify({ base: result.base, head }));
' > "$OUT" 2>&1; then
  pass "Integration: fleet/<goal> resolves to origin/fleet/<goal> when only the remote ref exists"
else
  fail "Integration remote-only goal ref did not resolve before merge-target/origin-HEAD: $(cat "$OUT" 2>/dev/null)"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "seat-worktree.selftest: PASS (5 checks)"
else
  echo "seat-worktree.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
