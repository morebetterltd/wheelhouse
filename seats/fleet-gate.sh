#!/usr/bin/env bash
# fleet-gate.sh — optional prompt status reader.
#
# The slow fleet checks moved to seats/alerts.ts, which writes
# seats/run/fleet-snapshot.json from the herald clock. This script is safe for a
# UserPromptSubmit hook only because it reads that snapshot and nothing else: no
# bd, no gh, no adapter status, no herald log scan.

set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
SNAP="$ROOT/seats/run/fleet-snapshot.json"

if [ ! -f "$SNAP" ]; then
  printf '🚢 FLEET: no snapshot yet — run seats/cockpit.sh\n'
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  PARSER=(node - "$SNAP")
elif command -v bun >/dev/null 2>&1; then
  PARSER=(bun -e 'const fs=require("fs"); const file=process.argv[2]||process.argv[1]; const src=fs.readFileSync(file,"utf8"); const j=JSON.parse(src); const live=Array.isArray(j?.snapshot?.workers?.live)?j.snapshot.workers.live.length:Number(j?.snapshot?.workers?.live??0); const rostered=Number(j?.snapshot?.workers?.rostered??j?.snapshot?.workers?.total??j?.snapshot?.workers?.count??live); const ready=Number(j?.snapshot?.readyCount??0); const review=Array.isArray(j?.snapshot?.reviewBacklog)?j.snapshot.reviewBacklog.length:Number(j?.snapshot?.reviewBacklog??0); const alerts=Object.entries(j?.alerts??{}).filter(([,v])=>v&&v.active).map(([k])=>k).sort(); const at=Date.parse(j?.at||""); const age=Number.isFinite(at)?Math.max(0,Math.floor((Date.now()-at)/1000)):null; const interval=Number(j?.intervalMs); let line=`🚢 FLEET: ${live}/${Number.isFinite(rostered)?rostered:live} seats live · ${Number.isFinite(ready)?ready:0} ready · ${Number.isFinite(review)?review:0} in review · alerts: ${alerts.length?alerts.join(", "):"none"}`; if(age!==null&&Number.isFinite(interval)&&interval>=0&&Date.now()-at>3*interval) line+=` · snapshot ${age}s old — is the herald running?`; console.log(line);' "$SNAP")
else
  exit 0
fi

"${PARSER[@]}" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const file = process.argv[2] || process.argv[1];
const src = fs.readFileSync(file, 'utf8');
const j = JSON.parse(src);
const workers = j?.snapshot?.workers ?? {};
const live = Array.isArray(workers.live) ? workers.live.length : Number(workers.live ?? 0);
const rostered = Number(workers.rostered ?? workers.total ?? workers.count ?? live);
const ready = Number(j?.snapshot?.readyCount ?? 0);
const reviewRaw = j?.snapshot?.reviewBacklog ?? 0;
const review = Array.isArray(reviewRaw) ? reviewRaw.length : Number(reviewRaw);
const alerts = Object.entries(j?.alerts ?? {})
  .filter(([, v]) => v && v.active)
  .map(([k]) => k)
  .sort();
const at = Date.parse(j?.at || '');
const age = Number.isFinite(at) ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : null;
const interval = Number(j?.intervalMs);
let line = `🚢 FLEET: ${live}/${Number.isFinite(rostered) ? rostered : live} seats live · ${Number.isFinite(ready) ? ready : 0} ready · ${Number.isFinite(review) ? review : 0} in review · alerts: ${alerts.length ? alerts.join(', ') : 'none'}`;
if (age !== null && Number.isFinite(interval) && interval >= 0 && Date.now() - at > 3 * interval) line += ` · snapshot ${age}s old — is the herald running?`;
console.log(line);
NODE
exit 0
