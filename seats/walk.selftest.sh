#!/usr/bin/env bash
# Hermetic selftest for seats/walk.ts. It uses a stub pi in a temp HOME/PATH;
# no live verifier seat and no live credentials are required or touched.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WALK="${1:-$HERE/walk.ts}"
VERIFY="$(cd "$(dirname "$WALK")" && pwd)/verify.ts"
BRIEFS="$(cd "$(dirname "$WALK")" && pwd)/briefs.ts"
SCRUB="$HERE/evidence-scrub.sh"
[ -f "$WALK" ] || { echo "selftest: not found: $WALK" >&2; exit 2; }
[ -f "$VERIFY" ] || { echo "selftest: not found: $VERIFY" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required" >&2; exit 2; }
GIT_BIN="$(command -v git)" || { echo "selftest: git is required" >&2; exit 2; }

exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
FIX=""
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
cleanup(){ [ -n "$FIX" ] && rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-walk-selftest.$$.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"

cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write('stub pi: no PI_CODING_AGENT_DIR\n'); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, 'prompt.txt'), process.argv[process.argv.length - 1] || '');
fs.writeFileSync(path.join(agentDir, 'cwd.txt'), process.cwd());
const reply = process.env.STUB_REPLY || '';
process.stdout.write(reply.replaceAll('__HOME__', process.env.HOME || '').replaceAll('__TMP__', process.cwd()));
if (process.env.STUB_SLEEP_MS) {
  setTimeout(() => process.exit(Number(process.env.STUB_EXIT || 0)), Number(process.env.STUB_SLEEP_MS));
} else {
  process.exit(Number(process.env.STUB_EXIT || 0));
}
STUB
chmod +x "$BIN/pi"

build_proj(){
  local proj="$1" ns="$2"
  mkdir -p "$proj/seats" "$proj/contracts" "$HOME_FIX/.pi-seats-$ns/verifier"
  cp "$WALK" "$proj/seats/walk.ts"
  cp "$VERIFY" "$proj/seats/verify.ts"
  cp "$BRIEFS" "$proj/seats/briefs.ts"
  cp "$SCRUB" "$proj/seats/evidence-scrub.sh"
  chmod +x "$proj/seats/walk.ts" "$proj/seats/evidence-scrub.sh"
  cat > "$proj/contracts/VERIFIER.md" <<'EOF'
# Crew: Verifier

Fixture walker brief. The stub pi records that this path was appended.
EOF
  cat > "$proj/contracts/REVIEWER.md" <<'EOF'
# Crew: Reviewer

Fixture reviewer brief for verify.ts import compatibility.
EOF
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "verifier": {
      "role": "verifier",
      "provider": "openai",
      "model": "stub-model",
      "account": { "dir": "~/.pi-seats-$ns/verifier" }
    }
  }
}
EOF
  printf '{"stub":true}\n' > "$HOME_FIX/.pi-seats-$ns/verifier/auth.json"
  ( cd "$proj" && git init -q && git -c user.email=selftest@local -c user.name=selftest commit -q --allow-empty -m base ) \
    || { echo "selftest: could not build fixture git repo" >&2; exit 2; }
}

run_case(){
  local name="$1" reply="$2" expect_rc="$3" expect_text="$4"
  local proj="$FIX/proj-$name" out="$FIX/out-$name" ns="walk-$name" got rc transcript argv prompt
  build_proj "$proj" "$ns"
  got=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY="$reply" bun seats/walk.ts 'claim text' --surface product:'echo product' --out "$out" 2>&1)
  rc=$?
  if [ "$rc" -eq "$expect_rc" ]; then pass "$name exit $rc"; else fail "$name exit got $rc expected $expect_rc: $got"; fi
  if printf '%s\n' "$got" | grep -qF "$expect_text"; then pass "$name printed $expect_text"; else fail "$name missing $expect_text: $got"; fi
  transcript="$out/transcript.txt"
  [ -s "$transcript" ] && pass "$name retained transcript" || fail "$name transcript missing"
  if grep -q '\[tmpdir\]' "$transcript" && ! grep -qF "$HOME_FIX" "$transcript" && ! grep -qF "$FIX" "$transcript"; then pass "$name scrub applied"; else fail "$name scrub markers missing in transcript"; fi
  argv="$HOME_FIX/.pi-seats-$ns/verifier/argv.json"
  prompt="$HOME_FIX/.pi-seats-$ns/verifier/prompt.txt"
  if grep -q -- '--append-system-prompt' "$argv" && grep -q 'contracts/VERIFIER.md' "$argv"; then pass "$name appended verifier brief"; else fail "$name did not append verifier brief: $(cat "$argv" 2>/dev/null)"; fi
  if grep -q 'Claim under verifier walk' "$prompt" && grep -q 'Product surface: echo product' "$prompt"; then pass "$name prompt carries claim and surface"; else fail "$name prompt missing claim/surface"; fi
  if grep -E 'contracts/REVIEWER|contracts/WORKER|wheelhouse/ISA|seats/logs|bd show' "$prompt" >/dev/null; then fail "$name prompt leaked fleet internals"; else pass "$name prompt avoids fleet internals"; fi
}

phase 'walk verdict parsing and transcript retention'
run_case done $'consumer output __HOME__ __TMP__\nVERDICT: WALKED-DONE\n' 0 'VERDICT: WALKED-DONE'
run_case notdone $'step output __HOME__ __TMP__\nVERDICT: WALKED-NOT-DONE — failed at fixture step\n' 2 'VERDICT: WALKED-NOT-DONE'
run_case couldnot $'blocked __HOME__ __TMP__\nVERDICT: COULD-NOT-WALK — missing fixture credential\n' 3 'VERDICT: COULD-NOT-WALK'
run_case zero $'no verdict here __HOME__ __TMP__\n' 4 'expected exactly one'
run_case two $'VERDICT: WALKED-DONE\nVERDICT: COULD-NOT-WALK — duplicate\n__HOME__ __TMP__\n' 4 'expected exactly one'

phase 'upgrade surface requires baseline'
proj="$FIX/proj-upgrade"; ns="walk-upgrade"; build_proj "$proj" "$ns"
out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface upgrade:runbooks/UPGRADE.md --out "$FIX/out-upgrade" 2>&1)
rc=$?
[ "$rc" -eq 1 ] && pass 'upgrade without baseline exits 1' || fail "upgrade without baseline rc=$rc output=$out"
printf '%s\n' "$out" | grep -q -- 'requires --baseline' && pass 'upgrade baseline refusal named' || fail "upgrade baseline refusal missing: $out"

phase 'credential refusal distinct and no live pi required'
proj="$FIX/proj-refuse"; ns="walk-refuse"; build_proj "$proj" "$ns"
rm -f "$HOME_FIX/.pi-seats-$ns/verifier/auth.json"
out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-refuse" 2>&1)
rc=$?
[ "$rc" -eq 5 ] && pass 'missing credential exits 5' || fail "missing credential rc=$rc output=$out"
[ ! -f "$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt" ] && pass 'missing credential did not spawn stub pi' || fail 'missing credential spawned stub pi'

phase 'interrupt removes scratch worktree'
proj="$FIX/proj-int"; ns="walk-int"; build_proj "$proj" "$ns"
( cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'working\nVERDICT: WALKED-DONE\n' STUB_SLEEP_MS=5000 bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-int" ) > "$FIX/int.out" 2>&1 &
wpid=$!
cwdfile="$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt"
for _ in $(seq 1 50); do [ -s "$cwdfile" ] && break; sleep 0.1; done
scratch="$(cat "$cwdfile" 2>/dev/null || true)"
if [ -n "$scratch" ] && [ -d "$scratch" ]; then pass 'interrupt fixture captured scratch cwd'; else fail 'interrupt fixture did not capture scratch cwd'; fi
kill -INT "$wpid" 2>/dev/null || true
wait "$wpid" >/dev/null 2>&1
sleep 0.2
if [ -n "$scratch" ] && [ ! -e "$scratch" ]; then pass 'interrupt removed scratch cwd'; else fail "interrupt left scratch cwd: $scratch"; fi

if [ "$FAILED" -eq 0 ]; then
  echo "walk.selftest: PASS"
  exit 0
fi
echo "walk.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
