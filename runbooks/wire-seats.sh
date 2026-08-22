#!/usr/bin/env bash
#
# wire-seats.sh — wire the fleet's session registries together, both directions.
#
# Each seat runs with its own CLAUDE_CONFIG_DIR, so each has its own session
# registry and none of them can see any other. Cross-session discovery reads
# only the registry it was launched with, so wiring is a file copy:
#
#   forward  seat registration  -> commander registry   (commander can address the seat)
#   reverse  commander registration -> seat registry    (seat can address the commander)
#
# The reverse leg is not optional. A forward-only wiring produces seats that
# can ANSWER the commander (replying to an inbound message needs no registry
# row) but cannot INITIATE to it — which silently breaks report-before-idle,
# because a seat that finishes work has no address to report to.
#
# WHAT THIS DOES NOT DO: it does not name anything. Registry rows carry
# auto-derived names ("myproject-4f"), never seat names, so a wired-but-un-
# roll-called fleet is REACHABLE BUT ANONYMOUS: the commander sees rows it
# cannot map to seats. Only a roll call binds name -> seat, and the binding is
# per-launch. Run one before the first dispatch.
#
# Run this as the OPERATOR, not as the commander agent: an agent writing into
# its own session registry is blocked by the permission classifier (observed
# August 2026). The fleet cannot wire itself.
#
# Version-stamped, like the runbook that carries it: this depends on where and
# how the harness writes session registrations and transcripts, which are
# internals that can change without notice. Verified August 2026. If wiring
# stops working, check the current layout before assuming you ran it wrong --
# `wire-seats.selftest.sh` alongside this file tells a broken script apart from
# a moved substrate.
#
# Usage:
#   wire-seats.sh [--dry-run] [--commander-pid PID] [seat ...]
#
#   --dry-run           report the plan, copy nothing
#   --commander-pid     skip auto-detection (required when several live
#                       non-seat sessions share the project cwd)
#   seat ...            seat names to wire, from the roster in
#                       wheelhouse/fleet/SEATS.md. Default is every directory
#                       the seat root, which is this project's seats and no
#                       other once a namespace is recorded -- see below.
#
# SEATS_ROOT -- this project's seat root, and an INTERFACE rather than a test
# hook. It is DERIVED, not remembered: this script reads `namespace=` out of
# wheelhouse/.template-source, one level up from itself, and uses
# $HOME/.claude-seats-<namespace>. Set SEATS_ROOT in the environment to override
# that; the override is what a fixture, a relocated seat tree, or an install
# whose namespace is not yet recorded uses.
#
#   SEATS_ROOT="$HOME/.claude-seats-<namespace>" wheelhouse/runbooks/wire-seats.sh
#
# The derivation matters more than the override. What this whole file guards
# against is a machine hosting two wheelhouses, and the one thing that failed
# there was a human remembering something -- so the value the operator can
# forget to pass is read off the install instead.
#
# Why it is per-project. This script ENUMERATES the root: with no seat names it
# wires every directory under it. One machine can host several wheelhouses, and
# under the shared fallback below every one of them sees every other one's
# seats -- so a second fleet's wiring copies the first fleet's registrations
# into its own commander's registry, and a dispatch to `seat-worker-1` can land
# on another project's worker. Observed on a real machine, 2026-08-22: a
# wheelhouse being installed found another wheelhouse's four seat directories
# already sitting in the place it was about to use.
#
# The root is half the fix and the seat NAMES are the other half. What this
# script writes into is MAIN_SESSIONS, the commander's own registry, and that is
# scoped by nothing -- two fleets whose commanders run under the principal's
# default configuration directory land their rows in one place. A scoped root
# stops the wiring crossing fleets; a namespaced seat name is what stops the
# ADDRESSING crossing them, because two rows called `seat-worker-1` in one
# registry are two rows the roll call cannot tell apart.
#
# The fallback is deliberately the old shared path, so an install that predates
# the namespace keeps working unchanged while it is the only fleet on its
# machine. It is the collision state the moment a second one arrives:
# wheelhouse/runbooks/UPGRADE.md carries the migration. An unfiltered run on that
# shared path warns, and it warns on the PATH rather than on how the path was
# arrived at -- SEATS_ROOT pointed back at it is the same scope as never having
# recorded a namespace, and a scope this wide should not be quieter for having
# been asked for.
#
# THE FOREIGN-SEAT PREFLIGHT is what makes that fallback survivable, and it is
# the check that would have caught the 2026-08-22 machine. Before anything is
# copied, every seat in scope has its LIVE registrations read for the cwd they
# record. contracts/SEATS.md requires a seat to be started at its project root,
# so a live registration whose cwd is not this project's is a seat belonging to
# another wheelhouse -- and this script REFUSES the whole run rather than wiring
# it. Live registrations only, because a dead or never-run seat is skipped
# anyway and can do no harm; a registration whose cwd cannot be read is treated
# as foreign, on the same "refuses to guess" principle as commander detection.
#
# There is no flag to override the refusal, because the two things it tells you
# to do -- set SEATS_ROOT, or name your seats as arguments -- are the fix rather
# than a way round it. The reason the check is needed at all even with a scoped
# root: the transcript-ownership rule below CANNOT see this case. A foreign seat
# sitting under a shared root has its transcript inside that root, so owner_of
# reports it correctly owned; only cwd separates the two fleets. (Credit: this
# check and that finding are Releaf seat-worker-2's, 2026-08-22.)
#
# Env overrides (all default to the real fleet; set them to point at a fixture
# tree when testing):
#   MAIN_SESSIONS    commander registry   default ~/.claude/sessions
#   SEATS_ROOT       seat config dirs     default from namespace= (see above)
#   PROJECT_CWD      commander's cwd      default two levels above this script
#                                         (wheelhouse/runbooks/ -> project root)
#   TEMPLATE_SOURCE  the install record   default one level above this script
#                                         (wheelhouse/.template-source)

set -euo pipefail
shopt -s nullglob

MAIN_SESSIONS="${MAIN_SESSIONS:-$HOME/.claude/sessions}"
PROJECT_CWD="${PROJECT_CWD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TEMPLATE_SOURCE="${TEMPLATE_SOURCE:-$(dirname "${BASH_SOURCE[0]}")/../.template-source}"

# The seat root, and WHERE IT CAME FROM. The provenance is reported rather than
# inferred later: an environment override, a derived root and the bare fallback
# are three different situations, and the warning below turns on the ROOT rather
# than on which of the three produced it — an override aimed back at the shared
# path is the same scope as the fallback, and used to pass in silence.
NAMESPACE=""
SEATS_ROOT_FALLBACK=""
[ -r "$TEMPLATE_SOURCE" ] && NAMESPACE="$(sed -n 's/^namespace=//p' "$TEMPLATE_SOURCE" | head -1)"
if [ -n "${SEATS_ROOT:-}" ]; then
  SEATS_ROOT_FROM="the environment"
elif [ -n "$NAMESPACE" ]; then
  SEATS_ROOT="$HOME/.claude-seats-$NAMESPACE"
  SEATS_ROOT_FROM="namespace=$NAMESPACE recorded in $TEMPLATE_SOURCE"
else
  SEATS_ROOT="$HOME/.claude-seats"
  SEATS_ROOT_FROM="the shared fallback — no namespace= recorded for this install"
  SEATS_ROOT_FALLBACK=1
fi
# Scope is a property of the path, not of how the path was chosen.
SEATS_ROOT_SHARED=""
[ "${SEATS_ROOT%/}" = "$HOME/.claude-seats" ] && SEATS_ROOT_SHARED=1

DRY_RUN=0
COMMANDER_PID=""
SEATS=()

die_early() { printf 'wire-seats: %s\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; shift ;;
    --commander-pid)  [ $# -ge 2 ] || die_early "--commander-pid needs a PID"
                      case "${2:-}" in
                        ''|*[!0-9]*) die_early "--commander-pid takes a PID, got '${2:-}'" ;;
                      esac
                      COMMANDER_PID="$2"; shift 2 ;;
    -h|--help)        sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)               echo "wire-seats: unknown option $1" >&2; exit 2 ;;
    *)                SEATS+=("$1"); shift ;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { printf 'wire-seats: %s\n' "$*" >&2; exit 1; }

# Liveness by ps, not kill -0: kill -0 answers "may I signal this pid", which
# is a permission question, not an existence one.
is_live() { ps -p "$1" >/dev/null 2>&1; }

# Which config dir owns this pid? Not answerable from where a registration
# file sits: this script copies those around, so after one pass every row
# exists in two places. Transcripts are the on-machine record that nothing
# copies — a session writes <config-dir>/projects/<slug>/<sessionId>.jsonl —
# and sessionId is identical in every copy of a registration, so it survives
# the wiring it describes. (An earlier version asked `ps eww` for
# CLAUDE_CONFIG_DIR. That reads the real fleet correctly but returns nothing
# for macOS platform binaries, which makes the rule untestable against a
# fixture and unreadable on a hardened build — a discriminator you cannot
# exercise is one you cannot trust.)
session_id_of() {
  local f
  f="$(ls -t "$MAIN_SESSIONS/$1.json" "$SEATS_ROOT"/*/sessions/"$1.json" 2>/dev/null | head -1)"
  [ -n "$f" ] || return 0
  field "$f" sessionId
}

owner_of() {
  local sid d t
  sid="$(session_id_of "$1")"
  [ -n "$sid" ] || return 0
  for d in "$MAIN_CONFIG_DIR" "$SEATS_ROOT"/*/; do
    d="${d%/}"
    for t in "$d"/projects/*/"$sid.jsonl"; do
      [ -e "$t" ] || continue
      printf '%s' "$d"
      return 0
    done
  done
}

is_seat_pid() { case "$(owner_of "$1")" in "$SEATS_ROOT"/*) return 0 ;; *) return 1 ;; esac; }

pid_of()  { local b; b="$(basename "$1")"; printf '%s' "${b%%.*}"; }

# Single-line JSON, no jq dependency.
field()   { sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p' "$1" | head -1; }

# cp -p, but say which of the two things happened. Symlinks are ignored by
# discovery, so this is a copy on purpose (verified 2026-08-16).
copy() {
  local src="$1" dst="$2" label="$3"
  if [ -e "$dst" ] && cmp -s "$src" "$dst"; then
    say "      = $label $(basename "$src") (already current)"
    return 0
  fi
  if [ -e "$dst" ] && [ "$dst" -nt "$src" ]; then
    say "      ~ $label $(basename "$src") (destination is newer — left alone)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "      + $label $(basename "$src") (dry-run, not copied)"
  else
    cp -p "$src" "$dst"
    say "      + $label $(basename "$src")"
  fi
}

[ -d "$MAIN_SESSIONS" ] || die "no commander registry at $MAIN_SESSIONS"
[ -d "$SEATS_ROOT" ]    || die "no seat root at $SEATS_ROOT"
MAIN_SESSIONS="$(cd "$MAIN_SESSIONS" && pwd)"
SEATS_ROOT="$(cd "$SEATS_ROOT" && pwd)"
MAIN_CONFIG_DIR="$(dirname "$MAIN_SESSIONS")"

SEATS_NAMED=$([ ${#SEATS[@]} -gt 0 ] && echo 1 || echo "")
if [ ${#SEATS[@]} -eq 0 ]; then
  for d in "$SEATS_ROOT"/*/; do SEATS+=("$(basename "$d")"); done
fi
[ ${#SEATS[@]} -gt 0 ] || die "no seats found under $SEATS_ROOT"

# The scope this run is about to wire, stated before it wires anything.
say "seat root: $SEATS_ROOT"
say "           (from $SEATS_ROOT_FROM)"
if [ -n "$SEATS_ROOT_SHARED" ] && [ -z "$SEATS_NAMED" ]; then
  if [ -n "$SEATS_ROOT_FALLBACK" ]; then
    warn "wire-seats: no namespace= is recorded for this install, so this run is on"
    warn "            the shared root."
  else
    warn "wire-seats: SEATS_ROOT was set to the shared root, so this run is on it"
    warn "            whatever this install has recorded."
  fi
  warn "            Every seat directory under it is in scope — including any"
  warn "            belonging to another wheelhouse on this machine. Record a"
  warn "            namespace (wheelhouse/fleet/SEATS.md, '### Seat namespace'),"
  warn "            point SEATS_ROOT at this project's own root, or name this"
  warn "            project's seats as arguments. The preflight below refuses on"
  warn "            any foreign seat it can identify, but it can only see seats"
  warn "            that are RUNNING."
fi

# --- foreign-seat preflight -------------------------------------------------
# The tooth. Everything above narrows what is in scope; this refuses what is in
# scope and does not belong. It runs BEFORE the first copy, because a refusal
# in the middle of the wiring loop leaves half a fleet wired to a stranger.
foreign_cwd_preflight() {
  local seat sessions f pid rcwd owner found=""
  for seat in "${SEATS[@]}"; do
    sessions="$SEATS_ROOT/$seat/sessions"
    [ -d "$sessions" ] || continue
    for f in "$sessions"/*.json; do
      pid="$(pid_of "$f")"
      is_live "$pid" || continue
      rcwd="$(field "$f" cwd)"
      [ "$rcwd" = "$PROJECT_CWD" ] && continue
      # A row a previous run copied in belongs to the commander or to some
      # other session, and says nothing about which fleet this SEAT is in.
      # Same test as the forward leg below, deliberately: an UNOWNABLE row is
      # one that leg would copy, so it is one this preflight has to judge.
      owner="$(owner_of "$pid")"
      [ -n "$owner" ] && [ "$owner" != "$SEATS_ROOT/$seat" ] && continue
      if [ -z "$found" ]; then
        warn "wire-seats: a seat in scope belongs to a different project."
        warn "            contracts/SEATS.md requires a seat to be started at its"
        warn "            project root, so the cwd its live session recorded is"
        warn "            which fleet it is in. This project's root is:"
        warn "              $PROJECT_CWD"
        found=1
      fi
      warn "            $seat  (pid $pid) records cwd:"
      warn "              ${rcwd:-<unreadable — treated as foreign>}"
    done
  done
  [ -z "$found" ] || die "refusing to wire — nothing was copied. Point SEATS_ROOT at this project's own seat root, or name this project's seats as arguments; wheelhouse/runbooks/UPGRADE.md step 7 has the migration if these fleets share a root."
}
foreign_cwd_preflight

# --- commander --------------------------------------------------------------
# Every seat shares the commander's cwd, so cwd alone cannot tell them apart;
# ownership comes from the transcript tree (see owner_of).
if [ -n "$COMMANDER_PID" ]; then
  is_live "$COMMANDER_PID" || die "--commander-pid $COMMANDER_PID is not a live process"
  [ -e "$MAIN_SESSIONS/$COMMANDER_PID.json" ] || die "no registration $MAIN_SESSIONS/$COMMANDER_PID.json"
  if is_seat_pid "$COMMANDER_PID"; then
    die "--commander-pid $COMMANDER_PID is a seat ($(owner_of "$COMMANDER_PID")), not the commander"
  fi
else
  CANDIDATES=()
  UNKNOWN=()
  for f in "$MAIN_SESSIONS"/*.json; do
    pid="$(pid_of "$f")"
    [ "$(field "$f" cwd)" = "$PROJECT_CWD" ] || continue
    is_live "$pid" || continue
    case "$(owner_of "$pid")" in
      "$MAIN_CONFIG_DIR") CANDIDATES+=("$pid") ;;
      "$SEATS_ROOT"/*)    continue ;;
      *)                  UNKNOWN+=("$pid") ;;
    esac
  done
  if [ ${#UNKNOWN[@]} -gt 0 ]; then
    warn "wire-seats: cannot tell who owns these live sessions — no transcript"
    warn "            found for their sessionId, so they may be seats:"
    for pid in "${UNKNOWN[@]}"; do
      warn "  pid $pid  name $(field "$MAIN_SESSIONS/$pid.json" name)"
    done
    die "pass --commander-pid to say which one is the commander"
  fi
  case ${#CANDIDATES[@]} in
    1) COMMANDER_PID="${CANDIDATES[0]}" ;;
    0) die "no live non-seat session with cwd $PROJECT_CWD — is the commander running?" ;;
    *) warn "wire-seats: several live non-seat sessions share cwd $PROJECT_CWD:"
       for pid in "${CANDIDATES[@]}"; do
         warn "  pid $pid  name $(field "$MAIN_SESSIONS/$pid.json" name)"
       done
       die "pass --commander-pid to choose one" ;;
  esac
fi

CMD_NAME="$(field "$MAIN_SESSIONS/$COMMANDER_PID.json" name)"
say "commander: pid $COMMANDER_PID  name ${CMD_NAME:-?}  cwd $PROJECT_CWD"
if [ "$DRY_RUN" -eq 1 ]; then say "(dry run — nothing will be written)"; fi
say ""

# --- wire ------------------------------------------------------------------
wired=0
skipped=0

for seat in "${SEATS[@]}"; do
  seat_sessions="$SEATS_ROOT/$seat/sessions"
  say "$seat"

  if [ ! -d "$SEATS_ROOT/$seat" ]; then
    warn "      ! no config dir $SEATS_ROOT/$seat — skipped"
    skipped=$((skipped + 1)); continue
  fi
  if [ ! -d "$seat_sessions" ]; then
    warn "      ! no sessions dir (seat has never run) — skipped"
    skipped=$((skipped + 1)); continue
  fi

  regs=("$seat_sessions"/*.json)
  if [ ${#regs[@]} -eq 0 ]; then
    warn "      ! sessions dir is empty (seat not running) — skipped"
    skipped=$((skipped + 1)); continue
  fi

  live_regs=0
  for f in "${regs[@]}"; do
    pid="$(pid_of "$f")"
    # A previous run left somebody else's row here — the commander's, or any
    # other session wired in earlier. Forwarding it back would let a stale
    # snapshot overwrite that session's live registration, so the reverse
    # leg's output is never an input.
    owner="$(owner_of "$pid")"
    if [ -n "$owner" ] && [ "$owner" != "$SEATS_ROOT/$seat" ]; then
      say "      - pid $pid belongs to $(basename "$owner") — not forwarded"
      continue
    fi
    if ! is_live "$pid"; then
      say "      - pid $pid is dead — not forwarded"
      continue
    fi
    live_regs=$((live_regs + 1))
    for part in "$seat_sessions/$pid".*; do
      copy "$part" "$MAIN_SESSIONS/$(basename "$part")" "forward"
    done
  done

  if [ "$live_regs" -eq 0 ]; then
    warn "      ! no live registration (seat not running) — skipped"
    skipped=$((skipped + 1)); continue
  fi

  for part in "$MAIN_SESSIONS/$COMMANDER_PID".*; do
    copy "$part" "$seat_sessions/$(basename "$part")" "reverse"
  done
  wired=$((wired + 1))
done

say ""
say "wired $wired seat(s), skipped $skipped"
if [ "$wired" -eq 0 ]; then
  die "nothing was wired — every seat was skipped"
fi
say "next: the commander runs a ROLL CALL before its first dispatch."
say "      Until it does, these rows are reachable but anonymous."
