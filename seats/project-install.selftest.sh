#!/usr/bin/env bash
# GH #80: seats selftests must not borrow ripgrep or template-owned evidence.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
for tool in bash dirname grep bun node git ps; do
  type -P "$tool" >/dev/null || { echo "selftest: $tool is required" >&2; exit 2; }
done
BASH_BIN="$(type -P bash)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-project-install.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup

mkdir -p "$FIX/home" "$FIX/tmp" "$FIX/no-rg"
export HOME="$FIX/home" XDG_CONFIG_HOME="$FIX/home/.config" TMPDIR="$FIX/tmp"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$FIX/gitconfig"
printf '[user]\n name = selftest\n email = selftest@example.invalid\n[commit]\n gpgsign = false\n[init]\n defaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
# Keep the cheap scrubber subject's PATH minimal and rg-free, including its
# allocation/scrubbing/teardown tools. Bun/ps admission checks remain mandatory.
for tool in bash dirname grep bun ps mktemp date mkdir id perl find awk rm tr sleep; do
  ln -s "$(type -P "$tool")" "$FIX/no-rg/$tool"
done

INSTALL="$FIX/project"
mkdir -p "$INSTALL/wheelhouse/evidence" "$INSTALL/seats/fixtures"
printf 'Install-owned evidence lives here.\n' > "$INSTALL/wheelhouse/evidence/README.txt"
selftest_copy_seat_runtime "$INSTALL" "$HERE" || exit 2
cp -f "$HERE/evidence-scrub.selftest.sh" "$INSTALL/seats/" || exit 2
cp -R "$HERE/fixtures/walk" "$HERE/fixtures/verify-real" "$INSTALL/seats/fixtures/" || exit 2
git -C "$INSTALL" init -q -b main
git -C "$INSTALL" commit --allow-empty -qm 'project install fixture'
[ -f "$INSTALL/seats/walk.ts" ] && [ -s "$INSTALL/seats/fixtures/walk/walk-desk-incident.out" ]
[ -d "$INSTALL/wheelhouse/evidence" ] && [ ! -e "$INSTALL/evidence" ]
echo 'PASS simulated project: shipped seats fixtures, wheelhouse/evidence present, template evidence/ absent'

FAILED=0
for layout in template project; do
  root="$HERE/.."; [ "$layout" != project ] || root="$INSTALL"
  rc=0
  # Clear an exported shell function too, so it cannot mask the missing binary.
  (cd "$root" && env -u BASH_ENV -u ENV PATH="$FIX/no-rg" "$BASH_BIN" --noprofile --norc -c '
    unset -f rg
    if ! command -v bun >/dev/null || ! command -v ps >/dev/null; then echo "STOP: no-rg PATH lacks bun/ps admission prerequisites" >&2; exit 2; fi
    echo "PASS bun and ps admission prerequisites available on minimal child PATH"
    if command -v rg >/dev/null 2>&1; then echo "STOP: no-rg PATH unexpectedly resolves rg" >&2; exit 2; fi
    echo "PASS rg unavailable on child PATH (no shell function either)"
    exec "$@"
  ' _ "$BASH_BIN" seats/evidence-scrub.selftest.sh) || rc=$?
  if [ "$rc" = 0 ]; then echo "PASS $layout evidence-scrub without rg";
  else echo "FAIL $layout evidence-scrub without rg (exit $rc)" >&2; FAILED=$((FAILED+1)); fi
done
# Only packaging/layout belongs here. The standalone walk suite exercises
# verdicts, wire formats, guards and teardown once, rather than once per install.
if bun - "$HERE" "$INSTALL" <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const [seats,install]=process.argv.slice(2);
assert(fs.statSync(path.join(install,'seats/walk.ts')).isFile());
function check(relative){
  const source=path.join(seats,relative),target=path.join(install,'seats',relative);
  if(fs.statSync(source).isDirectory())for(const name of fs.readdirSync(source))check(path.join(relative,name));
  else assert.deepEqual(fs.readFileSync(target),fs.readFileSync(source),relative);
}
for(const dir of ['fixtures/walk','fixtures/verify-real'])check(dir);
assert(fs.statSync(path.join(install,'wheelhouse/evidence')).isDirectory());
assert(!fs.existsSync(path.join(install,'evidence')));
JS
then echo 'PASS project walk fixture bytes and installed evidence layout without a second walk run'
else echo 'FAIL project installed fixtures/evidence layout' >&2; FAILED=$((FAILED+1)); fi
[ ! -e "$INSTALL/evidence" ] || { echo 'FAIL project check created template evidence/' >&2; FAILED=$((FAILED+1)); }
if [ "$FAILED" = 0 ]; then echo 'project-install.selftest: PASS'; exit 0; fi
echo "project-install.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
