#!/usr/bin/env bash
set -u

run_case() {
  name=$1
  setup=$2
  root=$TMPDIR_ROOT/$name
  mkdir -p "$root/wheelhouse/fleet"
  cat > "$root/wheelhouse/fleet/WORKER.md.new" <<'EOF'
# New contract

contract line
## This project

new scaffold
### New upstream heading
EOF
  case "$setup" in
    normal)
      cat > "$root/wheelhouse/fleet/WORKER.md" <<'EOF'
# Old contract

old contract line
## This project

kept project line
EOF
      ;;
    headingless)
      cat > "$root/wheelhouse/fleet/WORKER.md" <<'EOF'
# Hand-built brief

local content without the expected heading
EOF
      ;;
    absent)
      rm -f "$root/wheelhouse/fleet/WORKER.md"
      ;;
  esac

  (
    cd "$root" || exit 99
    targets=(wheelhouse/fleet/WORKER.md)
    for target in "${targets[@]}"; do
      [ -e "$target" ] || continue
      heading_count=$(grep -cx '## This project' "$target" || true)
      case "$heading_count" in
        1) ;;
        0)
          echo "STOP: existing contract has no '## This project' heading: $target" >&2
          echo "Adopt it first: copy the new contract half whole, then hand-fold the existing content under a freshly added '## This project' heading as described above." >&2
          exit 1
          ;;
        *)
          first_heading=$(grep -n '^## This project$' "$target" | head -1 | cut -d: -f1)
          echo "STOP: existing contract has $heading_count '## This project' headings: $target" >&2
          echo "The splice uses the first exact heading (line $first_heading); remove or rename the later duplicate before continuing." >&2
          exit 1
          ;;
      esac
    done

    splice() {
      if [ ! -e "$2" ]; then
        cp "$1" "$2"; echo "new, copied whole: $2"; return
      fi
      diff <(awk 'f&&/^##+ /{print} /^## This project$/{f=1}' "$2") \
           <(awk 'f&&/^##+ /{print} /^## This project$/{f=1}' "$1") \
        | sed -n "s|^> |project section UPSTREAM, not in yours — $2: |p"
      awk '/^## This project$/{exit} {print}' "$1"  >  "$2.tmp"
      awk 'f{print} /^## This project$/{f=1; print}' "$2" >> "$2.tmp"
      mv "$2.tmp" "$2"
    }
    splice wheelhouse/fleet/WORKER.md.new wheelhouse/fleet/WORKER.md
  )
  status=$?
  echo "[$name] exit=$status"
  if [ -e "$root/wheelhouse/fleet/WORKER.md" ]; then
    echo "[$name] headings=$(grep -cx '## This project' "$root/wheelhouse/fleet/WORKER.md" || true)"
    echo "[$name] content:"
    sed 's/^/    /' "$root/wheelhouse/fleet/WORKER.md"
  fi
}

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT
run_case normal normal
run_case headingless headingless
run_case absent absent
