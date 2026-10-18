#!/usr/bin/env bash
# Shared teardown helpers for wheelhouse selftests.
# Source this file, then call selftest_cleanup_fixture_processes "$FIX" [tmux-socket...]
# from the selftest's EXIT trap before deleting the fixture root.

SELFTEST_INVOCATION_PWD="${SELFTEST_INVOCATION_PWD:-$(pwd -P)}"

# Initialize in the sourcing parent: almost all allocations run inside $(...),
# whose exports cannot reach that parent. Descendants inherit the same run.
# This is an allocation correlation token, not a secret/authentication scheme.
# Read system randomness using Bash builtins, including on a minimal PATH.
selftest_initialize_fixture_nonce() {
  [ -z "${WHEELHOUSE_SELFTEST_FIXTURE_NONCE:-}" ] || return 0
  local LC_ALL=C bytes="" chunk nonce="" i byte_value
  # Bash cannot store NUL bytes. read's NUL delimiter discards those; retain
  # sixteen non-NUL random bytes and serialize them as 32 lowercase hex digits.
  while [ "${#bytes}" -lt 16 ]; do
    IFS= read -r -n 16 -d '' chunk < /dev/urandom || { echo 'STOP: cannot read selftest allocation randomness' >&2; return 2; }
    bytes="$bytes$chunk"
  done
  for ((i=0; i<16; i++)); do
    # Bash 3.2 reports high bytes as signed character constants. Mask before
    # hex formatting, otherwise e.g. 0x96 expands to ffffffffffffff96.
    printf -v byte_value '%d' "'${bytes:$i:1}"
    printf -v nonce '%s%02x' "$nonce" "$((byte_value & 255))"
  done
  WHEELHOUSE_SELFTEST_FIXTURE_NONCE="$nonce"
}
selftest_initialize_fixture_nonce || return 2
export WHEELHOUSE_SELFTEST_FIXTURE_NONCE

# Fixtures must not borrow the identity of the seat/operator running the suite.
# Identity-construction/refusal legs may still explicitly unset/override this.
export BEADS_ACTOR=wheelhouse-selftest

with_timeout() {
  seconds="${1:-}"
  shift || true
  [ -n "$seconds" ] || { echo "with_timeout: missing seconds" >&2; return 2; }
  [ "$#" -gt 0 ] || { echo "with_timeout: missing command" >&2; return 2; }
  perl -e '$seconds = shift @ARGV; alarm $seconds; exec @ARGV or die "exec @ARGV: $!\n"' "$seconds" "$@"
}

selftest_lib_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P; }
selftest_path_contains() { case "$2" in "$1"|"$1"/*) return 0;; *) return 1;; esac; }
selftest_fixture_refused() {
  fixture="$1"; reason="$2"
  echo "STOP: unsafe selftest fixture path: ${fixture:-<empty>} ($reason)" >&2
  return 2
}
selftest_has_fixture_marker() {
  path="${1:-}"
  [ -n "$path" ] || return 1
  while [ -n "$path" ] && [ "$path" != "/" ]; do
    [ -f "$path/.wheelhouse-selftest-fixture" ] && return 0
    path="$(dirname "$path")"
  done
  return 1
}
selftest_fixture_nonce_valid() {
  local nonce="${WHEELHOUSE_SELFTEST_FIXTURE_NONCE:-}"
  [ "${#nonce}" -eq 32 ] || return 1
  case "$nonce" in *[!0-9a-f]*) return 1;; esac
}

# Exact allocation marker only. A copied marker cannot claim a different path.
selftest_require_fixture_owner() {
  local dir="$1" marker="$1/.wheelhouse-selftest-fixture"
  local prefix_line pid_line started_line nonce_line root_line extra
  selftest_fixture_nonce_valid || { selftest_fixture_refused "$dir" 'missing or invalid run nonce'; return 2; }
  [ -f "$marker" ] && [ ! -L "$marker" ] || { selftest_fixture_refused "$dir" 'missing or non-regular allocation marker'; return 2; }
  # Bounded fields; no evaluation of marker content or unbounded file read.
  if ! {
    IFS= read -r -n 4096 prefix_line && IFS= read -r -n 4096 pid_line &&
    IFS= read -r -n 4096 started_line && IFS= read -r -n 4096 nonce_line &&
    IFS= read -r -n 4096 root_line && ! IFS= read -r -n 4096 extra
  } < "$marker"; then
    selftest_fixture_refused "$dir" 'malformed allocation marker'; return 2
  fi
  case "$prefix_line" in prefix=?*) ;; *) selftest_fixture_refused "$dir" 'missing allocation prefix'; return 2;; esac
  case "$pid_line" in pid=?*) ;; *) selftest_fixture_refused "$dir" 'missing allocation pid'; return 2;; esac
  case "${pid_line#pid=}" in 0|*[!0-9]*) selftest_fixture_refused "$dir" 'invalid allocation pid'; return 2;; esac
  case "$started_line" in started=?*) ;; *) selftest_fixture_refused "$dir" 'missing allocation start time'; return 2;; esac
  [ "$nonce_line" = "nonce=$WHEELHOUSE_SELFTEST_FIXTURE_NONCE" ] || { selftest_fixture_refused "$dir" 'allocation marker nonce mismatch'; return 2; }
  [ "$root_line" = "root=$dir" ] || { selftest_fixture_refused "$dir" 'allocation marker path mismatch'; return 2; }
}

# Resolve existing ancestors BEFORE making anything. Missing child components
# are allowed only beneath a real allocation belonging to this run. The nearest
# marker is a boundary: a foreign child marker cannot borrow an owned ancestor.
selftest_owned_fixture_path() {
  local requested="${1:-}" existing suffix="" leaf canon cursor
  [ -n "$requested" ] || { selftest_fixture_refused "$requested" 'empty destination'; return 2; }
  existing="$requested"
  while [ ! -e "$existing" ] && [ ! -L "$existing" ]; do
    leaf="${existing##*/}"
    case "$leaf" in ''|.|..) selftest_fixture_refused "$requested" 'ambiguous destination'; return 2;; esac
    suffix="/$leaf$suffix"
    existing="$(dirname "$existing")"
  done
  canon="$(cd "$existing" 2>/dev/null && pwd -P)" || { selftest_fixture_refused "$requested" 'destination ancestor is not a directory'; return 2; }
  canon="$canon$suffix"
  cursor="$canon"
  while [ "$cursor" != / ]; do
    if [ -e "$cursor/.wheelhouse-selftest-fixture" ] || [ -L "$cursor/.wheelhouse-selftest-fixture" ]; then
      if ! selftest_require_fixture_owner "$cursor"; then
        selftest_fixture_refused "$requested" "destination is not owned by this run (allocation $cursor)"
        return 2
      fi
      printf '%s\n' "$canon"
      return 0
    fi
    cursor="$(dirname "$cursor")"
  done
  selftest_fixture_refused "$requested" 'destination is outside this run allocation'
}

selftest_recheck_fixture_path() {
  local expected="$1" resolved
  resolved="$(selftest_owned_fixture_path "$expected")" || return 2
  [ "$resolved" = "$expected" ] && [ ! -L "$expected" ] || { selftest_fixture_refused "$expected" 'destination path changed'; return 2; }
}

selftest_make_fixture_dir() {
  template="${1:-}"
  # Stale-reclaiming suites can record their stable suite name rather than
  # a pid-bearing mktemp pattern. Other callers keep their existing metadata.
  local allocation_prefix="${2:-${template##*/}}"
  case "$allocation_prefix" in ''|*$'\n'*) selftest_fixture_refused "$template" 'invalid allocation prefix'; return 2;; esac
  selftest_fixture_nonce_valid || { selftest_fixture_refused "$template" 'parent shell run nonce is missing or invalid'; return 2; }
  export WHEELHOUSE_SELFTEST_FIXTURE_NONCE
  [ -n "$template" ] || { echo "STOP: mktemp fixture template is empty" >&2; return 2; }
  made="$(mktemp -d "$template")" || { echo "STOP: mktemp failed for fixture template: $template" >&2; return 2; }
  [ -n "$made" ] || selftest_fixture_refused "$made" "mktemp returned an empty path" || return 2
  fixture="$(cd "$made" && pwd -P)" || { echo "STOP: could not canonicalize fixture path: $made" >&2; return 2; }
  cwd="$SELFTEST_INVOCATION_PWD"
  repo="$(selftest_lib_root)"
  [ "$fixture" != "/" ] || selftest_fixture_refused "$fixture" "refuses filesystem root" || return 2
  if selftest_path_contains "$fixture" "$cwd"; then selftest_fixture_refused "$fixture" "fixture would contain caller cwd $cwd" || return 2; fi
  if selftest_path_contains "$fixture" "$repo"; then selftest_fixture_refused "$fixture" "fixture would contain repository root $repo" || return 2; fi
  case "$fixture${template##*/}" in *$'\n'*) selftest_fixture_refused "$fixture" 'newline in allocation metadata'; return 2;; esac
  started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" || { selftest_fixture_refused "$fixture" 'could not record allocation time'; return 2; }
  if ! (set -o noclobber; printf 'prefix=%s\npid=%s\nstarted=%s\nnonce=%s\nroot=%s\n' \
    "$allocation_prefix" "$$" "$started" "$WHEELHOUSE_SELFTEST_FIXTURE_NONCE" "$fixture" > "$fixture/.wheelhouse-selftest-fixture"); then
    selftest_fixture_refused "$fixture" 'could not exclusively publish allocation marker'; return 2
  fi
  printf '%s\n' "$fixture"
}
# A stale owner needs TWO native absence observations. Only the captured C
# locale ESRCH message is definitive; EPERM and unknown failures stay alive.
selftest_stale_owner_gone() {
  local pid="$1" killed kill_rc ps_output ps_rc
  killed="$(LC_ALL=C kill -0 "$pid" 2>&1)"; kill_rc=$?
  if [ "$kill_rc" = 0 ]; then SELFTEST_STALE_REASON='owner is alive'; return 1; fi
  case "$killed" in
    *' - No such process') ;;
    *'Operation not permitted'*|*'Permission denied'*) SELFTEST_STALE_REASON='owner permission denied (alive)'; return 1 ;;
    *) SELFTEST_STALE_REASON='owner liveness is unknown'; return 1 ;;
  esac
  # Diagnostics are intentionally retained with output: ANY nonempty channel
  # is a refusal, never counted as an empty process inventory.
  ps_output="$(LC_ALL=C ps -p "$pid" -o pid= 2>&1)"; ps_rc=$?
  if [ "$ps_rc" != 1 ] || [ -n "$ps_output" ]; then SELFTEST_STALE_REASON='ps did not prove owner absent'; return 1; fi
  SELFTEST_STALE_REASON=''
  return 0
}

selftest_stale_marker_matches() {
  local dir="$1" prefix="$2" pid="$3" marker="$1/.wheelhouse-selftest-fixture"
  local p n started nonce root extra
  SELFTEST_STALE_REASON='missing or non-regular root allocation marker'
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  SELFTEST_STALE_REASON='malformed allocation marker'
  if ! {
    IFS= read -r -n 4096 p && IFS= read -r -n 4096 n &&
    IFS= read -r -n 4096 started && IFS= read -r -n 4096 nonce &&
    IFS= read -r -n 4096 root && ! IFS= read -r -n 4096 extra && [ -z "$extra" ]
  } < "$marker"; then return 1; fi
  [ "$p" = "prefix=$prefix" ] || { SELFTEST_STALE_REASON='allocation prefix mismatch'; return 1; }
  [ "$n" = "pid=$pid" ] || { SELFTEST_STALE_REASON='allocation pid mismatch'; return 1; }
  case "$started" in started=????-??-??T??:??:??Z) ;; *) return 1;; esac
  case "$nonce" in nonce=*) nonce="${nonce#nonce=}";; *) return 1;; esac
  [ "${#nonce}" = 32 ] || return 1
  case "$nonce" in *[!0-9a-f]*) return 1;; esac
  [ "$root" = "root=$dir" ] || { SELFTEST_STALE_REASON='allocation root mismatch'; return 1; }
  SELFTEST_STALE_REASON=''
  return 0
}

# Reclaim only a prior selftest allocation recorded at this exact root. This
# is distinct from current-run removal: a dead run necessarily has another
# nonce. Name/pid alone, an ancestor marker or copied marker never authorizes it.
selftest_sweep_stale_fixtures() {
  local prefix="${1:-}" base="${TMPDIR:-/tmp}" d stamp phys sf pid
  local SELFTEST_STALE_REASON='' marker_before marker_after
  case "$prefix" in ''|*[!a-zA-Z0-9_-]*) echo 'STOP: invalid stale fixture prefix' >&2; return 2;; esac
  base="$(cd "$base" && pwd -P)" || { echo 'STOP: cannot inspect stale fixture TMPDIR' >&2; return 2; }
  while IFS= read -r -d '' d; do
    if [ ! -d "$d" ] || [ -L "$d" ]; then echo "skipped: $d (not a physical directory)"; continue; fi
    # Holding cwd pins the original directory inode for rechecks, so observed
    # same-name replacements are rejected before removal.
    (
    cd "$d" 2>/dev/null || { echo "skipped: $d (cannot inspect directory)"; exit 0; }
    phys="$(pwd -P)"
    stamp="${d##*/}"; stamp="${stamp#"$prefix".}"; stamp="${stamp%%.*}"
    case "$stamp" in ''|0|0*|*[!0-9]*) echo "skipped: $d (invalid owner pid in name)"; exit 0;; esac
    if [ "${#stamp}" -gt 10 ] || [ "$stamp" -gt 2147483647 ]; then echo "skipped: $d (invalid owner pid in name)"; exit 0; fi
    if ! selftest_stale_marker_matches "$phys" "$prefix" "$stamp" || ! selftest_stale_owner_gone "$stamp"; then
      echo "skipped: $d ($SELFTEST_STALE_REASON)"; exit 0
    fi
    marker_before="$(<"$phys/.wheelhouse-selftest-fixture")"
    if [ -L "$d" ] || [ ! . -ef "$phys" ]; then echo "skipped: $d (allocation directory changed)"; exit 0; fi
    # Retain the existing per-suite seat rule: recorded state pid AND native
    # lsof proof under this already-authorized fixture, never bare kill -0.
    while IFS= read -r sf; do
      [ -f "$sf" ] || continue
      for pid in $(sed -n 's/.*"pid": \([0-9][0-9]*\).*/\1/p' "$sf"); do
        if kill -0 "$pid" 2>/dev/null && lsof -p "$pid" 2>/dev/null | grep -F >/dev/null "$phys"; then
          kill "$pid" 2>/dev/null
          echo "swept: killed leaked seat pid $pid (held open files under $d)"
        fi
      done
    done < <(find "$phys" -mindepth 3 -maxdepth 3 -path '*/seats/state.json' 2>/dev/null)
    # Recheck after any process cleanup and before deleting. A missing/changed
    # marker or a newly live/reused owner is not permission to keep going.
    if ! selftest_stale_marker_matches "$phys" "$prefix" "$stamp" || ! selftest_stale_owner_gone "$stamp" || [ -L "$d" ] || [ ! . -ef "$phys" ]; then
      echo "skipped: $d (${SELFTEST_STALE_REASON:-allocation changed})"; exit 0
    fi
    marker_after="$(<"$phys/.wheelhouse-selftest-fixture")"
    if [ "$marker_before" != "$marker_after" ]; then echo "skipped: $d (allocation marker changed)"; exit 0; fi
    rm -rf "$phys" || exit 2
    echo "swept: removed stale fixture $d"
    ) || return 2
  done < <(find "$base" -mindepth 1 -maxdepth 1 -name "$prefix.*" -print0)
}

# Metrics are global bd configuration, not per-graph state. bd 1.2.2 writes
# HOME/.config/bd even with a different XDG_CONFIG_HOME, so pin BOTH to an
# owned fixture before init; exporting XDG alone is not sufficient.
selftest_disable_bd_metrics() {
  local metrics_root="${1:-}" metrics_home="${2:-${1:-}/home}"
  [ -n "$metrics_root" ] && [ -d "$metrics_root" ] && selftest_has_fixture_marker "$metrics_root" || { echo 'STOP: bd metrics config needs an owned fixture' >&2; return 2; }
  mkdir -p "$metrics_home" || return 2
  metrics_home="$(cd "$metrics_home" && pwd -P)" || return 2
  selftest_has_fixture_marker "$metrics_home" || { echo 'STOP: bd metrics HOME needs an owned fixture' >&2; return 2; }
  export HOME="$metrics_home" XDG_CONFIG_HOME="$metrics_home/.config"
  (cd "$metrics_root" && bd metrics off > "$metrics_root/bd-metrics-off.out" 2> "$metrics_root/bd-metrics-off.err") || { echo 'STOP: could not disable fixture bd metrics' >&2; return 2; }
}

# Call in the parent shell: selftest_make_fixture_dir usually runs in $(...),
# so an export there would be lost. Children (including runtime/stub git) inherit
# this boundary. Include the parent too: git starting AT a ceiling ignores it.
selftest_isolate_git() {
  git_fixture="$(cd "$1" && pwd -P)" || return 2
  [ -f "$git_fixture/.wheelhouse-selftest-fixture" ] || { echo "STOP: git isolation needs a marked fixture: $git_fixture" >&2; return 2; }
  export GIT_CEILING_DIRECTORIES="$git_fixture:$(dirname "$git_fixture")${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}"
}

selftest_copy_seat_runtime() {
  dest_root="${1:-}"
  src_seats="${2:-$(selftest_lib_root)/seats}"
  [ -n "$dest_root" ] || { echo "STOP: selftest_copy_seat_runtime needs destination root" >&2; return 2; }
  [ -d "$src_seats" ] || { echo "STOP: selftest_copy_seat_runtime source missing: $src_seats" >&2; return 2; }
  local dest_seats child
  dest_root="$(selftest_owned_fixture_path "$dest_root")" || return 2
  dest_seats="$(selftest_owned_fixture_path "$dest_root/seats")" || return 2
  # Preflight both replacement trees, before even copying top-level files.
  for child in "$dest_root/seats" "$dest_seats/drivers" "$dest_seats/transports"; do
    [ ! -L "$child" ] || { selftest_fixture_refused "$child" 'symlinked runtime destination'; return 2; }
    selftest_owned_fixture_path "$child" >/dev/null || return 2
  done
  mkdir -p "$dest_seats" || return 2
  find "$src_seats" -maxdepth 1 \( -name '*.ts' -o -name '*.sh' \) ! -name '*.selftest.sh' -type f -exec cp -f {} "$dest_seats/" \;
  [ ! -d "$src_seats/drivers" ] || { selftest_recheck_fixture_path "$dest_seats/drivers" || return 2; rm -rf "$dest_seats/drivers"; cp -R "$src_seats/drivers" "$dest_seats/drivers"; }
  [ ! -d "$src_seats/transports" ] || { selftest_recheck_fixture_path "$dest_seats/transports" || return 2; rm -rf "$dest_seats/transports"; cp -R "$src_seats/transports" "$dest_seats/transports"; }
}

selftest_shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\''/g")"; }

selftest_scratch_graph() {
  graph_root="${1:-}"
  [ -n "$graph_root" ] || { echo "STOP: selftest_scratch_graph needs a destination directory" >&2; return 2; }
  bd_bin="$(command -v bd 2>/dev/null || true)"
  [ -n "$bd_bin" ] || { echo "STOP: selftest_scratch_graph requires bd on PATH" >&2; return 2; }
  graph_root="$(selftest_owned_fixture_path "$graph_root")" || return 2
  [ ! -e "$graph_root/.wheelhouse-selftest-fixture" ] && [ ! -L "$graph_root/.wheelhouse-selftest-fixture" ] || { selftest_fixture_refused "$graph_root" 'cannot reset an allocation root'; return 2; }
  parent="$(dirname "$graph_root")"
  mkdir -p "$parent" || { echo "STOP: selftest_scratch_graph could not create parent: $parent" >&2; return 2; }
  repo="$(selftest_lib_root)"
  cwd="$SELFTEST_INVOCATION_PWD"
  if selftest_path_contains "$graph_root" "$repo" || selftest_path_contains "$graph_root" "$cwd"; then
    echo "STOP: selftest_scratch_graph destination must be outside the install/worktree: $graph_root" >&2
    return 2
  fi
  # Recheck immediately before reset; an ancestor's generic marker is not proof.
  selftest_owned_fixture_path "$graph_root" >/dev/null || return 2
  rm -rf "$graph_root"
  mkdir -p "$graph_root"
  selftest_disable_bd_metrics "$graph_root" || return 2
  GIT_CEILING_DIRECTORIES="$parent:$(dirname "$parent")${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}" git -C "$graph_root" init -q
  init_log="$graph_root/bd-init.log"
  if ! (cd "$graph_root" && "$bd_bin" init --non-interactive --skip-agents -p scratch) >"$init_log" 2>&1; then
    echo "STOP: bd init failed for scratch graph $graph_root:" >&2
    cat "$init_log" >&2
    return 2
  fi
  wrapper_dir="$graph_root/bin"
  mkdir -p "$wrapper_dir"
  cat > "$wrapper_dir/bd" <<EOF
#!/usr/bin/env bash
exec $(selftest_shell_quote "$bd_bin") -C $(selftest_shell_quote "$graph_root") "\$@"
EOF
  chmod +x "$wrapper_dir/bd"
  printf 'export HOME=%s\n' "$(selftest_shell_quote "$HOME")"
  printf 'export XDG_CONFIG_HOME=%s\n' "$(selftest_shell_quote "$XDG_CONFIG_HOME")"
  printf 'export WHEELHOUSE_SELFTEST_BD_ROOT=%s\n' "$(selftest_shell_quote "$graph_root")"
  printf 'export PATH=%s:"$PATH"\n' "$(selftest_shell_quote "$wrapper_dir")"
}

selftest_remove_fixture_dir() {
  fixture="${1:-}"
  [ -n "$fixture" ] || return 0
  [ -e "$fixture" ] || [ -L "$fixture" ] || return 0
  canon="$(cd "$fixture" 2>/dev/null && pwd -P)" || { selftest_fixture_refused "$fixture" 'cannot canonicalize allocation'; return 2; }
  selftest_require_fixture_owner "$canon" || return 2
  cwd="$SELFTEST_INVOCATION_PWD"; repo="$(selftest_lib_root)"
  [ "$canon" != "/" ] || selftest_fixture_refused "$canon" "refuses filesystem root" || return 2
  if selftest_path_contains "$canon" "$cwd"; then selftest_fixture_refused "$canon" "fixture would contain caller cwd $cwd" || return 2; fi
  if selftest_path_contains "$canon" "$repo"; then selftest_fixture_refused "$canon" "fixture would contain repository root $repo" || return 2; fi
  selftest_require_fixture_owner "$canon" || return 2
  rm -rf "$canon"
}

selftest_fixture_processes() {
  root="${1:-}"
  [ -n "$root" ] || return 0
  caller_pid="${BASHPID:-$$}"
  (
    cd / || exit 0
    {
      ps axww -o pid=,command= | grep -F "$root" | grep -v 'grep -F' | grep -v 'awk -v root' || true
      lsof_bin="$(command -v lsof 2>/dev/null || true)"
      [ -n "$lsof_bin" ] || lsof_bin="/usr/sbin/lsof"
      if [ -x "$lsof_bin" ]; then
        lsof_out="${TMPDIR:-/tmp}/wheelhouse-selftest-lsof.$$.out"
        "$lsof_bin" -d cwd -Fpcn > "$lsof_out" 2>/dev/null || true
        awk -v root="$root" '
          function flush(){ if(pid && cwd && (cwd == root || index(cwd, root "/") == 1)) print pid " " cmd " [cwd " cwd "]" }
          /^p/ { flush(); pid=substr($0,2); cmd="?"; cwd=""; next }
          /^c/ { cmd=substr($0,2); next }
          /^n/ { cwd=substr($0,2); next }
          END { flush() }
        ' "$lsof_out" 2>/dev/null || true
        rm -f "$lsof_out"
      fi
    } | awk -v self="$$" -v caller="$caller_pid" '$1 != self && $1 != caller && !seen[$1]++'
  )
}

selftest_stop_fixture_adapters() {
  root="${1:-}"
  [ -n "$root" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  [ -d "$root" ] || return 0
  while IFS= read -r state; do
    seats_dir="$(dirname "$state")"
    adapter="$seats_dir/adapter.ts"
    [ -f "$adapter" ] || continue
    (cd "$(dirname "$seats_dir")" && bun seats/adapter.ts stop-all >/dev/null 2>&1) || true
  done <<EOF
$(find "$root" -path '*/seats/state.json' -type f 2>/dev/null)
EOF
}

selftest_cleanup_fixture_processes() {
  root="${1:-}"
  shift || true
  [ -n "$root" ] || return 0
  [ -e "$root" ] || [ -L "$root" ] || return 0
  local canonical_root
  canonical_root="$(cd "$root" 2>/dev/null && pwd -P)" || { selftest_fixture_refused "$root" 'cannot canonicalize allocation'; return 2; }
  root="$canonical_root"
  selftest_require_fixture_owner "$root" || return 2

  selftest_stop_fixture_adapters "$root"

  for sock in "$@"; do
    [ -n "${sock:-}" ] || continue
    tmux -L "$sock" kill-server >/dev/null 2>&1 || true
  done

  pids="$(selftest_fixture_processes "$root" | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  sleep 0.2
  pids="$(selftest_fixture_processes "$root" | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill -9 $pids >/dev/null 2>&1 || true
  sleep 0.1

  leaks="$(selftest_fixture_processes "$root" || true)"
  if [ -n "$leaks" ]; then
    sleep 0.2
    stable=""
    while IFS= read -r line; do
      pid="${line%% *}"
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && stable="${stable}${stable:+
}$line"
    done <<EOF
$leaks
EOF
    if [ -n "$stable" ]; then
      echo "selftest cleanup leak under $root:" >&2
      printf '%s\n' "$stable" >&2
      return 1
    fi
  fi
  return 0
}

# Admission happens on source, before fixture allocation or suite work. A
# supervisor owns the lock so a suite's later traps/exec cannot replace release.
selftest_admit_suite() {
  local helper="${WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:-$(selftest_lib_root)/seats/selftest-sweep-lock.ts}"
  local lock="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-/tmp/wheelhouse-selftest-sweep.lock}" rc option
  local options=()
  [ -r "$helper" ] || { echo "STOP: selftest lock helper missing or unreadable: $helper" >&2; exit 2; }
  if bun "$helper" inherited "$lock"; then return 0; else rc=$?; fi
  [ "$rc" -eq 75 ] || exit "$rc"
  # Preserve active shell options without exporting them into unrelated child
  # programs. Both normal suite scripts and bash -c library consumers re-enter
  # through the verified ancestor path; no trusted 'already locked' env flag.
  for option in ${SHELLOPTS//:/ }; do options+=( -o "$option" ); done
  if [ -n "${BASH_EXECUTION_STRING:-}" ]; then
    exec bun "$helper" supervise "$lock" "$BASH" "${options[@]}" -c "$BASH_EXECUTION_STRING" "$0" "$@"
  elif [ -f "$0" ]; then
    exec bun "$helper" supervise "$lock" "$BASH" "${options[@]}" -- "$0" "$@"
  else
    echo 'STOP: selftest admission requires a Bash script or bash -c invocation' >&2
    exit 2
  fi
}
selftest_admit_suite "$@"
