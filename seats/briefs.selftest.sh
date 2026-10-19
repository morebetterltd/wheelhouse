#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/selftest-lib.sh"
IMPL=${1:-$HERE/briefs.ts}
FIX=$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-briefs.XXXXXX") || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_remove_fixture_dir "$FIX"'
mkdir -p "$FIX/template/contracts" "$FIX/installed/wheelhouse/crew" "$FIX/installed/seats"
printf '%s\n' '{"seats":{"producer":{"role":"producer"}}}' > "$FIX/installed/seats/seats.json"
cp -f "$HERE/../contracts/PRODUCER.md" "$FIX/template/contracts/PRODUCER.md"
cp -f "$HERE/../contracts/PRODUCER.md" "$FIX/installed/wheelhouse/crew/PRODUCER.md"
cat > "$FIX/check.ts" <<'TS'
const { resolveRoleBrief } = await import(process.argv[2]);
const fs = await import("node:fs");
const root = process.argv[3], layout = process.argv[4];
const role = JSON.parse(fs.readFileSync(process.argv[5], "utf8")).seats.producer.role;
const want = `${root}/${layout === "installed" ? "wheelhouse/crew" : "contracts"}/PRODUCER.md`;
const got = resolveRoleBrief(root, role);
if (got !== want) throw new Error(`producer ${layout}: expected ${want}, got ${got}`);
console.log(`PASS producer brief ${layout}`);
TS
SELECTED=${WHEELHOUSE_BRIEFS_CASE:-all}
case "$SELECTED" in all|template|installed) ;; *) echo "FAIL unknown briefs case: $SELECTED"; exit 1;; esac
for layout in template installed; do
  [ "$SELECTED" = all ] || [ "$SELECTED" = "$layout" ] || continue
  bun "$FIX/check.ts" "$IMPL" "$FIX/$layout" "$layout" "$FIX/installed/seats/seats.json"
done
echo "briefs.selftest: PASS ($SELECTED)"
