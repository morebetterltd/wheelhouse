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

if command -v bd >/dev/null 2>&1; then
  REAL_BD="$(command -v bd)"
  INSTALL="$FIX/install-graph"
  mkdir -p "$INSTALL"
  git -C "$INSTALL" init -q
  if (cd "$INSTALL" && "$REAL_BD" init --non-interactive --skip-agents -p install >/dev/null 2>"$FIX/install-bd-init.err"); then
    count_install(){ (cd "$INSTALL" && "$REAL_BD" list --json) | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
    before_count="$(count_install)"
    INSIDE="$INSTALL/inside-install"
    mkdir -p "$INSIDE"
    (cd "$INSIDE" && "$REAL_BD" create 'canary reaches parent graph' --json >/dev/null)
    after_canary_count="$(count_install)"
    if [ "$after_canary_count" -gt "$before_count" ]; then
      pass "canary: bd create from a scratch dir inside an install reaches the parent graph without helper"
    else
      fail "canary: inner bd create did not reach fixture install graph (before=$before_count after=$after_canary_count)"
    fi
    before_isolated_count="$after_canary_count"
    scratch_env="$(selftest_scratch_graph "$FIX/isolated-bd")"
    scratch_rc=$?
    if [ $scratch_rc -eq 0 ]; then
      eval "$scratch_env"
      SCRATCH_WORK="$WHEELHOUSE_SELFTEST_BD_ROOT/work"
      mkdir -p "$SCRATCH_WORK"
      (cd "$SCRATCH_WORK" && bd create 'isolated helper row' --json >/dev/null)
      after_isolated_count="$(count_install)"
      scratch_count="$(cd "$SCRATCH_WORK" && bd list --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
      if [ "$after_isolated_count" = "$before_isolated_count" ] && [ "$scratch_count" -ge 1 ]; then
        pass "selftest_scratch_graph isolates bd create from the fixture install graph"
      else
        fail "selftest_scratch_graph did not isolate graph writes (install before=$before_isolated_count after=$after_isolated_count scratch=$scratch_count)"
      fi
    else
      fail "selftest_scratch_graph failed for fixture path"
    fi
  else
    fail "fixture install bd init failed: $(cat "$FIX/install-bd-init.err")"
  fi
else
  pass "SKIP selftest_scratch_graph isolation: bd not on PATH"
fi

if [ $FAIL -eq 0 ]; then echo "selftest-lib.selftest: PASS ($PASS checks)"; exit 0; fi
echo "selftest-lib.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
