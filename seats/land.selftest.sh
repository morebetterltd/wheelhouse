#!/bin/sh
# land.selftest.sh — proves seats/land.ts gates before it writes.
#
# Every leg builds its own throwaway project under one fixture root: a git repo
# with a bare `origin`, a contracts/INTEGRATOR.md whose project section carries
# whatever authority sentence the leg is about, a committed sibling selftest for
# the gate-3 path, and stub `bd`/`gh`/`adapter.ts` on PATH.
#
# THE STUBS ARE STATEFUL, and that is not decoration. An earlier revision
# validated argv and mutated nothing, so the happy fixture ended still carrying
# `needs-review` while the leg reported the drop had worked — a leg green for a
# reason unrelated to what it claimed. The doubles now keep a real labels/status
# file, a real state.json, and a real issue state, and the legs assert the FINAL
# OBSERVABLE STATE rather than the call log wherever the state is what matters.
# They still exit 64 on argv the real tools would not receive.
#
# bd is NOT installed on the machine this was written on. These stubs are the
# only bd path exercised anywhere in this repo's proofs; the real bead path has
# never been run against land.ts. A green run here is evidence about the calls
# land.ts makes, their order and the state it leaves, and about nothing bd does.
#
# The comment `author` field these fixtures set is the clearest case. The beads
# vendor's published JSON Output Schema Contract
# (https://beads.gascity.com/reference/json-schema.md, read 2026-09-16)
# specifies bd list, bd ready, bd blocked, bd show, import and export, and does
# not specify the comment object's fields at all — zero occurrences of "author"
# there, with "comment" present as a positive control. So these fixtures assert
# what land.ts does with an author it recognises; which key a real bd uses is a
# documented absence, and land.ts exits 1 rather than guessing past it.
#
# `bd update <id> --remove-label needs-review` is documented in the beads vendor
# CLI reference for `bd update` — it is not inferred from --add-label. But that
# page carries no version and contracts/GRAPH.md stamps this install's bd facts
# against build 1.2.2, so the spelling is documented and the BUILD is
# unconfirmed. Re-verify against your own build the way GRAPH.md asks.

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
LAND="$SCRIPT_DIR/land.ts"
TMPBASE=${TMPDIR:-/tmp}
FIX=$(mktemp -d "$TMPBASE/wheelhouse-land-selftest.$$.XXXXXX")
FIX=$(cd "$FIX" && pwd -P)
cleanup() { selftest_cleanup_fixture_processes "${FIX:-}"; rm -rf "$FIX"; }
trap cleanup EXIT HUP INT TERM

pass_count=0
say() { printf '%s\n' "$*"; }
fail() { say "FAIL: $*"; exit 1; }
# Self-numbering, so inserting a leg never renumbers the ones after it.
ok() { pass_count=$((pass_count + 1)); say "ok $pass_count - $*"; }

run_capture() {
  name=$1
  shift
  out="$FIX/$name.out"
  set +e
  "$@" >"$out" 2>&1
  rc=$?
  set -e
  printf '%s' "$rc" >"$FIX/$name.rc"
}

expect_rc() {
  name=$1; want=$2
  got=$(cat "$FIX/$name.rc")
  if [ "$got" != "$want" ]; then
    say "--- $name output ---"; cat "$FIX/$name.out"
    fail "${name}: expected exit $want, got $got"
  fi
}

expect_output() {
  name=$1; pattern=$2
  if ! grep -q "$pattern" "$FIX/$name.out"; then
    say "--- $name output ---"; cat "$FIX/$name.out"
    fail "${name}: missing output pattern: $pattern"
  fi
}

expect_file_has() {
  file=$1; pattern=$2; label=$3
  [ -f "$file" ] || fail "$label: $file does not exist"
  if ! grep -q "$pattern" "$file"; then
    say "--- $file ---"; cat "$file"
    fail "$label: $file lacks pattern: $pattern"
  fi
}

expect_file_lacks() {
  file=$1; pattern=$2; label=$3
  if [ -f "$file" ] && grep -q "$pattern" "$file"; then
    say "--- $file ---"; cat "$file"
    fail "$label: $file unexpectedly contains: $pattern"
  fi
}

expect_count() {
  file=$1; pattern=$2; want=$3; label=$4
  got=0
  [ -f "$file" ] && got=$(grep -c "$pattern" "$file" | tr -d ' ')
  if [ "$got" != "$want" ]; then
    say "--- $file ---"; [ -f "$file" ] && cat "$file"
    fail "$label: expected $want occurrence(s) of '$pattern', got $got"
  fi
}

expect_line_count() {
  file=$1; want=$2; label=$3
  got=0
  [ -f "$file" ] && got=$(wc -l <"$file" | tr -d ' ')
  if [ "$got" != "$want" ]; then
    say "--- $file ---"; [ -f "$file" ] && cat "$file"
    fail "$label: expected $want line(s), got $got"
  fi
}

# The C6 assertions: the bead's FINAL state, from the stub's own store.
expect_bead() {
  bddir=$1; bead=$2; want_status=$3; want_label_state=$4; label=$5
  f="$bddir/$bead.show.json"
  [ -f "$f" ] || fail "$label: $f does not exist"
  got_status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$f")
  has_label=$(python3 -c 'import json,sys; print("yes" if "needs-review" in json.load(open(sys.argv[1]))["labels"] else "no")' "$f")
  if [ "$got_status" != "$want_status" ] || [ "$has_label" != "$want_label_state" ]; then
    say "--- $f ---"; cat "$f"
    fail "$label: expected status=$want_status needs-review=$want_label_state, got status=$got_status needs-review=$has_label"
  fi
}

# ---------------------------------------------------------------------------
# Stubs.
# ---------------------------------------------------------------------------
BIN="$FIX/bin"
mkdir -p "$BIN" "$FIX/home"
BUN_BIN=$(command -v bun) || fail "bun is not on PATH — land.ts cannot be exercised"
GIT_BIN=$(command -v git) || fail "git is not on PATH"
PY_BIN=$(command -v python3) || fail "python3 is not on PATH — the stateful stubs need it"
RUN_PATH="$BIN:$(dirname "$BUN_BIN"):$(dirname "$GIT_BIN"):$(dirname "$PY_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"

cat >"$BIN/bd" <<'STUB'
#!/bin/sh
# Stateful stub bd. Exits 64 on argv the real CLI would not have been handed,
# and MUTATES <id>.show.json so a leg can assert the bead's final state.
D="${LAND_SELFTEST_BD_DIR:?stub bd: LAND_SELFTEST_BD_DIR unset}"
L="${LAND_SELFTEST_BD_CALLS:?stub bd: LAND_SELFTEST_BD_CALLS unset}"
printf '%s\n' "$*" >>"$L"
case "${1:-}" in
  show)
    [ $# -eq 3 ] && [ "$3" = "--json" ] || exit 64
    [ -f "$D/$2.show.json" ] || exit 65
    cat "$D/$2.show.json"
    ;;
  comments)
    [ $# -eq 3 ] && [ "$3" = "--json" ] || exit 64
    [ -f "$D/$2.comments.json" ] || exit 65
    cat "$D/$2.comments.json"
    ;;
  list)
    [ "$*" = "list --status in_progress --label needs-review --limit 0 --json" ] || exit 64
    [ -f "$D/list.json" ] || exit 65
    cat "$D/list.json"
    ;;
  close)
    [ $# -eq 4 ] && [ "$3" = "--reason" ] || exit 64
    [ -f "$D/$2.show.json" ] || exit 65
    if [ -f "$D/refuse-close" ]; then exit 66; fi
    python3 -c 'import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["status"]="closed"; json.dump(d,open(p,"w"),indent=2)' "$D/$2.show.json"
    ;;
  update)
    # --remove-label is what the beads vendor CLI reference documents for
    # `bd update`, alongside --add-label and --set-labels. Accepting it here is
    # the exact-argument match the brief asks for, NOT our own invention being
    # laundered through our own stub — but the vendor page carries no version
    # and contracts/GRAPH.md stamps this install's bd facts against build 1.2.2,
    # so a green leg is evidence about land.ts's call, never about bd's
    # behaviour.
    [ $# -eq 4 ] || exit 64
    case "$3" in --remove-label|--add-label) ;; *) exit 64 ;; esac
    [ -f "$D/$2.show.json" ] || exit 65
    # An `if`, not an `&&` chain: a chain here is the branch's LAST command, so
    # its false status becomes the stub's exit status and every drop reads as
    # refused. That bug shipped in this file for one revision and made the
    # drop-failure leg pass with its sentinel doing nothing.
    if [ "$3" = "--remove-label" ] && [ -f "$D/refuse-remove-label" ]; then exit 67; fi
    python3 -c 'import json,sys
p,op,lab=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p)); ls=d.get("labels",[])
if op=="--remove-label": ls=[x for x in ls if x!=lab]
elif lab not in ls: ls.append(lab)
d["labels"]=ls; json.dump(d,open(p,"w"),indent=2)' "$D/$2.show.json" "$3" "$4"
    ;;
  *)
    exit 64
    ;;
esac
STUB
chmod +x "$BIN/bd"

cat >"$BIN/gh" <<'STUB'
#!/bin/sh
# Stateful stub gh: `issue view <N> --json state`, `issue comment <N> --body <t>`,
# `issue close <N>`. Closed issues are recorded so a reconcile can see them.
L="${LAND_SELFTEST_GH_CALLS:?stub gh: LAND_SELFTEST_GH_CALLS unset}"
S="${LAND_SELFTEST_GH_STATE:?stub gh: LAND_SELFTEST_GH_STATE unset}"
printf '%s\n' "$*" >>"$L"
mkdir -p "$S"
[ "${1:-}" = "issue" ] || exit 64
case "${2:-}" in
  view)
    [ $# -eq 5 ] && [ "$4" = "--json" ] && [ "$5" = "state" ] || exit 64
    if [ -f "$S/$3.closed" ]; then echo '{"state":"CLOSED"}'; else echo '{"state":"OPEN"}'; fi
    ;;
  comment) [ $# -eq 5 ] && [ "$4" = "--body" ] || exit 64 ;;
  close)   [ $# -eq 3 ] || exit 64; : >"$S/$3.closed" ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$BIN/gh"

# ---------------------------------------------------------------------------
# Fixture builder.  make_proj <dir> <bead> <grant-sentence-or-NONE>
# ---------------------------------------------------------------------------
make_proj() {
  dir=$1; bead=$2; grant=$3
  mkdir -p "$dir/seats/logs" "$dir/contracts"

  {
    printf '# Integrator\n\n## This project\n\n### Push, PR, deploy, and reserved-action authority\n\n'
    if [ "$grant" = "NONE" ]; then
      printf '<!-- Nothing recorded here yet. -->\n'
    else
      printf '%s\n' "$grant"
    fi
  } >"$dir/contracts/INTEGRATOR.md"

  printf 'export const widget = 1;\n' >"$dir/seats/widget.ts"
  cat >"$dir/seats/widget.selftest.sh" <<'SH'
#!/bin/sh
echo 'widget.selftest: PASS'
SH
  chmod +x "$dir/seats/widget.selftest.sh"

  # Stateful stub adapter: records the dispatch AND writes state.json the way
  # the real adapter.ts does (state.seats.<seat>.lastBead), which is the signal
  # land.ts reads to avoid re-dispatching a review already running.
  cat >"$dir/seats/adapter.ts" <<'TS'
#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const calls = process.env.LAND_SELFTEST_ADAPTER_CALLS;
if (!calls) { process.stderr.write("stub adapter: LAND_SELFTEST_ADAPTER_CALLS unset\n"); process.exit(1); }
const argv = process.argv.slice(2);
if (argv[0] !== "dispatch" || argv.length !== 4) { process.stderr.write("stub adapter: unexpected argv\n"); process.exit(64); }
fs.appendFileSync(calls, argv.join("  ") + "\n");
const stateFile = path.join(import.meta.dir, "state.json");
let state: any = { seats: {} };
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
state.seats = state.seats ?? {};
state.seats[argv[1]] = { ...(state.seats[argv[1]] ?? {}), role: "reviewer", lastBead: argv[2] };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
TS

  cat >"$dir/seats/seats.json" <<'JSON'
{
  "commander": { "role": "commander", "external": true },
  "seats": {
    "worker-1": { "role": "worker", "account": { "dir": "/tmp/land-selftest/worker-1" } },
    "reviewer": { "role": "reviewer", "account": { "dir": "/tmp/land-selftest/reviewer" } }
  }
}
JSON

  printf '{"type":"agent_end"}\n' >"$dir/seats/logs/reviewer.jsonl"

  cat >"$dir/.gitignore" <<'IGN'
seats/logs/
seats/state.json
seats/inbox.jsonl
seats/inbox.cursor
seats/inbox.seen.json
seats/land.lock
seats/run/
seats/verdicts/
IGN

  (
    cd "$dir"
    git init -q -b main
    git config user.email land@example.invalid
    git config user.name 'Land Selftest'
    git add -A
    git commit -q -m 'Base'
    git init -q --bare "$dir/../origin-$bead.git"
    git remote add origin "$dir/../origin-$bead.git"
    git push -q origin main
  )
}

GRANT='The commander pushes main to origin on a reviewed APPROVE. Recorded 2026-01-01.'

branch_touching() {
  dir=$1; bead=$2
  (
    cd "$dir"
    git checkout -q -b "fleet/$bead"
    printf 'export const widget = 2;\n' >seats/widget.ts
    git add -A
    git commit -q -m 'Widget becomes two'
    git checkout -q main
  )
}

# bd_state <dir> <bead> <status> <labels-json> <pinned> <push-line> [author]
bd_state() {
  d=$1; bead=$2; status=$3; labels=$4; pinned=$5; push=$6; author=${7:-reviewer}
  mkdir -p "$d"
  cat >"$d/$bead.show.json" <<JSON
{
  "id": "$bead",
  "title": "Widget becomes two",
  "status": "$status",
  "labels": $labels
}
JSON
  python3 - "$d/$bead.comments.json" "$bead" "$pinned" "$push" "$author" <<'PY'
import json, sys
out, bead, pinned, push, author = sys.argv[1:6]
rows = [
  {"id": "c1", "created_at": "2026-01-01T00:00:00Z", "author": "worker-1",
   "text": f"worker report: done, branch fleet/{bead}"},
  {"id": "c2", "created_at": "2026-01-02T00:00:00Z", "author": author,
   "text": f"VERDICT: APPROVE — at pinned tip {pinned}\nPUSH:    {push}\n"},
]
json.dump(rows, open(out, "w"), indent=2)
PY
  cat >"$d/list.json" <<JSON
[
  { "id": "$bead", "created_at": "2026-01-01T00:00:00Z", "status": "in_progress" },
  { "id": "other-bead", "created_at": "2025-12-01T00:00:00Z", "status": "in_progress" }
]
JSON
}

# land <name> <proj> <bd-dir> [args...]
land() {
  name=$1; proj=$2; bddir=$3
  shift 3
  run_capture "$name" env \
    PATH="$RUN_PATH" HOME="$FIX/home" \
    WHEELHOUSE_LAND_ROOT="$proj" \
    LAND_SELFTEST_BD_DIR="$bddir" \
    LAND_SELFTEST_BD_CALLS="$FIX/$name.bd" \
    LAND_SELFTEST_GH_CALLS="$FIX/$name.gh" \
    LAND_SELFTEST_GH_STATE="$FIX/$name.ghstate" \
    LAND_SELFTEST_ADAPTER_CALLS="$FIX/$name.adapter" \
    "$BUN_BIN" "$LAND" "$@"
}

inbox() { printf '%s' "$1/seats/inbox.jsonl"; }
main_sha() { git -C "$1" rev-parse main; }
origin_head() { git --git-dir="$2" rev-parse main 2>/dev/null || echo none; }

# setup <n> <bead> <grant> -> sets P, D, TIP for the leg
setup() {
  n=$1; bead=$2; grant=$3
  P="$FIX/p$n/proj"; D="$FIX/p$n/bd"
  mkdir -p "$FIX/p$n"
  make_proj "$P" "$bead" "$grant"
  branch_touching "$P" "$bead"
  TIP=$(git -C "$P" rev-parse --short "fleet/$bead")
}

# ===========================================================================
# 1. Happy path.
# ===========================================================================
B=bead-happy
setup 1 "$B" "$GRANT"
P1=$P; D1=$D
bd_state "$D1" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
BEFORE=$(main_sha "$P1")
land happy "$P1" "$D1" "$B"
expect_rc happy 0
[ "$(main_sha "$P1")" != "$BEFORE" ] || fail "happy: main did not move"
git -C "$P1" log -1 --format=%s main >"$FIX/happy.subject"
expect_file_has "$FIX/happy.subject" "^Merge fleet/$B: Widget becomes two (reviewed $TIP, APPROVE)$" 'happy merge subject'
[ "$(origin_head "$P1" "$FIX/p1/origin-$B.git")" = "$(main_sha "$P1")" ] || fail "happy: origin/main was not pushed to the merge"
# The drop as an OUTCOME: exactly one attempt, before the close, and the bead's
# final state proves it took. The ordering is load-bearing — seats/intent-check.sh
# fails a bead closed while still labelled, so the label must come off first and
# a failed close must put it back.
expect_count "$FIX/happy.bd" "^update $B --remove-label needs-review$" 1 'happy drop attempts'
expect_count "$FIX/happy.bd" "^close $B --reason " 1 'happy close attempts'
drop_at=$(grep -n "^update $B --remove-label needs-review$" "$FIX/happy.bd" | head -1 | cut -d: -f1)
close_at=$(grep -n "^close $B --reason " "$FIX/happy.bd" | head -1 | cut -d: -f1)
[ "$drop_at" -lt "$close_at" ] || { cat "$FIX/happy.bd"; fail "happy: dropped at $drop_at, after the close at $close_at"; }
expect_bead "$D1" "$B" closed no 'happy final bead state'
expect_count "$FIX/happy.adapter" "^dispatch . reviewer . other-bead . " 1 'happy dispatch'
expect_line_count "$(inbox "$P1")" 1 'happy inbox'
expect_file_has "$(inbox "$P1")" '"class":"landed"' 'happy row'
expect_file_has "$(inbox "$P1")" 'and dropped needs-review' 'happy row records the drop'
expect_file_lacks "$(inbox "$P1")" 'NOT dropped' 'happy row'
ok "happy path merges, pushes, closes, dispatches, writes one landed row"

# 1b. Second run: every duty already done, so nothing happens and no second row.
SHA1=$(main_sha "$P1")
land happy2 "$P1" "$D1" "$B"
expect_rc happy2 0
[ "$(main_sha "$P1")" = "$SHA1" ] || fail "happy2: second run moved main"
expect_line_count "$(inbox "$P1")" 1 'happy2 inbox'
expect_file_lacks "$FIX/happy2.bd" "^close $B " 'happy2 bd'
[ ! -s "$FIX/happy2.adapter" ] || { cat "$FIX/happy2.adapter"; fail "happy2: dispatched a second time"; }
ok "second run merges nothing, closes nothing, dispatches nothing, writes no second row"

# ===========================================================================
# 3. Stale tip.
# ===========================================================================
B=bead-stale
setup 2 "$B" "$GRANT"
P2=$P; D2=$D; STALE=$TIP
( cd "$P2"; git checkout -q "fleet/$B"; printf 'export const widget = 3;\n' >seats/widget.ts
  git commit -q -am 'Widget becomes three'; git checkout -q main )
bd_state "$D2" "$B" in_progress '["needs-review"]' "$STALE" "APPROVE origin — verified: tip equals the SHA I reviewed"
BEFORE=$(main_sha "$P2")
land stale "$P2" "$D2" "$B"
expect_rc stale 2
expect_output stale 'stale-tip'
[ "$(main_sha "$P2")" = "$BEFORE" ] || fail "stale: main moved on a refusal"
expect_line_count "$(inbox "$P2")" 1 'stale inbox'
expect_file_has "$(inbox "$P2")" '"class":"land-refused"' 'stale row'
expect_bead "$D2" "$B" in_progress yes 'stale bead untouched'
ok "stale tip refuses, writes one land-refused row, writes nothing else"

# ===========================================================================
# 4. Planted conflict.
# ===========================================================================
B=bead-conflict
setup 3 "$B" "$GRANT"
P3=$P; D3=$D
( cd "$P3"; printf 'export const widget = 99;\n' >seats/widget.ts; git commit -q -am 'Ninety-nine on main' )
bd_state "$D3" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
BEFORE=$(main_sha "$P3")
land conflict "$P3" "$D3" "$B"
expect_rc conflict 2
expect_output conflict 'merge-conflict'
[ "$(main_sha "$P3")" = "$BEFORE" ] || fail "conflict: main moved on a refusal"
expect_bead "$D3" "$B" in_progress yes 'conflict bead untouched'
ok "a conflicting branch refuses and is never merged"

# ===========================================================================
# 5. Planted failing selftest. The same sibling PASSES in leg 1.
# ===========================================================================
B=bead-red
P4="$FIX/p4/proj"; D4="$FIX/p4/bd"; mkdir -p "$FIX/p4"
make_proj "$P4" "$B" "$GRANT"
( cd "$P4"; git checkout -q -b "fleet/$B"
  printf 'export const widget = 2;\n' >seats/widget.ts
  printf '#!/bin/sh\necho "widget.selftest: FAIL planted"\nexit 1\n' >seats/widget.selftest.sh
  chmod +x seats/widget.selftest.sh
  git add -A; git commit -q -m 'Two, with a red sibling'; git checkout -q main )
TIP4=$(git -C "$P4" rev-parse --short "fleet/$B")
bd_state "$D4" "$B" in_progress '["needs-review"]' "$TIP4" "APPROVE origin — verified: tip equals the SHA I reviewed"
BEFORE=$(main_sha "$P4")
land red "$P4" "$D4" "$B"
expect_rc red 2
expect_output red 'selftest-red'
expect_output red 'seats/widget.selftest.sh'
[ "$(main_sha "$P4")" = "$BEFORE" ] || fail "red: main moved on a refusal"
[ -z "$(git -C "$P4" status --porcelain)" ] || fail "red: the live checkout is dirty — the gate ran outside its scratch"
ok "a red sibling selftest refuses, names it, leaves the live tree untouched"

# ===========================================================================
# 6. A1 — the sibling selftest exists only on the MERGE, added by main after
#    the branch forked. Discovering from the branch would miss it entirely,
#    and it is exactly the selftest that catches this integration.
# ===========================================================================
B=bead-mainadded
P5="$FIX/p5/proj"; D5="$FIX/p5/bd"; mkdir -p "$FIX/p5"
make_proj "$P5" "$B" "$GRANT"
( cd "$P5"
  rm seats/widget.selftest.sh          # not present at the fork point
  git add -A; git commit -q -m 'Drop the sibling selftest'
  git checkout -q -b "fleet/$B"
  printf 'export const widget = 2;\n' >seats/widget.ts
  git add -A; git commit -q -m 'Widget becomes two'
  git checkout -q main
  # main adds a sibling selftest that fails against the branch's value
  printf '#!/bin/sh\ngrep -q "widget = 1" seats/widget.ts || { echo "widget.selftest: FAIL widget is not 1"; exit 1; }\necho ok\n' >seats/widget.selftest.sh
  chmod +x seats/widget.selftest.sh
  git add -A; git commit -q -m 'main adds the sibling selftest' )
TIP5=$(git -C "$P5" rev-parse --short "fleet/$B")
bd_state "$D5" "$B" in_progress '["needs-review"]' "$TIP5" "APPROVE origin — verified: tip equals the SHA I reviewed"
BEFORE=$(main_sha "$P5")
land mainadded "$P5" "$D5" "$B"
expect_rc mainadded 2
expect_output mainadded 'selftest-red'
expect_output mainadded 'seats/widget.selftest.sh'
[ "$(main_sha "$P5")" = "$BEFORE" ] || fail "mainadded: main moved on a refusal"
ok "a sibling selftest main added after the fork still gates the merge"

# ===========================================================================
# 7. Bead already closed.
# ===========================================================================
B=bead-closed
setup 6 "$B" "$GRANT"
P6=$P; D6=$D
bd_state "$D6" "$B" closed '["needs-review"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
BEFORE=$(main_sha "$P6")
land closed "$P6" "$D6" "$B"
expect_rc closed 2
expect_output closed 'not-in-review'
[ "$(main_sha "$P6")" = "$BEFORE" ] || fail "closed: main moved on a refusal"
ok "a closed bead refuses with not-in-review"

# ===========================================================================
# 8. No recorded push grant — this install's default. Merged, closed, NOT pushed.
# ===========================================================================
B=bead-nopush
setup 7 "$B" NONE
P7=$P; D7=$D
bd_state "$D7" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
ORIGIN_BEFORE=$(origin_head "$P7" "$FIX/p7/origin-$B.git")
land nopush "$P7" "$D7" "$B"
expect_rc nopush 0
git -C "$P7" merge-base --is-ancestor "fleet/$B" main || fail "nopush: branch was not merged"
expect_bead "$D7" "$B" closed no 'nopush final bead state'
[ "$(origin_head "$P7" "$FIX/p7/origin-$B.git")" = "$ORIGIN_BEFORE" ] || fail "nopush: origin moved without a grant"
expect_file_has "$(inbox "$P7")" 'not pushed (authorised skip)' 'nopush row says so'
ok "with no recorded grant the branch is merged and closed but never pushed"

# ===========================================================================
# 9. A3 — a prohibition that the lint's own regex reads as a GRANT must not push.
# ===========================================================================
n=8
for sentence in \
  'Do not push main to origin.' \
  'Never push main. Ask the principal.' \
  'Only the principal may push main to origin.' \
  'Pushing to origin is reserved to the principal.'
do
  B="bead-prohibit$n"
  setup "$n" "$B" "$sentence"
  bd_state "$D" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
  OB=$(origin_head "$P" "$FIX/p$n/origin-$B.git")
  land "prohibit$n" "$P" "$D" "$B"
  expect_rc "prohibit$n" 0
  git -C "$P" merge-base --is-ancestor "fleet/$B" main || fail "prohibit$n: branch was not merged"
  [ "$(origin_head "$P" "$FIX/p$n/origin-$B.git")" = "$OB" ] || fail "prohibit$n: PUSHED on a prohibition: $sentence"
  expect_file_has "$(inbox "$P")" 'reads as a prohibition' "prohibit$n row"
  n=$((n + 1))
done
ok "four prohibitions the lint's regex reads as grants are merged and closed but NOT pushed"

# Positive control for leg 9: the same machinery DOES push on a real grant.
# Without this, leg 9 would pass just as well if grantsPush() always said no.
[ "$(origin_head "$P1" "$FIX/p1/origin-bead-happy.git")" = "$(main_sha "$P1")" ] || fail "leg 9 control: the happy leg did not push either"
ok "control: the same code pushed on leg 1's genuine grant, so leg 9 is the prohibition and not a dead push path"

# ===========================================================================
# 11. A2 — the push destination must be a remote this install configured.
# ===========================================================================
n=12
for dest in 'https://attacker.example/x.git' '--upload-pack=evil' 'notaremote'
do
  B="bead-dest$n"
  setup "$n" "$B" "$GRANT"
  bd_state "$D" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE $dest — verified: tip equals the SHA I reviewed"
  BEFORE=$(main_sha "$P")
  land "dest$n" "$P" "$D" "$B"
  expect_rc "dest$n" 2
  expect_output "dest$n" 'push-destination'
  [ "$(main_sha "$P")" = "$BEFORE" ] || fail "dest$n: merged despite an unusable push destination ($dest)"
  expect_bead "$D" "$B" in_progress yes "dest$n bead untouched"
  n=$((n + 1))
done
ok "a URL, an option-shaped token and an unconfigured name each refuse before any write"

# ===========================================================================
# 12. gh-<N> label.
# ===========================================================================
B=bead-gh
setup 15 "$B" "$GRANT"
P15=$P; D15=$D
bd_state "$D15" "$B" in_progress '["needs-review","gh-42"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
land ghleg "$P15" "$D15" "$B"
expect_rc ghleg 0
expect_count "$FIX/ghleg.gh" "^issue comment 42 --body " 1 'gh comment'
expect_count "$FIX/ghleg.gh" "^issue close 42$" 1 'gh close'
ok "a gh-<N> label gets the fix commit commented and the issue closed, once"

# ===========================================================================
# 13. Reviewer mid-turn: no dispatch.
# ===========================================================================
B=bead-midturn
setup 16 "$B" "$GRANT"
P16=$P; D16=$D
printf '{"type":"agent_end"}\n{"type":"tool_execution_start"}\n' >"$P16/seats/logs/reviewer.jsonl"
bd_state "$D16" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: tip equals the SHA I reviewed"
land midturn "$P16" "$D16" "$B"
expect_rc midturn 0
git -C "$P16" merge-base --is-ancestor "fleet/$B" main || fail "midturn: branch was not merged"
[ ! -s "$FIX/midturn.adapter" ] || { cat "$FIX/midturn.adapter"; fail "midturn: dispatched to a mid-turn seat"; }
expect_file_has "$(inbox "$P16")" 'not dispatched' 'midturn row says so'
ok "a mid-turn reviewer is not dispatched to, and the row says so"

# ===========================================================================
# 14. C1 — a comment that decides two things decides nothing.
# ===========================================================================
n=17
for shape in twoverdicts twopush contradiction
do
  B="bead-$shape"
  setup "$n" "$B" "$GRANT"
  bd_state "$D" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
  case "$shape" in
    twoverdicts) body="VERDICT: APPROVE — at pinned tip $TIP\nPUSH:    APPROVE origin — verified: ok\nVERDICT: BOUNCE\n" ;;
    twopush)     body="VERDICT: APPROVE — at pinned tip $TIP\nPUSH:    APPROVE origin — verified: ok\nPUSH:    HOLD — on reflection, no\n" ;;
    contradiction) body="VERDICT: APPROVE BOUNCE — at pinned tip $TIP\nPUSH:    APPROVE origin — verified: ok\n" ;;
  esac
  python3 - "$D/$B.comments.json" "$body" <<'PY'
import json, sys
out, body = sys.argv[1], sys.argv[2].replace("\\n", "\n")
json.dump([{"id": "c1", "created_at": "2026-01-02T00:00:00Z", "author": "reviewer", "text": body}], open(out, "w"), indent=2)
PY
  BEFORE=$(main_sha "$P")
  land "$shape" "$P" "$D" "$B"
  expect_rc "$shape" 2
  expect_output "$shape" 'malformed-verdict'
  [ "$(main_sha "$P")" = "$BEFORE" ] || fail "$shape: merged on a verdict that decides two things"
  n=$((n + 1))
done
ok "two VERDICT lines, two PUSH lines, and APPROVE-plus-BOUNCE each refuse as malformed"

# ===========================================================================
# A comment with NO PUSH line at all is the other half of that, and it is the
# opposite answer. contracts/INTEGRATOR.md:48: "A missing PUSH line is
# unanswered, which is neither permission nor refusal. Go and ask." It is a
# documented, expected state — not a malformed verdict — so it is NOT A TRIGGER:
# no row, no writes, exit 0, exactly as PUSH: NOT CONSIDERED already behaves.
#
# Every leg above constructs DUPLICATE lines; none constructed an ABSENT one,
# which is how the duplicate check was allowed to swallow this case.
# ===========================================================================
B=bead-nopushline
setup 29 "$B" "$GRANT"
P29=$P; D29=$D
bd_state "$D29" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
python3 - "$D29/$B.comments.json" "$TIP" <<'PY'
import json, sys
out, pinned = sys.argv[1], sys.argv[2]
json.dump([{"id": "c1", "created_at": "2026-01-02T00:00:00Z", "author": "reviewer",
            "text": f"VERDICT: APPROVE — at pinned tip {pinned}\nEvidence: the bench is green.\n"}],
          open(out, "w"), indent=2)
PY
BEFORE=$(main_sha "$P29")
ORIGIN_BEFORE=$(origin_head "$P29" "$FIX/p29/origin-$B.git")
land nopushline "$P29" "$D29" "$B"
expect_rc nopushline 0
expect_output nopushline 'not triggered'
[ "$(main_sha "$P29")" = "$BEFORE" ] || fail "nopushline: merged on an unanswered push question"
[ "$(origin_head "$P29" "$FIX/p29/origin-$B.git")" = "$ORIGIN_BEFORE" ] || fail "nopushline: pushed on an unanswered push question"
expect_line_count "$(inbox "$P29")" 0 'nopushline inbox'
expect_bead "$D29" "$B" in_progress yes 'nopushline bead untouched'
expect_file_lacks "$FIX/nopushline.bd" "^close " 'nopushline bd'
ok "a verdict with NO PUSH line is unanswered, not malformed: exit 0, no row, nothing touched"

# ===========================================================================
# contracts/REVIEWER.md's grammar gained annotations upstream:
#   VERDICT: APPROVE [— <annotation>] | BOUNCE [— ...] | DISCOVER [— ...]
#   PUSH:    APPROVE <remote> — verified: <what> [<annotation>] | ...
# The annotation is free text, so a parser that ASKS WHETHER A WORD APPEARS on
# the line refuses ordinary approvals. Both of these are valid and must land.
# ===========================================================================
B=bead-annotated
setup 30 "$B" "$GRANT"
P30=$P; D30=$D
bd_state "$D30" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
python3 - "$D30/$B.comments.json" "$TIP" <<'PY'
import json, sys
out, pinned = sys.argv[1], sys.argv[2]
json.dump([{"id": "c1", "created_at": "2026-01-02T00:00:00Z", "author": "reviewer",
            "text": (f"VERDICT: APPROVE — at pinned tip {pinned}; the earlier BOUNCE is addressed and the DISCOVER note was folded in\n"
                     "PUSH:    APPROVE origin — verified: base..tip is one commit; the earlier HOLD is resolved and NOT CONSIDERED no longer applies\n")}],
          open(out, "w"), indent=2)
PY
BEFORE=$(main_sha "$P30")
land annotated "$P30" "$D30" "$B"
expect_rc annotated 0
[ "$(main_sha "$P30")" != "$BEFORE" ] || { cat "$FIX/annotated.out"; fail "annotated: refused an APPROVE whose annotation merely mentions BOUNCE/HOLD"; }
[ "$(origin_head "$P30" "$FIX/p30/origin-$B.git")" = "$(main_sha "$P30")" ] || fail "annotated: did not push, so the remote was not read off the annotated PUSH line"
expect_bead "$D30" "$B" closed no 'annotated final bead state'
ok "an annotation naming BOUNCE, DISCOVER, HOLD or NOT CONSIDERED is prose, not a contradiction"

# A verdict QUOTED INSIDE A FENCE is evidence text — REVIEWER.md prints the
# grammar in fences, so a reviewer who quotes the format they are following must
# not trip the duplicate-line refusal.
#
# A BLOCKQUOTE MARKER IS NOT THE SAME THING, and this leg asserts the
# difference. seats/verify.ts's liveLineCandidates strips a leading `> ` and
# then matches, so a marked-up line still counts as the verdict — the marker is
# forwarding, not quoting. This leg puts the real verdict behind `> ` for that
# reason; an earlier draft of it assumed blockquotes were inert like fences and
# was wrong about the tool it was written to match.
B=bead-fenced
setup 31 "$B" "$GRANT"
P31=$P; D31=$D
bd_state "$D31" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
python3 - "$D31/$B.comments.json" "$TIP" <<'PY'
import json, sys
out, pinned = sys.argv[1], sys.argv[2]
json.dump([{"id": "c1", "created_at": "2026-01-02T00:00:00Z", "author": "reviewer",
            "text": ("The format I am following, from contracts/REVIEWER.md:\n\n"
                     "```\nVERDICT: BOUNCE\nPUSH:    HOLD — example\n```\n\n"
                     "and again, as an indented sample:\n\n"
                     "```\nVERDICT: DISCOVER\nPUSH:    NOT CONSIDERED\n```\n\n"
                     "My actual answer, forwarded from the pass:\n\n"
                     f"> VERDICT: APPROVE — at pinned tip {pinned}\n"
                     "> PUSH:    APPROVE origin — verified: ok\n")}],
          open(out, "w"), indent=2)
PY
BEFORE=$(main_sha "$P31")
land fenced "$P31" "$D31" "$B"
expect_rc fenced 0
[ "$(main_sha "$P31")" != "$BEFORE" ] || { cat "$FIX/fenced.out"; fail "fenced: a quoted example was counted as a second verdict"; }
expect_bead "$D31" "$B" closed no 'fenced final bead state'
ok "a verdict quoted in a fence is evidence text; a blockquote marker is stripped and still counts"

# ===========================================================================
# runbooks/RUNNING_THE_LOOP.md, "When publishing a reviewed tip by object id":
# a local branch named like the object id we are about to publish makes the
# token ambiguous to Git. That is a cleanup defect, and it refuses BEFORE the
# push rather than publishing whatever the branch points at.
# ===========================================================================
B=bead-shabranch
setup 32 "$B" "$GRANT"
P32=$P; D32=$D
bd_state "$D32" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
# The merge commit does not exist yet, so the branch is planted by a first run
# that is allowed to merge, then reset.
#
# THE DATE PIN IS LOAD-BEARING. A commit's object id covers its committer
# timestamp, so the prep merge and the real merge share an id only when both
# land inside the same clock second. Measured 2026-09-17 on the unmutated
# tool: adding two `say` lines between the runs was enough to push them apart,
# the planted branch then named a commit nobody was about to publish, and the
# leg went red having tested nothing about the refusal. A leg whose fixture
# misses by a second is a leg that reports on the clock. Pinned, the id is a
# function of the parents, the tree and the message alone. `env` here carries
# the surrounding environment through, so the pin reaches the git children
# land.ts spawns.
ORIGIN_BEFORE=$(origin_head "$P32" "$FIX/p32/origin-$B.git")
GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'; export GIT_AUTHOR_DATE
GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'; export GIT_COMMITTER_DATE
land shaprep "$P32" "$D32" "$B"
expect_rc shaprep 0
MERGE_SHA=$(git -C "$P32" rev-parse HEAD)
# Now rewind and plant a branch named exactly like that merge commit.
( cd "$P32"
  git reset -q --hard "$ORIGIN_BEFORE"
  git branch "$MERGE_SHA" "fleet/$B"
  git update-ref -d refs/heads/nonexistent 2>/dev/null || true )
git --git-dir="$FIX/p32/origin-$B.git" update-ref refs/heads/main "$ORIGIN_BEFORE"
bd_state "$D32" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
rm -f "$(inbox "$P32")"
land shabranch "$P32" "$D32" "$B"
expect_rc shabranch 2
expect_output shabranch 'sha-named-branch'
# The fixture HIT: the refusal names the very id the planted branch carries.
# Without this the leg could refuse for some other reason and still read green.
expect_output shabranch "$MERGE_SHA"
[ "$(origin_head "$P32" "$FIX/p32/origin-$B.git")" = "$ORIGIN_BEFORE" ] || fail "shabranch: published with a SHA-named branch in the way"
expect_file_has "$(inbox "$P32")" '"class":"land-refused"' 'shabranch row'
unset GIT_AUTHOR_DATE GIT_COMMITTER_DATE
ok "a local branch named like the object id being published refuses before the push"

# The other half of the same runbook sentence: push `<tip>^{commit}`, never a
# bare 40-hex token. The refusal above covers refs/heads, which is the detector
# the runbook specifies — so a TAG named like the object id is the case where
# the caret qualification is doing the work on its own, and it is doing it.
# Measured here: with a tag of that name pointing elsewhere, a bare token
# publishes the TAG'S TARGET and `^{commit}` publishes the merge.
B=bead-shatag
setup 33 "$B" "$GRANT"
P33=$P; D33=$D
bd_state "$D33" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
DECOY=$(git -C "$P33" rev-parse main)      # what a bare token would publish instead
# Same pin, same reason as leg 32 above: the tag has to be named after the id
# the SECOND run will produce, and that id moves with the clock unless it is
# held still. An unpinned run tags an id nobody publishes, the ambiguity never
# arises, and the leg passes without ever exercising the caret.
GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'; export GIT_AUTHOR_DATE
GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'; export GIT_COMMITTER_DATE
land shatagprep "$P33" "$D33" "$B"
expect_rc shatagprep 0
MERGE33=$(git -C "$P33" rev-parse HEAD)
( cd "$P33"
  git reset -q --hard "$DECOY"
  git config advice.objectNameWarning false
  git tag "$MERGE33" "$DECOY" )
git --git-dir="$FIX/p33/origin-$B.git" update-ref refs/heads/main "$DECOY"
bd_state "$D33" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
rm -f "$(inbox "$P33")"
land shatag "$P33" "$D33" "$B"
expect_rc shatag 0
PUBLISHED=$(origin_head "$P33" "$FIX/p33/origin-$B.git")
# The fixture HIT: the second run built the very id the tag is named after, so
# the token this leg is about really was ambiguous to Git.
[ "$(main_sha "$P33")" = "$MERGE33" ] || fail "shatag: the second merge is $(main_sha "$P33"), not the tagged $MERGE33 — the ambiguity was never set up and this leg proved nothing"
[ "$PUBLISHED" != "$DECOY" ] || fail "shatag: published the tag's target, not the merge — the token was resolved as a ref"
[ "$PUBLISHED" = "$(main_sha "$P33")" ] || fail "shatag: origin does not carry the merge ($PUBLISHED vs $(main_sha "$P33"))"
unset GIT_AUTHOR_DATE GIT_COMMITTER_DATE
ok "with a TAG named like the object id, ^{commit} publishes the merge and not the tag's target"

# ===========================================================================
# 15. C2 — an approval from a seat not entitled to give one lands nothing.
# ===========================================================================
B=bead-selfapproved
setup 20 "$B" "$GRANT"
P20=$P; D20=$D
bd_state "$D20" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok" worker-1
BEFORE=$(main_sha "$P20")
land selfapproved "$P20" "$D20" "$B"
expect_rc selfapproved 1
expect_output selfapproved 'not a reviewer or verifier seat'
[ "$(main_sha "$P20")" = "$BEFORE" ] || fail "selfapproved: a worker-authored APPROVE was merged"
expect_line_count "$(inbox "$P20")" 0 'selfapproved inbox'
ok "a worker-authored APPROVE is not a verdict: nothing merged, nothing written"

# ===========================================================================
# 16. C3 — an authorised push that FAILS must not tell anyone the fix shipped.
# ===========================================================================
B=bead-pushfail
setup 21 "$B" "$GRANT"
P21=$P; D21=$D
bd_state "$D21" "$B" in_progress '["needs-review","gh-77"]' "$TIP" "APPROVE origin — verified: ok"
rm -rf "$FIX/p21/origin-$B.git"          # the remote is configured but gone
land pushfail "$P21" "$D21" "$B"
expect_rc pushfail 1
expect_output pushfail 'NOT pushed'
git -C "$P21" merge-base --is-ancestor "fleet/$B" main || fail "pushfail: the merge should still have happened locally"
expect_bead "$D21" "$B" in_progress yes 'pushfail bead must stay open'
expect_file_lacks "$FIX/pushfail.bd" "^close " 'pushfail bd'
[ ! -s "$FIX/pushfail.gh" ] || { cat "$FIX/pushfail.gh"; fail "pushfail: answered a GitHub issue naming an unpublished commit"; }
[ ! -s "$FIX/pushfail.adapter" ] || fail "pushfail: dispatched the next review on a half-finished land"
expect_file_has "$(inbox "$P21")" 'NOT PUBLISHED' 'pushfail row'
ok "a failed push leaves the bead open, the issue unanswered, and says NOT PUBLISHED"

# The remote is still gone. A poll tick every couple of minutes against a
# persistently unreachable remote must not append a new NOT PUBLISHED row each
# time: the first one said it, and the inbox is durable.
land pushfail2 "$P21" "$D21" "$B"
expect_rc pushfail2 1
expect_line_count "$(inbox "$P21")" 1 'pushfail2 inbox'
ok "a second tick against the same unreachable remote adds no second row"

# 16b. The next tick reconciles it once the remote is back.
git -C "$P21" init -q --bare "$FIX/p21/origin-$B.git"
land pushfix "$P21" "$D21" "$B"
expect_rc pushfix 0
expect_bead "$D21" "$B" closed no 'pushfix final bead state'
expect_count "$FIX/pushfix.gh" "^issue close 77$" 1 'pushfix gh close'
expect_line_count "$(inbox "$P21")" 2 'pushfix inbox'
ok "the next run reconciles the half-finished land: pushed, closed, issue answered"

# ===========================================================================
# 18. C4 — a merge that happened with every later duty undone is repaired,
#     not reported as "already landed; nothing to do".
# ===========================================================================
B=bead-reconcile
setup 22 "$B" "$GRANT"
P22=$P; D22=$D
bd_state "$D22" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
( cd "$P22"; git merge -q --no-ff -m "Merge fleet/$B: Widget becomes two (reviewed $TIP, APPROVE)" "fleet/$B" )
land reconcile "$P22" "$D22" "$B"
expect_rc reconcile 0
expect_bead "$D22" "$B" closed no 'reconcile final bead state'
[ "$(origin_head "$P22" "$FIX/p22/origin-$B.git")" = "$(main_sha "$P22")" ] || fail "reconcile: never pushed"
expect_count "$FIX/reconcile.adapter" "^dispatch . reviewer . other-bead . " 1 'reconcile dispatch'
expect_line_count "$(inbox "$P22")" 1 'reconcile inbox'
expect_file_has "$(inbox "$P22")" 'reconciling the remaining duties' 'reconcile row'
ok "an already-merged branch with its duties undone is reconciled, not declared done"

# ===========================================================================
# 19. B2 — the branch moving while the gates run must not land an unreviewed tip.
# ===========================================================================
B=bead-moved
P23="$FIX/p23/proj"; D23="$FIX/p23/bd"; mkdir -p "$FIX/p23"
make_proj "$P23" "$B" "$GRANT"
( cd "$P23"
  printf '#!/bin/sh\nsleep 4\necho slow ok\n' >seats/widget.selftest.sh
  chmod +x seats/widget.selftest.sh
  git add -A; git commit -q -m 'A slow sibling selftest'
  git checkout -q -b "fleet/$B"
  printf 'export const widget = 2;\n' >seats/widget.ts
  git add -A; git commit -q -m 'Widget becomes two'; git checkout -q main )
TIP23=$(git -C "$P23" rev-parse --short "fleet/$B")
bd_state "$D23" "$B" in_progress '["needs-review"]' "$TIP23" "APPROVE origin — verified: ok"
BEFORE=$(main_sha "$P23")
( land moved "$P23" "$D23" "$B" ) &
LAND_PID=$!
sleep 2
( cd "$P23"; git checkout -q "fleet/$B"; printf 'export const widget = 4;\n' >seats/widget.ts
  git commit -q -am 'A worker appends mid-review'; git checkout -q main )
wait "$LAND_PID" || true
expect_rc moved 2
expect_output moved 'stale-tip'
[ "$(main_sha "$P23")" = "$BEFORE" ] || fail "moved: merged a tip nobody reviewed"
ok "a branch that moves while the gates run refuses rather than landing an unreviewed tip"

# ===========================================================================
# 20. B1 — two concurrent runs. Exactly one of everything.
# ===========================================================================
B=bead-race
P24="$FIX/p24/proj"; D24="$FIX/p24/bd"; mkdir -p "$FIX/p24"
make_proj "$P24" "$B" "$GRANT"
( cd "$P24"
  printf '#!/bin/sh\nsleep 4\necho slow ok\n' >seats/widget.selftest.sh
  chmod +x seats/widget.selftest.sh
  git add -A; git commit -q -m 'A slow sibling selftest'
  git checkout -q -b "fleet/$B"
  printf 'export const widget = 2;\n' >seats/widget.ts
  git add -A; git commit -q -m 'Widget becomes two'; git checkout -q main )
TIP24=$(git -C "$P24" rev-parse --short "fleet/$B")
bd_state "$D24" "$B" in_progress '["needs-review"]' "$TIP24" "APPROVE origin — verified: ok"
RACE_BD="$FIX/race.bd"; RACE_AD="$FIX/race.adapter"
race_run() {
  env PATH="$RUN_PATH" HOME="$FIX/home" WHEELHOUSE_LAND_ROOT="$P24" \
    LAND_SELFTEST_BD_DIR="$D24" LAND_SELFTEST_BD_CALLS="$RACE_BD" \
    LAND_SELFTEST_GH_CALLS="$FIX/race.gh" LAND_SELFTEST_GH_STATE="$FIX/race.ghstate" \
    LAND_SELFTEST_ADAPTER_CALLS="$RACE_AD" \
    "$BUN_BIN" "$LAND" "$B" >"$FIX/race.$1.out" 2>&1
}
( race_run a ) & RA=$!
sleep 1
( race_run b ) & RB=$!
wait "$RA" || true
wait "$RB" || true
git -C "$P24" merge-base --is-ancestor "fleet/$B" main || {
  cat "$FIX/race.a.out" "$FIX/race.b.out"
  fail "race: neither run landed the branch"
}
expect_count "$RACE_BD" "^close $B --reason " 1 'race close attempts'
expect_count "$RACE_AD" "^dispatch . reviewer . other-bead . " 1 'race dispatch attempts'
expect_line_count "$(inbox "$P24")" 1 'race inbox'
expect_bead "$D24" "$B" closed no 'race final bead state'
ok "two concurrent runs produce exactly one merge, one close, one dispatch and one row"

# ===========================================================================
# 21. C5 — a dependency this tool cannot read is an error, never a judgment.
# ===========================================================================
B=bead-badjson
setup 25 "$B" "$GRANT"
P25=$P; D25=$D
bd_state "$D25" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
printf '{ this is not json' >"$D25/$B.comments.json"
BEFORE=$(main_sha "$P25")
land badjson "$P25" "$D25" "$B"
expect_rc badjson 1
expect_output badjson 'unparseable JSON'
[ "$(main_sha "$P25")" = "$BEFORE" ] || fail "badjson: merged on unreadable comments"
expect_line_count "$(inbox "$P25")" 0 'badjson inbox'
ok "unreadable bd output exits 1 and writes no row, rather than reading as no-verdict"

# ===========================================================================
# 22. Drop refused: a note, not a failed land.
# ===========================================================================
B=bead-dropfail
setup 26 "$B" "$GRANT"
P26=$P; D26=$D
bd_state "$D26" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
: >"$D26/refuse-remove-label"
land dropfail "$P26" "$D26" "$B"
expect_rc dropfail 0
git -C "$P26" merge-base --is-ancestor "fleet/$B" main || fail "dropfail: a refused drop stopped the merge"
expect_bead "$D26" "$B" closed yes 'dropfail final bead state'
expect_file_has "$(inbox "$P26")" 'needs-review NOT dropped' 'dropfail row says so'
expect_file_has "$(inbox "$P26")" 'needs-review still on it' 'dropfail row'
expect_file_lacks "$(inbox "$P26")" 'and dropped needs-review' 'dropfail row'
ok "a refused label drop is a note on the row, not a failed land"

# ===========================================================================
# 23. --scan, and the poll-script wiring that is the real trigger.
# ===========================================================================
B=bead-scan
setup 27 "$B" "$GRANT"
P27=$P; D27=$D
bd_state "$D27" "$B" in_progress '["needs-review"]' "$TIP" "APPROVE origin — verified: ok"
printf '{ "id": "other-bead", "title": "Not yet reviewed", "status": "in_progress", "labels": ["needs-review"] }\n' >"$D27/other-bead.show.json"
printf '[ { "id": "c1", "created_at": "2025-12-01T00:00:00Z", "author": "worker-1", "text": "worker report: done" } ]\n' >"$D27/other-bead.comments.json"
BEFORE=$(main_sha "$P27")
land scan "$P27" "$D27" --scan
expect_rc scan 0
[ "$(main_sha "$P27")" != "$BEFORE" ] || fail "scan: main did not move"
expect_line_count "$(inbox "$P27")" 1 'scan inbox'
ok "--scan lands the bead whose verdict triggers and leaves the unreviewed one alone"

B=bead-wired
setup 28 "$B" "$GRANT"
P28=$P; D28=$D
cp "$SCRIPT_DIR/land.ts" "$P28/seats/land.ts"
cp "$SCRIPT_DIR/herald.ts" "$P28/seats/herald.ts"
( cd "$P28"; git add seats/land.ts seats/herald.ts; git commit -q -m 'Install land.ts and herald.ts'; git push -q origin main )
TIP28=$(git -C "$P28" rev-parse --short "fleet/$B")
bd_state "$D28" "$B" in_progress '["needs-review"]' "$TIP28" "APPROVE origin — verified: ok"
printf '{ "id": "other-bead", "title": "Not yet reviewed", "status": "in_progress", "labels": ["needs-review"] }\n' >"$D28/other-bead.show.json"
printf '[ { "id": "c1", "created_at": "2025-12-01T00:00:00Z", "author": "worker-1", "text": "worker report: done" } ]\n' >"$D28/other-bead.comments.json"
BEFORE=$(main_sha "$P28")
run_capture wired env PATH="$RUN_PATH" HOME="$FIX/home" \
  WHEELHOUSE_COMMANDER_POLL_ROOT="$P28" WHEELHOUSE_HERALD_ROOT="$P28" \
  LAND_SELFTEST_BD_DIR="$D28" LAND_SELFTEST_BD_CALLS="$FIX/wired.bd" \
  LAND_SELFTEST_GH_CALLS="$FIX/wired.gh" LAND_SELFTEST_GH_STATE="$FIX/wired.ghstate" \
  LAND_SELFTEST_ADAPTER_CALLS="$FIX/wired.adapter" \
  sh "$SCRIPT_DIR/commander-inbox-poll.sh" --once
expect_rc wired 0
[ "$(main_sha "$P28")" != "$BEFORE" ] || { cat "$FIX/wired.out"; fail "wired: the poll script did not land the reviewed branch"; }
expect_bead "$D28" "$B" closed no 'wired final bead state'
ok "commander-inbox-poll.sh --once is the trigger and lands the reviewed branch"

say "land.selftest: PASS ($pass_count checks)"
