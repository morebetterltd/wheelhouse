#!/usr/bin/env bash
# GH #80: seats selftests must not borrow ripgrep or template-owned evidence.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
for tool in bash dirname grep bun node git; do
  type -P "$tool" >/dev/null || { echo "selftest: $tool is required" >&2; exit 2; }
done
BASH_BIN="$(type -P bash)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-project-install.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT

mkdir -p "$FIX/home" "$FIX/tmp" "$FIX/no-rg"
export HOME="$FIX/home" XDG_CONFIG_HOME="$FIX/home/.config" TMPDIR="$FIX/tmp"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$FIX/gitconfig"
printf '[user]\n name = selftest\n email = selftest@example.invalid\n[commit]\n gpgsign = false\n[init]\n defaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
# Only this static-source suite gets a minimal PATH. Keep walk's normal PATH
# (including any host build shims) intact: it launches Bun and Node children.
for tool in bash dirname grep; do
  ln -s "$(type -P "$tool")" "$FIX/no-rg/$tool"
done

INSTALL="$FIX/project"
mkdir -p "$INSTALL/wheelhouse/evidence" "$INSTALL/seats/fixtures"
printf 'Install-owned evidence lives here.\n' > "$INSTALL/wheelhouse/evidence/README.txt"
selftest_copy_seat_runtime "$INSTALL" "$HERE" || exit 2
cp -f "$HERE/pid-ownership.selftest.sh" "$HERE/walk.selftest.sh" "$INSTALL/seats/" || exit 2
cp -R "$HERE/fixtures/walk" "$HERE/fixtures/verify-real" "$INSTALL/seats/fixtures/" || exit 2
git -C "$INSTALL" init -q -b main
git -C "$INSTALL" commit --allow-empty -qm 'project install fixture'
[ -f "$INSTALL/seats/walk.selftest.sh" ] && [ -s "$INSTALL/seats/fixtures/walk/walk-desk-incident.out" ]
[ -d "$INSTALL/wheelhouse/evidence" ] && [ ! -e "$INSTALL/evidence" ]
echo 'PASS simulated project: shipped seats fixtures, wheelhouse/evidence present, template evidence/ absent'

FAILED=0
for layout in template project; do
  root="$HERE/.."; [ "$layout" != project ] || root="$INSTALL"
  rc=0
  # Clear an exported shell function too, so it cannot mask the missing binary.
  (cd "$root" && env -u BASH_ENV -u ENV PATH="$FIX/no-rg" "$BASH_BIN" --noprofile --norc -c '
    unset -f rg
    if command -v rg >/dev/null 2>&1; then echo "STOP: no-rg PATH unexpectedly resolves rg" >&2; exit 2; fi
    echo "PASS rg unavailable on child PATH (no shell function either)"
    exec "$@"
  ' _ "$BASH_BIN" seats/pid-ownership.selftest.sh) || rc=$?
  if [ "$rc" = 0 ]; then echo "PASS $layout pid-ownership without rg";
  else echo "FAIL $layout pid-ownership without rg (exit $rc)" >&2; FAILED=$((FAILED+1)); fi
done
rc=0
(cd "$INSTALL" && "$BASH_BIN" seats/walk.selftest.sh) || rc=$?
if [ "$rc" = 0 ]; then echo 'PASS project walk without template evidence';
else echo "FAIL project walk without template evidence (exit $rc)" >&2; FAILED=$((FAILED+1)); fi
[ ! -e "$INSTALL/evidence" ] || { echo 'FAIL project walk created template evidence/' >&2; FAILED=$((FAILED+1)); }
if [ "$FAILED" = 0 ]; then echo 'project-install.selftest: PASS'; exit 0; fi
echo "project-install.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
