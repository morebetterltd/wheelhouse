#!/usr/bin/env bash
# A container-only install must guard pushes from a separate product's seats.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
INSTALLER="${1:-$HERE/install-fleet-pre-push-guard.sh}"
[ -f "$INSTALLER" ] || exit 2
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-product-pre-push.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
mkdir -p "$FIX/home" "$FIX/tmp"
export HOME="$FIX/home" XDG_CONFIG_HOME="$FIX/home/.config" TMPDIR="$FIX/tmp"
# Explicit Git contexts/config overrides can bypass a discovery ceiling.
for variable in ${!GIT_@}; do
  [ "$variable" = GIT_CEILING_DIRECTORIES ] || unset "$variable"
done
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$FIX/gitconfig"
printf '[user]\n name = selftest\n email = selftest@example.invalid\n[commit]\n gpgsign = false\n[init]\n defaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
unset WHEELHOUSE_INTEGRATOR_PUSH
FAILED=0
pass(){ printf 'ok - %s\n' "$*"; }
fail(){ printf 'not ok - %s\n' "$*"; FAILED=$((FAILED+1)); }

previous_hook(){
  local hook="$1" log="$2" log_q
  mkdir -p "$(dirname "$hook")"
  printf -v log_q '%q' "$log"
  cat > "$hook" <<HOOK
#!/usr/bin/env bash
set -eu
LOG=$log_q
printf 'called\\n' >> "\$LOG.calls"
printf '%s\\n' "\$@" > "\$LOG.args"
cat > "\$LOG.stdin"
if [ -e "\$LOG.refuse" ]; then echo 'PREVIOUS_HOOK_REFUSED' >&2; exit 7; fi
HOOK
  chmod +x "$hook"
  : > "$log.calls"
}

run_case(){
  local name="$1" base="$FIX/$1" c p r seat ch ph log branch sha zero rc got prev_q missing_q
  c="$base/container's root"; p="$base/product repo's"; r="$base/remote.git"; seat="$base/worker-1"
  mkdir -p "$c/seats" "$c/wheelhouse"
  git init -q -b main "$c"; git -C "$c" commit --allow-empty -qm container
  git init -q -b main "$p"; git -C "$p" commit --allow-empty -qm product
  git init -q --bare -b main "$r"; git -C "$p" remote add origin "$r"; git -C "$p" push -q origin main
  [ "$(git --git-dir="$r" rev-parse --is-bare-repository)" = true ]
  cp -f "$INSTALLER" "$c/seats/install-fleet-pre-push-guard.sh"
  cp -f "$HERE/fleet-pre-push-guard.sh" "$c/seats/"
  chmod +x "$c/seats/"*.sh
  printf 'product-repo=%s\n' "$p" > "$c/wheelhouse/.template-source"
  ch="$c/.git/hooks"; ph="$p/.git/hooks"
  case "$name" in
    relative)
      printf "product-repo=../product repo's\n" > "$c/wheelhouse/.template-source"
      git -C "$c" config core.hooksPath .beads/hooks; ch="$c/.beads/hooks"
      git -C "$p" config core.hooksPath .product-hooks; ph="$p/.product-hooks" ;;
    absolute)
      ch="$base/container hooks"; ph="$base/product hooks"
      git -C "$c" config core.hooksPath "$ch"; git -C "$p" config core.hooksPath "$ph" ;;
    shared)
      ch="$c/.beads/hooks"; ph="$ch"
      git -C "$c" config core.hooksPath .beads/hooks; git -C "$p" config core.hooksPath "$ph" ;;
  esac
  log="$base/previous-product"
  previous_hook "$ch/pre-push" "$base/previous-container"
  previous_hook "$ph/pre-push" "$log"
  if [ "$name" = legacy ]; then
    # The previous installer could leave this wrapper pointing into a product
    # with no seats/. Keep a nonstandard PREV to detect lost backup metadata.
    mv -f "$ph/pre-push" "$ph/preserved-with-custom-suffix"
    printf -v prev_q '%q' "$ph/preserved-with-custom-suffix"
    printf -v missing_q '%q' "$p/seats/fleet-pre-push-guard.sh"
    cat > "$ph/pre-push" <<HOOK
#!/usr/bin/env bash
set -eu
# wheelhouse fleet pre-push guard
PREV=$prev_q
GUARD=$missing_q
TMP=\$(mktemp "\${TMPDIR:-/tmp}/wheelhouse-pre-push.XXXXXX")
trap 'rm -f "\$TMP"' EXIT
cat > "\$TMP"
"\$GUARD" "\$@" < "\$TMP"
"\$PREV" "\$@" < "\$TMP"
HOOK
    chmod +x "$ph/pre-push"
  fi

  rc=0; (cd "$c" && seats/install-fleet-pre-push-guard.sh) > "$base/install.out" 2> "$base/install.err" || rc=$?
  if [ "$rc" = 0 ] && [ -x "$ch/pre-push" ] && [ -x "$ph/pre-push" ]; then pass "$name installs both hooks";
  else fail "$name did not install both hooks (exit $rc)"; fi
  got=$(git -C "$p" config --get core.hooksPath || true)
  if [ "$got" = "$ph" ]; then pass "$name respects product hooks path"; else fail "$name product hooks path: $got (expected $ph)"; fi
  [ ! -e "$p/seats" ] || { echo 'STOP: product fixture must have no seats/' >&2; exit 2; }

  # Re-running the upgrade command must not nest wrappers or reset product-repo.
  if [ -f "$ph/pre-push" ]; then cp -f "$ph/pre-push" "$base/hook.before"; fi
  cp -f "$c/wheelhouse/.template-source" "$base/source.before"
  rc=0; (cd "$c" && seats/install-fleet-pre-push-guard.sh) >> "$base/install.out" 2>> "$base/install.err" || rc=$?
  if [ "$rc" = 0 ] && [ -f "$base/hook.before" ] && cmp -s "$base/hook.before" "$ph/pre-push" && cmp -s "$base/source.before" "$c/wheelhouse/.template-source"; then
    pass "$name upgrade reinstall is byte-idempotent and preserves product-repo"
  else fail "$name upgrade reinstall changed wrapper/data or failed"; fi

  sha=$(git -C "$c" rev-parse HEAD); zero=${sha//[0-9a-f]/0}
  rc=0
  printf '%s %s %s %s\n' refs/heads/fleet/container "$sha" refs/heads/fleet/container "$zero" | "$ch/pre-push" origin "$r" > "$base/container.out" 2> "$base/container.err" || rc=$?
  if [ "$rc" != 0 ] && grep -qF 'refusing push to refs/heads/fleet/container' "$base/container.err"; then
    pass "$name container hook also refuses fleet refs"
  else fail "$name container hook is not guarded (exit $rc)"; fi

  branch="fleet/seat-$name"
  git -C "$p" worktree add -q -b "$branch" "$seat" main
  printf 'unreviewed seat change\n' > "$seat/change"
  git -C "$seat" add change; git -C "$seat" commit -qm 'seat candidate'
  sha=$(git -C "$seat" rev-parse HEAD); zero=${sha//[0-9a-f]/0}
  rc=0; git -C "$seat" push origin "$branch:$branch" > "$base/raw.out" 2> "$base/raw.err" || rc=$?
  if [ "$rc" != 0 ] && grep -qF "refusing push to refs/heads/$branch" "$base/raw.err" && grep -qF 'WHEELHOUSE_INTEGRATOR_PUSH=1' "$base/raw.err"; then
    pass "$name product seat raw fleet push refused by guard"
  else fail "$name product seat raw fleet push not refused by guard (exit $rc)"; fi
  rc=0; git --git-dir="$r" show-ref --verify --quiet "refs/heads/$branch" || rc=$?
  if [ "$rc" = 1 ] && [ ! -s "$log.calls" ]; then pass "$name refusal leaves remote absent and previous hook uncalled";
  else fail "$name refusal published a ref, called previous hook, or failed ref lookup (exit $rc)"; fi

  rc=0; WHEELHOUSE_INTEGRATOR_PUSH=1 git -C "$seat" push origin "$branch:$branch" > "$base/allowed.out" 2> "$base/allowed.err" || rc=$?
  if [ "$rc" = 0 ] && [ "$(git --git-dir="$r" rev-parse "refs/heads/$branch")" = "$sha" ]; then
    pass "$name integrator fleet push reaches exact seat tip"
  else fail "$name integrator fleet push failed or wrong remote tip (exit $rc)"; fi
  if [ -f "$log.stdin" ] && [ "$(wc -l < "$log.calls" | tr -d ' ')" = 1 ] \
    && printf '%s %s %s %s\n' "refs/heads/$branch" "$sha" "refs/heads/$branch" "$zero" | cmp -s - "$log.stdin" \
    && printf '%s\n' origin "$r" | cmp -s - "$log.args"; then
    pass "$name previous hook gets identical stdin/args exactly once"
  else fail "$name previous hook missing, nested, or stdin/args changed"; fi

  : > "$log.refuse"
  printf 'next seat change\n' >> "$seat/change"
  git -C "$seat" commit -qam 'next seat candidate'
  rc=0; WHEELHOUSE_INTEGRATOR_PUSH=1 git -C "$seat" push origin "$branch:$branch" > "$base/veto.out" 2> "$base/veto.err" || rc=$?
  if [ "$rc" != 0 ] && grep -q 'PREVIOUS_HOOK_REFUSED' "$base/veto.err" && [ "$(git --git-dir="$r" rev-parse "refs/heads/$branch")" = "$sha" ]; then
    pass "$name previous hook can still veto an integrator push"
  else fail "$name previous hook veto was lost (exit $rc)"; fi
}

for name in default relative absolute shared legacy; do run_case "$name"; done

# A declared but invalid product must not produce a successful container-only
# install (including a plain subdirectory that Git would walk up out of).
for kind in missing plain; do
  c="$FIX/invalid-$kind"; mkdir -p "$c/seats" "$c/wheelhouse"
  git init -q -b main "$c"
  cp -f "$INSTALLER" "$c/seats/install-fleet-pre-push-guard.sh"
  cp -f "$HERE/fleet-pre-push-guard.sh" "$c/seats/"
  chmod +x "$c/seats/"*.sh
  [ "$kind" != plain ] || mkdir "$c/not-a-repo"
  printf 'product-repo=not-a-repo\n' > "$c/wheelhouse/.template-source"
  rc=0; (cd "$c" && seats/install-fleet-pre-push-guard.sh) > "$c/out" 2> "$c/err" || rc=$?
  if [ "$rc" != 0 ] && grep -q 'product-repo' "$c/err" && [ ! -e "$c/.git/hooks/pre-push" ]; then pass "$kind product fails before container mutation";
  else fail "$kind product silently accepted or container changed (exit $rc)"; fi
done

if [ "$FAILED" = 0 ]; then echo 'product-pre-push.selftest: PASS'; exit 0; fi
echo "product-pre-push.selftest: FAIL ($FAILED failure(s))"
exit 1
