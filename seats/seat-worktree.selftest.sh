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
trap cleanup EXIT INT TERM

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-seat-worktree-selftest.$$.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"

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
printf 'default branch only\n' > "$SRC/default.txt"
git -C "$SRC" add default.txt && git -C "$SRC" commit -qm 'default branch moves ahead'
MAIN_SHA="$(git -C "$SRC" rev-parse main)"
git -C "$SRC" clone -q --bare . "$ORIGIN"
git --git-dir="$ORIGIN" symbolic-ref HEAD refs/heads/main

git -C "$INSTALL" clone -q "$ORIGIN" product
PRODUCT="$INSTALL/product"
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$ORIGIN
commit=$MAIN_SHA
path=$SRC
product-repo=product
merge-target=staging
EOF

OUT="$FIX/resolve-base.out"
if env WHEELHOUSE_SKIP_BD=1 INSTALL="$INSTALL" PRODUCT="$PRODUCT" MODULE="$ROOT/seats/seat-worktree.ts" EXPECT="$STAGING_SHA" bun -e '
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

if [ "$FAILED" -eq 0 ]; then
  echo "seat-worktree.selftest: PASS (1 checks)"
else
  echo "seat-worktree.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
