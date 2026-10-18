#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-pool-selftest.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; exit 1; }

ROOT="$FIX/proj"; HOME_FIX="$FIX/home"; BIN="$FIX/bin"
mkdir -p "$ROOT/seats" "$ROOT/wheelhouse" "$HOME_FIX/.pi-seats-pooltest/pool/a" "$HOME_FIX/.pi-seats-pooltest/pool/b" "$HOME_FIX/.pi-seats-pooltest/pool/c" "$HOME_FIX/.pi-seats-pooltest/pool/codex-a" "$HOME_FIX/.pi-seats-pooltest/pool/claude-b" "$HOME_FIX/.pi-seats-pooltest/pool/openrouter-c" "$BIN"
printf 'namespace=pooltest\n' > "$ROOT/wheelhouse/.template-source"
selftest_copy_seat_runtime "$ROOT" "$HERE"; chmod +x "$ROOT/seats/seat-env.sh"
for tool in pi claude codex; do printf '#!/usr/bin/env sh\nexit 0\n' > "$BIN/$tool"; chmod +x "$BIN/$tool"; done
cat > "$ROOT/seats/seats.json" <<'JSON'
{"version":1,"commander":{"role":"commander","external":true},"seats":{"observer":{"role":"researcher","external":true}}}
JSON

write_valid_pool(){ cat > "$ROOT/seats/pool.json" <<'JSON'
{"version":1,"entries":{"a":{"harness":"codex","provider":"openai","models":["worker-model","reviewer-model"],"account":{"dir":"~/.pi-seats-pooltest/pool/a","authRoute":"oauth"}},"b":{"harness":"claude-code","provider":"anthropic","models":["worker-b"],"account":{"dir":"~/.pi-seats-pooltest/pool/b","authRoute":"oauth"}},"c":{"harness":"pi","provider":"openrouter","models":["reviewer-c"],"account":{"dir":"~/.pi-seats-pooltest/pool/c","authRoute":"api_key"}}},"roles":{"workers":{"min":1,"max":2,"entries":["a","b"],"model":{"a":"worker-model","b":"worker-b"}},"reviewers":{"min":1,"max":1,"entries":["a","c"],"model":{"a":"reviewer-model","c":"reviewer-c"}}}}
JSON
}
run_check(){ HOME="$HOME_FIX" PATH="$BIN:$PATH" bun "$ROOT/seats/pool.ts" check > "$FIX/out" 2>&1; RC=$?; OUT="$(cat "$FIX/out")"; }
expect_refusal(){ name="$1" want="$2"; run_check; [ $RC -eq 2 ] && printf '%s\n' "$OUT" | grep -F >/dev/null "$want" && printf '%s\n' "$OUT" | grep >/dev/null '— fix:' && pass "$name" || fail "$name rc=$RC out=$OUT"; }

bun - "$HERE/pool.json.example" "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,src=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(const e of Object.values(src.entries)) e.account.dir=e.account.dir.replaceAll('myproject','pooltest');
fs.writeFileSync(process.argv[3],JSON.stringify(src));
JS
run_check
[ $RC -eq 0 ] && [ "$OUT" = 'pool: 3 entries, workers 1..2 (2 entries), reviewers 1..1 (1 entries)' ] && pass 'shipped pool.json.example loads and summarizes' || fail "example failed rc=$RC out=$OUT"

rm -f "$ROOT/seats/pool.json"
run_check
[ $RC -eq 0 ] && [ "$OUT" = 'pool: none (fixed roster)' ] && pass 'no pool check prints fixed roster' || fail "no-pool check failed rc=$RC out=$OUT"
( cd "$ROOT" && HOME="$HOME_FIX" bun -e 'import { effectiveRoster, fixedRoster } from "./seats/roster.ts"; const a=JSON.stringify(effectiveRoster(process.cwd())); const b=JSON.stringify(fixedRoster(process.cwd())); if(a!==b) throw new Error(`${a} != ${b}`);' ) > "$FIX/nopool-roster.out" 2>&1
[ $? -eq 0 ] && pass 'no pool effectiveRoster equals seats.json by JSON diff' || fail "no-pool roster diff failed: $(cat "$FIX/nopool-roster.out")"

write_valid_pool
run_check
[ $RC -eq 0 ] && pass 'valid pool fixture loads' || fail "valid pool failed rc=$RC out=$OUT"
( cd "$ROOT" && HOME="$HOME_FIX" bun -e 'import { loadPool, seatEntryFor } from "./seats/pool.ts"; const p=loadPool(process.cwd()); if(seatEntryFor(p,"workers","a").model!=="worker-model") throw new Error("worker model wrong"); if(seatEntryFor(p,"reviewers","a").model!=="reviewer-model") throw new Error("reviewer model wrong");' ) > "$FIX/role-model.out" 2>&1
[ $? -eq 0 ] && pass 'seatEntryFor assigns the role-specific model' || fail "role model failed: $(cat "$FIX/role-model.out")"
cat > "$ROOT/seats/staffing.json" <<'JSON'
{"version":1,"seats":{"worker-a":{"role":"worker","entry":"a","addedAt":"2026-01-01T00:00:00Z"},"verifier-a":{"role":"verifier","entry":"a","addedAt":"2026-01-01T00:00:00Z"}}}
JSON
( cd "$ROOT" && HOME="$HOME_FIX" bun -e 'import { effectiveRoster } from "./seats/roster.ts"; const r=effectiveRoster(process.cwd()); if(r["worker-a"]?.model!=="worker-model"||r["verifier-a"]?.model!=="reviewer-model") throw new Error(JSON.stringify(r));' ) > "$FIX/staffing-roster.out" 2>&1
[ $? -eq 0 ] && pass 'effectiveRoster expands only seats registered in staffing.json' || fail "staffing roster failed: $(cat "$FIX/staffing-roster.out")"
( cd "$ROOT" && HOME="$HOME_FIX" bun -e 'import { worktreeCap } from "./seats/seat-worktree.ts"; const c=worktreeCap(process.cwd()); if(c.seats!==3 || c.cap!==5) throw new Error(JSON.stringify(c));' ) > "$FIX/worktree-cap.out" 2>&1
[ $? -eq 0 ] && pass 'worktreeCap counts the effective roster, including staffed seats' || fail "worktree cap failed: $(cat "$FIX/worktree-cap.out")"
bun - "$ROOT/seats/staffing.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.seats['worker-missing']={role:'worker',entry:'missing'}; fs.writeFileSync(p,JSON.stringify(j));
JS
( cd "$ROOT" && HOME="$HOME_FIX" bun -e 'import { effectiveRoster } from "./seats/roster.ts"; effectiveRoster(process.cwd());' ) > "$FIX/missing-staffing.out" 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q 'seat worker-missing names missing pool entry missing' "$FIX/missing-staffing.out" && pass 'staffing entry missing from pool is a STOP naming the seat' || fail "missing staffing entry rc=$rc out=$(cat "$FIX/missing-staffing.out")"
rm -f "$ROOT/seats/staffing.json"

write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.harness='bad'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'unknown harness is refused' 'entries.a.harness is unknown'
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.roles.workers.min=2; j.roles.workers.max=1; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'min above max is refused' 'roles.workers min/max is invalid'
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.roles.workers.max=3; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'max above role entries is refused' 'roles.workers.max exceeds subscription count'
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.account.dir='~/.pi-seats-pooltest/pool/missing'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'missing login dir is refused' 'login folder for entry a is missing'
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.roles.workers.model.a='not-offered'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'role model not offered is refused' 'roles.workers.model for a is not offered'
ln -sfn a "$HOME_FIX/.pi-seats-pooltest/pool/link-a"
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.b.account.dir='~/.pi-seats-pooltest/pool/link-a'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'symlinked duplicate login dir is refused' 'share a login folder'
mkdir -p "$HOME_FIX/.claude"
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.account.dir='~/.claude'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'commander login dir is refused' 'uses the commander login folder'
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.account.authRoute='default'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'authRoute default is refused' 'account.authRoute default is not allowed'
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.surprise=1; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'unknown entry key is refused' 'unknown key entries.a.surprise'
write_valid_pool; bun - "$ROOT/seats/seats.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.seats['fixed-worker']={role:'worker',harness:'codex',provider:'openai',model:'m',account:{dir:'~/.pi-seats-pooltest/fixed',authRoute:'oauth'}};
fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'fixed worker plus pool workers is refused' 'the pool replaces the fixed roster for workers'
cat > "$ROOT/seats/seats.json" <<'JSON'
{"version":1,"commander":{"role":"commander","external":true},"seats":{"observer":{"role":"researcher","external":true}}}
JSON
write_valid_pool
SECRET_PREFIX='sk-'; SECRET_BODY='abcdefghijklmnopqrstuvwxyz'
SECRET="$SECRET_PREFIX$SECRET_BODY"; export SECRET
bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.allowedTools=process.env.SECRET; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'token-shaped pool strings are refused without echoing the value' 'credential-shaped value at entries.a.allowedTools'
printf '%s\n' "$OUT" | grep -F >/dev/null "$SECRET" && fail 'token-shaped refusal echoed the planted value' || pass 'token-shaped refusal omits the planted value'

mkdir -p "$HOME_FIX/.pi-seats-other/pool/foreign"; printf 'foreign\n' > "$HOME_FIX/.pi-seats-other/pool/foreign/file.txt"
checksum(){ (cd "$HOME_FIX/.pi-seats-other" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256) 2>/dev/null; }
BEFORE="$(checksum)"
write_valid_pool; run_check; HOME="$HOME_FIX" PATH="$BIN:$PATH" bun "$ROOT/seats/pool.ts" show > "$FIX/show.out" 2>&1; HOME="$HOME_FIX" PATH="$BIN:$PATH" "$ROOT/seats/seat-env.sh" pooltest --pool a "$ROOT" > "$FIX/seat-env.out" 2>&1
AFTER="$(checksum)"
[ "$BEFORE" = "$AFTER" ] && pass 'check/show/seat-env --pool do not touch another namespace root' || fail "second namespace checksum changed: before=$BEFORE after=$AFTER"
write_valid_pool; bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.a.account.dir='~/.pi-seats-other/pool/foreign'; fs.writeFileSync(p,JSON.stringify(j));
JS
expect_refusal 'entry pointing at another namespace is refused' 'login folder is outside namespace root'

write_valid_pool
BROKEN="$ROOT/seats/pool-no-dupe.ts"
cp "$ROOT/seats/pool.ts" "$BROKEN"
BROKEN="$BROKEN" bun - <<'JS'
const fs=(await import('node:fs')).default,p=process.env.BROKEN,s=fs.readFileSync(p,'utf8');
const needle='    if (seenDirs.has(rdir)) stop(`entries ${seenDirs.get(rdir)} and ${name} share a login folder`, "give every pool entry its own account.dir");\n';
if(s.split(needle).length!==2) throw new Error('duplicate-dir canary source changed');
fs.writeFileSync(p,s.replace(needle,''));
JS
bun - "$ROOT/seats/pool.json" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.b.account.dir='~/.pi-seats-pooltest/pool/a'; fs.writeFileSync(p,JSON.stringify(j));
JS
HOME="$HOME_FIX" PATH="$BIN:$PATH" bun "$BROKEN" check > "$FIX/canary.out" 2>&1; rc=$?
[ $rc -eq 0 ] && pass 'canary: cutting duplicate-dir check lets the same-dir fixture through' || fail "canary did not prove duplicate-dir leg would catch a broken pool.ts rc=$rc out=$(cat "$FIX/canary.out")"

echo "pool.selftest.sh works on this machine."
