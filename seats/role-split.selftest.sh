#!/usr/bin/env bash
# Fast, credential-free role dispatch and legacy-roster regressions.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-role-split.$$.XXXXXX" wheelhouse-role-split)" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
mkdir -p "$FIX/project/seats" "$FIX/project/contracts" "$FIX/bin" "$FIX/home"
selftest_copy_seat_runtime "$FIX/project" "$HERE"
printf 'Inert reviewer brief.\n' > "$FIX/project/contracts/REVIEWER.md"
printf 'Inert walker brief.\n' > "$FIX/project/contracts/VERIFIER.md"
# Supply fixture data to the real contract gate before exercising role admission.
cat > "$FIX/contract.md" <<'CONTRACT'
Trace: Role-split CLI admission regression fixture
Signal: isa-gap: K1
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Keep checks of finished changes separate from independent checks of what people use. Callers need the intended kind of check and a clear explanation when an incompatible choice needs correction.

Outcomes:
- O1 Review and walk admission selects or refuses the intended seat roles.
  consumer: machine — the role-split fixture controller
  surface: verify.ts and walk.ts exit statuses and admission diagnostics
  check: run — require the intended missing-identity target or wrong-role migration diagnostic without launching a provider
CONTRACT
cat > "$FIX/bin/bd" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  show) cat "$ROLE_SPLIT_CONTRACT" ;;
  *) printf '[]\n' ;;
esac
SH
chmod +x "$FIX/bin/bd"
(cd "$FIX/project" && git init -q -b main && git -c user.name=selftest -c user.email=selftest@local commit -qm base --allow-empty) || exit 2
ROLE_SPLIT_CONTRACT="$FIX/contract.md" HOME="$FIX/home" PATH="$FIX/bin:$PATH" bun "$HERE/fixtures/role-split.ts" "$FIX/project"
