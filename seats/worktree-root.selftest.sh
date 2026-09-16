#!/usr/bin/env bash
# worktree-root.selftest.sh — prove install doctrine, dispatch, prune, and Pi trust
# all agree on the in-root .wheelhouse-worktrees directory.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ADAPTER="$HERE/adapter.ts"
PRUNE="$HERE/prune.ts"
SEAT_ENV="$HERE/seat-env.sh"
BRIEFS="$HERE/briefs.ts"
HARNESS="$HERE/harness.ts"
HOST_BUDGET="$HERE/host-budget.ts"

FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase() { printf '\n%s\n' "$*"; }

for f in "$ADAPTER" "$PRUNE" "$SEAT_ENV" "$BRIEFS" "$HARNESS" "$HOST_BUDGET"; do
  [ -s "$f" ] || { echo "selftest: missing $f" >&2; exit 2; }
done
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "selftest: node is required" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-worktree-root-selftest.$$.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
PROJ="$FIX/project"
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$(command -v node)"):/usr/bin:/bin"
cleanup() { pkill -f "$FIX" 2>/dev/null || true; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM
mkdir -p "$HOME_FIX" "$BIN" "$PROJ/seats" "$PROJ/contracts"

cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write('stub pi: no PI_CODING_AGENT_DIR\n'); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
const args = process.argv.slice(2);
fs.writeFileSync(path.join(agentDir, 'argv.json'), JSON.stringify(args));
fs.writeFileSync(path.join(agentDir, 'cwd.txt'), process.cwd());
if (args.includes('-p')) { process.stdout.write('OK\n'); process.exit(0); }
const sessDir = path.join(agentDir, 'sessions');
fs.mkdirSync(sessDir, { recursive: true });
let sessionFile, sessionId;
const si = args.indexOf('--session');
if (si !== -1) {
  sessionFile = args[si + 1];
  sessionId = path.basename(sessionFile, '.jsonl');
  fs.appendFileSync(sessionFile, JSON.stringify({ type: 'resumed', cwd: process.cwd() }) + '\n');
} else {
  sessionId = crypto.randomUUID();
  sessionFile = path.join(sessDir, sessionId + '.jsonl');
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session-start', cwd: process.cwd() }) + '\n');
}
const commandsFile = path.join(agentDir, 'commands.jsonl');
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
function handle(cmd) {
  fs.appendFileSync(commandsFile, JSON.stringify(cmd) + '\n');
  if (cmd.type === 'get_state') {
    out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false, sessionFile, sessionId, messageCount: 0 } });
    return;
  }
  if (cmd.type === 'prompt') {
    out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
    fs.appendFileSync(sessionFile, JSON.stringify({ type: 'prompt', message: cmd.message, cwd: process.cwd() }) + '\n');
    out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + cmd.message }] } });
    out({ type: 'agent_end', messages: [] });
    return;
  }
  out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'stub unknown ' + cmd.type });
}
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.on('SIGTERM', () => process.exit(0));
STUB
chmod +x "$BIN/pi"

cp "$ADAPTER" "$PROJ/seats/adapter.ts"
cp "$PRUNE" "$PROJ/seats/prune.ts"
cp "$SEAT_ENV" "$PROJ/seats/seat-env.sh"
cp "$BRIEFS" "$PROJ/seats/briefs.ts"
cp "$HARNESS" "$PROJ/seats/harness.ts"
cp "$HOST_BUDGET" "$PROJ/seats/host-budget.ts"
printf '# Fleet: Worker\n\nfixture brief\n' > "$PROJ/contracts/WORKER.md"
cat > "$PROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model",
      "account": { "dir": "~/.pi-seats-nyff/worker-1" }
    }
  }
}
EOF

# prune.ts discovers repositories from --root, so make the fixture root a real repo.
git -C "$PROJ" init -q
printf 'fixture\n' > "$PROJ/README.md"
git -C "$PROJ" add README.md
git -C "$PROJ" -c user.email=selftest@local -c user.name=selftest commit -q -m init

phase "single-repo worktree root agreement"
OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$PROJ/seats/seat-env.sh" nyff worker-1 "$PROJ" 2>&1)"; RC=$?
TRUST="$HOME_FIX/.pi-seats-nyff/worker-1/trust.json"
if [ $RC -eq 0 ] && [ -s "$TRUST" ]; then pass "seat-env writes the Pi trust grant"; else fail "seat-env failed (exit $RC): $OUT"; fi
TRUST_ROOT="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(Object.keys(j).find(k=>j[k]===true)||"")' "$TRUST" 2>/dev/null)"
WORKTREE_ROOT="$PROJ/.wheelhouse-worktrees"
if [ "$TRUST_ROOT" = "$PROJ" ] && [ "${WORKTREE_ROOT#"$TRUST_ROOT"/}" != "$WORKTREE_ROOT" ]; then
  pass "trust grant covers the in-root .wheelhouse-worktrees directory"
else
  fail "trust grant and worktree root disagree: trust=$TRUST_ROOT worktree_root=$WORKTREE_ROOT"
fi
printf '{"stub":true}\n' > "$HOME_FIX/.pi-seats-nyff/worker-1/auth.json"

mkdir -p "$WORKTREE_ROOT/bead-a"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/adapter.ts" spawn worker-1 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "fixture seat spawns"; else fail "spawn failed (exit $RC): $OUT"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/adapter.ts" dispatch worker-1 bead-a "hello from worktree root selftest" 2>&1)"; RC=$?
CWD_FILE="$HOME_FIX/.pi-seats-nyff/worker-1/cwd.txt"
if [ $RC -eq 0 ] && [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$WORKTREE_ROOT/bead-a" ]; then
  pass "adapter dispatch uses <root>/.wheelhouse-worktrees/<bead>"
else
  fail "dispatch did not use the in-root worktree (exit $RC): cwd=$(cat "$CWD_FILE" 2>/dev/null) out=$OUT"
fi

mkdir -p "$WORKTREE_ROOT/orphan-a"
SCAN="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/prune.ts" scan --root "$PROJ" --format json 2>&1)"; RC=$?
if [ $RC -eq 0 ] && node -e 'const rows=JSON.parse(process.argv[1]); const want=process.argv[2]; if (!rows.some(r => r.category === "orphaned-worktree" && r.path === want)) process.exit(1)' "$SCAN" "$WORKTREE_ROOT/orphan-a"; then
  pass "prune scans the same <root>/.wheelhouse-worktrees directory"
else
  fail "prune did not report the in-root orphaned worktree (exit $RC): $SCAN"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "worktree-root selftest passed."
else
  echo "$FAILED check(s) failed."
fi
exit "$FAILED"
