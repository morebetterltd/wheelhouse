#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-lib.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }

# Exercise a worker caller even when this suite is launched by the commander.
for caller in unset worker-1 commander; do
  actor_env=(env -u BEADS_ACTOR)
  [ "$caller" = unset ] || actor_env+=("BEADS_ACTOR=$caller")
  RC=0
  ACTOR="$("${actor_env[@]}" bash -c '. "$1"; printenv BEADS_ACTOR' _ "$HERE/selftest-lib.sh")" || RC=$?
  if [ "$RC" -eq 0 ] && [ "$ACTOR" = wheelhouse-selftest ]; then
    pass "fixture actor ignores caller BEADS_ACTOR=$caller"
  else
    fail "fixture actor inherited caller BEADS_ACTOR=$caller (rc=$RC actor=$ACTOR)"
  fi
done

SRCROOT="$FIX/source"; DEST="$FIX/dest"
mkdir -p "$SRCROOT"
selftest_copy_seat_runtime "$SRCROOT" "$HERE"
cat > "$SRCROOT/seats/fixture-added-module.ts" <<'TS'
export const fixtureAddedModule = "copied";
TS
bun - "$SRCROOT/seats/adapter.ts" <<'TS'
import fs from "node:fs";
const file = process.argv[2], source = fs.readFileSync(file, "utf8");
const at = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
fs.writeFileSync(file, source.slice(0, at) + 'import "./fixture-added-module";\n' + source.slice(at));
TS
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
  METRICS_FIX="$FIX/metrics-fixture"
  mkdir -p "$METRICS_FIX"
  selftest_disable_bd_metrics "$METRICS_FIX" || exit 2
  if [ "$HOME" = "$METRICS_FIX/home" ] && [ "$XDG_CONFIG_HOME" = "$HOME/.config" ] && [ -f "$XDG_CONFIG_HOME/bd/config.yaml" ] && grep -Eq '^[[:space:]]+disabled: true$' "$XDG_CONFIG_HOME/bd/config.yaml"; then
    pass 'shared fixture metrics setup pins HOME and XDG to an owned disabled config'
  else
    fail 'shared fixture metrics setup did not pin an owned disabled config'
  fi
  INSTALL="$FIX/install-graph"
  mkdir -p "$INSTALL"
  git -C "$INSTALL" init -q -b main
  if (cd "$INSTALL" && "$REAL_BD" init --non-interactive --skip-agents -p install >/dev/null 2>"$FIX/install-bd-init.err"); then
    count_install(){ (cd "$INSTALL" && "$REAL_BD" list --json) | bun -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(0,"utf8")).length)'; }
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
      scratch_count="$(cd "$SCRATCH_WORK" && bd list --json | bun -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(0,"utf8")).length)')"
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
