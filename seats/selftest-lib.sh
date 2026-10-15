#!/usr/bin/env bash
# Shared teardown helpers for wheelhouse selftests.
# Source this file, then call selftest_cleanup_fixture_processes "$FIX" [tmux-socket...]
# from the selftest's EXIT trap before deleting the fixture root.
# Removal also drains fixture-owned processes, including for older traps which
# only called selftest_remove_fixture_dir. Direct children are waited/reaped.

SELFTEST_INVOCATION_PWD="${SELFTEST_INVOCATION_PWD:-$(pwd -P)}"

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
selftest_make_fixture_dir() {
  template="${1:-}"
  [ -n "$template" ] || { echo "STOP: mktemp fixture template is empty" >&2; return 2; }
  made="$(mktemp -d "$template")" || { echo "STOP: mktemp failed for fixture template: $template" >&2; return 2; }
  [ -n "$made" ] || selftest_fixture_refused "$made" "mktemp returned an empty path" || return 2
  fixture="$(cd "$made" && pwd -P)" || { echo "STOP: could not canonicalize fixture path: $made" >&2; return 2; }
  cwd="$SELFTEST_INVOCATION_PWD"
  repo="$(selftest_lib_root)"
  [ "$fixture" != "/" ] || selftest_fixture_refused "$fixture" "refuses filesystem root" || return 2
  if selftest_path_contains "$fixture" "$cwd"; then selftest_fixture_refused "$fixture" "fixture would contain caller cwd $cwd" || return 2; fi
  if selftest_path_contains "$fixture" "$repo"; then selftest_fixture_refused "$fixture" "fixture would contain repository root $repo" || return 2; fi
  : > "$fixture/.wheelhouse-selftest-fixture"
  printf '%s\n' "$fixture"
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
  mkdir -p "$dest_root/seats"
  find "$src_seats" -maxdepth 1 \( -name '*.ts' -o -name '*.sh' \) ! -name '*.selftest.sh' -type f -exec cp -f {} "$dest_root/seats/" \;
  [ ! -d "$src_seats/drivers" ] || { rm -rf "$dest_root/seats/drivers"; cp -R "$src_seats/drivers" "$dest_root/seats/drivers"; }
  [ ! -d "$src_seats/transports" ] || { rm -rf "$dest_root/seats/transports"; cp -R "$src_seats/transports" "$dest_root/seats/transports"; }
}

selftest_shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\''/g")"; }

selftest_scratch_graph() {
  graph_root="${1:-}"
  [ -n "$graph_root" ] || { echo "STOP: selftest_scratch_graph needs a destination directory" >&2; return 2; }
  bd_bin="$(command -v bd 2>/dev/null || true)"
  [ -n "$bd_bin" ] || { echo "STOP: selftest_scratch_graph requires bd on PATH" >&2; return 2; }
  parent="$(dirname "$graph_root")"
  mkdir -p "$parent" || { echo "STOP: selftest_scratch_graph could not create parent: $parent" >&2; return 2; }
  graph_root="$(cd "$parent" && pwd -P)/$(basename "$graph_root")"
  repo="$(selftest_lib_root)"
  cwd="$SELFTEST_INVOCATION_PWD"
  if selftest_path_contains "$graph_root" "$repo" || selftest_path_contains "$graph_root" "$cwd"; then
    echo "STOP: selftest_scratch_graph destination must be outside the install/worktree: $graph_root" >&2
    return 2
  fi
  if ! selftest_has_fixture_marker "$parent"; then
    echo "STOP: selftest_scratch_graph destination must live under selftest_make_fixture_dir: $graph_root" >&2
    return 2
  fi
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
  canon="$(cd "$fixture" 2>/dev/null && pwd -P)" || return 0
  [ -f "$canon/.wheelhouse-selftest-fixture" ] || { echo "STOP: refusing to remove fixture path not made by selftest_make_fixture_dir: $canon" >&2; return 2; }
  cwd="$SELFTEST_INVOCATION_PWD"; repo="$(selftest_lib_root)"
  [ "$canon" != "/" ] || selftest_fixture_refused "$canon" "refuses filesystem root" || return 2
  if selftest_path_contains "$canon" "$cwd"; then selftest_fixture_refused "$canon" "fixture would contain caller cwd $cwd" || return 2; fi
  if selftest_path_contains "$canon" "$repo"; then selftest_fixture_refused "$canon" "fixture would contain repository root $repo" || return 2; fi
  selftest_cleanup_fixture_processes "$canon" || return 2
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

  selftest_stop_fixture_adapters "$root"

  for sock in "$@"; do
    [ -n "${sock:-}" ] || continue
    tmux -L "$sock" kill-server >/dev/null 2>&1 || true
  done

  local fixture_children="" fixture_pid
  pids="$(selftest_fixture_processes "$root" | awk '{print $1}' | tr '\n' ' ')"
  fixture_children="$pids"
  [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  sleep 0.2
  pids="$(selftest_fixture_processes "$root" | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill -9 $pids >/dev/null 2>&1 || true
  fixture_children="$fixture_children $pids"
  # wait accepts only our own children; detached descendants are checked below.
  # Preserve the first snapshot too: TERM may have removed them from the second.
  for fixture_pid in $fixture_children; do wait "$fixture_pid" 2>/dev/null || true; done
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
