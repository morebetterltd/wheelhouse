#!/usr/bin/env bash
#
# seat-env.sh — provision one Pi seat: an isolated per-account agent directory.
#
# A seat is an account, and Pi keeps an account's identity in auth.json inside
# its agent directory (~/.pi/agent by default). PI_CODING_AGENT_DIR relocates
# that whole tree — auth.json, settings, sessions, extensions — per process,
# which is the entire isolation mechanism: one directory per seat, one account
# per directory, and two processes pointed at different directories cannot
# share or clobber each other's identity.
#
# This script creates the directory for one seat, pre-grants trust for the
# project root, and prints the two lines the operator needs: the export that
# points a process at the seat, and the one-time login. The trust grant must
# exist before the first run because a headless run with no trust does NOT
# stall or error — it silently skips the project's .pi/ resources (config,
# SYSTEM.md), and nothing in the output says so: the seat just behaves as if
# the project had none. Pi matches trust keys against the CANONICALIZED cwd,
# so the root is resolved through pwd -P before it is written — a symlinked
# path (/tmp vs /private/tmp) would write a key pi never matches, which is
# the same silent skip by another door. The script never writes auth.json —
# only `pi /login` may do that — and it refuses to disturb one that holds an
# identity, because auth.json IS the seat's identity and overwriting it with
# a different account has no undo.
#
# Usage: seat-env.sh <namespace> <seat-name> [project-root]
#
#   namespace     this project's seat namespace, recorded as namespace= in
#                 wheelhouse/.template-source; directories land under
#                 $HOME/.pi-seats-<namespace>/ so two fleets on one machine
#                 cannot reach into each other's seats
#   seat-name     the seat, as named in seats/seats.json
#   project-root  absolute directory to pre-grant trust for; defaults to the
#                 top of the git checkout you run this from, else the cwd
#
# Idempotent: re-running for an existing seat changes nothing and exits 0.
# Exit 0 = seat directory ready. Non-zero = a STOP line says what and why.

set -u

die()  { printf 'STOP: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

# --- pi must exist before anything writes -----------------------------------
# Same shape as BOOTSTRAP.md's preflight: a MISSING line is a STOP, and it
# names why the tool is needed and how to get it, because a bare
# `command not found` halfway through leaves a half-made seat.
if command -v pi >/dev/null 2>&1; then
  note "OK      pi — $(command -v pi)"
else
  echo "MISSING pi"
  echo "        seats run on the Pi coding agent; without it there is no login to run"
  echo "        install it: npm install -g @earendil-works/pi-coding-agent   # or see https://github.com/earendil-works/pi"
  exit 1
fi

# --- arguments ---------------------------------------------------------------
ns="${1:-}"
seat="${2:-}"
root="${3:-}"
if [ -z "$ns" ] || [ -z "$seat" ]; then
  die "usage: seat-env.sh <namespace> <seat-name> [project-root]"
fi
# Each becomes exactly one path segment under $HOME; a separator or a dot-dot
# in either would silently land the seat somewhere else.
case "$ns/$seat" in
  *..*|*" "*) die "namespace and seat-name become one path segment each; no '..' or spaces in: $ns / $seat" ;;
esac
case "$ns" in */*) die "namespace must be a single path segment, got: $ns" ;; esac
case "$seat" in */*) die "seat-name must be a single path segment, got: $seat" ;; esac

if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
case "$root" in
  /*) : ;;
  *) die "project root must be an absolute path, got: $root" ;;
esac
[ -d "$root" ] || die "project root does not exist: $root — trust granted to a path that is not there protects nothing and hides a typo"

# Canonicalize before writing: pi matches trust keys against the CANONICALIZED
# cwd, so a symlinked root (/tmp vs /private/tmp) would write a key pi never
# matches — the grant would exist and protect nothing.
root="$(cd "$root" && pwd -P)" || die "could not resolve the physical path of $root"

seat_dir="$HOME/.pi-seats-$ns/$seat"
trust_file="$seat_dir/trust.json"
auth_file="$seat_dir/auth.json"

# --- the directory -----------------------------------------------------------
if [ -e "$seat_dir" ] && [ ! -d "$seat_dir" ]; then
  die "$seat_dir exists and is not a directory — refusing to guess what it is"
fi
mkdir -p "$seat_dir" || die "could not create $seat_dir"
note "dir     $seat_dir"

# --- trust -------------------------------------------------------------------
# Pi reads trust.json as a flat map of absolute directory -> bool. A headless
# run with no matching grant does not stall or error — it silently skips the
# project's .pi/ resources and nothing surfaces it — so the grant is written
# here, before the seat ever runs.
expected_trust="$(printf '{\n  "%s": true\n}' "$root")"
write_trust() { printf '%s\n' "$expected_trust" > "$trust_file"; }

if [ ! -e "$trust_file" ]; then
  write_trust
  note "wrote   $trust_file (pre-grants $root)"
elif [ "$(cat "$trust_file")" = "$expected_trust" ]; then
  note "current $trust_file (already grants $root)"
elif grep -q "\"$root\"[[:space:]]*:[[:space:]]*true" "$trust_file"; then
  note "current $trust_file (grants $root among other entries; left as it is)"
else
  die "$trust_file exists but does not grant $root.
      This script will not rewrite a trust file it did not write: it may carry
      grants an operator added by hand, and shell is the wrong tool to edit
      JSON. Add the entry yourself: \"$root\": true"
fi

# --- auth --------------------------------------------------------------------
# auth.json is written by `pi /login` and by nothing else, this script
# included. If it holds an identity, the seat is somebody; printing a login
# command next to it invites a re-login that silently makes it somebody else.
# Existence alone is not identity: pi auto-creates an EMPTY {} auth.json on
# its first headless run, and a seat with only that has never been logged in.
auth_is_identity() {
  [ -e "$auth_file" ] || return 1
  [ -n "$(tr -d '{}[:space:]' < "$auth_file" 2>/dev/null)" ]
}

login_needed=1
if auth_is_identity; then
  login_needed=0
  note "exists  $auth_file — this seat is already logged in; not printing a"
  note "        login command. This script never touches auth.json: it is the"
  note "        seat's identity and overwriting it has no undo. To re-login"
  note "        deliberately, remove it first:  rm \"$auth_file\""
elif [ -e "$auth_file" ]; then
  note "empty   $auth_file — pi auto-creates an empty {} auth.json on a first"
  note "        headless run; that is not a login. The login command below"
  note "        fills it in place."
fi

# --- hand-back ---------------------------------------------------------------
note ""
note "seat ready: $seat_dir"
note ""
note "point a process at this seat:"
note "  export PI_CODING_AGENT_DIR=\"$seat_dir\""
if [ "$login_needed" -eq 1 ]; then
  note ""
  note "one-time login (writes $auth_file; sign in as the account this seat should BE):"
  note "  PI_CODING_AGENT_DIR=\"$seat_dir\" pi /login"
fi
exit 0
