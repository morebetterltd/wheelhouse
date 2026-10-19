#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-report-issues.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
PROJ="$FIX/project"; mkdir -p "$PROJ/seats" "$PROJ/wheelhouse" "$FIX/bin" "$FIX/nogh"; selftest_copy_seat_runtime "$PROJ" "$HERE"
chmod +x "$PROJ/seats/report-issues.ts" "$PROJ/seats/evidence-scrub.sh"
cat > "$PROJ/seats/seats.json" <<'JSON'
{"commander":{"external":true},"seats":{"worker-a":{"role":"worker"}}}
JSON
cat > "$FIX/bin/bd" <<'BD'
#!/usr/bin/env node
const fs=require('fs'); const log=process.env.CALLS_LOG; fs.appendFileSync(log, 'bd '+process.argv.slice(2).join(' ')+'\n');
const tasks=JSON.parse(fs.readFileSync(process.env.BD_TASKS,'utf8')); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='list') { const label=args[args.indexOf('--label')+1], status=args[args.indexOf('--status')+1]; console.log(JSON.stringify(tasks.filter(t=>t.labels.includes(label)&&t.status===status))); process.exit(0); }
if(cmd==='show') { console.log(JSON.stringify([tasks.find(t=>t.id===args[1])||{}])); process.exit(0); }
if(cmd==='comments') { console.log(process.env.BD_COMMENTS||'[]'); process.exit(0); }
if(cmd==='update') { process.exit(0); }
process.exit(1);
BD
chmod +x "$FIX/bin/bd"
cat > "$FIX/bin/gh" <<'GH'
#!/usr/bin/env node
const fs=require('fs'); const args=process.argv.slice(2); const log=process.env.CALLS_LOG; fs.appendFileSync(log, 'gh '+args.join(' ')+'\n');
if(args[0]==='--version') { if(process.env.GH_VERSION_FAIL==='1') process.exit(1); console.log('gh version fixture'); process.exit(0); }
if(args[0]==='auth'&&args[1]==='status') { process.exit(process.env.GH_AUTH_FAIL==='1'?1:0); }
if(args[0]==='issue'&&args[1]==='list') { console.log(fs.existsSync(process.env.GH_ISSUES||'')?fs.readFileSync(process.env.GH_ISSUES,'utf8'):'[]'); process.exit(0); }
if(args[0]==='issue'&&args[1]==='create') { const f=args[args.indexOf('--body-file')+1]; fs.copyFileSync(f, process.env.GH_BODY_CAPTURE); console.log('https://github.com/fixture/repo/issues/7'); process.exit(0); }
process.exit(1);
GH
chmod +x "$FIX/bin/gh"
cp "$FIX/bin/bd" "$FIX/nogh/bd"
RUN_PATH="$FIX/bin:$PATH"; NOGH_PATH="$FIX/nogh:/usr/bin:/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/v22.21.0/bin"
TASKS="$FIX/tasks.json"; ISSUES="$FIX/issues.json"; BODY="$FIX/body.md"; CALLS="$FIX/calls.log"
base_env(){ : > "$CALLS"; printf '[]' > "$ISSUES"; export WHEELHOUSE_REPORT_ROOT="$PROJ" BD_TASKS="$TASKS" GH_ISSUES="$ISSUES" GH_BODY_CAPTURE="$BODY" CALLS_LOG="$CALLS" HOME="/home/wheelhouse-report-fixture"; }
write_tasks(){ printf '%s\n' "$1" > "$TASKS"; }
runpub(){ (cd "$PROJ" && PATH="$RUN_PATH" bun seats/report-issues.ts publish "$@") > "$FIX/out" 2>&1; RC=$?; OUT="$(cat "$FIX/out")"; }
# 1 off -> no calls
base_env; printf 'source=https://github.com/fixture/repo.git\n' > "$PROJ/wheelhouse/.template-source"; write_tasks '[]'; runpub
[ $RC -eq 0 ] && grep -q 'report-issues: off' "$FIX/out" && [ ! -s "$CALLS" ] && pass 'github-report absent -> off and no calls' || fail "off leg rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 2 on no gh
base_env; printf 'github-report=on\nsource=https://github.com/fixture/repo.git\n' > "$PROJ/wheelhouse/.template-source"; (cd "$PROJ" && PATH="$NOGH_PATH" WHEELHOUSE_REPORT_ROOT="$PROJ" BD_TASKS="$TASKS" CALLS_LOG="$CALLS" bun seats/report-issues.ts publish > "$FIX/out" 2>&1); RC=$?; OUT="$(cat "$FIX/out")"
[ $RC -eq 0 ] && grep -q 'gh is not installed' "$FIX/out" && ! grep -q '^bd ' "$CALLS" && pass 'github-report=on, no gh -> skipped no bd' || fail "no-gh rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 3 dry run
base_env; write_tasks '[{"id":"t1","title":"Report tool issue","description":"body","status":"open","labels":["template-report"]}]'; runpub
[ $RC -eq 0 ] && grep -q 'would file t1 -> fixture/repo: Report tool issue' "$FIX/out" && grep -q 'gh issue list' "$CALLS" && [ "$(grep -c ' issue create ' "$CALLS" || true)" = 0 ] && ! grep -q 'bd update' "$CALLS" && pass 'dry-run lists and creates nothing' || fail "dry rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 4 yes creates scrubbed body + marker + external ref
base_env; write_tasks '[{"id":"t1","title":"Report tool issue","description":"home /home/wheelhouse-report-fixture path","status":"open","labels":["template-report"]}]'; runpub --yes
[ $RC -eq 0 ] && grep -q 'filed t1 https://github.com/fixture/repo/issues/7' "$FIX/out" && [ "$(grep -c ' issue create ' "$CALLS")" = 1 ] && grep -q '<!-- wheelhouse-report namespace=project bead=t1 -->' "$BODY" && grep -q '\[home\]' "$BODY" && grep -q 'bd update t1 --external-ref https://github.com/fixture/repo/issues/7' "$CALLS" && pass '--yes creates once, scrubs body, writes external-ref' || fail "yes rc=$RC out=$OUT calls=$(cat "$CALLS") body=$(cat "$BODY" 2>/dev/null)"
# 5 marker dedupe links no create
base_env; printf '[{"title":"Other","body":"%s","url":"https://github.com/fixture/repo/issues/7"}]\n' '<!-- wheelhouse-report namespace=project bead=t1 -->' > "$ISSUES"; write_tasks '[{"id":"t1","title":"Report tool issue","description":"body","status":"open","labels":["template-report"]}]'; runpub --yes
[ $RC -eq 0 ] && grep -q 'linked t1 https://github.com/fixture/repo/issues/7' "$FIX/out" && [ "$(grep -c ' issue create ' "$CALLS" || true)" = 0 ] && [ "$(grep -c 'bd update t1 --external-ref' "$CALLS")" = 1 ] && pass 'marker dedupe links without create' || fail "dedupe rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 6 existing github external ref skip, no gh
base_env; write_tasks '[{"id":"t2","title":"Done","description":"body","status":"open","labels":["template-report"],"external_ref":"https://github.com/x/y/issues/1"}]'; runpub --yes
[ $RC -eq 0 ] && grep -q 'skip t2: external-ref already' "$FIX/out" && ! grep -q '^gh issue' "$CALLS" && pass 'existing github external-ref skipped' || fail "xref rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 7 credential-shaped body refuses, no secret stdout
base_env; SECRET="gh""p_$(printf 'abcdefghijklmnopqrstuvwxyz123456')"; write_tasks "[{\"id\":\"t3\",\"title\":\"Secret\",\"description\":\"$SECRET\",\"status\":\"open\",\"labels\":[\"template-report\"]}]"; runpub --yes
[ $RC -eq 2 ] && grep -q 'skip t3: credential-shaped text in body' "$FIX/out" && [ "$(grep -c ' issue create ' "$CALLS" || true)" = 0 ] && ! grep -q "$SECRET" "$FIX/out" && pass 'credential-shaped body refused without leaking match' || fail "cred rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 8 seat actor STOP before calls
base_env; BEADS_ACTOR=worker-a runpub --yes
[ $RC -eq 2 ] && grep -q 'seats do not publish' "$FIX/out" && [ ! -s "$CALLS" ] && pass 'rostered BEADS_ACTOR stops before calls' || fail "actor rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 9 routes by label
base_env; printf 'github-report=on\ngithub-report-routes=template-report:fixture/repo,bug:fixture/product\n' > "$PROJ/wheelhouse/.template-source"; write_tasks '[{"id":"bug1","title":"Bug","description":"body","status":"open","labels":["bug"]},{"id":"other1","title":"Other","description":"body","status":"open","labels":["other"]}]'; runpub
[ $RC -eq 0 ] && grep -q 'would file bug1 -> fixture/product: Bug' "$FIX/out" && ! grep -q 'other1' "$FIX/out" && pass 'routes select candidates by label' || fail "routes rc=$RC out=$OUT"
printf 'github-report=on\nsource=https://github.com/fixture/repo.git\n' > "$PROJ/wheelhouse/.template-source"
# 10 title dedupe
base_env; printf '[{"title":"  report   tool ISSUE ","body":"no marker","url":"https://github.com/fixture/repo/issues/9"}]\n' > "$ISSUES"; write_tasks '[{"id":"t1","title":"Report tool issue","description":"body","status":"open","labels":["template-report"]}]'; runpub --yes
[ $RC -eq 0 ] && grep -q 'linked t1 https://github.com/fixture/repo/issues/9' "$FIX/out" && [ "$(grep -c ' issue create ' "$CALLS" || true)" = 0 ] && pass 'normalized-title dedupe links without create' || fail "title rc=$RC out=$OUT calls=$(cat "$CALLS")"
# 11 default route and bad source
base_env; printf 'github-report=on\nsource=git@github.com:owner/name.git\n' > "$PROJ/wheelhouse/.template-source"; (cd "$PROJ" && PATH="$RUN_PATH" bun seats/report-issues.ts status > "$FIX/out" 2>&1); RC=$?; ok1=0; [ $RC -eq 0 ] && grep -q 'routes=template-report->owner/name' "$FIX/out" && ok1=1
printf 'github-report=on\nsource=https://example.invalid/nope.git\n' > "$PROJ/wheelhouse/.template-source"; runpub; [ "$ok1" = 1 ] && [ $RC -eq 2 ] && grep -q 'source= is not a github.com' "$FIX/out" && pass 'default route from github source and bad source STOP' || fail "default/bad rc=$RC out=$OUT status=$(cat "$FIX/out")"

if [ "$FAIL" -eq 0 ]; then echo "report-issues.selftest: PASS ($PASS legs)"; exit 0; fi
echo "report-issues.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
