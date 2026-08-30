#!/usr/bin/env bash
#
# seat-env.selftest.sh — does seat-env.sh still do what seats/README.md
# claims, on THIS machine?
#
# Hermetic: it builds seats in a temp HOME with a stub `pi` on a private PATH,
# so your real seats, your real ~/.pi-seats-* directories, and your real pi
# install are never touched or required. Every claim the README makes is
# exercised: isolation (two seats, two directories, two distinct auth.json
# paths), the trust pre-grant's exact content, idempotency, and the two
# refusals — an existing auth.json is left byte-identical with no login
# command printed beside it, and a foreign trust.json stops the run rather
# than being rewritten.
#
# The last phase is a canary. It sabotages COPIES of the script — once with
# the trust write cut out, once with the auth guard cut out — and checks that
# these tests notice. A suite that passes everything, including a script that
# grants no trust or invites a re-login over a live identity, is decoration —
# so if a canary survives, this exits non-zero even when every real check
# passed. Each sabotage is guarded with cmp: if the sed no longer bites, the
# canary says so instead of proving nothing.
#
# Usage: seat-env.selftest.sh [path-to-seat-env.sh]
#
# Runs under bash and zsh alike; both are asserted in review, not assumed.
# Exit 0 = the script works here. Non-zero = read the FAIL lines: a failure in
# phases 1-5 means the script broke; a canary failure means these checks
# cannot be trusted to tell you either way.

set -uo pipefail   # deliberately not -e: half these cases are meant to fail

SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/seat-env.sh}"
[ -x "$SCRIPT" ] || { echo "selftest: not executable: $SCRIPT" >&2; exit 2; }

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- fixture -----------------------------------------------------------------
FIX="$(mktemp -d)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
PROJECT="$FIX/project"
mkdir -p "$HOME_FIX" "$BIN" "$PROJECT" "$FIX/emptybin"
printf '#!/bin/sh\nexit 0\n' > "$BIN/pi"
chmod +x "$BIN/pi"
RUN_PATH="$BIN:/usr/bin:/bin"

# What trust.json must contain, written down BEFORE anything runs, so a wrong
# answer has something to be wrong against.
printf '{\n  "%s": true\n}\n' "$PROJECT" > "$FIX/expected-trust.json"

# Assert the subjects exist before anything measures them: a stub pi that is
# not executable and a project dir that was never made would fail every check
# below for reasons that have nothing to do with seat-env.sh.
[ -x "$BIN/pi" ] || { echo "selftest: fixture stub pi was not created" >&2; exit 2; }
[ -d "$PROJECT" ] || { echo "selftest: fixture project dir was not created" >&2; exit 2; }

RUN_SCRIPT="$SCRIPT"
run()  { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" "$RUN_SCRIPT" "$@" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

# --- the checks, parameterized so the canary can point them at a sabotage ----
check_provision() {   # $1 = label, $2 = seat name (must not exist yet)
  local label="$1" seatname="$2" d
  d="$HOME_FIX/.pi-seats-alpha/$seatname"
  run alpha "$seatname" "$PROJECT"
  if [ $RC -eq 0 ]; then pass "$label: fresh seat run exits 0"
  else fail "$label: fresh seat run exited $RC"; fi

  if [ -d "$d" ]; then pass "$label: seat directory created"
  else fail "$label: $d was not created"; fi

  if cmp -s "$d/trust.json" "$FIX/expected-trust.json"; then
    pass "$label: trust.json pre-grants the project root, exactly"
  else fail "$label: trust.json missing or wrong for $seatname"; fi

  if says "export PI_CODING_AGENT_DIR=\"$d\""; then
    pass "$label: export line names this seat's own directory"
  else fail "$label: export line missing or names the wrong directory"; fi

  if says "pi /login"; then pass "$label: fresh seat gets a one-time login command"
  else fail "$label: no login command for a seat with no auth.json"; fi
}

check_auth_refusal() {   # $1 = label, $2 = seat name (auth.json must exist)
  local label="$1" seatname="$2" authf
  authf="$HOME_FIX/.pi-seats-alpha/$seatname/auth.json"
  [ -s "$authf" ] || { fail "$label: fixture auth.json was never written — this check is measuring nothing"; return; }
  cp "$authf" "$FIX/auth-before.json"
  run alpha "$seatname" "$PROJECT"
  if [ $RC -eq 0 ]; then pass "$label: run over a logged-in seat exits 0"
  else fail "$label: run over a logged-in seat exited $RC"; fi

  if cmp -s "$authf" "$FIX/auth-before.json"; then
    pass "$label: existing auth.json left byte-identical"
  else fail "$label: auth.json was modified"; fi

  if says "pi /login"; then
    fail "$label: printed a login command beside a live auth.json"
  else pass "$label: no login command beside a live auth.json"; fi

  if says "already logged in"; then pass "$label: says why the login command is withheld"
  else fail "$label: withheld the login command without saying why"; fi
}

phase "1. two seats, one namespace — isolation"
check_provision "seat one" "worker-1"
check_provision "seat two" "worker-2"
D1="$HOME_FIX/.pi-seats-alpha/worker-1"
D2="$HOME_FIX/.pi-seats-alpha/worker-2"
if [ "$D1/auth.json" != "$D2/auth.json" ] && [ -d "$D1" ] && [ -d "$D2" ]; then
  pass "the two seats' auth.json paths are distinct — accounts cannot collide"
else fail "both seats resolve to one auth.json path"; fi

phase "2. idempotency"
cp "$D1/trust.json" "$FIX/trust-before.json"
run alpha worker-1 "$PROJECT"
if [ $RC -eq 0 ] && says "current"; then pass "rerun exits 0 and says the trust grant is already current"
else fail "rerun was not idempotent (exit $RC)"; fi
if cmp -s "$D1/trust.json" "$FIX/trust-before.json"; then
  pass "rerun leaves trust.json byte-identical"
else fail "rerun rewrote trust.json"; fi

phase "3. refusal — an existing auth.json is identity, not clutter"
printf '{"fixture":"sentinel-identity"}\n' > "$D1/auth.json"
check_auth_refusal "auth" "worker-1"

phase "4. refusal — a trust file this script did not write"
FOREIGN="$HOME_FIX/.pi-seats-alpha/worker-foreign"
mkdir -p "$FOREIGN"
printf '{\n  "/somewhere/else": true\n}\n' > "$FOREIGN/trust.json"
cp "$FOREIGN/trust.json" "$FIX/foreign-before.json"
run alpha worker-foreign "$PROJECT"
if [ $RC -ne 0 ] && says "will not rewrite"; then
  pass "a trust.json missing the project root STOPS the run, with the reason"
else fail "a foreign trust.json did not stop the run (exit $RC)"; fi
if cmp -s "$FOREIGN/trust.json" "$FIX/foreign-before.json"; then
  pass "the refusal wrote nothing over the foreign trust file"
else fail "the refusal still rewrote trust.json"; fi

phase "5. refusing to guess"
OUT="$(env HOME="$HOME_FIX" PATH="$FIX/emptybin:/usr/bin:/bin" "$SCRIPT" alpha worker-3 "$PROJECT" 2>&1)"; RC=$?
if [ $RC -ne 0 ] && says "MISSING pi"; then pass "no pi on PATH is a STOP, named as MISSING"
else fail "a missing pi did not stop the run (exit $RC)"; fi

run alpha worker-3 "relative/path"
if [ $RC -ne 0 ] && says "absolute"; then pass "a relative project root is refused"
else fail "a relative project root was accepted (exit $RC)"; fi

run alpha "../escape" "$PROJECT"
if [ $RC -ne 0 ]; then pass "a seat name with '..' is refused"
else fail "a seat name with '..' was accepted"; fi

run alpha worker-3 "$PROJECT/does-not-exist"
if [ $RC -ne 0 ]; then pass "a project root that does not exist is refused"
else fail "trust was granted to a directory that is not there"; fi

phase "6. default project root — the checkout you run it from"
OUT="$(cd "$PROJECT" && env HOME="$HOME_FIX" PATH="$RUN_PATH" "$SCRIPT" alpha worker-4 2>&1)"; RC=$?
if [ $RC -eq 0 ] && cmp -s "$HOME_FIX/.pi-seats-alpha/worker-4/trust.json" "$FIX/expected-trust.json"; then
  pass "with no root argument, trust is granted to the directory the run stood in"
else fail "default root did not resolve to the cwd (exit $RC)"; fi

phase "7. canary — can these checks detect a broken script?"
SAB_TRUST="$FIX/seat-env-no-trust.sh"
sed 's|^  write_trust$|  :|' "$SCRIPT" > "$SAB_TRUST"
chmod +x "$SAB_TRUST"
if cmp -s "$SCRIPT" "$SAB_TRUST"; then
  fail "canary: could not cut the trust write — its call no longer matches the pattern this test cuts, so the canary proves nothing"
else
  CANARY_FAILED_BEFORE=$FAILED
  RUN_SCRIPT="$SAB_TRUST"
  check_provision "canary" "worker-canary-a" > /dev/null 2>&1
  RUN_SCRIPT="$SCRIPT"
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: a script that grants no trust is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a script with its trust write removed PASSED — these checks prove nothing"
  fi
fi

SAB_AUTH="$FIX/seat-env-no-auth-guard.sh"
sed 's|^if \[ -e "\$auth_file" \]; then$|if false; then|' "$SCRIPT" > "$SAB_AUTH"
chmod +x "$SAB_AUTH"
if cmp -s "$SCRIPT" "$SAB_AUTH"; then
  fail "canary: could not cut the auth guard — its line no longer matches the pattern this test cuts, so the canary proves nothing"
else
  mkdir -p "$HOME_FIX/.pi-seats-alpha/worker-canary-b"
  printf '{\n  "%s": true\n}\n' "$PROJECT" > "$HOME_FIX/.pi-seats-alpha/worker-canary-b/trust.json"
  printf '{"fixture":"sentinel-identity"}\n' > "$HOME_FIX/.pi-seats-alpha/worker-canary-b/auth.json"
  CANARY_FAILED_BEFORE=$FAILED
  RUN_SCRIPT="$SAB_AUTH"
  check_auth_refusal "canary" "worker-canary-b" > /dev/null 2>&1
  RUN_SCRIPT="$SCRIPT"
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: a script that invites a re-login over a live identity is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a script with its auth guard removed PASSED — these checks prove nothing"
  fi
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "seat-env.sh works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-6, the script is broken or its output"
echo "wording moved. If a failure is in the canary, fix this test first."
exit 1
