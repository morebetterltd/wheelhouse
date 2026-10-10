#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-lib.XXXXXX")" || exit 2
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }

SRCROOT="$FIX/source"; DEST="$FIX/dest"
mkdir -p "$SRCROOT"
selftest_copy_seat_runtime "$SRCROOT" "$HERE"
cat > "$SRCROOT/seats/fixture-added-module.ts" <<'TS'
export const fixtureAddedModule = "copied";
TS
python3 - "$SRCROOT/seats/adapter.ts" <<'PY'
import sys
from pathlib import Path
p=Path(sys.argv[1])
s=p.read_text()
if s.startswith('#!'):
    first, rest = s.split('\n', 1)
    p.write_text(first + '\nimport "./fixture-added-module";\n' + rest)
else:
    p.write_text('import "./fixture-added-module";\n' + s)
PY
selftest_copy_seat_runtime "$DEST" "$SRCROOT/seats"
if [ -f "$DEST/seats/fixture-added-module.ts" ] && grep -q 'fixture-added-module' "$DEST/seats/adapter.ts"; then
  pass "runtime copy helper carries a newly added adapter dependency into a fixture"
else
  fail "runtime copy helper did not carry the dummy module or adapter import"
fi

PAT1='(^|[;&|][[:space:]]*)cp[[:space:]][^;&|]*'
PAT2='(adapter[.]ts|cockpit[.]sh|herald[.]ts|[$]ADAPTER([^_[:alnum:]]|$)|[$]COCKPIT([^_[:alnum:]]|$)|[$]HERALD([^_[:alnum:]]|$))'
MATCHES="$(grep -En "$PAT1$PAT2" "$HERE"/*.selftest.sh 2>/dev/null | grep -v '/selftest-lib.selftest.sh:' || true)"
if [ -z "$MATCHES" ]; then
  pass "lint: selftests do not copy adapter.ts, cockpit.sh, or herald.ts by name"
else
  printf '%s\n' "$MATCHES" >&2
  fail "lint: selftests must use selftest_copy_seat_runtime instead of copying core runtime files by name"
fi

if [ $FAIL -eq 0 ]; then echo "selftest-lib.selftest: PASS ($PASS checks)"; exit 0; fi
echo "selftest-lib.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
