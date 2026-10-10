#!/usr/bin/env bash
set -u

ROOT="${1:-$(pwd -P)}"
JSON=0
[ "${1:-}" = "--json" ] && { JSON=1; ROOT="${2:-$(pwd -P)}"; }
[ "${2:-}" = "--json" ] && JSON=1
SRC_FILE="$ROOT/wheelhouse/.template-source"

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'; }
fail_compare() {
  msg="$1"
  if [ "$JSON" = 1 ]; then printf '{"error":%s,"modified":[],"localOnly":[],"missing":[],"aheadBy":null,"comparedAgainst":null}\n' "$(printf '%s' "$msg" | json_escape)"; else printf 'DRIFT: cannot compare (%s)\n' "$msg"; fi
  exit 3
}

[ -f "$SRC_FILE" ] || fail_compare "missing wheelhouse/.template-source"
source_url=""; commit=""; template_path=""
while IFS='=' read -r k v; do
  case "$k" in source) source_url="$v" ;; commit) commit="$v" ;; path) template_path="$v" ;; esac
done < "$SRC_FILE"
[ -n "$commit" ] || fail_compare "missing commit= in .template-source"

REPO=""
if [ -n "$template_path" ] && git -C "$template_path" cat-file -e "$commit^{commit}" >/dev/null 2>&1; then
  REPO="$template_path"
else
  [ -n "$source_url" ] || fail_compare "path= lacks commit and source= is missing"
  cache="$ROOT/wheelhouse/.template-cache"
  mkdir -p "$cache" 2>/dev/null || fail_compare "cannot create template cache"
  if [ ! -d "$cache/repo.git" ]; then git init --bare "$cache/repo.git" >/dev/null 2>&1 || fail_compare "cannot initialise template cache"; fi
  git -C "$cache/repo.git" fetch --quiet "$source_url" "$commit" >/dev/null 2>&1 || fail_compare "cannot fetch $commit from source"
  git -C "$cache/repo.git" cat-file -e "$commit^{commit}" >/dev/null 2>&1 || fail_compare "fetched source lacks $commit"
  REPO="$cache/repo.git"
fi

is_wanted() {
  case "$1" in
    seats/*/*.ts|seats/*/*.sh) case "$1" in seats/transports/*|seats/drivers/*) return 0;; esac ;;
    seats/*) case "${1#seats/}" in */*) return 1;; *.ts|*.sh) return 0;; esac ;;
    runbooks/*) case "${1#runbooks/}" in */*) return 1;; *.md) return 0;; esac ;;
    wheelhouse/crew/*.md) case "${1#wheelhouse/crew/}" in */*) return 1;; *) return 0;; esac ;;
    wheelhouse/fleet/*.md) case "${1#wheelhouse/fleet/}" in */*) return 1;; *) return 0;; esac ;;
    wheelhouse/*.md) case "${1#wheelhouse/}" in */*) return 1;; *) return 0;; esac ;;
  esac
  return 1
}
is_contract_half() { case "$1" in wheelhouse/crew/*.md) case "${1#wheelhouse/crew/}" in */*) return 1;; *) return 0;; esac;; wheelhouse/fleet/*.md) case "${1#wheelhouse/fleet/}" in */*) return 1;; *) return 0;; esac;; wheelhouse/*.md) case "${1#wheelhouse/}" in */*) return 1;; *) return 0;; esac;; *) return 1;; esac; }
split_contract() { awk 'BEGIN{p=1} /^## This project$/{p=0} p{print}' "$1"; }
template_content() {
  p="$1"
  if is_contract_half "$p"; then git -C "$REPO" show "$commit:$p" 2>/dev/null | awk 'BEGIN{p=1} /^## This project$/{p=0} p{print}'
  else git -C "$REPO" show "$commit:$p" 2>/dev/null
  fi
}
install_content() { if is_contract_half "$1"; then split_contract "$ROOT/$1"; else cat "$ROOT/$1"; fi; }

TMP="${TMPDIR:-/tmp}/wheelhouse-template-drift.$$"; mkdir -p "$TMP" || exit 2
trap 'rm -rf "$TMP"' EXIT INT TERM
: > "$TMP/install"; : > "$TMP/template"
( cd "$ROOT" && find seats runbooks wheelhouse -type f 2>/dev/null | while read -r p; do is_wanted "$p" && printf '%s\n' "$p"; done ) | sort > "$TMP/install"
git -C "$REPO" ls-tree -r --name-only "$commit" -- seats runbooks wheelhouse 2>/dev/null | while read -r p; do is_wanted "$p" && printf '%s\n' "$p"; done | sort > "$TMP/template"

modified=""; local_only=""; missing=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if ! grep -qxF "$p" "$TMP/template"; then local_only="${local_only}${p}
"; continue; fi
  template_content "$p" > "$TMP/t"; install_content "$p" > "$TMP/i"
  cmp -s "$TMP/t" "$TMP/i" || modified="${modified}${p}
"
done < "$TMP/install"
while IFS= read -r p; do
  [ -n "$p" ] || continue
  grep -qxF "$p" "$TMP/install" || missing="${missing}${p}
"
done < "$TMP/template"

ahead="null"; headref=""
for ref in main origin/main refs/heads/main refs/remotes/origin/main; do
  if git -C "$REPO" rev-parse --verify -q "$ref^{commit}" >/dev/null 2>&1; then headref="$ref"; break; fi
done
if [ -n "$headref" ]; then ahead="$(git -C "$REPO" rev-list --count "$commit..$headref" 2>/dev/null || printf null)"; [ -n "$ahead" ] || ahead=null; fi

if [ "$JSON" = 1 ]; then
  python3 - "$commit" "$ahead" "$modified" "$local_only" "$missing" <<'PY'
import json,sys
commit,ahead,mod,loc,mis=sys.argv[1:6]
def lines(s): return [x for x in s.split('\n') if x]
print(json.dumps({"modified":lines(mod),"localOnly":lines(loc),"missing":lines(mis),"aheadBy":(None if ahead=='null' else int(ahead)),"comparedAgainst":commit}, indent=2))
PY
else
  printf '%s' "$modified" | while IFS= read -r p; do [ -n "$p" ] && printf 'MODIFIED %s\n' "$p"; done
  printf '%s' "$local_only" | while IFS= read -r p; do [ -n "$p" ] && printf 'LOCAL-ONLY %s\n' "$p"; done
  printf '%s' "$missing" | while IFS= read -r p; do [ -n "$p" ] && printf 'MISSING %s\n' "$p"; done
  if [ "$ahead" != null ] && [ "$ahead" != 0 ]; then printf 'template main is %s commits ahead of %s\n' "$ahead" "$commit"; fi
fi
[ -z "$modified$local_only$missing" ] && { [ "$ahead" = null ] || [ "$ahead" = 0 ]; } && exit 0
exit 1
