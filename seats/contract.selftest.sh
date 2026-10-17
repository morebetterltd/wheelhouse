#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
CONTRACT="${1:-$HERE/contract.ts}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-contract.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
export GIT_CEILING_DIRECTORIES="$(dirname "$FIX")"
git -C "$FIX" init -q || exit 2
[ "$(git -C "$FIX" rev-parse --show-toplevel)" = "$FIX" ] || { echo 'STOP: contract fixture git root escaped'; exit 2; }
export GIT_CEILING_DIRECTORIES="$FIX"
FAILED=0
pass(){ echo "PASS $*"; }
fail(){ echo "FAIL $*"; FAILED=$((FAILED+1)); }
leg(){
  local name="$1" expected="$2" error="$3" out rc=0
  out="$(bun "$CONTRACT" check --file "$HERE/fixtures/contracts/$name.md" 2>&1)" || rc=$?
  if [ "$rc" = "$expected" ] && { [ -z "$error" ] || grep -Fq "$error" <<<"$out"; }; then pass "$name (exit $rc)"; else fail "$name expected exit $expected + '$error', got $rc: $out"; fi
}
# Intent-only linter never reads the graph. All fixtures are owned by this run.
mkdir -p "$FIX/intents"
intent_leg(){
  local name="$1" text="$2" expected="$3" error="$4" rc=0
  printf '%s' "$text" > "$FIX/intents/$name.md"
  bun "$CONTRACT" lint-intent --file "$FIX/intents/$name.md" > "$FIX/intents/$name.out" 2> "$FIX/intents/$name.err" || rc=$?
  if [ "$rc" = "$expected" ] && { [ -z "$error" ] || grep -Fq "$error" "$FIX/intents/$name.err"; } && [ ! -s "$FIX/intents/$name.out" ] && { { [ "$expected" = 0 ] && [ ! -s "$FIX/intents/$name.err" ]; } || { [ "$expected" != 0 ] && [ "$(wc -l < "$FIX/intents/$name.err" | tr -d ' ')" = 1 ]; }; }; then
    pass "lint-intent $name (exit $rc)"
  else fail "lint-intent $name expected exit $expected + '$error', got $rc: $(<"$FIX/intents/$name.err")"; fi
}
intent_leg paragraph $'Intent:\nMake the shared list easier to trust, so people avoid repeated shopping.\n' 0 ''
intent_leg three-paragraphs $'Intent:\nMake the shared list easier to trust.\n\nPeople need a clear record of what is bought.\n\nThis avoids repeated shopping.\n' 0 ''
intent_leg crlf $'Intent:\r\nMake the list clear so people can coordinate.\r\n' 0 ''
intent_leg no-header $'Make the list clear.\n' 2 'line 1: expected the literal Intent: header'
intent_leg leading-blank $'\nIntent:\nMake the list clear.\n' 2 'line 1: expected the literal Intent: header'
intent_leg empty $'Intent:\n\n \t\n' 2 'line 2: Intent: needs at least one non-blank paragraph'
intent_leg numbered-dot $'Intent:\nMake the list clear.\n1. edit the file\n' 2 'line 3: numbered build step: 1. edit the file'
intent_leg numbered-paren $'Intent:\nMake the list clear.\n  2) rebuild it\n' 2 'line 3: numbered build step:'
intent_leg outcome $'Intent:\nMake the list clear.\n  - O2 It is clear\n' 2 'line 3: outcome row:'
intent_leg consumer $'Intent:\nMake the list clear.\n  consumer: person-reading\n' 2 'line 3: outcome field:'
intent_leg surface $'Intent:\nMake the list clear.\n  surface: the list\n' 2 'line 3: outcome field:'
intent_leg check $'Intent:\nMake the list clear.\n\tcheck: read\n' 2 'line 3: outcome field:'
intent_leg outcomes $'Intent:\nMake the list clear.\nOutcomes:\n' 2 'line 3: Outcomes: header is not part of an intent:'
intent_leg first-offense $'Intent:\nMake the list clear.\n1. edit the file\n\nconsumer: someone\n' 2 'line 3: numbered build step: 1. edit the file'
intent_leg quoted-header $'> Intent:\nMake the list clear.\n' 2 'line 1: expected the literal Intent: header'
intent_leg prose-number $'Intent:\nMake the list clear for 2 households, so people can coordinate.\n' 0 ''
RC=0
bun "$CONTRACT" lint-intent --file "$FIX/intents/missing.md" > "$FIX/intents/missing.out" 2> "$FIX/intents/missing.err" || RC=$?
[ "$RC" = 2 ] && grep -Fq 'lint-intent: cannot read file:' "$FIX/intents/missing.err" && pass 'lint-intent unreadable (exit 2)' || fail "lint-intent unreadable rc=$RC"
if [ "${WHEELHOUSE_INTENT_LINT_ONLY:-0}" = 1 ]; then
  [ "$FAILED" = 0 ] && { echo 'intent lint selftest: PASS'; exit 0; }
  echo "intent lint selftest: FAIL ($FAILED failures)"; exit 1
fi

leg valid 0 ''
leg no-intent 2 'contract: Intent: missing'
leg empty-intent 2 'contract: Intent: must contain'
leg no-outcomes 2 'contract: Outcomes: missing'
leg outcome-no-surface 2 'O1: surface: missing'
leg outcome-no-consumer 2 'O1: consumer: missing'
leg group-check-mismatch 2 'O1: check: person-on-surface requires walk'
leg duplicate-ids 2 'O1: id: duplicate'
leg bad-group-token 2 'O1: consumer: unknown group "robot"'

# Real bd output, not a guessed JSON envelope: isolated scratch graph.
eval "$(selftest_scratch_graph "$FIX/graph")" || exit 2
[ "$(git -C "$FIX/graph" rev-parse --show-toplevel)" = "$FIX/graph" ] || { echo 'STOP: contract graph git root escaped'; exit 2; }
VALID_JSON="$(bd create 'Valid contract fixture' --body-file "$HERE/fixtures/contracts/valid.md" --json)" || exit 2
INVALID_JSON="$(bd create 'Invalid contract fixture' --body-file "$HERE/fixtures/contracts/outcome-no-surface.md" --json)" || exit 2
VALID_ID="$(printf '%s' "$VALID_JSON" | bun -e 'import fs from "node:fs";process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).id)')"
INVALID_ID="$(printf '%s' "$INVALID_JSON" | bun -e 'import fs from "node:fs";process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).id)')"
[ -n "$VALID_ID" ] && [ -n "$INVALID_ID" ] || exit 2
bd update "$INVALID_ID" --status in_progress >/dev/null || exit 2
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE WHEELHOUSE_CONTRACT_ROOT="$FIX/graph" bun "$CONTRACT" audit 2>&1)" || RC=$?
if [ "$RC" = 1 ] && grep -Fq "$INVALID_ID: O1: surface: missing" <<<"$OUT" && ! grep -Fq "$VALID_ID" <<<"$OUT" && [ "$(wc -l <<<"$OUT" | tr -d ' ')" = 1 ]; then pass "audit (exit 1; invalid id printed once, valid id absent)"; else fail "audit rc=$RC: $OUT"; fi
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE WHEELHOUSE_CONTRACT_ROOT="$FIX/graph" bun "$CONTRACT" check "$VALID_ID" 2>&1)" || RC=$?
[ "$RC" = 0 ] && pass 'read real bd show JSON from overridden root' || fail "bd JSON check rc=$RC: $OUT"

mkdir -p "$FIX/bin"
printf '#!/bin/sh\necho fixture-bd-unavailable >&2\nexit 7\n' > "$FIX/bin/bd"; chmod +x "$FIX/bin/bd"
RC=0; OUT="$(env -u WHEELHOUSE_CONTRACT_FIXTURE WHEELHOUSE_SKIP_BD=1 bun "$CONTRACT" check unreadable-bead 2>&1)" || RC=$?
[ "$RC" = 3 ] && grep -Fq 'unreadable-bead: contract: unreadable:' <<<"$OUT" && pass 'skip-bd without fixture refuses unreadable (exit 3)' || fail "missing fixture rc=$RC: $OUT"
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE PATH="$FIX/bin:$PATH" bun "$CONTRACT" check unreadable-bead 2>&1)" || RC=$?
[ "$RC" = 3 ] && grep -Fq 'fixture-bd-unavailable' <<<"$OUT" && pass 'failed bd read refuses unreadable (exit 3)' || fail "bd failure rc=$RC: $OUT"
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD WHEELHOUSE_CONTRACT_FIXTURE="$HERE/fixtures/contracts/valid.md" PATH="$FIX/bin:$PATH" bun "$CONTRACT" check fallback-bead 2>&1)" || RC=$?
[ "$RC" = 0 ] && pass 'failed bd read uses explicit fixture (exit 0)' || fail "fallback fixture rc=$RC: $OUT"
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD PATH="$FIX/bin:$PATH" bun "$CONTRACT" audit 2>&1)" || RC=$?
[ "$RC" = 3 ] && grep -Fq 'audit: bd list open unreadable:' <<<"$OUT" && pass 'unreadable audit is exit 3, never a clean empty graph' || fail "audit failure rc=$RC: $OUT"

# Pure shape flags remain opt-in; dispatch/review's shared gate requires Signal.
RC=0; OUT="$(CONTRACT="$CONTRACT" VALID="$HERE/fixtures/contracts/valid.md" bun -e '
import fs from "node:fs";
const m=await import(process.env.CONTRACT);
const p=m.parseContract(fs.readFileSync(process.env.VALID,"utf8"));
if(p.trace!=="contract parser fixture"||p.integration!=="fleet/fixture-goal"||p.signal!=="isa-gap: K1"||p.skills!=="intent@1.0.0 outcomes@1.0.0"||p.outcomes.length!==3)throw Error("parsed fields lost");
p.signal="";p.skills="";
if(m.validateContract(p).length)throw Error("default flags enforced siblings");
if(!m.validateContract(p,{requireSkills:true}).some(e=>e.includes("Skills:")))throw Error("requireSkills ignored");
if(!m.validateContract(p,{requireSignal:true}).some(e=>e.includes("Signal:")))throw Error("requireSignal ignored");
console.log("parsed fields + opt-in flags");' 2>&1)" || RC=$?
[ "$RC" = 0 ] && pass 'parse fields and optional Skills/Signal flags' || fail "API rc=$RC: $OUT"

# K4's ledger shape is produced by the actual owner CLI, not a guessed row.
# Only the random signal id is normalized to the task's deterministic sig-abcd.
POSTED_ID="$(WHEELHOUSE_INTAKE_ROOT="$FIX/graph" bun "$HERE/intake.ts" post --kind finding --source selftest --title 'Fixture signal' --text 'A trace can read a fixture signal')" || exit 2
case "$POSTED_ID" in sig-????) ;; *) echo 'STOP: intake post did not return an id'; exit 2;; esac
sed "s/$POSTED_ID/sig-abcd/g" "$FIX/graph/seats/intake.jsonl" > "$FIX/posted.jsonl"
cp -f "$FIX/posted.jsonl" "$FIX/graph/seats/intake.jsonl"
CONTRACT="$CONTRACT" HERE="$HERE" FIX="$FIX" node - <<'JS'
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert');
const {CONTRACT,HERE,FIX}=process.env,root=path.join(FIX,'graph'),ledger=path.join(root,'seats/intake.jsonl');
const valid=fs.readFileSync(path.join(HERE,'fixtures/contracts/valid.md'),'utf8');
const env={...process.env,WHEELHOUSE_CONTRACT_ROOT:root};delete env.WHEELHOUSE_SKIP_BD;delete env.WHEELHOUSE_CONTRACT_FIXTURE;delete env.WHEELHOUSE_INTAKE_FIXTURE;
let failed=0,passed=0;
function test(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
function run(args,extra={}){return cp.spawnSync('bun',[CONTRACT,...args],{env:{...env,...extra},encoding:'utf8'});}
function body(signal,repo){return (repo===undefined?'':`Repo: ${repo}\n`)+valid.replace(/^Signal: .*\n/m,signal===null?'':`Signal: ${signal}\n`);}
function fixture(signal,repo){const file=path.join(FIX,'signal-contract.md');fs.writeFileSync(file,body(signal,repo));return file;}
function check(signal,extra={}){return run(['check','signal-fixture'],{WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_CONTRACT_FIXTURE:fixture(signal),WHEELHOUSE_INTAKE_FIXTURE:ledger,...extra});}
function refuses(r,needle){assert.equal(r.status,2);assert(r.stderr.includes(needle),r.stderr);assert.equal(r.stdout,'');}
function git(repo,args){assert.equal(cp.execFileSync('git',['-C',repo,'rev-parse','--show-toplevel'],{env,encoding:'utf8'}).trim(),fs.realpathSync(repo));return cp.execFileSync('git',['-C',repo,'-c','user.email=selftest@local','-c','user.name=selftest','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function init(repo){fs.mkdirSync(repo,{recursive:true});cp.execFileSync('git',['-C',repo,'init','-q','-b','main'],{env});assert.equal(git(repo,['rev-parse','--show-toplevel']),fs.realpathSync(repo));}
function create(text){const r=cp.spawnSync('bd',['create','Trace fixture','--description',text,'--json'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).id;}
function update(id,text){const r=cp.spawnSync('bd',['update',id,'--description',text],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
test('Signal missing refused naming the bead at the default shared gate',()=>refuses(check(null),'signal-fixture: contract: Signal: missing'));
test('Signal unknown posted id refused naming sig-zzzz',()=>refuses(check('sig-zzzz'),'sig-zzzz is not a posted intake event'));
test('Signal posted sig-abcd accepted',()=>{const r=check('sig-abcd');assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');});
for(const signal of ['isa-gap: K4','install-procedure'])test('Signal '+signal+' accepted',()=>{const r=check(signal);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');});
for(const signal of ['garbage','isa-gap: k4','isa-gap: K4 extra','sig-'])test('Signal bad form '+signal+' refused',()=>refuses(check(signal),'Signal: invalid'));
test('Signal quoted or fenced line does not supply a missing header',()=>{for(const text of ['> Signal: install-procedure\n','```\nSignal: install-procedure\n```\n']){const f=path.join(FIX,'quoted.md');fs.writeFileSync(f,text+body(null));refuses(run(['check','signal-fixture'],{WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_CONTRACT_FIXTURE:f}),'Signal: missing');}});
test('Signal duplicate lines refused',()=>{const f=path.join(FIX,'duplicate.md');fs.writeFileSync(f,'Signal: install-procedure\n'+valid);refuses(run(['check','signal-fixture'],{WHEELHOUSE_SKIP_BD:'1',WHEELHOUSE_CONTRACT_FIXTURE:f}),'Signal: duplicate line');});
test('skip-bd unset intake fixture warns, does not silently pass',()=>{const r=check('sig-abcd',{WHEELHOUSE_INTAKE_FIXTURE:''});assert.equal(r.status,0);assert(r.stderr.includes('intake id check skipped'));});
test('explicit missing intake fixture refuses instead of skipping',()=>refuses(check('sig-abcd',{WHEELHOUSE_INTAKE_FIXTURE:path.join(FIX,'missing.jsonl')}),'ledger link unreadable'));
test('reachable empty ledger has no posted id',()=>{const f=path.join(FIX,'empty.jsonl');fs.writeFileSync(f,'');refuses(check('sig-abcd',{WHEELHOUSE_INTAKE_FIXTURE:f}),'not a posted intake event');});
test('existing malformed ledger refuses',()=>{const f=path.join(FIX,'malformed.jsonl');fs.writeFileSync(f,'not json\n');refuses(check('sig-abcd',{WHEELHOUSE_INTAKE_FIXTURE:f}),'ledger link invalid');});
test('existing unreadable ledger refuses',()=>{const f=path.join(FIX,'directory-ledger');fs.mkdirSync(f);refuses(check('sig-abcd',{WHEELHOUSE_INTAKE_FIXTURE:f}),'ledger link unreadable');});
test('disposed-only row is not a posted signal',()=>{const f=path.join(FIX,'disposed-only.jsonl');fs.writeFileSync(f,JSON.stringify({type:'disposed',id:'sig-abcd',at:'2026-10-01T00:00:00Z',disposition:'dropped',by:'fixture',reason:'fixture'})+'\n');refuses(check('sig-abcd',{WHEELHOUSE_INTAKE_FIXTURE:f}),'ledger link invalid');});
const bead=create(body('sig-abcd','TEMPLATE (template/)'));
const disposed=cp.spawnSync('bun',[path.join(HERE,'intake.ts'),'dispose','sig-abcd','produced','--work',bead],{env:{...env,WHEELHOUSE_INTAKE_ROOT:root,BEADS_ACTOR:'fixture-producer'},encoding:'utf8'});assert.equal(disposed.status,0,disposed.stderr);
const repo=path.join(root,'template');init(repo);fs.writeFileSync(path.join(repo,'base'),'base');git(repo,['add','base']);git(repo,['commit','-q','-m','base']);git(repo,['checkout','-q','-b','feature']);fs.writeFileSync(path.join(repo,'feature'),'feature');git(repo,['add','feature']);git(repo,['commit','-q','-m','feature']);git(repo,['checkout','-q','main']);git(repo,['merge','--no-ff','-q','feature','-m',`Merge fleet/${bead}: fixture change`]);const sha=git(repo,['rev-parse','HEAD']);
fs.mkdirSync(path.join(root,'wheelhouse'),{recursive:true});fs.writeFileSync(path.join(root,'wheelhouse/.template-source'),'product-repo=template\n');
const beforeLedger=fs.readFileSync(ledger,'utf8');
function chain(r){assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');for(const text of [sha,`Contract: fleet/${bead}`,'Signal: sig-abcd','id: sig-abcd','kind: finding','source: "selftest"','title: "Fixture signal"','posted at:','disposition: produced'])assert(r.stdout.includes(text),r.stdout);}
test('trace bead reads real scratch graph, posted row and merge',()=>chain(run(['trace',bead])));
test('trace merge orders merge -> fleet/bead -> Signal -> intake',()=>{const r=run(['trace',sha]);chain(r);const values=[`Merge: ${sha}`,`Contract: fleet/${bead}`,'Signal: sig-abcd','Intake:'];for(let i=1;i<values.length;i++)assert(r.stdout.indexOf(values[i-1])<r.stdout.indexOf(values[i]));if(process.env.WHEELHOUSE_CONTRACT_EVIDENCE_DIR){fs.mkdirSync(process.env.WHEELHOUSE_CONTRACT_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.WHEELHOUSE_CONTRACT_EVIDENCE_DIR,'trace.out'),r.stdout);fs.writeFileSync(path.join(process.env.WHEELHOUSE_CONTRACT_EVIDENCE_DIR,'trace.rc'),String(r.status)+'\n');}});
for(const declaration of ['template/','TEMPLATE.'])test('trace real Repo form '+declaration,()=>{update(bead,body('sig-abcd',declaration));chain(run(['trace',bead]));});
const second=path.join(root,'second');git(repo,['clone','-q',repo,second]);assert.equal(git(second,['rev-parse','--show-toplevel']),fs.realpathSync(second));
test('trace enumerates both declared product repositories',()=>{update(bead,body('sig-abcd','template/; second'));const r=run(['trace',bead]);chain(r);assert(r.stdout.includes(`(${repo})`));assert(r.stdout.includes(`(${second})`));});
const wt=path.join(root,'worktree');git(repo,['worktree','add','-q','--detach',wt,sha]);assert.equal(git(wt,['rev-parse','--show-toplevel']),fs.realpathSync(wt));
test('trace follows an explicitly declared worktree root',()=>{update(bead,body('sig-abcd','worktree'));chain(run(['trace',sha]));});
test('trace refuses a worktree subdirectory as a repo root',()=>{fs.mkdirSync(path.join(wt,'plain'));update(bead,body('sig-abcd','worktree/plain'));refuses(run(['trace',bead]),'not its own git root');});
test('trace product-repo fallback',()=>{update(bead,body('sig-abcd'));chain(run(['trace',sha]));});
test('trace missing normal ledger refuses while gate warns',()=>{fs.renameSync(ledger,ledger+'.saved');try{const r=run(['check',bead]);assert.equal(r.status,0,r.stderr);assert(r.stderr.includes('id check skipped'));refuses(run(['trace',bead]),'ledger link unreadable');}finally{fs.renameSync(ledger+'.saved',ledger);}});
for(const kind of ['directory','malformed','dangling-link'])test('normal existing '+kind+' ledger refuses',()=>{fs.renameSync(ledger,ledger+'.saved');try{if(kind==='directory')fs.mkdirSync(ledger);else if(kind==='dangling-link')fs.symlinkSync(path.join(root,'absent-ledger'),ledger);else fs.writeFileSync(ledger,'broken json\n');refuses(run(['check',bead]),'ledger link '+(kind==='malformed'?'invalid':'unreadable'));}finally{fs.rmSync(ledger,{recursive:true,force:true});fs.renameSync(ledger+'.saved',ledger);}});
test('trace unknown sig id names missing link',()=>{update(bead,body('sig-zzzz'));refuses(run(['trace',bead]),'signal link missing: sig-zzzz');});
test('trace missing Signal names bead',()=>{update(bead,body(null));refuses(run(['trace',bead]),`bead ${bead} has no Signal:`);});
update(bead,body('sig-abcd','template/'));
test('trace unknown bead names bead link',()=>refuses(run(['trace','missing-bead']),'bead link missing: missing-bead'));
git(repo,['checkout','-q','-b','other']);fs.writeFileSync(path.join(repo,'other'),'other');git(repo,['add','other']);git(repo,['commit','-q','-m','other']);git(repo,['checkout','-q','main']);git(repo,['merge','--no-ff','-q','other','-m','Merge unrelated fixture']);const unrelated=git(repo,['rev-parse','HEAD']);
test('trace merge with no fleet bead refuses',()=>refuses(run(['trace',unrelated]),'merge subject names no bead'));
test('trace non-merge commit is not a merge chain',()=>refuses(run(['trace',git(repo,['rev-parse',sha+'^2'])]),'merge link missing'));
test('trace does not mistake a Repo subdirectory for its enclosing git root',()=>{fs.mkdirSync(path.join(repo,'plain'));update(bead,body('sig-abcd','template/plain'));refuses(run(['trace',bead]),'not its own git root');});
update(bead,body('sig-abcd','template/'));
test('trace install root fallback is an actual git root',()=>{git(root,['fetch','-q',repo,'main']);git(root,['update-ref','refs/heads/main',sha]);const source=path.join(root,'wheelhouse/.template-source');fs.renameSync(source,source+'.saved');update(bead,body('sig-abcd'));try{chain(run(['trace',bead]));}finally{fs.renameSync(source+'.saved',source);update(bead,body('sig-abcd','template/'));}});
test('trace never modifies ledger or refs',()=>{assert.equal(fs.readFileSync(ledger,'utf8'),beforeLedger);const before=git(repo,['show-ref']);chain(run(['trace',sha]));assert.equal(git(repo,['show-ref']),before);assert.equal(fs.readFileSync(ledger,'utf8'),beforeLedger);});
const parser=cp.spawnSync('bun',['-e',`import a from 'node:assert/strict'; const m=await import(process.env.CONTRACT); a.deepEqual(m.repoDeclarations('Repo: TEMPLATE (template/)'),['template/']); a.deepEqual(m.repoDeclarations('Repo: TEMPLATE.'),['template/']); a.deepEqual(m.repoDeclarations('Repo: template/'),['template/']); a.deepEqual(m.repoDeclarations('Repo: UMBRELLA; other.'),['.','other']); a.deepEqual(m.repoDeclarations('  Repo: UMBRELLA'),['.']); a.deepEqual(m.repoDeclarations('Repo: ../..'),['../..']); a.equal(m.repoDeclarations('> Repo: wrong'),null); a.equal(m.repoDeclarations('\\x60\\x60\\x60\\nRepo: wrong\\n\\x60\\x60\\x60'),null);`],{env:{...env,CONTRACT},encoding:'utf8'});
test('shared Repo parser accepts actual forms/lists and ignores examples',()=>assert.equal(parser.status,0,parser.stderr));
console.log(`Signal/trace checks: ${passed} PASS / ${failed} FAIL`);process.exitCode=failed?1:0;
JS
SIGNAL_RC=$?
[ "$SIGNAL_RC" = 0 ] || FAILED=$((FAILED+1))
if [ "$FAILED" = 0 ]; then echo 'contract.selftest: PASS'; exit 0; fi
echo "contract.selftest: FAIL ($FAILED failures)"; exit 1
