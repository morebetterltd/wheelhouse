#!/usr/bin/env bash
# Fast, credential-free role dispatch and legacy-roster regressions.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-role-split.$$.XXXXXX" wheelhouse-role-split)" || exit 2
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
selftest_isolate_git "$FIX" || exit 2
mkdir -p "$FIX/project/seats" "$FIX/project/contracts" "$FIX/bin"
selftest_copy_seat_runtime "$FIX/project" "$HERE"
printf 'Inert reviewer brief.\n' > "$FIX/project/contracts/REVIEWER.md"
printf 'Inert walker brief.\n' > "$FIX/project/contracts/VERIFIER.md"
printf '#!/usr/bin/env bash\nprintf "[]\\n"\n' > "$FIX/bin/bd"
chmod +x "$FIX/bin/bd"
(cd "$FIX/project" && git init -q -b main && git -c user.name=selftest -c user.email=selftest@local commit -qm base --allow-empty) || exit 2
PATH="$FIX/bin:$PATH" bun "$HERE/fixtures/role-split.ts" "$FIX/project"
