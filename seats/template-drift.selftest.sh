#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-template-drift.XXXXXX")" || exit 2
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; exit 1; }
SCRIPT="$HERE/template-drift.sh"
TEMPLATE="$FIX/template"; INSTALL="$FIX/install"
mkdir -p "$TEMPLATE/seats/transports" "$TEMPLATE/runbooks" "$TEMPLATE/wheelhouse/crew" "$INSTALL/wheelhouse"
( cd "$TEMPLATE" && git init -q -b main && git config user.email selftest@example.invalid && git config user.name selftest )
cat > "$TEMPLATE/seats/herald.ts" <<'EOF'
export const herald = 'template';
EOF
cat > "$TEMPLATE/seats/alerts.ts" <<'EOF'
export const alerts = 'template';
EOF
cat > "$TEMPLATE/seats/desk-watchdog.sh" <<'EOF'
#!/usr/bin/env bash
echo template
EOF
cat > "$TEMPLATE/runbooks/UPGRADE.md" <<'EOF'
# Upgrade

template runbook
EOF
cat > "$TEMPLATE/wheelhouse/crew/WORKER.md" <<'EOF'
# Crew: Worker

template contract
## This project

template project half
EOF
( cd "$TEMPLATE" && git add . && git commit -q -m one )
COMMIT1="$(git -C "$TEMPLATE" rev-parse HEAD)"
printf 'change\n' > "$TEMPLATE/seats/new-in-main.ts"
( cd "$TEMPLATE" && git add . && git commit -q -m two )
COMMIT2="$(git -C "$TEMPLATE" rev-parse HEAD)"
mkdir -p "$INSTALL"
( cd "$TEMPLATE" && git archive "$COMMIT1" | tar -x -C "$INSTALL" )
mkdir -p "$INSTALL/wheelhouse"
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$TEMPLATE
commit=$COMMIT1
path=$TEMPLATE
EOF
run(){ RC=0; OUT="$($SCRIPT "$INSTALL" 2>&1)" || RC=$?; }
run_json(){ RC=0; OUT="$($SCRIPT --json "$INSTALL" 2>&1)" || RC=$?; }
run; [ $RC -eq 1 ] && grep -q "template main is 1 commits ahead of $COMMIT1" <<<"$OUT" && pass 'ahead-by 1 is reported when template main has advanced' || fail "ahead-by failed rc=$RC out=$OUT"
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$TEMPLATE
commit=$COMMIT2
path=$TEMPLATE
EOF
( cd "$TEMPLATE" && git archive "$COMMIT2" | tar -x -C "$INSTALL" )
run; [ $RC -eq 0 ] && [ -z "$OUT" ] && pass 'clean install exits 0 with no findings' || fail "clean failed rc=$RC out=$OUT"
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$FIX/unreachable-source-must-not-be-used
commit=$COMMIT2
path=$TEMPLATE
EOF
run; [ $RC -eq 0 ] && [ -z "$OUT" ] && pass 'path containing commit is sufficient; unreachable source is not fetched'
printf "export const herald = 'install edit';\n" > "$INSTALL/seats/herald.ts"
run; [ $RC -eq 1 ] && grep -q '^MODIFIED seats/herald.ts$' <<<"$OUT" && pass 'edited template seat file reports MODIFIED' || fail "modified failed rc=$RC out=$OUT"
printf 'local tool\n' > "$INSTALL/seats/commander-watch.ts"
run; [ $RC -eq 1 ] && grep -q '^LOCAL-ONLY seats/commander-watch.ts$' <<<"$OUT" && pass 'install-only seat file reports LOCAL-ONLY' || fail "local-only failed rc=$RC out=$OUT"
rm -f "$INSTALL/seats/alerts.ts"
run; [ $RC -eq 1 ] && grep -q '^MISSING seats/alerts.ts$' <<<"$OUT" && pass 'deleted template seat file reports MISSING' || fail "missing failed rc=$RC out=$OUT"
# Contract split: project half local edits are ignored, contract half edits are drift.
git -C "$TEMPLATE" archive "$COMMIT2" wheelhouse/crew/WORKER.md | tar -x -C "$INSTALL"
cat > "$INSTALL/wheelhouse/crew/WORKER.md" <<'EOF'
# Crew: Worker

template contract
## This project

local project half differs only here
EOF
rm -f "$INSTALL/seats/commander-watch.ts"; git -C "$TEMPLATE" show "$COMMIT2:seats/alerts.ts" > "$INSTALL/seats/alerts.ts"; git -C "$TEMPLATE" show "$COMMIT2:seats/herald.ts" > "$INSTALL/seats/herald.ts"
run; [ $RC -eq 0 ] && [ -z "$OUT" ] && pass 'contract split ignores project-half-only changes' || fail "project-half split failed rc=$RC out=$OUT"
cat > "$INSTALL/wheelhouse/crew/WORKER.md" <<'EOF'
# Crew: Worker

install contract changed
## This project

local project half
EOF
run; [ $RC -eq 1 ] && grep -q '^MODIFIED wheelhouse/crew/WORKER.md$' <<<"$OUT" && pass 'contract-half changes report MODIFIED' || fail "contract-half failed rc=$RC out=$OUT"
run_json; [ $RC -eq 1 ] && python3 - <<'PY' <<<"$OUT"
import json,sys
j=json.load(sys.stdin)
assert 'wheelhouse/crew/WORKER.md' in j['modified']
assert isinstance(j['localOnly'], list) and isinstance(j['missing'], list)
assert j['comparedAgainst']
PY
[ $? -eq 0 ] && pass '--json shape includes arrays and comparedAgainst' || fail "json shape failed rc=$RC out=$OUT"
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$FIX/no-such-remote
commit=$COMMIT2
path=$FIX/no-such-path
EOF
run; [ $RC -eq 3 ] && grep -q '^DRIFT: cannot compare' <<<"$OUT" && pass 'unreachable path and source exits 3 without false clean' || fail "unreachable failed rc=$RC out=$OUT"
# Canary: if the split rule is removed, the project-half-only leg reports drift.
BROKEN="$FIX/template-drift-nosplit.sh"
cp "$SCRIPT" "$BROKEN"
python3 - "$BROKEN" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
s=s.replace("split_contract() { awk 'BEGIN{p=1} /^## This project$/{p=0} p{print}' \"$1\"; }", 'split_contract() { cat "$1"; }')
s=s.replace('if is_contract_half "$p"; then git -C "$REPO" show "$commit:$p" 2>/dev/null | awk \'BEGIN{p=1} /^## This project$/{p=0} p{print}\'', 'if is_contract_half "$p"; then git -C "$REPO" show "$commit:$p" 2>/dev/null')
p.write_text(s)
PY
chmod +x "$BROKEN"
cat > "$INSTALL/wheelhouse/.template-source" <<EOF
source=$TEMPLATE
commit=$COMMIT2
path=$TEMPLATE
EOF
git -C "$TEMPLATE" archive "$COMMIT2" | tar -x -C "$INSTALL"
cat > "$INSTALL/wheelhouse/crew/WORKER.md" <<'EOF'
# Crew: Worker

template contract
## This project

local project half differs only here
EOF
RC=0; OUT="$($BROKEN "$INSTALL" 2>&1)" || RC=$?
[ $RC -eq 1 ] && grep -q '^MODIFIED wheelhouse/crew/WORKER.md$' <<<"$OUT" && pass 'canary: removing split rule makes project-half leg fail' || fail "canary failed rc=$RC out=$OUT"
echo 'template-drift.selftest.sh works on this machine.'
