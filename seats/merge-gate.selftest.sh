#!/usr/bin/env bash
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
GATE="${1:-$HERE/merge-gate.ts}"
SOURCE="$(cd "$(dirname "$GATE")" && pwd -P)"
FIX=""
cleanup() { [ -z "$FIX" ] || selftest_remove_fixture_dir "$FIX"; return 0; }
selftest_install_cleanup_traps cleanup
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-merge-gate.$$.XXXXXX")"
selftest_isolate_git "$FIX"
FIX="$(cd "$FIX" && pwd -P)"
SAMPLE="$FIX/actual-review.md"
WHEELHOUSE_REVIEW_RECORD_ONLY=1 WHEELHOUSE_REVIEW_RECORD_SEED_ONLY=1 WHEELHOUSE_REVIEW_RECORD_SEED="$SAMPLE" \
  bash "$HERE/verify.selftest.sh" "$SOURCE/verify.ts"
PROJ="$FIX/project"
mkdir -p "$PROJ/seats"
cp -f "$SOURCE/"*.ts "$SOURCE/"*.sh "$PROJ/seats/"
cp -rf "$SOURCE/drivers" "$SOURCE/transports" "$PROJ/seats/"
cp -f "$GATE" "$PROJ/seats/merge-gate.ts"
git init -q -b main "$PROJ"
git -C "$PROJ" config user.email merge-gate@example.invalid
git -C "$PROJ" config user.name 'Merge Gate Selftest'
printf 'base\n' > "$PROJ/base"
git -C "$PROJ" add base && git -C "$PROJ" commit -qm base
git -C "$PROJ" branch fleet/fixture-work
bun "$HERE/fixtures/merge-gate.ts" "$PROJ" "$SAMPLE" "$GATE" "$HERE"
