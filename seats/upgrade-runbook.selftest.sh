#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
BASELINE=${WHEELHOUSE_UPGRADE_SELFTEST_BASELINE:-d8128d4}
TEMPLATE_SOURCE="$ROOT/wheelhouse/.template-source"

source_refusal() {
  echo "REFUSED template source: $*" >&2
  exit 42
}

read_template_source_field() {
  local field=$1
  sed -n "s/^${field}=//p" "$TEMPLATE_SOURCE" 2>/dev/null | tail -1
}

ensure_template_cache_ignored() {
  local ignore="$ROOT/.gitignore"
  if [ -e "$ignore" ] && [ -n "$(tail -c1 "$ignore")" ]; then printf '\n' >> "$ignore"; fi
  grep -qxF 'wheelhouse/.template-cache/' "$ignore" 2>/dev/null || printf '%s\n' 'wheelhouse/.template-cache/' >> "$ignore"
}

template_root() {
  local recorded="" source="" commit="" cache="" short=""
  if [ -d "$ROOT/wheelhouse" ] && [ ! -d "$ROOT/contracts" ]; then
    [ -f "$TEMPLATE_SOURCE" ] || source_refusal "$TEMPLATE_SOURCE missing; expected source= and commit= lines (path= is only a disposable cache hint)"
    recorded=$(read_template_source_field path)
    source=$(read_template_source_field source)
    commit=$(read_template_source_field commit)
    [ -n "$commit" ] || commit=$BASELINE

    if [ -n "$recorded" ] \
      && git -C "$recorded" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      && git -C "$recorded" cat-file -e "${commit}^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "$recorded"
      return 0
    fi

    [ -n "$source" ] || source_refusal "$TEMPLATE_SOURCE has no source= line; cannot fetch commit=$commit (path=${recorded:-<empty>} is not usable)"
    short=$(printf '%s' "$commit" | cut -c1-12)
    cache="$ROOT/wheelhouse/.template-cache/$short"
    if [ -d "$cache/.git" ] && git -C "$cache" cat-file -e "${commit}^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "$cache"
      return 0
    fi

    ensure_template_cache_ignored
    mkdir -p "$ROOT/wheelhouse/.template-cache"
    rm -rf "$cache"
    if ! git clone --quiet "$source" "$cache" >/dev/null 2>&1; then
      source_refusal "source=$source unreachable; cannot fetch commit=$commit after path=${recorded:-<empty>} was unusable"
    fi
    git -C "$cache" cat-file -e "${commit}^{commit}" >/dev/null 2>&1 \
      || source_refusal "source=$source did not provide commit=$commit after path=${recorded:-<empty>} was unusable"
    printf '%s\n' "$cache"
    return 0
  fi
  printf '%s\n' "$ROOT"
}
TEMPLATE=$(template_root)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-upgrade-selftest.XXXXXX")
cleanup(){ selftest_cleanup_fixture_processes "${TMP:-}" "${SOCK:-}"; rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0
fail() { echo "not ok $((PASS+1)) - $*"; exit 1; }
pass() { PASS=$((PASS+1)); echo "ok $PASS - $*"; }

copy_installed_selftest() {
  local dest="$1"
  cp "$ROOT/seats/upgrade-runbook.selftest.sh" "$dest/upgrade-runbook.selftest.sh"
  cp "$ROOT/seats/selftest-lib.sh" "$dest/selftest-lib.sh"
}

command -v zsh >/dev/null 2>&1 || fail "zsh is required for this selftest"

if [ "$TEMPLATE" = "$ROOT" ]; then
  if grep -q 'remove `seats/bin`' "$TEMPLATE/runbooks/UPGRADE.md"; then
    fail "UPGRADE.md still tells non-opt-in installs to remove seats/bin"
  fi
  if grep -qi 'keep .*`seats/bin`' "$TEMPLATE/runbooks/UPGRADE.md" && grep -qi 'keep .*`seats/bin`' "$TEMPLATE/seats/README.md"; then
    pass "host budget docs keep seats/bin inert unless host-budget.json opts in"
  else
    fail "host budget docs do not agree that seats/bin is kept but inert without host-budget.json"
  fi
fi

PROJ="$TMP/project"
mkdir -p "$PROJ/wheelhouse/fleet" "$PROJ/wheelhouse/runbooks"
git -C "$TEMPLATE" show "${BASELINE}:contracts/WORKER.md" > "$PROJ/wheelhouse/fleet/WORKER.md"
for b in PROMOTION.md RUNNING_THE_LOOP.md UPGRADE.md; do
  git -C "$TEMPLATE" show "${BASELINE}:runbooks/$b" > "$PROJ/wheelhouse/runbooks/$b"
done
# One runbook is already byte-equal to the target, so step 3 must report it
# current rather than "updated" after copying identical bytes.
cp "$TEMPLATE/runbooks/UPGRADE.md" "$PROJ/wheelhouse/runbooks/UPGRADE.md"

STEP0_OUT=$(zsh -c '
set -e
TEMPLATE=$1
PROJECT=$2
for c in $(git -C "$TEMPLATE" rev-list HEAD -- contracts/); do
  if diff -rq <(git -C "$TEMPLATE" show ${c}:contracts/WORKER.md) "$PROJECT/wheelhouse/fleet/WORKER.md" >/dev/null 2>&1; then
    echo "candidate baseline: $c"
    break
  fi
done
' zsh "$TEMPLATE" "$PROJ")
case "$STEP0_OUT" in
  "candidate baseline: "*) pass "zsh step 0 baseline reconstruction reads commit:path with braces" ;;
  *) fail "zsh step 0 did not find a healthy baseline: $STEP0_OUT" ;;
esac

STEP3_OUT=$(zsh -c '
set -e
TEMPLATE=$1
PROJECT=$2
BASE=$3
TARGET=HEAD
cd "$PROJECT"
mkdir -p wheelhouse/runbooks
for f in "$TEMPLATE"/runbooks/*; do
  b=$(basename "$f")
  if [ ! -e "wheelhouse/runbooks/$b" ]; then
    cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook ARRIVED: $b"
    continue
  fi

  baseline=$(mktemp)
  if git -C "$TEMPLATE" show "${BASE:-unknown}:runbooks/$b" >"$baseline" 2>/dev/null; then
    if diff -q "$f" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
      echo "runbook current: $b"
    elif diff -q "$baseline" "wheelhouse/runbooks/$b" >/dev/null 2>&1; then
      cp -p "$f" "wheelhouse/runbooks/$b"; echo "runbook updated: $b"
    else
      echo "runbook YOURS, merge by hand: $b"
    fi
  else
    echo "runbook baseline unreadable — re-run before hand-merging: $b"
  fi
  rm -f "$baseline"
done
' zsh "$TEMPLATE" "$PROJ" "$BASELINE")
printf '%s\n' "$STEP3_OUT" | grep -q 'baseline unreadable' && fail "zsh step 3 reported baseline unreadable on a healthy baseline: $STEP3_OUT"
for b in PROMOTION.md RUNNING_THE_LOOP.md; do
  printf '%s\n' "$STEP3_OUT" | grep -Eq "runbook updated: $b" || fail "zsh step 3 did not update ${b}: $STEP3_OUT"
done
printf '%s\n' "$STEP3_OUT" | grep -Eq "runbook current: UPGRADE.md" || fail "zsh step 3 did not report byte-equal UPGRADE.md as current: $STEP3_OUT"
pass "zsh step 3 runbook loop reads real baseline and reports byte-equal files current"

REMOTE_SRC="$TMP/reused-cache-source"
CACHE_REUSED="$TMP/reused-cache"
mkdir -p "$REMOTE_SRC"
git -C "$REMOTE_SRC" init -b main >/dev/null
printf 'old\n' > "$REMOTE_SRC/template.txt"
git -C "$REMOTE_SRC" add template.txt
git -C "$REMOTE_SRC" -c user.email=selftest@local -c user.name=selftest commit -q -m old
OLD_COMMIT=$(git -C "$REMOTE_SRC" rev-parse HEAD)
git clone --quiet "$REMOTE_SRC" "$CACHE_REUSED"
printf 'new\n' > "$REMOTE_SRC/template.txt"
git -C "$REMOTE_SRC" add template.txt
git -C "$REMOTE_SRC" -c user.email=selftest@local -c user.name=selftest commit -q -m new
NEW_COMMIT=$(git -C "$REMOTE_SRC" rev-parse HEAD)
STEP1_REUSED_OUT=$(zsh -c '
set -e
TEMPLATE=$1
TARGET=main
git -C "$TEMPLATE" fetch --tags origin
git -C "$TEMPLATE" fetch origin
git -C "$TEMPLATE" rev-parse "${TARGET:-main}" >/dev/null
git -C "$TEMPLATE" checkout --quiet "${TARGET:-main}"
if git -C "$TEMPLATE" rev-parse --verify --quiet "origin/${TARGET:-main}^{commit}" >/dev/null; then
  git -C "$TEMPLATE" merge --ff-only --quiet "origin/${TARGET:-main}" \
    || { echo "STOP: cache branch ${TARGET:-main} could not fast-forward to origin/${TARGET:-main}" >&2; exit 1; }
fi
git -C "$TEMPLATE" rev-parse HEAD
' zsh "$CACHE_REUSED")
[ "$STEP1_REUSED_OUT" = "$NEW_COMMIT" ] || fail "step 1 reused cache stayed stale (old=$OLD_COMMIT new=$NEW_COMMIT got=$STEP1_REUSED_OUT)"
pass "step 1 reused cache fast-forwards local branch to origin target"

STEP6_PROJ="$TMP/step6-stop"
mkdir -p "$STEP6_PROJ/wheelhouse"
cat > "$STEP6_PROJ/wheelhouse/.template-source" <<EOF
source=$REMOTE_SRC
commit=$OLD_COMMIT
path=$CACHE_REUSED
EOF
# Simulate the exact stale-cache condition step 6 must catch: HEAD/TARGET are
# still BASE while origin/main resolves to a newer commit.
git -C "$CACHE_REUSED" checkout --quiet main
git -C "$CACHE_REUSED" reset --hard --quiet "$OLD_COMMIT"
git -C "$CACHE_REUSED" fetch --quiet origin
set +e
STEP6_STOP_OUT=$(cd "$STEP6_PROJ" && TEMPLATE="$CACHE_REUSED" BASE="$OLD_COMMIT" TARGET=main zsh -c '
set -e
NEW_COMMIT=$(git -C "$TEMPLATE" rev-parse HEAD)
if [ "$BASE" != unknown ] && [ "$NEW_COMMIT" = "$BASE" ] \
  && git -C "$TEMPLATE" rev-parse --verify --quiet "origin/${TARGET:-main}^{commit}" >/dev/null \
  && [ "$(git -C "$TEMPLATE" rev-parse "origin/${TARGET:-main}^{commit}")" != "$BASE" ]; then
  echo "STOP: target resolves to the baseline; the cache did not advance to origin/${TARGET:-main}" >&2
  exit 1
fi
sed -i.bak "s|^commit=.*|commit=$NEW_COMMIT|" wheelhouse/.template-source
' 2>&1)
STEP6_STOP_RC=$?
set -e
if [ "$STEP6_STOP_RC" -eq 1 ] && printf '%s\n' "$STEP6_STOP_OUT" | grep -q 'target resolves to the baseline; the cache did not advance'; then
  pass "step 6 stale-cache guard STOPs when origin target differs from BASE"
else
  fail "step 6 stale-cache guard did not STOP (rc=$STEP6_STOP_RC): $STEP6_STOP_OUT"
fi

git -C "$CACHE_REUSED" reset --hard --quiet "$NEW_COMMIT"

GITPROJ="$TMP/gitproj"
mkdir -p "$GITPROJ/wheelhouse/evidence-dir" "$GITPROJ/seats"
git -C "$GITPROJ" init -b main >/dev/null
printf 'x\n' > "$GITPROJ/CLAUDE.md"
printf 'x\n' > "$GITPROJ/.gitignore"
printf 'x\n' > "$GITPROJ/seats/README.md"
printf 'untracked\n' > "$GITPROJ/wheelhouse/evidence-dir/proof.txt"
(
  cd "$GITPROJ"
  git add wheelhouse/ seats/ .gitignore CLAUDE.md
)
if git -C "$GITPROJ" diff --cached --name-only | grep -qx 'wheelhouse/evidence-dir/proof.txt'; then
  pass "step 8 broad wheelhouse add stages untracked files under wheelhouse"
else
  fail "step 8 broad wheelhouse add did not demonstrate untracked wheelhouse staging"
fi

if [ "${WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG:-1}" = 1 ]; then
  BARE_SOURCE="$TMP/template-source.git"
  git clone --quiet --bare "$TEMPLATE" "$BARE_SOURCE"

  INSTALL_NO_LIB="$TMP/install-no-selftest-lib"
  mkdir -p "$INSTALL_NO_LIB/seats" "$INSTALL_NO_LIB/wheelhouse"
  git -C "$INSTALL_NO_LIB" init -b main >/dev/null
  cat > "$INSTALL_NO_LIB/wheelhouse/.template-source" <<EOF
source=$BARE_SOURCE
commit=$BASELINE
path=$TEMPLATE
namespace=fixture
EOF
  cp "$ROOT/seats/upgrade-runbook.selftest.sh" "$INSTALL_NO_LIB/seats/upgrade-runbook.selftest.sh"
  set +e
  NO_LIB_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_NO_LIB/seats/upgrade-runbook.selftest.sh" 2>&1)
  NO_LIB_RC=$?
  set -e
  if [ "$NO_LIB_RC" -eq 127 ] && printf '%s\n' "$NO_LIB_OUT" | grep -q 'selftest-lib.sh'; then
    pass "installed-layout fixture without selftest-lib.sh fails honestly instead of passing"
  else
    fail "installed-layout fixture without selftest-lib.sh was not caught (rc=$NO_LIB_RC): $NO_LIB_OUT"
  fi

  INSTALL="$TMP/install-root"
  mkdir -p "$INSTALL/seats" "$INSTALL/wheelhouse"
  git -C "$INSTALL" init -b main >/dev/null
  cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$BARE_SOURCE
commit=$BASELINE
path=$TEMPLATE
namespace=fixture
EOF
  copy_installed_selftest "$INSTALL/seats"
  INSTALLED_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL/seats/upgrade-runbook.selftest.sh" 2>&1)
  case "$INSTALLED_OUT" in
    *"upgrade-runbook.selftest: PASS"*) pass "installed-layout copied upgrade-runbook selftest uses live path= when it carries commit=" ;;
    *) fail "installed-layout copied upgrade-runbook selftest failed: $INSTALLED_OUT" ;;
  esac

  INSTALL_DEAD_REACHABLE="$TMP/install-dead-reachable"
  mkdir -p "$INSTALL_DEAD_REACHABLE/seats" "$INSTALL_DEAD_REACHABLE/wheelhouse"
  git -C "$INSTALL_DEAD_REACHABLE" init -b main >/dev/null
  cat > "$INSTALL_DEAD_REACHABLE/wheelhouse/.template-source" <<EOF
source=$BARE_SOURCE
commit=$BASELINE
path=$TMP/dead-template-path
namespace=fixture
EOF
  copy_installed_selftest "$INSTALL_DEAD_REACHABLE/seats"
  DEAD_REACHABLE_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_DEAD_REACHABLE/seats/upgrade-runbook.selftest.sh" 2>&1)
  case "$DEAD_REACHABLE_OUT" in
    *"upgrade-runbook.selftest: PASS"*)
      if [ -d "$INSTALL_DEAD_REACHABLE/wheelhouse/.template-cache/$(printf '%s' "$BASELINE" | cut -c1-12)/.git" ] \
        && grep -qxF 'wheelhouse/.template-cache/' "$INSTALL_DEAD_REACHABLE/.gitignore"; then
        pass "installed-layout dead path= fetches commit= from reachable source= into git-excluded install-local cache"
      else
        fail "installed-layout dead path= passed but did not create a git-excluded install-local template cache"
      fi
      ;;
    *) fail "installed-layout dead path= with reachable source= failed: $DEAD_REACHABLE_OUT" ;;
  esac

  INSTALL_DEAD_UNREACHABLE="$TMP/install-dead-unreachable"
  mkdir -p "$INSTALL_DEAD_UNREACHABLE/seats" "$INSTALL_DEAD_UNREACHABLE/wheelhouse"
  git -C "$INSTALL_DEAD_UNREACHABLE" init -b main >/dev/null
  copy_installed_selftest "$INSTALL_DEAD_UNREACHABLE/seats"
  cat > "$INSTALL_DEAD_UNREACHABLE/wheelhouse/.template-source" <<EOF
source=$TMP/not-a-source.git
commit=$BASELINE
path=$TMP/dead-template-path
namespace=fixture
EOF
  set +e
  DEAD_UNREACHABLE_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_DEAD_UNREACHABLE/seats/upgrade-runbook.selftest.sh" 2>&1)
  DEAD_UNREACHABLE_RC=$?
  set -e
  if [ "$DEAD_UNREACHABLE_RC" -eq 42 ] && printf '%s\n' "$DEAD_UNREACHABLE_OUT" | grep -q 'REFUSED template source: source=' && printf '%s\n' "$DEAD_UNREACHABLE_OUT" | grep -q 'unreachable'; then
    pass "installed-layout dead path= with unreachable source= refuses by named source reason"
  else
    fail "installed-layout dead path= with unreachable source= was not legible (rc=$DEAD_UNREACHABLE_RC): $DEAD_UNREACHABLE_OUT"
  fi

  INSTALL_MISSING="$TMP/install-missing-source"
  mkdir -p "$INSTALL_MISSING/seats" "$INSTALL_MISSING/wheelhouse"
  git -C "$INSTALL_MISSING" init -b main >/dev/null
  copy_installed_selftest "$INSTALL_MISSING/seats"
  set +e
  MISSING_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_MISSING/seats/upgrade-runbook.selftest.sh" 2>&1)
  MISSING_RC=$?
  set -e
  if [ "$MISSING_RC" -eq 42 ] && printf '%s\n' "$MISSING_OUT" | grep -q 'wheelhouse/.template-source missing' && printf '%s\n' "$MISSING_OUT" | grep -q 'source= and commit='; then
    pass "installed-layout missing .template-source fails legibly with source= and commit= expectation"
  else
    fail "installed-layout missing .template-source was not legible (rc=$MISSING_RC): $MISSING_OUT"
  fi

  INSTALL_BAD="$TMP/install-bad-source"
  mkdir -p "$INSTALL_BAD/seats" "$INSTALL_BAD/wheelhouse"
  git -C "$INSTALL_BAD" init -b main >/dev/null
  copy_installed_selftest "$INSTALL_BAD/seats"
  printf 'path=%s\ncommit=%s\n' "$TMP/not-a-template-repo" "$BASELINE" > "$INSTALL_BAD/wheelhouse/.template-source"
  set +e
  BAD_OUT=$(WHEELHOUSE_UPGRADE_SELFTEST_INSTALLED_LEG=0 bash "$INSTALL_BAD/seats/upgrade-runbook.selftest.sh" 2>&1)
  BAD_RC=$?
  set -e
  if [ "$BAD_RC" -eq 42 ] && printf '%s\n' "$BAD_OUT" | grep -q 'has no source= line' && printf '%s\n' "$BAD_OUT" | grep -q 'path='; then
    pass "installed-layout bad path= without source= fails legibly before raw git fatal"
  else
    fail "installed-layout bad path= without source= was not legible (rc=$BAD_RC): $BAD_OUT"
  fi
fi


if [ -f "$ROOT/seats/adapter.ts" ] && [ -f "$ROOT/seats/seat-env.sh" ]; then
# Harness-switch upgrade: old rosters without harness fields still mean pi, and
# changing one seat's harness must not touch another seat's running session.
HARNESS_FIX="$TMP/harness-switch"
HARNESS_HOME="$HARNESS_FIX/home"
HARNESS_BIN="$HARNESS_FIX/bin"
HARNESS_PROJ="$HARNESS_FIX/project"
mkdir -p "$HARNESS_HOME" "$HARNESS_BIN" "$HARNESS_PROJ/seats" "$HARNESS_PROJ/contracts" "$HARNESS_PROJ/wheelhouse" "$HARNESS_PROJ/.wheelhouse-worktrees/smoke-a" "$HARNESS_PROJ/.wheelhouse-worktrees/smoke-b"
cp "$ROOT/seats/adapter.ts" "$HARNESS_PROJ/seats/adapter.ts"
cp "$ROOT/seats/harness.ts" "$HARNESS_PROJ/seats/harness.ts"
cp "$ROOT/seats/briefs.ts" "$HARNESS_PROJ/seats/briefs.ts"
cp "$ROOT/seats/host-budget.ts" "$HARNESS_PROJ/seats/host-budget.ts"
cp -R "$ROOT/seats/drivers" "$HARNESS_PROJ/seats/drivers"
printf '# Fleet: Worker\n\nfixture brief for harness switching.\n' > "$HARNESS_PROJ/contracts/WORKER.md"
printf 'namespace=harnessswitch\n' > "$HARNESS_PROJ/wheelhouse/.template-source"
cat > "$HARNESS_PROJ/seats/seats.json" <<'JSON'
{"seats":{"worker-a":{"role":"worker","provider":"anthropic","model":"stub-model","account":{"dir":"~/.pi-seats-harnessswitch/worker-a","authRoute":"oauth"}},"worker-b":{"role":"worker","provider":"anthropic","model":"stub-model","account":{"dir":"~/.pi-seats-harnessswitch/worker-b","authRoute":"oauth"}}}}
JSON
for seat in worker-a worker-b; do mkdir -p "$HARNESS_HOME/.pi-seats-harnessswitch/$seat"; printf '{"stub":true}\n' > "$HARNESS_HOME/.pi-seats-harnessswitch/$seat/auth.json"; done
cat > "$HARNESS_BIN/pi" <<'PISTUB'
#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const dir=process.env.PI_CODING_AGENT_DIR; if(!dir) process.exit(2); fs.mkdirSync(dir,{recursive:true});
const args=process.argv.slice(2); fs.writeFileSync(path.join(dir,'pi-argv.json'),JSON.stringify(args));
if(!args.includes('--mode')) { console.log('OK'); process.exit(0); }
const sessDir=path.join(dir,'sessions'); fs.mkdirSync(sessDir,{recursive:true});
let sessionFile, sessionId; const si=args.indexOf('--session');
if(si>=0){ sessionFile=args[si+1]; sessionId=path.basename(sessionFile,'.jsonl'); fs.appendFileSync(sessionFile, JSON.stringify({type:'resumed'})+'\n'); }
else { sessionId=crypto.randomUUID(); sessionFile=path.join(sessDir,sessionId+'.jsonl'); fs.writeFileSync(sessionFile, JSON.stringify({type:'start'})+'\n'); }
let buf='', streaming=false; const out=o=>process.stdout.write(JSON.stringify(o)+'\n');
function finish(cmd){ fs.appendFileSync(sessionFile, JSON.stringify({type:'prompt',message:cmd.message})+'\n'); out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}]}}); out({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'OK'}],stopReason:'stop'}]}); streaming=false; }
function handle(cmd){ if(cmd.type==='get_state') out({id:cmd.id,type:'response',success:true,data:{isStreaming:streaming,sessionId,sessionFile}}); else if(cmd.type==='prompt'){ streaming=true; out({id:cmd.id,type:'response',success:true}); out({type:'agent_start'}); setTimeout(()=>finish(cmd),50); } else out({id:cmd.id,type:'response',success:false,error:'unknown'}); }
process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(l.trim())handle(JSON.parse(l));}});
process.on('SIGTERM',()=>process.exit(0));
PISTUB
chmod +x "$HARNESS_BIN/pi"
cat > "$HARNESS_BIN/claude" <<'CLAUDESTUB'
#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2); const dir=process.env.CLAUDE_CONFIG_DIR||process.env.HOME; fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'claude-argv.json'),JSON.stringify(args));
if(args.includes('--output-format') && args.includes('json') && !args.includes('stream-json')) { console.log(JSON.stringify({type:'result',subtype:'success',result:'OK',session_id:'probe'})); process.exit(0); }
const session=args.includes('--resume')?args[args.indexOf('--resume')+1]:'claude-session-'+process.pid;
const proj=path.join(dir,'projects','fixture'); fs.mkdirSync(proj,{recursive:true}); fs.appendFileSync(path.join(proj,session+'.jsonl'), JSON.stringify({type:'start'})+'\n');
let buf=''; process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue; const msg=JSON.parse(l).message?.content?.[0]?.text||''; fs.appendFileSync(path.join(proj,session+'.jsonl'), JSON.stringify({type:'prompt',message:msg})+'\n'); console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:'sonnet'})); console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:'OK',session_id:session,num_turns:1})); }});
process.on('SIGTERM',()=>process.exit(0));
CLAUDESTUB
chmod +x "$HARNESS_BIN/claude"
hrun(){ HOUT=$(env HOME="$HARNESS_HOME" PATH="$HARNESS_BIN:$PATH" WHEELHOUSE_RPC_TIMEOUT_MS=5000 bun "$HARNESS_PROJ/seats/adapter.ts" "$@" 2>&1); HRC=$?; }
hstate(){ env HOME="$HARNESS_HOME" node -e "const s=require(process.argv[1]).seats[process.argv[2]]||{}; process.stdout.write(String(s[process.argv[3]]??''));" "$HARNESS_PROJ/seats/state.json" "$1" "$2"; }
# Pre-field roster: absent harness means pi and needs no edit.
hrun probe worker-b; [ "$HRC" -eq 0 ] || fail "pre-field roster without harness failed pi probe: $HOUT"
hrun spawn worker-a; [ "$HRC" -eq 0 ] || fail "worker-a initial pi spawn failed: $HOUT"
hrun spawn worker-b; [ "$HRC" -eq 0 ] || fail "worker-b initial pi spawn failed: $HOUT"
B_PID_BEFORE=$(hstate worker-b pid); B_SESS_BEFORE=$(hstate worker-b sessionFile)
hrun stop worker-a; [ "$HRC" -eq 0 ] || fail "stop switched seat before harness edit failed: $HOUT"
env HOME="$HARNESS_HOME" PROJ="$HARNESS_PROJ" node -e 'const fs=require("fs"); const p=process.env.PROJ+"/seats/seats.json"; const r=require(p); const s=r.seats["worker-a"]; s.harness="claude-code"; s.model="sonnet"; s.provider="anthropic"; s.allowedTools="Bash(printf *)"; s.account.authRoute="oauth"; fs.writeFileSync(p, JSON.stringify(r,null,2)+"\n")'
printf '{"loggedIn":true}\n' > "$HARNESS_HOME/.pi-seats-harnessswitch/worker-a/.claude.json"
SEAT_ENV_OUT=$(env HOME="$HARNESS_HOME" PATH="$HARNESS_BIN:$PATH" "$ROOT/seats/seat-env.sh" harnessswitch worker-a "$HARNESS_PROJ")
printf '%s\n' "$SEAT_ENV_OUT" | grep -q 'CLAUDE_CONFIG_DIR' || fail "seat-env did not print claude binding after switch: $SEAT_ENV_OUT"
hrun probe worker-a; [ "$HRC" -eq 0 ] && [ "$HOUT" = OK ] || fail "claude-code binding probe failed: $HOUT"
hrun reset worker-a; [ "$HRC" -eq 0 ] || fail "claude-code reset failed: $HOUT"
hrun dispatch worker-a smoke-a 'Smoke check after harness switch: reply OK and stop.'; [ "$HRC" -eq 0 ] || fail "claude-code smoke dispatch failed: $HOUT"
for i in $(seq 1 50); do grep -q '"text":"OK"' "$HARNESS_PROJ/seats/logs/worker-a.jsonl" && break; sleep 0.1; done
grep -q '"text":"OK"' "$HARNESS_PROJ/seats/logs/worker-a.jsonl" || fail "claude-code smoke dispatch did not complete OK"
[ "$(hstate worker-b pid)" = "$B_PID_BEFORE" ] && [ "$(hstate worker-b sessionFile)" = "$B_SESS_BEFORE" ] || fail "switching worker-a touched worker-b state/session"
# Switch back to pi, again without touching worker-b.
hrun stop worker-a; [ "$HRC" -eq 0 ] || fail "stop claude-code seat before switching back failed: $HOUT"
env HOME="$HARNESS_HOME" PROJ="$HARNESS_PROJ" node -e 'const fs=require("fs"); const p=process.env.PROJ+"/seats/seats.json"; const r=require(p); const s=r.seats["worker-a"]; s.harness="pi"; s.model="stub-model"; s.provider="anthropic"; delete s.allowedTools; s.account.authRoute="oauth"; fs.writeFileSync(p, JSON.stringify(r,null,2)+"\n")'
SEAT_ENV_OUT=$(env HOME="$HARNESS_HOME" PATH="$HARNESS_BIN:$PATH" "$ROOT/seats/seat-env.sh" harnessswitch worker-a "$HARNESS_PROJ")
printf '%s\n' "$SEAT_ENV_OUT" | grep -q 'PI_CODING_AGENT_DIR' || fail "seat-env did not print pi binding after switch back: $SEAT_ENV_OUT"
hrun probe worker-a; [ "$HRC" -eq 0 ] || fail "pi binding probe after switch back failed: $HOUT"
hrun reset worker-a; [ "$HRC" -eq 0 ] || fail "pi reset after switch back failed: $HOUT"
hrun dispatch worker-a smoke-b 'Smoke check after switching back to pi: reply OK and stop.'; [ "$HRC" -eq 0 ] || fail "pi smoke dispatch after switch back failed: $HOUT"
[ "$(hstate worker-b pid)" = "$B_PID_BEFORE" ] && [ "$(hstate worker-b sessionFile)" = "$B_SESS_BEFORE" ] || fail "switching worker-a back touched worker-b state/session"
pass "harness switch pi -> claude-code -> pi leaves pre-field and untouched seats intact"

else
  pass "installed-layout harness-switch scratch leg skipped until copied seats machinery is present"
fi

echo "upgrade-runbook.selftest: PASS ($PASS checks)"
