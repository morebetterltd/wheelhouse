#!/usr/bin/env bash
set -uo pipefail
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-jev.XXXXXX")" || exit 2
SERVER_PID=""
cleanup(){ [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1; selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
ROOT="$FIX/project"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"; mkdir -p "$ROOT/seats/logs" "$ROOT/seats/run" "$ROOT/wheelhouse" "$BIN" "$HOME_FIX" "$FIX/out"
for f in staffing.ts jev.ts pool.ts roster.ts fleet-snapshot.ts seat-activity.ts seat-worktree.ts harness.ts credential-shapes.ts quota.ts lock.ts; do cp "$HERE/$f" "$ROOT/seats/$f"; done
cat > "$ROOT/seats/seats.json" <<'JSON'
{"seats":{"commander":{"role":"commander","external":true}}}
JSON
cat > "$ROOT/seats/pool.json" <<JSON
{"version":1,"roles":{"workers":{"min":0,"max":2,"entries":["e1","e2"],"model":"worker"},"reviewers":{"min":0,"max":1,"entries":["r1"],"model":"reviewer"}},"entries":{"e1":{"harness":"pi","provider":"anthropic","models":["worker"],"account":{"dir":"$HOME_FIX/.pi-seats-fixture/acct-e1","authRoute":"env"}},"e2":{"harness":"pi","provider":"anthropic","models":["worker"],"account":{"dir":"$HOME_FIX/.pi-seats-fixture/acct-e2","authRoute":"env"}},"r1":{"harness":"pi","provider":"anthropic","models":["reviewer"],"account":{"dir":"$HOME_FIX/.pi-seats-fixture/acct-r1","authRoute":"env"}}}}
JSON
cat > "$ROOT/wheelhouse/.template-source" <<'EOF'
namespace=fixture
EOF
mkdir -p "$HOME_FIX/.pi-seats-fixture/acct-e1" "$HOME_FIX/.pi-seats-fixture/acct-e2" "$HOME_FIX/.pi-seats-fixture/acct-r1"
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "ready --json") n=${BD_READY_COUNT:-1}; if [ "$n" = 0 ]; then printf '[]\n'; else printf '[{"id":"ready-1","title":"Synthetic ready work with a title long enough to exercise truncation but no paths","dependencies":[]}]\n'; fi ;;
  "list --json") printf '[{"id":"ready-1","title":"Synthetic ready work with a title long enough to exercise truncation but no paths","status":"open","dependencies":[],"issue_type":"task","created_at":"2026-01-01T00:00:00Z"}]\n' ;;
  *) printf '[]\n' ;;
esac
SH
chmod +x "$BIN/bd"
cat > "$FIX/server.ts" <<'TS'
const reqFile = process.env.REQ_FILE!;
const replyFile = process.env.REPLY_FILE!;
const portFile = process.env.PORT_FILE!;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (new URL(req.url).pathname !== "/v1/systemone") return new Response("not found", { status: 404 });
  const body = await req.text();
  await Bun.write(reqFile, body + "\n", { append: true });
  const reply = (await Bun.file(replyFile).text()).trim();
  if (reply === "HANG") await new Promise((resolve) => setTimeout(resolve, 10000));
  if (reply.startsWith("STATUS ")) return new Response(reply, { status: Number(reply.split(/\s+/)[1]) || 500 });
  return new Response(reply, { status: 200, headers: { "content-type": "application/json" } });
}});
await Bun.write(portFile, String(server.port));
await new Promise(() => {});
TS
REQ="$FIX/requests.jsonl"; REPLY="$FIX/reply.json"; PORT_FILE="$FIX/port"; : > "$REQ"; printf '{"model":"jev-latest","answers":{"":{"type":"choice","choice":"add_worker","probabilities":{"add_worker":0.9,"nothing":0.1},"confidence":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}\n' > "$REPLY"
REQ_FILE="$REQ" REPLY_FILE="$REPLY" PORT_FILE="$PORT_FILE" bun "$FIX/server.ts" > "$FIX/server.out" 2>&1 & SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$PORT_FILE")"
KEY="JEV-SENTINEL-selftest-key"
run_staff(){ OUT_FILE="$FIX/out/$1.out"; shift; OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" JEV_BASE_URL="$BASE" JEV_API_KEY="$KEY" JEV_TIMEOUT_MS=1000 "$@" 2>&1 | tee "$OUT_FILE")"; RC=${PIPESTATUS[0]}; }
set_reply(){ printf '%s\n' "$1" > "$REPLY"; }

phase 'request body and decisions'
run_staff add bun seats/staffing.ts check --dry-run
BODY="$(tail -n 1 "$REQ")"
if [ $RC -eq 0 ] && grep -q 'decision=add-worker decider=jev conf=0.90' <<<"$OUT" && node -e 'const j=JSON.parse(process.argv[1]); if(j.model!=="jev-latest"||!j.state?.counts||!j.questions?.[""]||j.questions[""].type!=="choice"||!j.questions[""].criteria.add_worker||!j.questions[""].criteria.add_reviewer||!j.questions[""].criteria.drop_seat||!j.questions[""].criteria.nothing||!j.questions[""].criteria.other) process.exit(1)' "$BODY"; then pass 'Jev add_worker 0.9 drives add-worker and sends confirmed wire shape'; else fail "add_worker failed rc=$RC out=$OUT body=$BODY"; fi
if ! printf '%s' "$BODY" | grep -Eq '/Users/|/home/|~/|JEV-SENTINEL|sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]' && ! printf '%s' "$BODY" | grep -F "$HOME_FIX" >/dev/null; then pass 'request body omits paths, home, key and credential-shaped strings'; else fail "request body leaked private material: $BODY"; fi
set_reply '{"model":"jev-latest","answers":{"":{"type":"choice","choice":"drop_seat","probabilities":{"drop_seat":0.3},"confidence":0.3}},"usage":{"input_tokens":1,"output_tokens":1}}'; run_staff low bun seats/staffing.ts check --dry-run
[ $RC -eq 0 ] && grep -q 'decision=add-worker decider=rule' <<<"$OUT" && grep -q 'jev skipped: low confidence 0.30' <<<"$OUT" && pass 'low confidence falls back to the rule' || fail "low confidence did not fall back: $OUT"
set_reply '{"model":"jev-latest","answers":{"":{"type":"choice","choice":"other","probabilities":{"other":0.95},"confidence":0.95}},"usage":{"input_tokens":1,"output_tokens":1}}'; run_staff other bun seats/staffing.ts check --dry-run
[ $RC -eq 0 ] && grep -q 'decider=rule' <<<"$OUT" && grep -q 'jev skipped: other' <<<"$OUT" && pass 'other falls back to the rule' || fail "other did not fall back: $OUT"
set_reply 'STATUS 500'; run_staff http500 bun seats/staffing.ts check --dry-run
[ $RC -eq 0 ] && grep -q 'jev skipped: http 500' <<<"$OUT" && pass 'http 500 falls back to the rule' || fail "http 500 failed: $OUT"
set_reply 'HANG'; start=$(date +%s); run_staff timeout bun seats/staffing.ts check --dry-run; elapsed=$(( $(date +%s) - start ))
[ $RC -eq 0 ] && [ "$elapsed" -le 3 ] && grep -q 'jev skipped: timeout' <<<"$OUT" && pass 'timeout falls back quickly' || fail "timeout path failed elapsed=$elapsed rc=$RC out=$OUT"
BAD_BASE="http://127.0.0.1:1"; OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" JEV_BASE_URL="$BAD_BASE" JEV_API_KEY="$KEY" JEV_TIMEOUT_MS=500 bun seats/staffing.ts check --dry-run 2>&1)"; RC=$?
[ $RC -eq 0 ] && grep -q 'jev skipped:' <<<"$OUT" && pass 'connection failure falls back to the rule' || fail "connection failure did not fall back rc=$RC out=$OUT"

phase 'key handling and clamps'
KEY_FILE="$FIX/jev.key"; printf '%s\n' "$KEY" > "$KEY_FILE"; chmod 600 "$KEY_FILE"; set_reply '{"model":"jev-latest","answers":{"":{"type":"choice","choice":"add_worker","probabilities":{"add_worker":0.9},"confidence":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}'
OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" JEV_BASE_URL="$BASE" JEV_API_KEY_FILE="$KEY_FILE" bun seats/staffing.ts check --dry-run 2>&1 | tee "$FIX/out/keyfile.out")"; RC=${PIPESTATUS[0]}
[ $RC -eq 0 ] && grep -q 'decider=jev' <<<"$OUT" && pass '0600 key file configures Jev' || fail "0600 key file failed rc=$RC out=$OUT"
BAD_KEY="$FIX/bad.key"; printf '%s\n' "$KEY" > "$BAD_KEY"; chmod 644 "$BAD_KEY"; OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" JEV_BASE_URL="$BASE" JEV_API_KEY_FILE="$BAD_KEY" bun seats/staffing.ts check --dry-run 2>&1)"; RC=$?
[ $RC -eq 0 ] && grep -q 'JEV_API_KEY_FILE must be mode 0600' <<<"$OUT" && grep -q 'decider=rule' <<<"$OUT" && pass '0644 key file is refused and rule is used' || fail "0644 key file not refused: $OUT"
INROOT="$ROOT/jev.key"; printf '%s\n' "$KEY" > "$INROOT"; chmod 600 "$INROOT"; OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" JEV_BASE_URL="$BASE" JEV_API_KEY_FILE="$INROOT" bun seats/staffing.ts check --dry-run 2>&1)"; RC=$?
[ $RC -eq 0 ] && grep -q 'under install root refused' <<<"$OUT" && grep -q 'decider=rule' <<<"$OUT" && pass 'install-root key file is refused and rule is used' || fail "install-root key not refused: $OUT"
if ! grep -R "$KEY" "$FIX/out" "$ROOT/seats/logs" >/dev/null 2>&1; then pass 'sentinel key never appears in selftest output files or seats/logs'; else fail 'sentinel key leaked to output or logs'; fi
# Jev chooses add at max -> clamp to nothing; chooses drop at min -> clamp to nothing.
cat > "$ROOT/seats/staffing.json" <<'JSON'
{"version":1,"seats":{"worker-e1":{"role":"worker","entry":"e1"},"worker-e2":{"role":"worker","entry":"e2"}},"rateLimited":{}}
JSON
printf '{"seats":{"worker-e1":{"pid":%s,"log":"%s"},"worker-e2":{"pid":%s,"log":"%s"}}}\n' $$ "$ROOT/seats/logs/worker-e1.jsonl" $$ "$ROOT/seats/logs/worker-e2.jsonl" > "$ROOT/seats/state.json"; printf '{"type":"agent_end"}\n' > "$ROOT/seats/logs/worker-e1.jsonl"; printf '{"type":"agent_end"}\n' > "$ROOT/seats/logs/worker-e2.jsonl"
run_staff max bun seats/staffing.ts check --dry-run
[ $RC -eq 0 ] && grep -q 'decision=nothing' <<<"$OUT" && grep -q 'at limit: workers 2/2' <<<"$OUT" && pass 'Jev add at max is clamped' || fail "add at max not clamped: $OUT"
python3 - <<PY
import json, pathlib
p=pathlib.Path('$ROOT/seats/pool.json'); j=json.load(open(p)); j['roles']['workers']['min']=2; json.dump(j,open(p,'w'))
PY
set_reply '{"model":"jev-latest","answers":{"":{"type":"choice","choice":"drop_seat","probabilities":{"drop_seat":0.9},"confidence":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}'
run_staff min bun seats/staffing.ts check --dry-run
[ $RC -eq 0 ] && grep -q 'decision=nothing' <<<"$OUT" && grep -q 'at minimum: workers 2/2' <<<"$OUT" && pass 'Jev drop at min is clamped' || fail "drop at min not clamped: $OUT"

phase 'JEV unset keeps staffing selftest green'
(env -u JEV_BASE_URL -u JEV_API_KEY -u JEV_API_KEY_FILE -u JEV_TIMEOUT_MS WHEELHOUSE_SKIP_REAL_PI=1 bash "$HERE/staffing.selftest.sh" > "$FIX/out/staffing-unset.out" 2>&1); SRC=$?
[ $SRC -eq 0 ] && pass 'staffing.selftest.sh passes with JEV_* unset' || fail "staffing.selftest with JEV unset failed rc=$SRC tail=$(tail -20 "$FIX/out/staffing-unset.out")"

if [ "$FAILED" -eq 0 ]; then echo 'jev.selftest.sh works on this machine.'; exit 0; fi
echo "jev.selftest.sh FAIL ($FAILED failure(s))" >&2; exit 1
