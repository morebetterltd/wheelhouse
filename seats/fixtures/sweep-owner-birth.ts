// Exercise the actual live-process census, not a separately reimplemented
// parser. Only whitespace in the launcher's real native owner row is varied;
// no wall clock, PID, group or date value is forged.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const [root, seats, control] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const removed = control === '--removed';
assert(!control || removed);
const dir = path.join(root, removed ? 'birth-removed' : 'birth-positive'); fs.mkdirSync(dir);
let source = fs.readFileSync(path.join(seats, 'selftest-sweep.sh'), 'utf8');
if (removed) {
  const owner = '  read -r owner group weekday month day clock year < "$dir/owner" || return 2\n  # lstart pads single-digit days. Compare date fields, not its display spaces,\n  # just as the widened argv-bearing process census below does.\n  born="$weekday $month $day $clock $year"';
  assert.equal(source.split(owner).length, 2, 'owner mutation anchor');
  source = source.replace(owner, '  read -r owner group born < "$dir/owner" || return 2');
  assert.equal(source.split('[ -n "$year" ] || return 2').length, 2);
  source = source.replace('[ -n "$year" ] || return 2', '[ -n "$born" ] || return 2');
}
const cut = source.indexOf('acquire_lock(){'); assert(cut > 0);
// Export only the committed prefix's existing functions into a private test
// module. Admission/outer loop are not run twice; our maintained caller owns
// the real host admission. start/finish/census/containment stay byte-identical.
const module = path.join(seats, removed ? 'birth-observer-removed.sh' : 'birth-observer.sh');
fs.writeFileSync(path.join(dir, 'child.sh'), `#!/usr/bin/env bash
set -eu
exec 6<> "$BIRTH_CASE/control"
printf '%s\\n' "$$" > "$BIRTH_CASE/ready"
read -r message <&6
[ "$message" = release ]
`);
fs.writeFileSync(module, source.slice(0, cut) + `
# Private probe footer, not shipped runner behavior.
cleanup_birth(){
  local rc=$?
  trap - EXIT
  if [ -n "$CURRENT_SUITE_PID" ]; then
    # Independent safe teardown even for the deliberately broken parser:
    # restore the same native identity with canonical field separators.
    if [ -s "$SUITE_STATE/owner" ]; then
      awk '{$1=$1; print}' "$SUITE_STATE/owner" > "$SUITE_STATE/owner.clean"
      mv -f "$SUITE_STATE/owner.clean" "$SUITE_STATE/owner"
    fi
    finish_current_suite stop
  fi
  exec 7>&-
  exit "$rc"
}
trap cleanup_birth EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
mkfifo "$BIRTH_CASE/control"
exec 7<> "$BIRTH_CASE/control"
start_suite "$BIRTH_CASE/child.sh"
for attempt in $(seq 1 500); do
  [ ! -s "$BIRTH_CASE/ready" ] || break
  sleep 0.01
done
[ -s "$BIRTH_CASE/ready" ] || exit 3
[ "$(< "$BIRTH_CASE/ready")" = "$CURRENT_SUITE_PID" ] || exit 3
cp -f "$SUITE_STATE/owner" "$BIRTH_CASE/native-owner"
awk '{$5="  "$5; print}' "$SUITE_STATE/owner" > "$SUITE_STATE/owner.padded"
mv -f "$SUITE_STATE/owner.padded" "$SUITE_STATE/owner"
cp -f "$SUITE_STATE/owner" "$BIRTH_CASE/padded-owner"
signal_suite_tree PROBE "$CURRENT_SUITE_PID" "$SUITE_STATE"
observed_rc=$?
printf 'OWNER_BIRTH rc=%s survivors=%s\\n' "$observed_rc" "$SUITE_SURVIVORS"
printf 'release\\n' >&7
finish_current_suite done
exit "$observed_rc"
`);
const r = spawnSync('bash', [module], { env: { ...process.env, BIRTH_CASE: dir, WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S: '1' }, encoding: 'utf8' });
fs.writeFileSync(path.join(dir, 'out'), r.stdout ?? ''); fs.writeFileSync(path.join(dir, 'err'), r.stderr ?? ''); fs.writeFileSync(path.join(dir, 'rc'), String(r.status) + '\n');
assert.ifError(r.error); assert.equal(r.signal, null);
const native = fs.readFileSync(path.join(dir, 'native-owner'), 'utf8'), padded = fs.readFileSync(path.join(dir, 'padded-owner'), 'utf8');
assert.notEqual(native, padded); assert.deepEqual(native.trim().split(/\s+/), padded.trim().split(/\s+/));
console.log(JSON.stringify({ nativeOwner: native, paddedOwner: padded, nativeExit: r.status, stdout: r.stdout, stderr: r.stderr }));
assert.equal(r.status, 0, 'owner birth whitespace must preserve live identity');
assert(r.stdout.includes('OWNER_BIRTH rc=0 survivors=1'), 'live child was not examined');
console.log('PASS owner-birth-whitespace: native identity values unchanged, live census accepted date padding');
if (!removed) {
  const c = spawnSync('bun', [import.meta.path, root, seats, '--removed'], { env: process.env, encoding: 'utf8' });
  assert.ifError(c.error); assert.equal(c.signal, null); assert.equal(c.status, 1);
  assert.match(c.stderr, /AssertionError: owner birth whitespace must preserve live identity/);
  assert(c.stdout.includes('OWNER_BIRTH rc=2 survivors=0'));
  assert(c.stdout.includes('STOP: suite leader identity changed'));
  process.stdout.write(c.stdout); process.stderr.write(c.stderr);
  console.log('PASS removal owner-birth-whitespace: native exit=1, own assertion rejected removed fix');
}
