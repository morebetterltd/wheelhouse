#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-host-build-shim.XXXXXX")" || exit 2
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM

PROJ="$FIX/project"; mkdir -p "$PROJ/seats/bin" "$PROJ/scripts" "$FIX/realbin" "$FIX/home"
cp "$HERE/bin/host-build-shim" "$PROJ/seats/bin/host-build-shim" || exit 2
ln -sf host-build-shim "$PROJ/seats/bin/cargo"
chmod +x "$PROJ/seats/bin/host-build-shim"
cat > "$FIX/realbin/cargo" <<'CARGO'
#!/usr/bin/env bash
log="${STUB_CARGO_LOG:?STUB_CARGO_LOG required}"
now_ms(){ perl -MTime::HiRes=time -e 'printf "%d", time()*1000'; }
printf 'start pid=%s ms=%s guard=%s args=%s\n' "$$" "$(now_ms)" "${WHEELHOUSE_BUILD_LOCK_HELD:-0}" "$*" >> "$log"
sleep 0.35
printf 'end pid=%s ms=%s guard=%s args=%s\n' "$$" "$(now_ms)" "${WHEELHOUSE_BUILD_LOCK_HELD:-0}" "$*" >> "$log"
CARGO
chmod +x "$FIX/realbin/cargo"
cat > "$PROJ/scripts/check.sh" <<'CHECK'
#!/usr/bin/env bash
set -eu
cargo build "$@"
CHECK
chmod +x "$PROJ/scripts/check.sh"

run_pair(){
  path_prefix="$1"; log="$2"; rm -f "$log"
  (cd "$PROJ" && HOME="$FIX/home" WHEELHOUSE_BUILD_LOCK="$FIX/host.lock" STUB_CARGO_LOG="$log" PATH="$path_prefix:$FIX/realbin:/usr/bin:/bin" scripts/check.sh a) > "$log.a.out" 2> "$log.a.err" & a=$!
  (cd "$PROJ" && HOME="$FIX/home" WHEELHOUSE_BUILD_LOCK="$FIX/host.lock" STUB_CARGO_LOG="$log" PATH="$path_prefix:$FIX/realbin:/usr/bin:/bin" scripts/check.sh b) > "$log.b.out" 2> "$log.b.err" & b=$!
  wait "$a"; rca=$?
  wait "$b"; rcb=$?
  [ "$rca" = 0 ] && [ "$rcb" = 0 ]
}

overlap_status(){
  perl -ne '
    if (/^(start|end) pid=(\d+) ms=(\d+) guard=(\S+) args=(.*)$/) {
      push @e, [$1,$2,$3,$4,$5];
    }
    END {
      my %start; my $overlap=0; my $badguard=0; my $started=0;
      for my $e (@e) {
        my ($kind,$pid,$ms,$guard,$args)=@$e;
        if ($kind eq "start") { $overlap=1 if keys %start; $start{$pid}=1; $started++; $badguard=1 if $guard ne "1"; }
        else { delete $start{$pid}; }
      }
      print "started=$started overlap=$overlap badguard=$badguard\n";
    }
  ' "$1"
}

if run_pair "$FIX/realbin" "$FIX/no-shim.log"; then
  status="$(overlap_status "$FIX/no-shim.log")"
  if printf '%s\n' "$status" | grep >/dev/null 'started=2 overlap=1'; then pass "canary: repo script with bare cargo and no shim overlaps outside the lock"; else fail "no-shim canary did not overlap status=$status log=$(cat "$FIX/no-shim.log" 2>/dev/null)"; fi
else fail "no-shim repo script failed unexpectedly"; fi

if run_pair "$PROJ/seats/bin" "$FIX/with-shim.log"; then
  status="$(overlap_status "$FIX/with-shim.log")"
  if printf '%s\n' "$status" | grep >/dev/null 'started=2 overlap=0 badguard=0'; then pass "repo script bare cargo goes through seats/bin shim and serializes on the build lock"; else fail "shim did not serialize or set reentry guard status=$status log=$(cat "$FIX/with-shim.log" 2>/dev/null)"; fi
else fail "with-shim repo script failed out=$(cat "$FIX/with-shim.log.a.err" "$FIX/with-shim.log.b.err" 2>/dev/null)"; fi

if [ -L "$HERE/bin/cargo" ] && [ "$(readlink "$HERE/bin/cargo")" = "host-build-shim" ]; then pass "template ships seats/bin/cargo as the host-build shim"; else fail "seats/bin/cargo is not a symlink to host-build-shim"; fi

if [ "$FAIL" -eq 0 ]; then echo "host-build-shim.selftest: PASS ($PASS checks)"; exit 0; fi
echo "host-build-shim.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
