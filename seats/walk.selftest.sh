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
HARNESS="$(cd "$(dirname "$WALK")" && pwd)/harness.ts"
FINAL_ASSISTANT="$(cd "$(dirname "$WALK")" && pwd)/final-assistant-message.ts"
HOST_BUDGET_TS="$(cd "$(dirname "$WALK")" && pwd)/host-budget.ts"
REAL_FIXTURES_DIR="$(cd "$(dirname "$WALK")" && pwd)/fixtures/verify-real"
INCIDENT_STREAM="$(cd "$(dirname "$WALK")" && pwd -P)/fixtures/walk/walk-desk-incident.out"
SCRUB="$HERE/evidence-scrub.sh"
CLOCK="$HERE/fixtures/walk/readiness.ts"
[ -f "$WALK" ] || { echo "selftest: not found: $WALK" >&2; exit 2; }
[ -f "$VERIFY" ] || { echo "selftest: not found: $VERIFY" >&2; exit 2; }
[ -f "$HARNESS" ] || { echo "selftest: not found: $HARNESS" >&2; exit 2; }
[ -f "$FINAL_ASSISTANT" ] || { echo "selftest: not found: $FINAL_ASSISTANT" >&2; exit 2; }
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
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-walk-selftest.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="$BIN:$PATH" # Preserve the installed host-budget shims.

cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write('stub pi: no PI_CODING_AGENT_DIR\n'); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, 'prompt.txt'), process.argv[process.argv.length - 1] || '');
fs.writeFileSync(path.join(agentDir, 'cwd.txt'), process.cwd());
fs.writeFileSync(path.join(agentDir, 'env.json'), JSON.stringify({ PATH: process.env.PATH || null }));
const clockDir = process.env.STUB_WALK_CLOCK_DIR;
if (clockDir) {
  fs.writeFileSync(path.join(clockDir, 'verifier.tmp'), JSON.stringify({pid:process.pid,cwd:process.cwd(),stdin:fs.fstatSync(0).isCharacterDevice()?'ignored':'open-pipe'}));
  fs.renameSync(path.join(clockDir, 'verifier.tmp'), path.join(clockDir, 'verifier.json'));
  while (!fs.existsSync(path.join(clockDir, 'release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, 'utf8'));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
const reply = process.env.STUB_REPLY || '';
const finish = () => {
  if (clockDir && process.env.STUB_READ_STDIN_TO_EOF) fs.writeFileSync(path.join(clockDir, 'eof'), 'observed');
  if (clockDir && ['timeout','interrupt'].includes(process.env.STUB_WALK_CLOCK_MODE)) {
    process.stdout.write(reply);
    fs.writeFileSync(path.join(clockDir, 'holding'), 'ready');
    setInterval(() => {},1000);
    return;
  }
  process.stdout.write(reply.replaceAll('__HOME__', process.env.HOME || '').replaceAll('__TMP__', process.cwd()));
  if (process.env.STUB_SLEEP_MS) {
    setTimeout(() => process.exit(Number(process.env.STUB_EXIT || 0)), Number(process.env.STUB_SLEEP_MS));
  } else {
    process.exit(Number(process.env.STUB_EXIT || 0));
  }
};
if (process.env.STUB_READ_STDIN_TO_EOF) {
  process.stdin.resume();
  process.stdin.on('end', finish);
} else {
  finish();
}
STUB
chmod +x "$BIN/pi"
cat > "$BIN/claude" <<'STUB'
#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const agentDir = process.env.CLAUDE_CONFIG_DIR;
if (!agentDir) { process.stderr.write('stub claude: no CLAUDE_CONFIG_DIR\n'); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, 'prompt.txt'), process.argv[process.argv.length - 1] || '');
fs.writeFileSync(path.join(agentDir, 'cwd.txt'), process.cwd());
fs.writeFileSync(path.join(agentDir, 'env.json'), JSON.stringify({ PATH: process.env.PATH || null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || null }));
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, 'utf8'));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
process.stdout.write(process.env.STUB_REPLY || '');
process.exit(Number(process.env.STUB_EXIT || 0));
STUB
cat > "$BIN/codex" <<'STUB'
#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const agentDir = process.env.CODEX_HOME;
if (!agentDir) { process.stderr.write('stub codex: no CODEX_HOME\n'); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, 'prompt.txt'), process.argv[process.argv.length - 1] || '');
fs.writeFileSync(path.join(agentDir, 'cwd.txt'), process.cwd());
fs.writeFileSync(path.join(agentDir, 'env.json'), JSON.stringify({ PATH: process.env.PATH || null, CODEX_HOME: process.env.CODEX_HOME || null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || null }));
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, 'utf8'));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
process.stdout.write(process.env.STUB_REPLY || '');
process.exit(Number(process.env.STUB_EXIT || 0));
STUB
chmod +x "$BIN/claude" "$BIN/codex"

build_proj(){
  local proj="$1" ns="$2"
  mkdir -p "$proj/seats" "$proj/contracts" "$HOME_FIX/.pi-seats-$ns/verifier"
  selftest_copy_seat_runtime "$proj" "$HERE"
  cp -f "$WALK" "$proj/seats/walk.ts"
  cp -f "$VERIFY" "$proj/seats/verify.ts"
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
  ( cd "$proj" && git init -q -b main && [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] && git -c user.email=selftest@local -c user.name=selftest commit -q --allow-empty -m base ) \
    || { echo "selftest: could not build fixture git repo" >&2; exit 2; }
}

run_clocked(){
  local mode="$1"; shift
  CLOCK_DIR="$(mktemp -d "$FIX/clock.XXXXXX")" || exit 2
  rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$CLOCK" drive "$proj/seats/walk.ts" "$CLOCK_DIR" "$mode" "$@" 2>&1) || rc=$?
}

assert_clock_budget(){
  local expected="$1"
  if bun - "$CLOCK_DIR/armed" "$expected" <<'TS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const armed=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(armed.kind,'walk','armed clock belongs to the verifier spawn');
assert.equal(armed.budget,Number(process.argv[3]),'armed verifier budget must equal WHEELHOUSE_WALK_TIMEOUT_MS');
console.log(`armed verifier budget ${armed.budget} equals env ${process.argv[3]}`);
TS
  then pass "verifier spawn receives env budget $expected"
  else fail "verifier spawn armed budget differs from env $expected"; fi
}

phase 'captured malformed GUI output: match the actual verdict line, not other text'
if bun - "$CLOCK" "$HERE/fixtures/walk/gui-malformed-output.txt" <<'TS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const {namedFailure}=await import(process.argv[2]);const actual=fs.readFileSync(process.argv[3],'utf8'),want='window-list command malformed JSON';
assert(namedFailure(actual,want));
assert(namedFailure(actual+'\n'+('diagnostic padding\n'.repeat(262144)),want));
assert(!namedFailure(actual.replace(want,'reason omitted')+'\nmetadata: '+want,want));
assert(!namedFailure(actual.replace('VERDICT: COULD-NOT-WALK','VERDICT: WALKED-DONE'),want));
TS
then pass 'captured GUI name accepts complete output and rejects missing/wrong verdict names'
else fail 'captured GUI verdict-name regression'; fi

run_case(){
  local name="$1" reply="$2" expect_rc="$3" expect_text="$4"
  local proj="$FIX/proj-$name" out="$FIX/out-$name" ns="walk-$name" got rc transcript metadata argv prompt
  build_proj "$proj" "$ns"
  rc=0; got=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY="$reply" bun seats/walk.ts 'claim text' --surface product:'echo product' --out "$out" 2>&1) || rc=$?
  if [ "$rc" -eq "$expect_rc" ]; then pass "$name exit $rc"; else fail "$name exit got $rc expected $expect_rc: $got"; fi
  if printf '%s\n' "$got" | grep -F >/dev/null "$expect_text"; then pass "$name printed $expect_text"; else fail "$name missing $expect_text: $got"; fi
  transcript="$out/transcript.txt"
  metadata="$out/walk.json"
  [ -s "$transcript" ] && pass "$name retained transcript" || fail "$name transcript missing"
  if grep -q '\[tmpdir\]' "$transcript" && ! grep -qF "$HOME_FIX" "$transcript" && ! grep -qF "$FIX" "$transcript"; then pass "$name scrub applied"; else fail "$name scrub markers missing in transcript"; fi
  if [ -f "$metadata" ]; then
    if ! grep -qF "$FIX" "$metadata" && ! grep -qF "$HOME_FIX" "$metadata" && grep -q '"transcript": "\.\./out-' "$metadata"; then pass "$name walk.json transcript path is root-relative"
    else fail "$name walk.json contains an absolute fixture path or lacks a root-relative transcript: $(cat "$metadata" 2>/dev/null)"; fi
    if ! printf '%s\n' "$got" | grep -F >/dev/null "$FIX" && ! printf '%s\n' "$got" | grep -F >/dev/null "$HOME_FIX" && printf '%s\n' "$got" | grep >/dev/null 'transcript: \.\./out-'; then pass "$name stdout prints root-relative evidence paths"
    else fail "$name stdout contains an absolute fixture path or lacks root-relative transcript: $got"; fi
  fi
  argv="$HOME_FIX/.pi-seats-$ns/verifier/argv.json"
  prompt="$HOME_FIX/.pi-seats-$ns/verifier/prompt.txt"
  if grep -q -- '--append-system-prompt' "$argv" && grep -q 'contracts/VERIFIER.md' "$argv"; then pass "$name appended verifier brief"; else fail "$name did not append verifier brief: $(cat "$argv" 2>/dev/null)"; fi
  if grep -q 'Claim under verifier walk' "$prompt" && grep -q 'Product surface: echo product' "$prompt"; then pass "$name prompt carries claim and surface"; else fail "$name prompt missing claim/surface"; fi
  if ! grep -q "$proj/seats/bin" "$HOME_FIX/.pi-seats-$ns/verifier/env.json" 2>/dev/null; then pass "$name host budget absent leaves PATH alone except walk helper"; else fail "$name host budget absent unexpectedly prepended seats/bin: $(cat "$HOME_FIX/.pi-seats-$ns/verifier/env.json" 2>/dev/null)"; fi
  if grep -E 'contracts/REVIEWER|contracts/WORKER|wheelhouse/ISA|seats/logs|bd show' "$prompt" >/dev/null; then fail "$name prompt leaked fleet internals"; else pass "$name prompt avoids fleet internals"; fi
}

phase 'walk verdict parsing and transcript retention'
run_case done $'consumer output __HOME__ __TMP__\nVERDICT: WALKED-DONE\n' 0 'VERDICT: WALKED-DONE'
run_case notdone $'step output __HOME__ __TMP__\nVERDICT: WALKED-NOT-DONE — failed at fixture step\n' 2 'VERDICT: WALKED-NOT-DONE'
run_case couldnot $'blocked __HOME__ __TMP__\nVERDICT: COULD-NOT-WALK — missing fixture credential\n' 3 'VERDICT: COULD-NOT-WALK'
run_case zero $'no verdict here __HOME__ __TMP__\n' 4 'expected exactly one'
run_case dedup $'VERDICT: WALKED-DONE\nVERDICT: WALKED-DONE\n__HOME__ __TMP__\n' 0 'VERDICT: WALKED-DONE'
run_case two $'VERDICT: WALKED-DONE\nVERDICT: COULD-NOT-WALK — duplicate\n__HOME__ __TMP__\n' 4 'expected exactly one'

make_walk_stream_fixture(){
  local harness="$1" source="$2" dest="$3"
  cp "$source" "$dest"
  case "$harness" in
    pi) printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"VERDICT: WALKED-DONE"}]}}' >> "$dest" ;;
    claude-code) printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"VERDICT: WALKED-DONE"}]}}' >> "$dest" ;;
    codex) printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"VERDICT: WALKED-DONE"}}' >> "$dest" ;;
  esac
}

run_stream_case(){
  local name="$1" harness="$2" stream="$3"
  local proj="$FIX/proj-stream-$name" outdir="$FIX/out-stream-$name" ns="walk-stream-$name" out rc
  build_proj "$proj" "$ns"
  if [ "$harness" != pi ]; then
    bun -e "import fs from 'node:fs'; const p='$proj/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.verifier.harness='$harness'; j.seats.verifier.provider='$([ "$harness" = claude-code ] && printf anthropic || printf openai-codex)'; j.seats.verifier.model='stream-fixture'; j.seats.verifier.account.authRoute='$([ "$harness" = claude-code ] && printf oauth || printf env)'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
  fi
  if [ "$harness" = claude-code ]; then
    rm -f "$HOME_FIX/.pi-seats-$ns/verifier/auth.json"
    printf '{"oauthAccount":{"accountUuid":"fixture-oauth"}}\n' > "$HOME_FIX/.pi-seats-$ns/verifier/.claude.json"
  fi
  local codex_key_env=""
  [ "$harness" = codex ] && codex_key_env="OPENAI_CODEX_API_KEY=fixture-key"
  rc=0; out=$(cd "$proj" && env HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STREAM_FILE="$stream" $codex_key_env bun seats/walk.ts 'claim' --surface product:fixture --out "$outdir" 2>&1) || rc=$?
  [ "$rc" -eq 0 ] && pass "$name final-message stream exits WALKED-DONE" || fail "$name stream rc=$rc output=$out"
  printf '%s\n' "$out" | grep >/dev/null 'VERDICT: WALKED-DONE' && pass "$name final-message stream prints verdict" || fail "$name stream missing verdict: $out"
  [ -s "$outdir/walk.json" ] && grep -q '"verdict": "WALKED-DONE"' "$outdir/walk.json" && pass "$name final-message stream writes verdict file" || fail "$name stream missing verdict file: $(cat "$outdir/walk.json" 2>/dev/null)"
}

phase 'real stream wire shapes parse walk verdict from final assistant message'
for f in pi-v3-message-end.jsonl claude-code-2.1.278-assistant.jsonl codex-0.144.0-item-completed-agent-message.jsonl; do
  [ -f "$REAL_FIXTURES_DIR/$f" ] || { echo "selftest: missing real verifier fixture: $REAL_FIXTURES_DIR/$f" >&2; exit 2; }
done
pi_stream="$FIX/pi-walk-stream.jsonl"; make_walk_stream_fixture pi "$REAL_FIXTURES_DIR/pi-v3-message-end.jsonl" "$pi_stream"; run_stream_case pi pi "$pi_stream"
claude_stream="$FIX/claude-walk-stream.jsonl"; make_walk_stream_fixture claude-code "$REAL_FIXTURES_DIR/claude-code-2.1.278-assistant.jsonl" "$claude_stream"; run_stream_case claude claude-code "$claude_stream"
codex_stream="$FIX/codex-walk-stream.jsonl"; make_walk_stream_fixture codex "$REAL_FIXTURES_DIR/codex-0.144.0-item-completed-agent-message.jsonl" "$codex_stream"; run_stream_case codex codex "$codex_stream"
[ -s "$INCIDENT_STREAM" ] || { echo "selftest: missing scrubbed incident stream: $INCIDENT_STREAM" >&2; exit 2; }
incident_stream="$FIX/incident-stream.jsonl"
"$NODE_BIN" - "$INCIDENT_STREAM" "$incident_stream" <<'NODE'
const fs = require('fs');
const input = fs.readFileSync(process.argv[2], 'utf8');
if (!input.includes('VERDICT: WALKED-DONE')) process.exit(2);
fs.writeFileSync(process.argv[3], JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: input + '\nVERDICT: WALKED-DONE' }] } }) + '\n');
NODE
run_stream_case incident pi "$incident_stream"

phase 'host budget PATH is opt-in for verifier walks'
proj="$FIX/proj-budget"; ns="walk-budget"; outdir="$FIX/out-budget"; build_proj "$proj" "$ns"
mkdir -p "$proj/seats/bin"
printf '{"enabled":true}\n' > "$proj/seats/host-budget.json"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$outdir" 2>&1) || rc=$?
[ "$rc" -eq 0 ] && pass 'host-budget walk exits 0' || fail "host-budget walk rc=$rc output=$out"
if grep -q "$proj/seats/bin" "$HOME_FIX/.pi-seats-$ns/verifier/env.json" 2>/dev/null; then pass 'host budget enabled: walk PATH includes project seats/bin'; else fail "host budget enabled: walk PATH missing seats/bin: $(cat "$HOME_FIX/.pi-seats-$ns/verifier/env.json" 2>/dev/null)"; fi

phase 'mixed harness verifier walks use the selected driver'
proj="$FIX/proj-mixed-walk"; ns="walk-mixed"; build_proj "$proj" "$ns"
bun -e "import fs from 'node:fs'; const p='$proj/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.verifier.harness='claude-code'; j.seats.verifier.provider='anthropic'; j.seats.verifier.model='sonnet'; j.seats.verifier.account.authRoute='oauth'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
rm -f "$HOME_FIX/.pi-seats-$ns/verifier/auth.json"
printf '{"oauthAccount":{"accountUuid":"fixture-oauth"}}\n' > "$HOME_FIX/.pi-seats-$ns/verifier/.claude.json"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-mixed-claude" 2>&1) || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'CLAUDE_CONFIG_DIR' "$HOME_FIX/.pi-seats-$ns/verifier/env.json" && ! grep -q 'PI_CODING_AGENT_DIR.*pi-seats' "$HOME_FIX/.pi-seats-$ns/verifier/env.json"; then pass 'claude-code oauth walk one-shot uses claude driver environment, not pi'; else fail "claude-code oauth walk one-shot wrong rc=$rc out=$out env=$(cat "$HOME_FIX/.pi-seats-$ns/verifier/env.json" 2>/dev/null)"; fi
if grep -q '"--output-format","stream-json"' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" && grep -q '"--verbose"' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json"; then pass 'claude-code walk one-shot requests stream-json output with --verbose'; else fail "claude-code walk one-shot missing stream-json/--verbose argv: $(cat "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" 2>/dev/null)"; fi
if grep -q 'Fixture walker brief' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" && ! grep -q 'contracts/VERIFIER.md' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json"; then pass 'claude-code walk one-shot carries verifier brief text, not the path'; else fail "claude-code walk one-shot carried path or missed brief text: $(cat "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" 2>/dev/null)"; fi
if ! grep -q -- 'permission-mode\|allowed-tools\|disallowed-tools' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json"; then pass 'claude-code walk one-shot omits tool permission flags when the seat has no tool lists'; else fail "claude-code walk one-shot unexpectedly carried tool permission flags: $(cat "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" 2>/dev/null)"; fi
bun -e "import fs from 'node:fs'; const p='$proj/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.verifier.allowedTools='Bash(git status:*),Bash(bun test:*)'; j.seats.verifier.disallowedTools='Bash(rm -rf:*)'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
rm -f "$HOME_FIX/.pi-seats-$ns/verifier/argv.json"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-mixed-claude-tools" 2>&1) || rc=$?
if [ "$rc" -eq 0 ] && bun -e '
  import fs from "node:fs";
  const args = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const flagAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 && /^--/.test(args[i+2] ?? ""); };
  if (args.at(-1).startsWith("--")) process.exit(1);
  if (!args.includes("--permission-mode") || args[args.indexOf("--permission-mode")+1] !== "acceptEdits") process.exit(2);
  if (!flagAfter("--allowed-tools") || !flagAfter("--disallowed-tools")) process.exit(3);
  if (args.indexOf("--allowed-tools") > args.indexOf("--model") || args.indexOf("--disallowed-tools") > args.indexOf("--model")) process.exit(4);
' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json"; then pass 'claude-code walk one-shot passes tool lists before --model with a following flag and prompt last'; else fail "claude-code walk one-shot tool-list argv order wrong (rc=$rc argv=$(cat "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" 2>/dev/null))"; fi
bun -e "import fs from 'node:fs'; const p='$proj/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.verifier.harness='codex'; j.seats.verifier.provider='openai-codex'; j.seats.verifier.model='gpt-5.5'; delete j.seats.verifier.allowedTools; delete j.seats.verifier.disallowedTools; fs.writeFileSync(p, JSON.stringify(j,null,2));"
printf '{"stub":true}\n' > "$HOME_FIX/.pi-seats-$ns/verifier/auth.json"
rm -f "$HOME_FIX/.pi-seats-$ns/verifier/env.json"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-mixed-codex" 2>&1) || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'CODEX_HOME' "$HOME_FIX/.pi-seats-$ns/verifier/env.json" && ! grep -q 'PI_CODING_AGENT_DIR.*pi-seats' "$HOME_FIX/.pi-seats-$ns/verifier/env.json"; then pass 'codex walk one-shot uses codex driver environment, not pi'; else fail "codex walk one-shot wrong rc=$rc out=$out env=$(cat "$HOME_FIX/.pi-seats-$ns/verifier/env.json" 2>/dev/null)"; fi
if grep -q 'Fixture walker brief' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" && grep -q -- '--skip-git-repo-check' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" && grep -q 'approval_policy=never' "$HOME_FIX/.pi-seats-$ns/verifier/argv.json"; then pass 'codex walk one-shot carries verifier brief and measured-safe exec flags'; else fail "codex walk one-shot missing brief or safe flags: $(cat "$HOME_FIX/.pi-seats-$ns/verifier/argv.json" 2>/dev/null)"; fi

phase 'image budget reduces over-budget capture set before spawn'
imgdir="$FIX/images-overbudget"
mkdir -p "$imgdir"
"$NODE_BIN" -e 'const fs=require("fs"), b=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJxvVgAAAABJRU5ErkJggg==","base64"); for (let i=1;i<=5;i++) fs.writeFileSync(process.argv[1]+`/shot-${i}.png`, b);' "$imgdir"
proj="$FIX/proj-images"; ns="walk-images"; build_proj "$proj" "$ns"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_IMAGE_SOURCE_DIR="$imgdir" WHEELHOUSE_WALK_IMAGE_MAX_CONTEXT=2 STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-images" 2>&1) || rc=$?
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
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_WINDOW_LIST_JSON='[{"title":"Fixture Device","frontmost":true,"obscuredBy":"Bench Simulator Clone"}]' STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:gui:Fixture --out "$FIX/out-gui" 2>&1) || rc=$?
[ "$rc" -eq 3 ] && pass 'obscured GUI target exits COULD-NOT-WALK (3)' || fail "obscured GUI target rc=$rc output=$out"
printf '%s\n' "$out" | grep >/dev/null 'VERDICT: COULD-NOT-WALK' && printf '%s\n' "$out" | grep >/dev/null 'obscured by Bench Simulator Clone' && pass 'obscured GUI target names the obscuring window' || fail "obscured GUI target did not name the blocker: $out"
[ ! -f "$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt" ] && pass 'obscured GUI target does not spawn the verifier seat' || fail 'obscured GUI target spawned stub pi before the guard'
if grep -q '"mode": "window-list"' "$FIX/out-gui/walk.json" && grep -q 'Bench Simulator Clone' "$FIX/out-gui/walk.json"; then pass 'walk.json records the window-list guard mode and blocker'; else fail "walk.json missing guard mode/blocker: $(cat "$FIX/out-gui/walk.json" 2>/dev/null)"; fi

for case in failcmd malformed wrongshape; do
  proj="$FIX/proj-gui-$case"; ns="walk-gui-$case"; outdir="$FIX/out-gui-$case"; build_proj "$proj" "$ns"
  case "$case" in
    failcmd) cmd='printf "fixture command stderr\\n" >&2; exit 1'; want='window-list command failed';;
    malformed) cmd='printf "not json"'; want='window-list command malformed JSON';;
    wrongshape) cmd='printf "{\\\"notWindows\\\":[]}"'; want='returned wrong shape';;
  esac
  WHEELHOUSE_WALK_WINDOW_LIST_COMMAND="$cmd" STUB_REPLY=$'VERDICT: WALKED-DONE\n' run_clocked gui 'claim' --surface product:gui:Fixture --out "$outdir"
  [ "$rc" -eq 3 ] && pass "GUI command $case exits COULD-NOT-WALK (3)" || fail "GUI command $case rc=$rc output=$out"
  printf '%s\n' "$out" | bun "$CLOCK" match "$want" && pass "GUI command $case names the window-list failure" || fail "GUI command $case did not name failure '$want': $out"
  [ -s "$outdir/walk.json" ] && grep -q "$want" "$outdir/walk.json" && pass "GUI command $case writes walk.json with reason" || fail "GUI command $case walk.json missing reason: $(cat "$outdir/walk.json" 2>/dev/null)"
  [ ! -f "$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt" ] && pass "GUI command $case does not spawn the verifier seat" || fail "GUI command $case spawned stub pi before guard refusal"
done

proj="$FIX/proj-nongui"; ns="walk-nongui"; build_proj "$proj" "$ns"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WALK_WINDOW_LIST_JSON='not-json-if-read' STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface install:README.md --out "$FIX/out-nongui" 2>&1) || rc=$?
[ "$rc" -eq 0 ] && pass 'non-GUI install surface does not consult the injected window list' || fail "non-GUI install consulted the window list or otherwise failed (rc=$rc): $out"
if grep -q '"mode": "not-gui"' "$FIX/out-nongui/walk.json"; then pass 'walk.json records not-gui mode for non-GUI surfaces'; else fail "non-GUI walk.json missing not-gui mode: $(cat "$FIX/out-nongui/walk.json" 2>/dev/null)"; fi

phase 'stdin-reading verifier receives EOF immediately'
proj="$FIX/proj-stdin"; ns="walk-stdin"; build_proj "$proj" "$ns"
# One tick of fixture time; no real deadline. The driver keeps caller stdin open.
WHEELHOUSE_WALK_TIMEOUT_MS=1 STUB_READ_STDIN_TO_EOF=1 STUB_REPLY=$'VERDICT: WALKED-DONE\n' run_clocked eof 'claim' --surface product:fixture --out "$FIX/out-stdin"
assert_clock_budget 1
[ "$rc" -eq 0 ] && pass 'stdin-reading verifier exits 0' || fail "stdin-reading verifier rc=$rc output=$out"
printf '%s\n' "$out" | grep >/dev/null 'VERDICT: WALKED-DONE' && pass 'stdin-reading verifier walk completes with a verdict' || fail "stdin-reading verifier missing verdict: $out"
[ -f "$CLOCK_DIR/readiness-observed" ] && [ -f "$CLOCK_DIR/eof" ] && [ ! -e "$CLOCK_DIR/expired" ] && pass 'stdin EOF is observed after readiness with caller pipe still open, without expiring a clock' || fail "stdin EOF handshake missing: $out"

phase 'timeout names phase and honors per-walk budget env'
proj="$FIX/proj-timeout"; ns="walk-timeout"; build_proj "$proj" "$ns"
WHEELHOUSE_WALK_TIMEOUT_MS=200 STUB_REPLY=$'working before timeout\nVERDICT: WALKED-DONE\n' run_clocked timeout 'claim' --surface product:fixture --out "$FIX/out-timeout"
assert_clock_budget 200
[ "$rc" -eq 3 ] && pass 'timeout exits as COULD-NOT-WALK (3)' || fail "timeout rc=$rc output=$out"
printf '%s\n' "$out" | grep >/dev/null 'VERDICT: COULD-NOT-WALK — timed out after 200ms during run verifier walk' && pass 'timeout verdict names budget and phase' || fail "timeout did not name budget/phase: $out"
if grep -q '"phase": "run verifier walk"' "$FIX/out-timeout/walk.json" && grep -q 'timed out after 200ms during run verifier walk' "$FIX/out-timeout/walk.json"; then pass 'timeout metadata records phase'; else fail "timeout metadata missing phase: $(cat "$FIX/out-timeout/walk.json" 2>/dev/null)"; fi

phase 'upgrade surface requires baseline'
proj="$FIX/proj-upgrade"; ns="walk-upgrade"; build_proj "$proj" "$ns"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface upgrade:runbooks/UPGRADE.md --out "$FIX/out-upgrade" 2>&1) || rc=$?
[ "$rc" -eq 1 ] && pass 'upgrade without baseline exits 1' || fail "upgrade without baseline rc=$rc output=$out"
printf '%s\n' "$out" | grep >/dev/null -- 'requires --baseline' && pass 'upgrade baseline refusal named' || fail "upgrade baseline refusal missing: $out"

phase 'credential refusal distinct and no live pi required'
proj="$FIX/proj-refuse"; ns="walk-refuse"; build_proj "$proj" "$ns"
rm -f "$HOME_FIX/.pi-seats-$ns/verifier/auth.json"
rc=0; out=$(cd "$proj" && HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY=$'VERDICT: WALKED-DONE\n' bun seats/walk.ts 'claim' --surface product:fixture --out "$FIX/out-refuse" 2>&1) || rc=$?
[ "$rc" -eq 5 ] && pass 'missing credential exits 5' || fail "missing credential rc=$rc output=$out"
[ ! -f "$HOME_FIX/.pi-seats-$ns/verifier/cwd.txt" ] && pass 'missing credential did not spawn stub pi' || fail 'missing credential spawned stub pi'

phase 'interrupt removes scratch worktree'
proj="$FIX/proj-int"; ns="walk-int"; build_proj "$proj" "$ns"
STUB_REPLY=$'working\nVERDICT: WALKED-DONE\n' run_clocked interrupt 'claim' --surface product:fixture --out "$FIX/out-int"
[ -f "$CLOCK_DIR/readiness-observed" ] && pass 'interrupt fixture captured scratch cwd before signalling' || fail "interrupt fixture readiness missing: $out"
if [ -f "$CLOCK_DIR/scratch-removed" ]; then pass 'interrupt removed scratch cwd before process exit'; else fail "interrupt left scratch cwd (rc=$rc): $out"; fi

if [ "$FAILED" -eq 0 ]; then
  echo "walk.selftest: PASS"
  exit 0
fi
echo "walk.selftest: FAIL ($FAILED failure(s))" >&2
exit 1
