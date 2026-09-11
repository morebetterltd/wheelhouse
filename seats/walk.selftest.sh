#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
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
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; [ -n "$FIX" ] && rm -rf "$FIX"; }
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
  local proj="$FIX/proj-$name" out="$FIX/out-$name" ns="walk-$name" got rc transcript metadata argv prompt
  build_proj "$proj" "$ns"
  got=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY="$reply" bun seats/walk.ts 'claim text' --surface product:'echo product' --out "$out" 2>&1)
  rc=$?
  if [ "$rc" -eq "$expect_rc" ]; then pass "$name exit $rc"; else fail "$name exit got $rc expected $expect_rc: $got"; fi
  if printf '%s\n' "$got" | grep -qF "$expect_text"; then pass "$name printed $expect_text"; else fail "$name missing $expect_text: $got"; fi
  transcript="$out/transcript.txt"
  metadata="$out/walk.json"
  [ -s "$transcript" ] && pass "$name retained transcript" || fail "$name transcript missing"
  if grep -q '\[tmpdir\]' "$transcript" && ! grep -qF "$HOME_FIX" "$transcript" && ! grep -qF "$FIX" "$transcript"; then pass "$name scrub applied"; else fail "$name scrub markers missing in transcript"; fi
  if [ -f "$metadata" ]; then
    if ! grep -qF "$FIX" "$metadata" && ! grep -qF "$HOME_FIX" "$metadata" && grep -q '"transcript": "\.\./out-' "$metadata"; then pass "$name walk.json transcript path is root-relative"
    else fail "$name walk.json contains an absolute fixture path or lacks a root-relative transcript: $(cat "$metadata" 2>/dev/null)"; fi
    if ! printf '%s\n' "$got" | grep -qF "$FIX" && ! printf '%s\n' "$got" | grep -qF "$HOME_FIX" && printf '%s\n' "$got" | grep -q 'transcript: \.\./out-'; then pass "$name stdout prints root-relative evidence paths"
    else fail "$name stdout contains an absolute fixture path or lacks root-relative transcript: $got"; fi
  fi
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

phase 'image budget reduces over-budget capture set before spawn'
imgdir="$FIX/images-overbudget"
mkdir -p "$imgdir"
"$NODE_BIN" -e 'const fs=require("fs"), b=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJxvVgAAAABJRU5ErkJggg==","base64"); for (let i=1;i<=5;i++) fs.writeFileSync(process.argv[1]+`/shot-${i}.png`, b);' "$imgdir"
proj="$FIX/proj-images"; ns="walk-images"; build_proj "$proj" "$ns"
out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_IMAGE_SOURCE_DIR="$imgdir" WHEELHOUSE_WALK_IMAGE_MAX_CONTEXT=2 STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-images" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && pass 'image-budget walk exits 0' || fail "image-budget rc=$rc output=$out"
full_count=$(find "$FIX/out-images/screen-captures/full-size" -type f -name '*.png' | wc -l | tr -d ' ')
context_count=$(find "$FIX/out-images/screen-captures/context" -type f -name '*.jpg' | wc -l | tr -d ' ')
[ "$full_count" -eq 5 ] && pass 'image budget retained all full-size captures under --out' || fail "image budget full-size count=$full_count"
[ "$context_count" -eq 2 ] && pass 'image budget kept only max context JPEGs' || fail "image budget context count=$context_count"
if grep -q '"maxContextImages": 2' "$FIX/out-images/image-budget.json" && grep -q '"sourceImages": 5' "$FIX/out-images/image-budget.json"; then pass 'image budget manifest names reduction'; else fail "image budget manifest wrong: $(cat "$FIX/out-images/image-budget.json" 2>/dev/null)"; fi
prompt="$HOME_FIX/.pi-seats-$ns/verifier/prompt.txt"
if grep -q 'Image budget for screen captures' "$prompt" && grep -q 'downscaled to <=1000px wide' "$prompt" && grep -q 'wheelhouse-walk-capture' "$prompt" && grep -q 'Already-budgeted context image(s), max 2:' "$prompt"; then pass 'walker prompt names image budget before first capture'; else fail "walker prompt missing image budget: $(cat "$prompt" 2>/dev/null)"; fi

phase 'GUI window-list guard refuses an obscured target before spawn'
proj="$FIX/proj-gui"; ns="walk-gui"; build_proj "$proj" "$ns"
out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_WINDOW_LIST_JSON='[{"title":"Fixture Device","frontmost":true,"obscuredBy":"Bench Simulator Clone"}]' STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:gui:Fixture --out "$FIX/out-gui" 2>&1)
rc=$?
[ "$rc" -eq 3 ] && pass 'obscured GUI target exits COULD-NOT-WALK (3)' || fail "obscured GUI target rc=$rc output=$out"
printf '%s\n' "$out" | grep -q 'VERDICT: COULD-NOT-WALK' && printf '%s\n' "$out" | grep -q 'obscured by Bench Simulator Clone' && pass 'obscured GUI target names the obscuring window' || fail "obscured GUI target did not name the blocker: $out"
[ ! -f "$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt" ] && pass 'obscured GUI target does not spawn the verifier seat' || fail 'obscured GUI target spawned stub pi before the guard'
if grep -q '"mode": "window-list"' "$FIX/out-gui/walk.json" && grep -q 'Bench Simulator Clone' "$FIX/out-gui/walk.json"; then pass 'walk.json records the window-list guard mode and blocker'; else fail "walk.json missing guard mode/blocker: $(cat "$FIX/out-gui/walk.json" 2>/dev/null)"; fi

for case in failcmd malformed wrongshape; do
  proj="$FIX/proj-gui-$case"; ns="walk-gui-$case"; outdir="$FIX/out-gui-$case"; build_proj "$proj" "$ns"
  case "$case" in
    failcmd) cmd='printf "fixture command stderr\\n" >&2; exit 1'; want='window-list command failed';;
    malformed) cmd='printf "not json"'; want='window-list command malformed JSON';;
    wrongshape) cmd='printf "{\\\"notWindows\\\":[]}"'; want='returned wrong shape';;
  esac
  out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_WINDOW_LIST_COMMAND="$cmd" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:gui:Fixture --out "$outdir" 2>&1)
  rc=$?
  [ "$rc" -eq 3 ] && pass "GUI command $case exits COULD-NOT-WALK (3)" || fail "GUI command $case rc=$rc output=$out"
  printf '%s\n' "$out" | grep -q 'VERDICT: COULD-NOT-WALK' && printf '%s\n' "$out" | grep -q "$want" && pass "GUI command $case names the window-list failure" || fail "GUI command $case did not name failure '$want': $out"
  [ -s "$outdir/walk.json" ] && grep -q "$want" "$outdir/walk.json" && pass "GUI command $case writes walk.json with reason" || fail "GUI command $case walk.json missing reason: $(cat "$outdir/walk.json" 2>/dev/null)"
  [ ! -f "$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt" ] && pass "GUI command $case does not spawn the verifier seat" || fail "GUI command $case spawned stub pi before guard refusal"
done

proj="$FIX/proj-nongui"; ns="walk-nongui"; build_proj "$proj" "$ns"
out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_WINDOW_LIST_JSON='not-json-if-read' STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface install:README.md --out "$FIX/out-nongui" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && pass 'non-GUI install surface does not consult the injected window list' || fail "non-GUI install consulted the window list or otherwise failed (rc=$rc): $out"
if grep -q '"mode": "not-gui"' "$FIX/out-nongui/walk.json"; then pass 'walk.json records not-gui mode for non-GUI surfaces'; else fail "non-GUI walk.json missing not-gui mode: $(cat "$FIX/out-nongui/walk.json" 2>/dev/null)"; fi

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
