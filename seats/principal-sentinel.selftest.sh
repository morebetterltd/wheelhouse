#!/bin/bash
set +e

SCRIPT="$(cd "$(dirname "$0")" && pwd)/principal-sentinel.sh"
NEEDS="$(cd "$(dirname "$0")" && pwd)/needs.ts"
FIX="${TMPDIR:-/tmp}/wheelhouse-principal-sentinel-selftest.$$"
FAILED=0
PASSED=0

pass(){ PASSED=$((PASSED+1)); echo "ok $PASSED - $1"; }
fail(){ FAILED=$((FAILED+1)); echo "not ok $((PASSED+FAILED)) - $1"; }
finish(){ rm -rf "$FIX"; if [ "$FAILED" -eq 0 ]; then echo "principal-sentinel.selftest: PASS ($PASSED checks)"; exit 0; else echo "principal-sentinel.selftest: FAIL ($FAILED failure(s), $PASSED pass(es))"; exit 1; fi; }
trap finish EXIT

mkdir -p "$FIX/proj/seats" "$FIX/proj/wheelhouse"
cp "$SCRIPT" "$FIX/proj/seats/principal-sentinel.sh"
cp "$NEEDS" "$FIX/proj/seats/needs.ts"
chmod +x "$FIX/proj/seats/principal-sentinel.sh"
printf 'namespace=sentinel\n' > "$FIX/proj/wheelhouse/.template-source"

write_transcript(){
  file="$1"; uuid="$2"; text="$3"
  python3 - <<'PY' "$file" "$uuid" "$text"
import json, sys
path, uuid, text = sys.argv[1:4]
rows = [
  {"type":"user","uuid":"user-"+uuid,"message":{"role":"user","content":"prompt"}},
  {"type":"assistant","uuid":uuid,"sessionId":"session-1","message":{"content":[{"type":"text","text":text}]}}
]
with open(path, "w") as f:
  for row in rows:
    f.write(json.dumps(row) + "\n")
PY
}

hook_json(){
  session="$1"; transcript="$2"; last="$3"; active="$4"
  python3 - <<'PY' "$session" "$transcript" "$last" "$active"
import json, sys
session, transcript, last, active = sys.argv[1:5]
print(json.dumps({"session_id":session,"transcript_path":transcript,"stop_hook_active":active == "true","last_assistant_message":last}))
PY
}

count_opened(){
  [ -f "$FIX/proj/seats/needs.jsonl" ] || { echo 0; return; }
  LEDGER="$FIX/proj/seats/needs.jsonl" bun -e 'const fs=require("fs"); let n=0; for (const l of fs.readFileSync(process.env.LEDGER,"utf8").split(/\n/)) { if (!l.trim()) continue; const r=JSON.parse(l); if (r.type === "opened") n++; } console.log(n);'
}

title_at(){
  LEDGER="$FIX/proj/seats/needs.jsonl" IDX="$1" bun -e 'const fs=require("fs"); const rows=fs.readFileSync(process.env.LEDGER,"utf8").trim().split(/\n/).filter(Boolean).map(JSON.parse).filter(r=>r.type==="opened"); console.log(rows[Number(process.env.IDX)]?.title || "");'
}

source_at(){
  LEDGER="$FIX/proj/seats/needs.jsonl" IDX="$1" bun -e 'const fs=require("fs"); const rows=fs.readFileSync(process.env.LEDGER,"utf8").trim().split(/\n/).filter(Boolean).map(JSON.parse).filter(r=>r.type==="opened"); console.log(rows[Number(process.env.IDX)]?.machine?.source || "");'
}

# 1. Final assistant sentinel opens one need with the sentinel line text as title.
T1="$FIX/transcript-1.jsonl"
MSG1='summary line
@principal: need a yes on the tag
context line'
write_transcript "$T1" "msg-1" "$MSG1"
hook_json "session-1" "$T1" "$MSG1" false | (cd "$FIX/proj" && bash seats/principal-sentinel.sh)
if [ "$(count_opened)" = 1 ] && [ "$(title_at 0)" = "need a yes on the tag" ] && [ "$(source_at 0)" = "session-1:msg-1" ]; then
  pass "assistant @principal sentinel opens exactly one need with title and source"
else
  fail "sentinel did not open expected need (ledger=$(cat "$FIX/proj/seats/needs.jsonl" 2>/dev/null))"
fi

# 2. Same message again is source-deduped by needs.ts and opens nothing new.
hook_json "session-1" "$T1" "$MSG1" false | (cd "$FIX/proj" && bash seats/principal-sentinel.sh)
if [ "$(count_opened)" = 1 ]; then
  pass "same assistant message opens nothing new because source is deduped"
else
  fail "source dedupe failed (ledger=$(cat "$FIX/proj/seats/needs.jsonl" 2>/dev/null))"
fi

# 3. A tool_result-only sentinel is ignored because only assistant records are read.
T2="$FIX/transcript-2.jsonl"
cat > "$T2" <<'JSONL'
{"type":"tool_result","uuid":"tool-1","content":"@principal: tool output should not count"}
{"type":"assistant","uuid":"msg-2","sessionId":"session-2","message":{"content":[{"type":"text","text":"ordinary assistant text"}]}}
JSONL
hook_json "session-2" "$T2" "" false | (cd "$FIX/proj" && bash seats/principal-sentinel.sh)
if [ "$(count_opened)" = 1 ]; then
  pass "@principal inside tool_result opens nothing"
else
  fail "tool_result sentinel was incorrectly opened (ledger=$(cat "$FIX/proj/seats/needs.jsonl" 2>/dev/null))"
fi

# 4. Assistant message without sentinel opens nothing.
T3="$FIX/transcript-3.jsonl"
write_transcript "$T3" "msg-3" "no principal request here"
hook_json "session-3" "$T3" "no principal request here" false | (cd "$FIX/proj" && bash seats/principal-sentinel.sh)
if [ "$(count_opened)" = 1 ]; then
  pass "assistant message without sentinel opens nothing"
else
  fail "non-sentinel assistant was incorrectly opened (ledger=$(cat "$FIX/proj/seats/needs.jsonl" 2>/dev/null))"
fi

# 5. stop_hook_active=true is respected.
T4="$FIX/transcript-4.jsonl"
MSG4='@principal: stop hook loop must not open'
write_transcript "$T4" "msg-4" "$MSG4"
hook_json "session-4" "$T4" "$MSG4" true | (cd "$FIX/proj" && bash seats/principal-sentinel.sh)
if [ "$(count_opened)" = 1 ]; then
  pass "stop_hook_active=true opens nothing"
else
  fail "stop_hook_active was not respected (ledger=$(cat "$FIX/proj/seats/needs.jsonl" 2>/dev/null))"
fi

# 6. Canary: a copy with sentinel detection disabled must be caught by phase 1.
CAN="$FIX/canary"
mkdir -p "$CAN/proj/seats" "$CAN/proj/wheelhouse"
cp "$FIX/proj/seats/principal-sentinel.sh" "$CAN/proj/seats/principal-sentinel.sh"
cp "$FIX/proj/seats/needs.ts" "$CAN/proj/seats/needs.ts"
printf 'namespace=sentinel\n' > "$CAN/proj/wheelhouse/.template-source"
python3 - <<'PY' "$CAN/proj/seats/principal-sentinel.sh"
import sys
p=sys.argv[1]
s=open(p).read()
s=s.replace('const idx = lines.findIndex((line) => /^@principal:/.test(line));', 'const idx = -1;')
open(p,'w').write(s)
PY
if cmp -s "$FIX/proj/seats/principal-sentinel.sh" "$CAN/proj/seats/principal-sentinel.sh"; then
  fail "canary: could not disable sentinel detection; test proves nothing"
else
  CT="$CAN/transcript.jsonl"
  write_transcript "$CT" "msg-canary" "$MSG1"
  hook_json "session-canary" "$CT" "$MSG1" false | (cd "$CAN/proj" && bash seats/principal-sentinel.sh)
  if [ ! -f "$CAN/proj/seats/needs.jsonl" ]; then
    pass "canary: disabled sentinel detection is caught by the opened-event check"
  else
    fail "canary: disabled sentinel detection still opened a need"
  fi
fi
