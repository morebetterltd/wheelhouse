#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHECK="$SCRIPT_DIR/intent-check.sh"
TMPBASE=${TMPDIR:-/tmp}
FIXTURE=$(mktemp -d "$TMPBASE/wheelhouse-intent-check-selftest.$$.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT HUP INT TERM

pass_count=0

say() { printf '%s\n' "$*"; }
fail() { say "FAIL: $*"; exit 1; }

run_capture() {
  name=$1
  shift
  out="$FIXTURE/$name.out"
  set +e
  "$@" >"$out" 2>&1
  rc=$?
  set -e
  printf '%s' "$rc" >"$FIXTURE/$name.rc"
}

expect_rc() {
  name=$1
  want=$2
  got=$(cat "$FIXTURE/$name.rc")
  if [ "$got" != "$want" ]; then
    say "--- $name output ---"
    cat "$FIXTURE/$name.out"
    fail "${name}: expected exit $want, got $got"
  fi
}

expect_output() {
  name=$1
  pattern=$2
  if ! grep -q "$pattern" "$FIXTURE/$name.out"; then
    say "--- $name output ---"
    cat "$FIXTURE/$name.out"
    fail "${name}: missing output pattern: $pattern"
  fi
}

make_fixture() {
  dir=$1
  mkdir -p "$dir"
  ( cd "$dir"
    git init -q -b main
    git config user.email intent-check@example.invalid
    git config user.name 'Intent Check Selftest'
    bd init --non-interactive --skip-agents -p intent >/dev/null
    mkdir -p wheelhouse
    printf '# Fixture ISA\n\n## Goal\n\nExercise the intent gate.\n\n## Claims\n\n(empty)\n\n## Decisions\n\n(empty)\n' >wheelhouse/ISA.md
    git add wheelhouse/ISA.md
    git commit -q -m 'Add ISA'
  )
}

new_bead() {
  dir=$1
  title=$2
  desc=$3
  ( cd "$dir" && bd create "$title" -d "$desc" --json ) |
    sed -n 's/^[[:space:]]*"id": "\([^"]*\)".*/\1/p' | head -1
}

# 1. Clean state passes.
clean="$FIXTURE/clean"
make_fixture "$clean"
new_bead "$clean" 'Traced clean bead' 'Trace: selftest clean state.' >/dev/null
run_capture clean_pass sh -c "cd '$clean' && '$CHECK' ."
expect_rc clean_pass 0
expect_output clean_pass 'intent-check: PASS'
say 'ok 1 - clean state PASSes'
pass_count=$((pass_count + 1))

# 2. A closed bead still carrying needs-review fails: worker handoff is a bead
# comment plus the review label, not close; commander/integrator close drops the label.
closed_review="$FIXTURE/closed-review"
make_fixture "$closed_review"
closed_review_bead=$(new_bead "$closed_review" 'Closed but still needs review' 'Trace: selftest closed needs-review bead.')
( cd "$closed_review"
  bd update "$closed_review_bead" --add-label needs-review >/dev/null
  bd close "$closed_review_bead" --reason 'selftest planted bad close' >/dev/null
)
run_capture closed_review sh -c "cd '$closed_review' && '$CHECK' ."
expect_rc closed_review 1
expect_output closed_review 'closed while still labelled needs-review'
say 'ok 2 - closed bead still labelled needs-review FAILs'
pass_count=$((pass_count + 1))

# 3. A planted merge with no ISA movement and no escape-hatch comment fails.
merge_fail="$FIXTURE/merge-fail"
make_fixture "$merge_fail"
merge_bead=$(new_bead "$merge_fail" 'Merged work' 'Trace: selftest planted merge.')
( cd "$merge_fail"
  git checkout -q -b "fleet/$merge_bead"
  printf 'changed\n' >product.txt
  git add product.txt
  git commit -q -m 'Product change'
  git checkout -q main
  git merge --no-ff -q "fleet/$merge_bead" -m "Merge fleet/${merge_bead}: planted merge"
)
run_capture merge_fail sh -c "cd '$merge_fail' && '$CHECK' ."
expect_rc merge_fail 1
expect_output merge_fail 'without ISA movement'
say 'ok 3 - planted merge without claim movement FAILs'
pass_count=$((pass_count + 1))

# 4. A planted merge that moves the ISA in the merge commit passes without an escape hatch.
merge_pass="$FIXTURE/merge-pass"
make_fixture "$merge_pass"
move_bead=$(new_bead "$merge_pass" 'Merged work with claim movement' 'Trace: selftest ISA-moving merge.')
( cd "$merge_pass"
  git checkout -q -b "fleet/$move_bead"
  printf 'changed\n' >product.txt
  git add product.txt
  git commit -q -m 'Product change'
  git checkout -q main
  git merge --no-ff --no-commit "fleet/$move_bead" >/dev/null
  printf '\n- claim moved with this merge.\n' >>wheelhouse/ISA.md
  git add wheelhouse/ISA.md product.txt
  git commit -q -m "Merge fleet/${move_bead}: claim moved in merge"
)
run_capture merge_pass sh -c "cd '$merge_pass' && '$CHECK' ."
expect_rc merge_pass 0
expect_output merge_pass 'intent-check: PASS'
say 'ok 4 - ISA-moving merge PASSes without escape hatch'
pass_count=$((pass_count + 1))

# 5. A planted open bead without Trace: fails.
trace_fail="$FIXTURE/trace-fail"
make_fixture "$trace_fail"
new_bead "$trace_fail" 'Traceless planted bead' 'No trace line here.' >/dev/null
run_capture trace_fail sh -c "cd '$trace_fail' && '$CHECK' ."
expect_rc trace_fail 1
expect_output trace_fail 'no literal Trace:'
say 'ok 5 - planted traceless bead FAILs'
pass_count=$((pass_count + 1))

# 6. An install whose ISA is not committed exits with the distinct unrunnable code.
unrun="$FIXTURE/uncommitted-isa"
mkdir -p "$unrun"
( cd "$unrun"
  git init -q -b main
  git config user.email intent-check@example.invalid
  git config user.name 'Intent Check Selftest'
  bd init --non-interactive --skip-agents -p intent >/dev/null
  mkdir -p wheelhouse
  printf '# Fixture ISA\n' >wheelhouse/ISA.md
  bd create 'Traced bead' -d 'Trace: selftest uncommitted ISA.' >/dev/null
)
run_capture uncommitted sh -c "cd '$unrun' && '$CHECK' ."
expect_rc uncommitted 2
expect_output uncommitted 'UNRUNNABLE:'
say 'ok 6 - uncommitted ISA exits distinct unrunnable code 2'
pass_count=$((pass_count + 1))

say "intent-check.selftest: PASS ($pass_count legs)"
