#!/usr/bin/env bash
# worktree-root.selftest.sh — prove install doctrine, dispatch, prune, and Pi trust
# all agree on the in-root .wheelhouse-worktrees directory.

set -uo pipefail

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
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

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-worktree-root-selftest.$$.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
PROJ="$FIX/project"
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$(command -v node)"):/usr/bin:/bin"
cleanup() { pkill -f "$FIX" 2>/dev/null || true; selftest_remove_fixture_dir "$FIX"; }
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
cp "$(dirname "$ADAPTER")/seat-worktree.ts" "$PROJ/seats/seat-worktree.ts"
cp "$PRUNE" "$PROJ/seats/prune.ts"
cp "$(dirname "$PRUNE")/seat-worktree.ts" "$PROJ/seats/seat-worktree.ts"
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
RC=0; OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$PROJ/seats/seat-env.sh" nyff worker-1 "$PROJ" 2>&1)" || RC=$?
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

RC=0; OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/adapter.ts" spawn worker-1 2>&1)" || RC=$?
if [ $RC -eq 0 ]; then pass "fixture seat spawns"; else fail "spawn failed (exit $RC): $OUT"; fi
RC=0; OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 bun "$PROJ/seats/adapter.ts" dispatch worker-1 bead-a "hello from worktree root selftest" 2>&1)" || RC=$?
CWD_FILE="$HOME_FIX/.pi-seats-nyff/worker-1/cwd.txt"
if [ $RC -eq 0 ] && [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$WORKTREE_ROOT/worker-1" ]; then
  pass "adapter dispatch uses the seat's own <root>/.wheelhouse-worktrees/<seat> worktree"
else
  fail "dispatch did not use the in-root seat worktree (exit $RC): cwd=$(cat "$CWD_FILE" 2>/dev/null) out=$OUT"
fi
if [ "$(git -C "$WORKTREE_ROOT/worker-1" branch --show-current 2>/dev/null)" = "fleet/bead-a" ]; then
  pass "the seat worktree is a real git worktree on fleet/<bead>"
else
  fail "seat worktree branch was $(git -C "$WORKTREE_ROOT/worker-1" branch --show-current 2>&1)"
fi

mkdir -p "$WORKTREE_ROOT/orphan-a"
RC=0; SCAN="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/prune.ts" scan --root "$PROJ" --format json 2>&1)" || RC=$?
if [ $RC -eq 0 ] && node -e 'const rows=JSON.parse(process.argv[1]); const want=process.argv[2]; if (!rows.some(r => r.category === "orphaned-worktree" && r.path === want)) process.exit(1)' "$SCAN" "$WORKTREE_ROOT/orphan-a"; then
  pass "prune scans the same <root>/.wheelhouse-worktrees directory"
else
  fail "prune did not report the in-root orphaned worktree (exit $RC): $SCAN"
fi

phase "umbrella root git repo with product-repo seat worktree"
UMB="$FIX/umbrella"
PRODUCT="$UMB/template"
mkdir -p "$UMB/seats" "$UMB/contracts" "$UMB/wheelhouse" "$PRODUCT"
cp "$ADAPTER" "$UMB/seats/adapter.ts"
cp "$(dirname "$ADAPTER")/seat-worktree.ts" "$UMB/seats/seat-worktree.ts"
cp "$BRIEFS" "$UMB/seats/briefs.ts"
cp "$HARNESS" "$UMB/seats/harness.ts"
cp "$HOST_BUDGET" "$UMB/seats/host-budget.ts"
cp "$SEAT_ENV" "$UMB/seats/seat-env.sh"
printf '# Fleet: Worker\n\nfixture brief\n' > "$UMB/contracts/WORKER.md"
cat > "$UMB/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model",
      "account": { "dir": "~/.pi-seats-umbrella/worker-1" }
    }
  }
}
EOF
cat > "$UMB/wheelhouse/.template-source" <<EOF
path=$FIX/template-source
product-repo=$PRODUCT
commit=fixture
namespace=umbrella
EOF
# This is the regression shape: the container root is itself a git repo, but
# the worker branch belongs to the product repo recorded in .template-source.
git -C "$UMB" init -q
printf 'umbrella machinery\n' > "$UMB/README.md"
git -C "$UMB" add README.md wheelhouse/.template-source
git -C "$UMB" -c user.email=selftest@local -c user.name=selftest commit -q -m umbrella

git -C "$PRODUCT" init -q
printf 'product\n' > "$PRODUCT/README.md"
git -C "$PRODUCT" add README.md
git -C "$PRODUCT" -c user.email=selftest@local -c user.name=selftest commit -q -m product

RC=0; OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$UMB/seats/seat-env.sh" umbrella worker-1 "$UMB" 2>&1)" || RC=$?
if [ $RC -eq 0 ]; then pass "umbrella fixture seat-env writes trust"; else fail "umbrella seat-env failed (exit $RC): $OUT"; fi
printf '{"stub":true}\n' > "$HOME_FIX/.pi-seats-umbrella/worker-1/auth.json"
RC=0; OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$UMB/seats/adapter.ts" spawn worker-1 2>&1)" || RC=$?
if [ $RC -eq 0 ]; then pass "umbrella fixture seat spawns"; else fail "umbrella spawn failed (exit $RC): $OUT"; fi
RC=0; OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 bun "$UMB/seats/adapter.ts" dispatch worker-1 bead-product-a "hello from umbrella" 2>&1)" || RC=$?
UMB_WT="$UMB/.wheelhouse-worktrees/worker-1"
if [ $RC -eq 0 ] && [ "$(git -C "$UMB_WT" rev-parse --show-toplevel 2>/dev/null)" = "$UMB_WT" ] && [ "$(git -C "$PRODUCT" worktree list --porcelain | awk -v wt="$UMB_WT" '$1=="worktree" && $2==wt {found=1} END{print found+0}')" = 1 ] && ! git -C "$UMB" worktree list --porcelain | awk -v wt="$UMB_WT" '$1=="worktree" && $2==wt {found=1} END{exit(found?0:1)}'; then
  pass "umbrella dispatch creates the seat worktree from product-repo, not the root repo"
else
  fail "umbrella dispatch did not create product repo worktree (exit $RC): out=$OUT product_list=$(git -C "$PRODUCT" worktree list --porcelain 2>&1) root_list=$(git -C "$UMB" worktree list --porcelain 2>&1)"
fi
RC=0; OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 bun "$UMB/seats/adapter.ts" dispatch worker-1 bead-product-b "reuse umbrella worktree" 2>&1)" || RC=$?
if [ $RC -eq 0 ] && [ "$(git -C "$PRODUCT" worktree list --porcelain | awk -v wt="$UMB_WT" '$1=="worktree" && $2==wt {found=1} END{print found+0}')" = 1 ] && [ "$(git -C "$UMB_WT" branch --show-current 2>/dev/null)" = "fleet/bead-product-b" ]; then
  pass "umbrella dispatch reuses the existing product-repo seat worktree"
else
  fail "umbrella dispatch did not reuse product repo worktree (exit $RC): out=$OUT branch=$(git -C "$UMB_WT" branch --show-current 2>&1)"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "worktree-root selftest passed."
else
  echo "$FAILED check(s) failed."
fi
exit "$FAILED"
