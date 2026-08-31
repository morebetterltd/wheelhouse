#!/usr/bin/env bash
#
# legibility.selftest.sh — is every failure class its own VISIBLE state, on
# THIS machine?
#
# The claim under test (seats/README.md, "Failure legibility"): quota
# exhaustion, auth failure, a dead process, a blocked review, and unsatisfied
# evidence are DISTINCT states in the floor and in `adapter.ts status`, and
# none of them can render as completion. Each class is injected through the
# real machinery where it has a door — a quota-shaped dispatch failure
# through the stub seat, a spawn refusal on an empty {} auth.json, a
# SIGKILLed pid, real verify.ts runs — and deterministically simulated where
# it does not (a seat record whose event stream carries a 401; a truncated
# verdict file). Then the actual rendered frames are asserted.
#
# Hermetic: a fixture project in a temp dir with a stub `pi` (long-lived RPC
# when spawned by the adapter, one-shot scripted-reply when spawned by
# verify.ts), a stub `bd`, and a private PATH. Your real seats, logs, and
# verdicts are never touched.
#
# The canary phase sabotages COPIES of floor.ts and adapter.ts — cutting the
# EVIDENCE UNSATISFIED state, cutting the VERDICT UNREADABLE state, cutting
# the adapter's DIED word, and (the cue-conflation canary) rewriting the
# AUTH line to the QUOTA wording so two classes render identically — and
# checks these tests notice each one. Every sabotage is cmp-guarded: if the
# sed no longer bites, the canary says so instead of proving nothing.
#
# Usage: legibility.selftest.sh [path-to-seats-dir]
#
# Exit 0 = every failure class is legible here. Non-zero = read the FAIL
# lines: a canary failure means these checks cannot be trusted either way.

set -uo pipefail   # deliberately not -e: the injected failures are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
SRC="${1:-$HERE}"
SEED_TS="floor.ts adapter.ts verify.ts recover.ts"
for f in $SEED_TS; do
  [ -f "$SRC/$f" ] || { echo "selftest: not found: $SRC/$f" >&2; exit 2; }
done
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
GIT_BIN="$(command -v git)" || { echo "selftest: git is required" >&2; exit 2; }
command -v lsof >/dev/null 2>&1 || command -v /usr/sbin/lsof >/dev/null 2>&1 \
  || { echo "selftest: lsof is required (recover.ts needs it)" >&2; exit 2; }

SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
# Selftest output is commonly redirected into committed evidence; scrub it as
# it is written so temp dirs, home dirs, and usernames never enter captures.
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- stale-fixture sweep (same rule as the adapter selftest's) ---------------
FIX_PREFIX="wheelhouse-legibility-selftest"
sweep_stale_fixtures() {
  local base="${TMPDIR:-/tmp}" d stamp phys sf pid
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    stamp="${d##*/}"; stamp="${stamp#"$FIX_PREFIX".}"; stamp="${stamp%%.*}"
    case "$stamp" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$stamp" 2>/dev/null && continue
    phys="$(cd "$d" 2>/dev/null && pwd -P)" || phys="$d"
    while IFS= read -r sf; do
      [ -f "$sf" ] || continue
      for pid in $(sed -n 's/.*"pid": \([0-9][0-9]*\).*/\1/p' "$sf"); do
        if kill -0 "$pid" 2>/dev/null && lsof -p "$pid" 2>/dev/null | grep -qF "$phys"; then
          kill "$pid" 2>/dev/null
          echo "swept: killed leaked seat pid $pid (held open files under $d)"
        fi
      done
    done < <(find "$d" -mindepth 3 -maxdepth 3 -path "*/seats/state.json" 2>/dev/null)
    rm -rf "$d"
    echo "swept: removed stale fixture $d"
  done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -name "$FIX_PREFIX.*" 2>/dev/null)
  return 0
}
sweep_stale_fixtures

FIX="$(mktemp -d "${TMPDIR:-/tmp}/$FIX_PREFIX.$$.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin:/usr/sbin"

# Stub bd: a couple of ready beads; `bd show` fails so verify.ts takes its
# read-the-bead-yourself fallback.
cat > "$BIN/bd" <<'EOF'
#!/bin/sh
[ "$1" = "ready" ] || exit 1
echo "wh-001  P2  ready  a waiting bead"
EOF
chmod +x "$BIN/bd"

# The stub pi, dual-mode:
#  - `pi -p ...` (verify.ts's one-shot): record argv + an "invoked" marker,
#    print STUB_REPLY_FILE, exit 0.
#  - `pi --mode rpc` (the adapter's long-lived seat): speak strict JSONL.
#    A prompt whose text contains QUOTA is answered with a 429-shaped
#    FAILURE response — the door the quota class is injected through.
cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
const args = process.argv.slice(2);
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(args));
if (args.includes("-p")) {           // one-shot: verify.ts's spawn shape
  fs.writeFileSync(path.join(agentDir, "invoked"), "");
  const reply = process.env.STUB_REPLY_FILE;
  if (reply) process.stdout.write(fs.readFileSync(reply, "utf8"));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
const sessDir = path.join(agentDir, "sessions");
fs.mkdirSync(sessDir, { recursive: true });
const sessionId = crypto.randomUUID();
const sessionFile = path.join(sessDir, sessionId + ".jsonl");
fs.writeFileSync(sessionFile, JSON.stringify({ type: "session-start" }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function handle(cmd) {
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ id, type: "response", command: "get_state", success: true,
            data: { isStreaming: false, sessionFile, sessionId, messageCount: 0 } });
      break;
    case "prompt":
      if (/QUOTA/.test(cmd.message)) {
        out({ id, type: "response", command: "prompt", success: false,
              error: "429: usage limit reached — quota exhausted for this account" });
        break;
      }
      out({ id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "message_end", message: { role: "assistant",
            content: [{ type: "text", text: "echo: " + cmd.message }] } });
      out({ type: "agent_end", messages: [] });
      break;
    default:
      out({ id, type: "response", command: cmd.type, success: false, error: "stub: unknown " + cmd.type });
  }
}
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { handle(JSON.parse(line)); } catch (e) { out({ type: "response", command: "parse", success: false, error: String(e) }); } }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
STUB
chmod +x "$BIN/pi"

# --- the fixture project ------------------------------------------------------
PROJ="$FIX/proj"
mkdir -p "$PROJ/seats/logs" "$PROJ/contracts"
copy_fixture_ts() {
  # Keep the hermetic fixture honest when a seat script extracts a new helper:
  # copy every local .ts dependency reachable from the seeded scripts. A missing
  # helper is a setup error (exit 2), not a failure-class judgment.
  local queue="$SEED_TS" seen=" " f spec dep changed
  while :; do
    changed=0
    for f in $queue; do
      case "$seen" in *" $f "*) continue ;; esac
      [ -f "$SRC/$f" ] || { echo "selftest: fixture setup missing TypeScript dependency: $SRC/$f" >&2; exit 2; }
      seen="$seen$f "
      while IFS= read -r spec; do
        dep="${spec#./}"
        case "$dep" in *.ts) ;; *) dep="$dep.ts" ;; esac
        case "$dep" in */*) echo "selftest: fixture setup cannot copy nested TypeScript dependency: $spec from $f" >&2; exit 2 ;; esac
        case " $queue " in *" $dep "*) ;; *) queue="$queue $dep"; changed=1 ;; esac
      done < <("$NODE_BIN" -e '
        const fs = require("fs");
        const text = fs.readFileSync(process.argv[1], "utf8");
        const specs = new Set();
        const patterns = [
          /\bimport\s+(?:[\s\S]*?\s+from\s*)?["'"'"'](\.\/[^"'"'"']+)["'"'"']/g,
          /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s*["'"'"'](\.\/[^"'"'"']+)["'"'"']/g,
        ];
        for (const re of patterns) {
          let m;
          while ((m = re.exec(text))) specs.add(m[1]);
        }
        for (const spec of specs) console.log(spec);
      ' "$SRC/$f")
    done
    [ "$changed" -eq 0 ] && break
  done
  for f in $queue; do cp "$SRC/$f" "$PROJ/seats/"; done
}

phase "fixture import scanner — multiline, side-effect, and re-export imports are copied"
SCAN_SRC="$FIX/import-scan-src"
SCAN_PROJ="$FIX/import-scan-proj"
mkdir -p "$SCAN_SRC" "$SCAN_PROJ/seats"
cat > "$SCAN_SRC/adapter.ts" <<'EOF'
import {
  multi
} from "./multi";
export const adapter = multi;
EOF
cat > "$SCAN_SRC/floor.ts" <<'EOF'
import "./side-effect";
export const floor = true;
EOF
cat > "$SCAN_SRC/verify.ts" <<'EOF'
export { reexported } from "./re-exported";
EOF
cat > "$SCAN_SRC/recover.ts" <<'EOF'
export const recover = true;
EOF
printf 'export const multi = true;\n' > "$SCAN_SRC/multi.ts"
printf 'export const side = true;\n' > "$SCAN_SRC/side-effect.ts"
printf 'export const reexported = true;\n' > "$SCAN_SRC/re-exported.ts"
ORIG_SRC="$SRC"; ORIG_PROJ="$PROJ"; ORIG_SEED_TS="$SEED_TS"
SRC="$SCAN_SRC"; PROJ="$SCAN_PROJ"; SEED_TS="adapter.ts floor.ts verify.ts recover.ts"
copy_fixture_ts
SRC="$ORIG_SRC"; PROJ="$ORIG_PROJ"; SEED_TS="$ORIG_SEED_TS"
for dep in multi.ts side-effect.ts re-exported.ts; do
  if [ -f "$SCAN_PROJ/seats/$dep" ]; then pass "fixture import scanner copies $dep"
  else fail "fixture import scanner missed $dep"; fi
done

copy_fixture_ts
printf '# Fleet: Worker\n\nfixture brief.\n'   > "$PROJ/contracts/WORKER.md"
printf '# Crew: Verifier\n\nfixture brief.\n'  > "$PROJ/contracts/VERIFIER.md"

# Six afflicted-to-be seats plus a verifier. Every account dir is namespaced
# under the fixture HOME; a-seat gets the empty {} auth.json its class needs,
# everyone else gets a stub identity.
cat > "$PROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "q-seat": { "role": "worker",   "account": { "dir": "~/.pi-seats-leg/q-seat" } },
    "a-seat": { "role": "worker",   "account": { "dir": "~/.pi-seats-leg/a-seat" } },
    "d-seat": { "role": "worker",   "account": { "dir": "~/.pi-seats-leg/d-seat" } },
    "r-seat": { "role": "worker",   "account": { "dir": "~/.pi-seats-leg/r-seat" } },
    "e-seat": { "role": "worker",   "account": { "dir": "~/.pi-seats-leg/e-seat" } },
    "u-seat": { "role": "worker",   "account": { "dir": "~/.pi-seats-leg/u-seat" } },
    "verifier": { "role": "verifier", "account": { "dir": "~/.pi-seats-leg/verifier" } }
  }
}
EOF
for s in q-seat a-seat d-seat r-seat e-seat u-seat verifier; do
  mkdir -p "$HOME_FIX/.pi-seats-leg/$s"
  printf '{\n  "%s": true\n}\n' "$PROJ" > "$HOME_FIX/.pi-seats-leg/$s/trust.json"
  if [ "$s" = "a-seat" ]; then
    printf '{}\n' > "$HOME_FIX/.pi-seats-leg/$s/auth.json"   # pi's empty auto-created shape
  else
    printf '{"stub":"identity"}\n' > "$HOME_FIX/.pi-seats-leg/$s/auth.json"
  fi
done

# A git repo: verify.ts resolves branches and reads evidence at the tip.
( cd "$PROJ" &&
  git init -q &&
  git -c user.email=selftest@local -c user.name=selftest commit -q --allow-empty -m base &&
  git branch fleet/bead-rev && git branch fleet/bead-ev ) \
  || { echo "selftest: could not build fixture git repo" >&2; exit 2; }

STATE="$PROJ/seats/state.json"
VDIR="$PROJ/seats/verdicts"
REPLY="$FIX/reply.txt"

arun()   { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
vrun()   { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" bun "$PROJ/seats/verify.ts" "$@" 2>&1)"; RC=$?; }
render() { local f="${1:-$PROJ/seats/floor.ts}"; shift 2>/dev/null
           OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" COLUMNS="${COLS:-160}" LINES=70 NO_COLOR=1 bun "$f" --once "$@" 2>&1)"; RC=$?; }
says()   { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
seatline(){ printf '%s\n' "$OUT" | grep "$1"; }   # every frame line naming the seat
state_get(){ env HOME="$HOME_FIX" bun -e "const s=require('$STATE');const v=s.seats['$1']?.['$2'];if(v!=null)console.log(typeof v==='object'?JSON.stringify(v):v)"; }

# Hand-inject a seat record: the deterministic-simulation door for classes
# that have no adapter path (a 401 in the stream; a verdict file waiting).
inject_seat() {   # $1 = name, $2 = pid, $3 = lastBead ('' for none)
  env HOME="$HOME_FIX" INJ_STATE="$STATE" INJ_NAME="$1" INJ_PID="$2" INJ_BEAD="${3:-}" INJ_PROJ="$PROJ" bun -e '
    const fs = require("fs");
    const f = process.env.INJ_STATE;
    const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { seats: {} };
    const n = process.env.INJ_NAME, p = process.env.INJ_PROJ;
    s.seats[n] = {
      pid: Number(process.env.INJ_PID), startedAt: "2026-08-30T00:00:00Z",
      accountDir: process.env.HOME + "/.pi-seats-leg/" + n, role: "worker", roleBrief: "x",
      fifo: p + "/seats/run/" + n + ".stdin", log: p + "/seats/logs/" + n + ".jsonl",
      sessionId: "s-" + n, sessionFile: null,
      ...(process.env.INJ_BEAD ? { lastBead: process.env.INJ_BEAD } : {}),
    };
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  '
}

ME=$$   # alive for the whole run

# =============================================================================
phase "phase 1: QUOTA — a quota-shaped dispatch failure is amber, never done"
arun spawn q-seat
[ $RC -eq 0 ] && pass "q-seat spawns against the stub" || fail "q-seat spawn: rc=$RC: $OUT"
mkdir -p "$PROJ/.wheelhouse-worktrees/bead-q"
arun dispatch q-seat bead-q "QUOTA please"
if [ $RC -ne 0 ] && says "dispatch failed"; then
  pass "quota-shaped dispatch fails loudly (rc=$RC) — non-success at the adapter"
else fail "quota dispatch did not fail (rc=$RC): $OUT"; fi
if [ -n "$(state_get q-seat lastCapacityEvent)" ]; then
  pass "state.json carries the capacity stamp"
else fail "no lastCapacityEvent stamped for q-seat"; fi
arun status
if says "CAPACITY: quota-shaped dispatch failure"; then
  pass "adapter status surfaces the CAPACITY line"
else fail "adapter status has no CAPACITY line: $OUT"; fi
render
if seatline q-seat | grep -q "QUOTA EXHAUSTED — dispatch failed at"; then
  pass "floor: amber QUOTA EXHAUSTED names the failed dispatch"
else fail "floor: no QUOTA EXHAUSTED line for q-seat: $(seatline q-seat)"; fi
if seatline q-seat | grep -q "AMBER"; then pass "floor: quota cue is AMBER"
else fail "floor: quota cue is not AMBER: $(seatline q-seat)"; fi

# =============================================================================
phase "phase 2: AUTH FAILURE — red, names the credential flow, distinct from quota"
arun spawn a-seat
if [ $RC -ne 0 ] && says "no identity" && says "type /login" && says "api_key"; then
  pass "spawn on an empty {} auth.json is refused, printing the credential flow"
else fail "authless spawn was not refused with the credential flow (rc=$RC): $OUT"; fi
# The stream-visible half: a seat that DID run and then hit a 401 mid-flight.
cat > "$PROJ/seats/logs/a-seat.jsonl" <<'EOF'
{"type":"agent_start"}
{"type":"response","command":"prompt","success":false,"error":"401 Unauthorized: token expired - login required"}
EOF
inject_seat a-seat "$ME" ""
# The fixture's temp-dir account path is far longer than any real seat's, so
# the rail's width budget truncates the tail of the line; render WIDE for the
# full-command assertion (the distinctness checks below use the normal width).
COLS=400 render
if seatline a-seat | grep -q "AUTH DEAD" && seatline a-seat | grep -q "then /login in the REPL" && seatline a-seat | grep -q "api_key"; then
  pass "floor: red AUTH DEAD with the credential flow"
else fail "floor: no AUTH DEAD line for a-seat: $(seatline a-seat)"; fi
render
if seatline a-seat | grep -q " RED"; then pass "floor: auth cue is RED"
else fail "floor: auth cue is not RED: $(seatline a-seat)"; fi
if ! seatline a-seat | grep -q "QUOTA"; then
  pass "auth line is DISTINCT from the quota line"
else fail "auth and quota render conflated: $(seatline a-seat)"; fi

# =============================================================================
phase "phase 3: DEAD PROCESS — SIGKILL, red PROCESS GONE, recover says DEAD"
arun spawn d-seat
[ $RC -eq 0 ] && pass "d-seat spawns" || fail "d-seat spawn: rc=$RC: $OUT"
arun dispatch d-seat bead-d "hello"
DPID="$(state_get d-seat pid)"
kill -9 "$DPID" 2>/dev/null
sleep 0.3
if ! kill -0 "$DPID" 2>/dev/null; then pass "d-seat pid $DPID SIGKILLed"
else fail "could not kill d-seat pid $DPID"; fi
render
if seatline d-seat | grep -q "PROCESS GONE" && seatline d-seat | grep -q "d-seat.stderr.log"; then
  pass "floor: red PROCESS GONE names the stderr log"
else fail "floor: no PROCESS GONE line naming the stderr log: $(seatline d-seat)"; fi
if seatline d-seat | grep -q " RED"; then pass "floor: dead-process cue is RED"
else fail "floor: dead-process cue is not RED: $(seatline d-seat)"; fi
if ! seatline d-seat | grep -q "AUTH"; then
  pass "dead-process line is DISTINCT from the auth line"
else fail "dead-process and auth render conflated: $(seatline d-seat)"; fi
arun status
if printf '%s\n' "$OUT" | grep "d-seat" | grep -q "DIED"; then
  pass "adapter status says DIED, not the calm STOPPED of a graceful stop"
else fail "adapter status does not say DIED for the killed seat: $OUT"; fi
if says "check" && says "d-seat.stderr.log"; then
  pass "adapter status points at the stderr log"
else fail "adapter status DIED line does not name the stderr log: $OUT"; fi
ROUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/recover.ts" 2>&1)"
if printf '%s\n' "$ROUT" | grep "d-seat" | grep -q "DEAD"; then
  pass "recover.ts classifies the SIGKILLed seat DEAD"
else fail "recover.ts did not classify d-seat DEAD: $ROUT"; fi

# =============================================================================
phase "phase 4: BLOCKED REVIEW — a BOUNCE verdict file renders amber, never done"
cat > "$REPLY" <<'EOF'
The done requires X; the diff does Y.
VERDICT: BOUNCE
EOF
vrun bead-rev fleet/bead-rev r-seat verifier
if [ $RC -eq 2 ] && grep -q "verdict: BOUNCE" "$VDIR/bead-rev.md" 2>/dev/null; then
  pass "real verify.ts run recorded a BOUNCE verdict for bead-rev"
else fail "verify.ts BOUNCE run: rc=$RC (want 2): $OUT"; fi
cat > "$PROJ/seats/logs/r-seat.jsonl" <<'EOF'
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done with the branch"}]}}
{"type":"agent_end","messages":[]}
EOF
inject_seat r-seat "$ME" bead-rev
render
if seatline r-seat | grep -q "REVIEW BLOCKED" && seatline r-seat | grep -q "bead-rev"; then
  pass "floor: amber REVIEW BLOCKED names the bead"
else fail "floor: no REVIEW BLOCKED line naming bead-rev: $(seatline r-seat)"; fi
if ! seatline r-seat | grep -q "VERDICT LANDED" && ! seatline r-seat | grep -q "idle"; then
  pass "a blocked review never renders as done or idle"
else fail "blocked review rendered as done/idle: $(seatline r-seat)"; fi

# =============================================================================
phase "phase 5: UNSATISFIED EVIDENCE — refusal, distinct rendering, unreadable routes to human"
# 5a: verify.ts's own gate — APPROVE over a failed evidence floor is exit 1.
rm -f "$VDIR/bead-ev.md"
cat > "$REPLY" <<'EOF'
Looks fine to me.
VERDICT: APPROVE
EOF
vrun bead-ev fleet/bead-ev e-seat verifier --evidence proof/shot.png
if [ $RC -eq 1 ] && says "unsatisfied evidence"; then
  pass "verify.ts refuses APPROVE-over-failed-floor: exit 1, named as malformed"
else fail "APPROVE over missing evidence was not refused (rc=$RC, want 1): $OUT"; fi
if [ ! -f "$VDIR/bead-ev.md" ]; then
  pass "the refused APPROVE recorded no verdict file — an error is not a judgment"
else fail "a verdict file exists for the refused APPROVE"; fi
# 5b: the recordable shape — BOUNCE with failed checks — must render as its
# own state, not as a generic blocked review.
cat > "$REPLY" <<'EOF'
The bead names proof/shot.png; it is not on the branch.
VERDICT: BOUNCE
EOF
vrun bead-ev fleet/bead-ev e-seat verifier --evidence proof/shot.png
if [ $RC -eq 2 ] && grep -q "UNSATISFIED" "$VDIR/bead-ev.md" 2>/dev/null; then
  pass "BOUNCE with failed floor checks is recorded, checks carried in the file"
else fail "BOUNCE-with-unsatisfied run: rc=$RC (want 2), or no UNSATISFIED in the record"; fi
cat > "$PROJ/seats/logs/e-seat.jsonl" <<'EOF'
{"type":"agent_start"}
{"type":"agent_end","messages":[]}
EOF
inject_seat e-seat "$ME" bead-ev
render
if seatline e-seat | grep -q "EVIDENCE UNSATISFIED" && seatline e-seat | grep -q "bead-ev"; then
  pass "floor: EVIDENCE UNSATISFIED is its own state, naming the bead"
else fail "floor: no EVIDENCE UNSATISFIED line for e-seat: $(seatline e-seat)"; fi
if ! seatline e-seat | grep -q "APPROVE" && ! seatline e-seat | grep -q "VERDICT LANDED"; then
  pass "unsatisfied evidence never renders as APPROVE"
else fail "unsatisfied evidence rendered as approval: $(seatline e-seat)"; fi
# 5c: a truncated/malformed verdict file routes to a human, never to success.
mkdir -p "$VDIR"
printf '# Verdict — bead bead-u\n\ntruncated before the verdict line was writ' > "$VDIR/bead-u.md"
cat > "$PROJ/seats/logs/u-seat.jsonl" <<'EOF'
{"type":"agent_start"}
{"type":"agent_end","messages":[]}
EOF
inject_seat u-seat "$ME" bead-u
render
if seatline u-seat | grep -q "VERDICT UNREADABLE" && seatline u-seat | grep -q "routed to human"; then
  pass "floor: a malformed verdict file reads VERDICT UNREADABLE — routed to human"
else fail "floor: no VERDICT UNREADABLE line for u-seat: $(seatline u-seat)"; fi
if ! seatline u-seat | grep -q "idle" && ! seatline u-seat | grep -q "VERDICT LANDED"; then
  pass "an unreadable verdict never renders as success"
else fail "unreadable verdict rendered as success: $(seatline u-seat)"; fi

# =============================================================================
phase "cross-check: all five classes staged at once — every state distinct, no success anywhere"
render   # rail view, all seats
ALL_OK=1
for want in "QUOTA EXHAUSTED" "AUTH DEAD" "PROCESS GONE" "REVIEW BLOCKED" "EVIDENCE UNSATISFIED" "VERDICT UNREADABLE"; do
  if says "$want"; then pass "rail shows: $want"
  else fail "rail is missing: $want"; ALL_OK=0; fi
done
if ! says "VERDICT LANDED" && ! says "GREEN"; then
  pass "no success rendering (VERDICT LANDED / GREEN) anywhere on the rail"
else fail "a success rendering appears while every seat is afflicted"; fi
render "$PROJ/seats/floor.ts" --pin 0
if says "ALERTS (6)"; then
  pass "STATUS leads with ALERTS listing all 6 afflicted seats"
else fail "STATUS ALERTS roll-up wrong or missing: $(printf '%s\n' "$OUT" | grep ALERTS)"; fi
for want in "QUOTA EXHAUSTED" "AUTH DEAD" "PROCESS GONE" "REVIEW BLOCKED" "EVIDENCE UNSATISFIED" "VERDICT UNREADABLE"; do
  if says "$want"; then pass "STATUS shows: $want"
  else fail "STATUS is missing: $want"; fi
done
if ! says "VERDICT LANDED" && ! says "GREEN"; then
  pass "no success rendering in STATUS either"
else fail "a success rendering appears in STATUS while every seat is afflicted"; fi
arun status
if ! says "APPROVE" && says "CAPACITY:" && says "DIED"; then
  pass "adapter status: capacity + death visible, nothing reads as approval"
else fail "adapter status cross-check failed: $OUT"; fi

# =============================================================================
phase "canaries — sabotage a copy; these checks must notice (all cmp-guarded)"
FLOOR="$PROJ/seats/floor.ts"

# canary 1: cut the EVIDENCE UNSATISFIED state
SAB1="$PROJ/seats/floor-sab1.ts"
sed '/EVIDENCE UNSATISFIED — /d' "$FLOOR" > "$SAB1"
if cmp -s "$FLOOR" "$SAB1"; then
  fail "canary 1: sed no longer bites (no EVIDENCE UNSATISFIED line) — fix this test"
else
  render "$SAB1"
  if seatline e-seat | grep -q "EVIDENCE UNSATISFIED"; then
    fail "canary 1: EVIDENCE UNSATISFIED survived its removal — these checks prove nothing"
  else pass "canary 1: cutting the EVIDENCE UNSATISFIED state is caught by phase 5's check"; fi
fi

# canary 2: cut the VERDICT UNREADABLE state
SAB2="$PROJ/seats/floor-sab2.ts"
sed '/VERDICT UNREADABLE — routed to human/d' "$FLOOR" > "$SAB2"
if cmp -s "$FLOOR" "$SAB2"; then
  fail "canary 2: sed no longer bites (no VERDICT UNREADABLE line) — fix this test"
else
  render "$SAB2"
  if seatline u-seat | grep -q "VERDICT UNREADABLE"; then
    fail "canary 2: VERDICT UNREADABLE survived its removal — these checks prove nothing"
  else pass "canary 2: cutting the VERDICT UNREADABLE state is caught by phase 5's check"; fi
fi

# canary 3 (cue conflation): force AUTH to render with the QUOTA wording —
# two classes collapsing into one line MUST be caught by the distinctness check.
SAB3="$PROJ/seats/floor-sab3.ts"
sed 's|AUTH DEAD — OAuth: PI_CODING_AGENT_DIR=${rec?.accountDir ?? "<dir>"} pi, then /login in the REPL; api_key: auth.json or provider env var|QUOTA EXHAUSTED — seat cannot take work until it resets|' "$FLOOR" > "$SAB3"
if cmp -s "$FLOOR" "$SAB3"; then
  fail "canary 3: sed no longer bites (auth line moved) — fix this test"
else
  render "$SAB3"
  CONFLATED=0
  seatline a-seat | grep -q "AUTH DEAD" || CONFLATED=1          # auth wording gone
  seatline a-seat | grep -q "QUOTA" && CONFLATED=1              # quota wording present
  if [ $CONFLATED -eq 1 ]; then
    pass "canary 3: forcing auth to wear quota's wording is caught by the distinctness checks"
  else
    fail "canary 3: two classes rendered identically and nothing noticed — these checks prove nothing"
  fi
fi

# canary 4: cut the adapter's DIED word — a crash must not sail as STOPPED
SAB4="$PROJ/seats/adapter-sab4.ts"
sed 's|const died = !alive.*|const died = false;|' "$PROJ/seats/adapter.ts" > "$SAB4"
if cmp -s "$PROJ/seats/adapter.ts" "$SAB4"; then
  fail "canary 4: sed no longer bites (the died line moved) — fix this test"
else
  SOUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$SAB4" status 2>&1)"
  if printf '%s\n' "$SOUT" | grep "d-seat" | grep -q "DIED"; then
    fail "canary 4: DIED survived its removal — these checks prove nothing"
  else pass "canary 4: cutting DIED is caught by phase 3's adapter-status check"; fi
fi

# --- teardown of live stub seats ---------------------------------------------
arun stop q-seat >/dev/null 2>&1

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "every failure class is legible on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-5 or the cross-check, a failure state went"
echo "invisible or conflated (or its wording moved). If a failure is in the"
echo "canaries, fix this test first."
exit 1
