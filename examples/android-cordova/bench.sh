#!/usr/bin/env bash
#
# bench.sh — one-command Android emulator review pass.
#
# Runs the steps of wheelhouse/crew/REVIEW_BENCH.md against a debug APK: payload
# check, headless boot, boot_completed poll, install, app-data clear, launch,
# liveness, screencap + near-solid-frame check, pid-scoped logcat + error grep,
# and an ALWAYS-runs emulator kill.
#
# Usage:  bench.sh <apk-path> <output-dir>
#
# Exit 0 only if the payload check + install + launch + liveness succeeded, the
# app loaded its www/ assets, and the frame it captured stopped being near-solid.
# Liveness alone is not a working app, and neither is a loaded payload: a
# plugin-less build, a bundle missing a generated module, and a resumed session
# that renders empty have each produced a live process in front of a blank
# screen.
#
# Exit 0 does NOT mean the app rendered correctly, or rendered at all. The frame
# check catches flat blanks only; see the notes above BLANK_MAX_SHARE for what it
# is blind to. Opening the screencap is still part of the review.
#
# Env overrides (defaults are the values verified in REVIEW_BENCH.md):
#   ANDROID_HOME  JAVA_HOME  AVD_NAME  EMU_SERIAL  APP_PKG  APP_ACTIVITY
#   BOOT_TIMEOUT (seconds, boot/PID appearance policy bound)
#   LIVENESS_WAIT (seconds, crash-on-launch window AFTER PID observation)
#   BLANK_MAX_SHARE (0..1)   RENDER_TIMEOUT (seconds)

set -euo pipefail

# When installed at wheelhouse/crew/bench.sh; do this before any heavy work.
WHEELHOUSE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
. "$WHEELHOUSE_ROOT/seats/heavy-test.sh"

ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
AVD_NAME="${AVD_NAME:-app-review}"
EMU_SERIAL="${EMU_SERIAL:-emulator-5554}"
APP_PKG="${APP_PKG:-com.example.app}"
APP_ACTIVITY="${APP_ACTIVITY:-.MainActivity}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-300}"
LIVENESS_WAIT="${LIVENESS_WAIT:-10}"
export ANDROID_HOME JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

ADB="$ANDROID_HOME/platform-tools/adb"
EMU="$ANDROID_HOME/emulator/emulator"

EMU_PID=""
WAIT_PID=""
EMU_ANCHOR=""
EMU_ANCHOR_ID=""

log()  { printf '[bench] %s\n' "$*"; }
# The verdict is the one thing OUT/ did not retain: every input (logcat, error
# grep, missing-assets, screencap) lands there but the runner's own PASS/FAIL
# conclusion only ever went to stdout/stderr. Tee it, with the exit code, into
# OUT/verdict.txt so a reviewer checking the evidence directory sees the
# conclusion too, not just what fed it. OUT may not exist yet for an
# arg-count or missing-APK failure (before `mkdir -p "$OUT"` runs) — in that
# case there is nowhere to write the file, so fall back to stderr only.
fail() {
  local line="[bench] FAIL: $* (exit 1)"
  if [ -n "${OUT:-}" ] && [ -d "$OUT" ]; then
    printf '%s\n' "$line" | tee "$OUT/verdict.txt" >&2
  else
    printf '%s\n' "$line" >&2
  fi
  exit 1
}

# A serial/AVD name is not process ownership. Launch into a private process
# group, prove the console listener belongs to it, and retain a live member's
# native birth/group identity. Never send `adb emu kill` to a borrowed serial
# or pkill by an AVD name shared with another bench.
process_identity() {
  local rc=0
  LC_ALL=C ps -p "$1" -o pgid=,lstart= > "$OUT/process.stdout" 2> "$OUT/process.stderr" || rc=$?
  if [ "$rc" = 1 ] && [ ! -s "$OUT/process.stdout" ] && [ ! -s "$OUT/process.stderr" ]; then return 1; fi
  if [ "$rc" != 0 ] || [ ! -s "$OUT/process.stdout" ] || [ -s "$OUT/process.stderr" ]; then
    printf '[bench] cannot observe process %s; see process.stdout/process.stderr\n' "$1" >&2
    return 2
  fi
  cat "$OUT/process.stdout"
}
anchor_owned() {
  local current
  [ -n "$EMU_ANCHOR" ] || return 1
  current="$(process_identity "$EMU_ANCHOR")" || return "$?"
  [ "$current" = "$EMU_ANCHOR_ID" ] || return 2
}
# shellcheck disable=SC2329  # invoked by trap
cleanup() {
  local rc=$? until ownership=0
  trap - EXIT INT TERM
  if [ -n "$WAIT_PID" ]; then
    kill -TERM "$WAIT_PID" 2>/dev/null || true
    wait "$WAIT_PID" 2>/dev/null || true
  fi
  if [ -n "$EMU_PID" ]; then
    log "shutting down owned emulator group $EMU_PID"
    anchor_owned || ownership=$?
    if [ "$ownership" = 0 ]; then
      kill -TERM -- "-$EMU_PID" 2>/dev/null || true
      until=$((SECONDS + 20))
      while anchor_owned && [ "$SECONDS" -lt "$until" ]; do sleep 0.1; done
      if anchor_owned; then kill -KILL -- "-$EMU_PID" 2>/dev/null || true; fi
    elif [ "$ownership" != 1 ]; then
      printf '[bench] FAIL: emulator ownership became unknown; refusing a signal\n' | tee -a "$OUT/verdict.txt" >&2
      rc=1
    fi
    wait "$EMU_PID" 2>/dev/null || true
    ownership=0
    anchor_owned || ownership=$?
    if [ "$ownership" != 1 ]; then
      printf '[bench] FAIL: owned emulator survived cleanup or its identity became unknown\n' | tee -a "$OUT/verdict.txt" >&2
      rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- args ---------------------------------------------------------------
[ $# -eq 2 ] || { printf 'usage: %s <apk-path> <output-dir>\n' "$0" >&2; exit 2; }
APK="$1"
OUT="$2"
[ -f "$APK" ] || fail "APK not found: $APK"
case "$APK" in /*) ;; *) APK="$PWD/$APK" ;; esac
mkdir -p "$OUT"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

# --- payload ------------------------------------------------------------
# `cordova build android` in a fresh worktree silently emits an APK with no
# plugins: assets/www/cordova_plugins.js is missing and the app boots to a blank
# WebView that passes liveness. Catch that here, before spending an emulator
# boot on it.
CORDOVA_PLUGINS="assets/www/cordova_plugins.js"
PLUGINS_MIN_BYTES=1024

command -v unzip >/dev/null 2>&1 || fail "unzip not found; cannot inspect $APK"
# awk reads the listing to EOF on purpose: exiting early SIGPIPEs unzip, and
# pipefail turns that into a spurious 141.
PLUGINS_BYTES="$(unzip -l "$APK" 2>/dev/null | awk -v e="$CORDOVA_PLUGINS" '$NF == e {b = $1} END {print b}')"
[ -n "$PLUGINS_BYTES" ] || fail "$CORDOVA_PLUGINS is missing from $(basename "$APK") — this is a plugin-less build (rm -rf platforms/android && npx cordova@13 platform add android, then rebuild)"
[ "$PLUGINS_BYTES" -gt "$PLUGINS_MIN_BYTES" ] \
  || fail "$CORDOVA_PLUGINS is only ${PLUGINS_BYTES}B in $(basename "$APK") (expected > ${PLUGINS_MIN_BYTES}B) — no plugins were bundled"
log "payload: $CORDOVA_PLUGINS ${PLUGINS_BYTES}B"

[ -x "$ADB" ] || fail "adb not executable at $ADB (set ANDROID_HOME)"
[ -x "$EMU" ] || fail "emulator not executable at $EMU (set ANDROID_HOME)"
"$EMU" -list-avds 2>/dev/null | grep -qx "$AVD_NAME" || fail "AVD '$AVD_NAME' not found (see REVIEW_BENCH.md)"

# Refuse to share the bench with someone else's guest: we address a fixed
# serial and we kill it on the way out.
"$ADB" devices > "$OUT/devices.stdout" 2> "$OUT/devices.stderr" \
  || fail "adb device inventory failed; absence is unknown (see devices.stdout/devices.stderr)"
if grep -q "^${EMU_SERIAL}[[:space:]]" "$OUT/devices.stdout"; then
  fail "$EMU_SERIAL is already running; not touching another agent's emulator"
fi
EMU_PORT="${EMU_SERIAL#emulator-}"
case "$EMU_PORT" in ''|*[!0-9]*) fail "expected EMU_SERIAL=emulator-<even console port>";; esac
case "$EMU_SERIAL" in emulator-*) ;; *) fail "only an owned emulator serial is supported";; esac
[ "$EMU_PORT" -ge 1024 ] && [ "$EMU_PORT" -le 65534 ] && [ "$((EMU_PORT % 2))" = 0 ] \
  || fail "emulator console port must be even, between 1024 and 65534"
command -v lsof >/dev/null 2>&1 || fail "lsof is required to verify console ownership"
console_snapshot() {
  CONSOLE_RC=0
  lsof -nP -iTCP:"$EMU_PORT" -sTCP:LISTEN -Fpg > "$OUT/console.stdout" 2> "$OUT/console.stderr" || CONSOLE_RC=$?
  [ ! -s "$OUT/console.stderr" ] || fail "console ownership unknown; see console.stderr"
  case "$CONSOLE_RC" in
    0) [ -s "$OUT/console.stdout" ] || fail "empty successful console inventory";;
    1) [ ! -s "$OUT/console.stdout" ] || fail "incomplete console inventory";;
    *) fail "console inventory failed (rc=$CONSOLE_RC)";;
  esac
}
console_snapshot
[ "$CONSOLE_RC" = 1 ] || fail "console port $EMU_PORT is occupied; not claiming its device"

SCREENCAP="$OUT/evidence-launch.png"
LOGCAT="$OUT/evidence-logcat.txt"
ERRORS="$OUT/evidence-errors.txt"
MISSING="$OUT/evidence-missing-assets.txt"
EMULOG="$OUT/emulator.log"

log "apk=$APK"
log "out=$OUT"

# --- boot ---------------------------------------------------------------
# Headless, software rendering (hw.gpu.mode=swiftshader_indirect in the AVD
# config is what makes screencap work with no window server), clean every run.
log "booting $AVD_NAME headless"
set -m
nohup "$EMU" -avd "$AVD_NAME" -port "$EMU_PORT" -no-window -no-audio -no-boot-anim -no-snapshot \
  > "$EMULOG" 2>&1 &
EMU_PID=$!
set +m
EMU_ANCHOR="$EMU_PID"
EMU_ANCHOR_ID="$(process_identity "$EMU_ANCHOR")" || fail "emulator exited before ownership observation"
[ "$(printf '%s\n' "$EMU_ANCHOR_ID" | awk '{print $1}')" = "$EMU_PID" ] || fail "emulator did not enter its private process group"
boot_started=$SECONDS
boot_until=$((SECONDS + BOOT_TIMEOUT))
LAST_BOOT="console not yet observed"
while :; do
  console_snapshot
  if [ "$CONSOLE_RC" = 0 ]; then
    # lsof -Fpg emits one pPID / gPGID pair per native listener process.
    awk -v group="$EMU_PID" '/^p[0-9]+$/ {p++; next} /^g[0-9]+$/ {g++; if (substr($0,2) != group) bad=1; next} /^f[0-9]+$/ {next} {bad=1} END {exit !(p>0 && p==g && !bad)}' "$OUT/console.stdout" \
      || fail "console listener is not in owned emulator group; refusing device commands"
    EMU_ANCHOR="$(awk '/^p/ {if (!p) p=substr($0,2)} END {print p}' "$OUT/console.stdout")"
    EMU_ANCHOR_ID="$(process_identity "$EMU_ANCHOR")" || fail "console listener exited during ownership observation"
    [ "$(printf '%s\n' "$EMU_ANCHOR_ID" | awk '{print $1}')" = "$EMU_PID" ] \
      || fail "console listener changed group during ownership observation"
    break
  fi
  anchor_owned || fail "emulator died during boot; last seen: $LAST_BOOT; see $EMULOG"
  [ "$SECONDS" -lt "$boot_until" ] || fail "boot policy expired after ${BOOT_TIMEOUT}s; last seen: $LAST_BOOT"
  sleep 0.1
 done

"$ADB" -s "$EMU_SERIAL" wait-for-device > "$OUT/wait.stdout" 2> "$OUT/wait.stderr" &
WAIT_PID=$!
while kill -0 "$WAIT_PID" 2>/dev/null; do
  anchor_owned || fail "emulator died during wait-for-device; see $EMULOG"
  [ "$SECONDS" -lt "$boot_until" ] || fail "boot policy expired after ${BOOT_TIMEOUT}s; last seen: wait-for-device pending"
  sleep 0.1
 done
wait_rc=0
wait "$WAIT_PID" || wait_rc=$?
WAIT_PID=""
printf '%s\n' "$wait_rc" > "$OUT/wait.rc"
[ "$wait_rc" = 0 ] || fail "wait-for-device failed (rc=$wait_rc); see wait.stdout/wait.stderr"

# An observed transport is not a booted framework. Return immediately on the
# boot marker; the explicit device policy bounds a guest that never boots.
log "waiting for sys.boot_completed"
while :; do
  anchor_owned || fail "emulator died before boot completed; last seen: $LAST_BOOT"
  boot_rc=0
  LAST_BOOT="$("$ADB" -s "$EMU_SERIAL" shell getprop sys.boot_completed 2> "$OUT/boot.stderr" | tr -d '\r')" || boot_rc=$?
  printf '%s\n' "$LAST_BOOT" > "$OUT/boot.stdout"
  [ "$boot_rc" = 0 ] || fail "getprop failed (rc=$boot_rc); last seen: $LAST_BOOT; see boot.stderr"
  [ "$LAST_BOOT" = 1 ] && break
  [ "$SECONDS" -lt "$boot_until" ] || fail "boot policy expired after ${BOOT_TIMEOUT}s; last sys.boot_completed='$LAST_BOOT'"
  sleep 0.1
 done
log "boot observed after $((SECONDS - boot_started))s"

# --- install ------------------------------------------------------------
# Print adb's own error verbatim rather than asserting a cause: a build that
# asserts "release APKs are unsigned" when the real cause is a stale
# signature-mismatched install left on the AVD by a previous run misdiagnoses
# a signed, fine APK. A guard that explains into the wrong diagnosis is worse
# than one that stays quiet, so this names both known causes and leaves which
# one applies to whoever reads adb's own text.
log "installing $(basename "$APK")"
INSTALL_OUT="$("$ADB" -s "$EMU_SERIAL" install -r "$APK" 2>&1)" || fail "adb install failed:
${INSTALL_OUT}
Known causes (not diagnosed here — read the error above): (1) this is a release APK, which is unsigned — use the debug APK; (2) signature mismatch against a stale install already on the AVD (INSTALL_FAILED_UPDATE_INCOMPATIBLE) — remedy: adb -s $EMU_SERIAL uninstall $APP_PKG, then retry."
log "adb install: ${INSTALL_OUT}"
"$ADB" -s "$EMU_SERIAL" shell pm list packages 2>/dev/null | tr -d '\r' | grep -qx "package:$APP_PKG" \
  || fail "$APP_PKG is not in pm list packages after install"
log "installed $APP_PKG"

# install -r keeps the previous install's data, so the bench would otherwise
# resume whatever the last agent left on this AVD -- a half-finished session, a
# session whose timestamps straddle a clock change, a granted-then-revoked
# permission. That is not what we are here to measure, and it has already
# produced one PASS on an app that rendered nothing. Every bench sees first-run
# state.
"$ADB" -s "$EMU_SERIAL" shell pm clear "$APP_PKG" >/dev/null 2>&1 \
  || fail "pm clear $APP_PKG failed"
log "cleared app data (first-run state)"

# --- launch -------------------------------------------------------------
"$ADB" -s "$EMU_SERIAL" logcat -c || true   # this capture is this run only
log "launching $APP_PKG/$APP_ACTIVITY"
"$ADB" -s "$EMU_SERIAL" shell am start -n "$APP_PKG/$APP_ACTIVITY" || fail "am start failed"

# First observe a PID. A quiet-host sleep is neither readiness nor absence.
# The same explicit device-start policy bounds PID appearance; the later frame
# marker (not this PID or elapsed stability window) determines render readiness.
launch_until=$((SECONDS + BOOT_TIMEOUT))
PID=""
while [ -z "$PID" ]; do
  anchor_owned || fail "emulator exited while waiting for app PID"
  pid_rc=0
  PID="$("$ADB" -s "$EMU_SERIAL" shell pidof "$APP_PKG" 2> "$OUT/pid.stderr" | tr -d '\r' | awk '{print $1}')" || pid_rc=$?
  [ "$pid_rc" = 0 ] || { [ "$pid_rc" = 1 ] && [ ! -s "$OUT/pid.stderr" ]; } \
    || fail "pidof failed (rc=$pid_rc); see pid.stderr"
  [ -n "$PID" ] && break
  [ "$SECONDS" -lt "$launch_until" ] || fail "PID appearance policy expired after ${BOOT_TIMEOUT}s; last PID empty (rc=$pid_rc)"
  sleep 0.1
done
log "observed pid $PID; crash-on-launch window ${LIVENESS_WAIT}s (not readiness proof)"
sleep "$LIVENESS_WAIT"
STABLE_PID="$("$ADB" -s "$EMU_SERIAL" shell pidof "$APP_PKG" 2> "$OUT/pid.stderr" | tr -d '\r' | awk '{print $1}')" \
  || fail "$APP_PKG exited during crash-on-launch window; see pid.stderr"
[ "$STABLE_PID" = "$PID" ] || fail "$APP_PKG PID changed during crash-on-launch window ($PID -> $STABLE_PID)"
log "alive, pid $PID"
"$ADB" -s "$EMU_SERIAL" shell dumpsys activity activities 2>/dev/null | tr -d '\r' \
  | grep -m1 topResumedActivity || true

# --- screencap ----------------------------------------------------------
# exec-out, never shell: adb's line-ending translation corrupts the PNG.
"$ADB" -s "$EMU_SERIAL" exec-out screencap -p > "$SCREENCAP" || fail "screencap failed"
file "$SCREENCAP" | grep -q 'PNG image data' || fail "screencap did not produce a PNG: $(file -b "$SCREENCAP")"
log "screencap: $(file -b "$SCREENCAP")"

# The screencap is a check, not just an artifact. Everything above this line can
# pass while the user sees nothing: a plugin-less APK, a bundle missing a
# generated module, a resumed session that renders empty. All three have
# happened, and the last one PASSed this bench with a solid-black frame.
#
# Read the name literally, because what this measures is narrow: it is a
# NEAR-SOLID FRAME detector. "Blank" is not "one colour" -- that black frame
# carried the gesture nav pill, so it held two -- so the signal is how much of
# the frame the single most common colour owns.
#
# It POLLS rather than judging one frame, and the polling does the real work.
# Share alone cannot tell a stuck screen from a live one: a healthy app measures
# 0.9208-0.9417 on the way up (flat launch screen, mid-paint) and only lands at
# 0.07-0.15 once painted. Elapsed time is what separates those from a frame that
# never changes. So re-capture until it stops being near-solid, or give up.
#
# Samples, all from this project's own captures:
#   blank, CAUGHT   black 0.9987 - blank-white 0.9965 - flat blank-teal 0.9217
#   healthy         0.9208-0.9417 mid-paint, transiting the same range;
#                   0.07-0.15 once painted
#   blank, MISSED   gradient-only background 0.0753 (a synthetic pure gradient
#                   scores 0.0100) - ANR dialog over a blank app 0.7761 / 0.7664
#
# So it catches flat blanks, and it is blind to two kinds this app actually
# produces: a gradient blank -- and this app's background IS a gradient, so its
# most likely blank screen passes -- and a blank under a system dialog, where the
# dialog's own panel breaks up the frame. Below threshold therefore means "not
# near-solid", never "the app rendered". Looking at the screencap remains a step
# the reviewer owes. Gradient-blank detection is app-mvv, deliberately not
# bolted on here.
BLANK_MAX_SHARE="${BLANK_MAX_SHARE:-0.90}"
RENDER_TIMEOUT="${RENDER_TIMEOUT:-90}"
SHARE_TOOL="$(dirname "$0")/screencap_share.py"
if [ -f "$SHARE_TOOL" ] && command -v python3 >/dev/null 2>&1; then
  render_started=$SECONDS
  render_until=$((SECONDS + RENDER_TIMEOUT))
  SHARE="$(python3 "$SHARE_TOOL" "$SCREENCAP" | awk '{print $1}')" || fail "could not measure $SCREENCAP"
  while awk -v s="$SHARE" -v m="$BLANK_MAX_SHARE" 'BEGIN {exit !(s >= m)}'; do
    if [ "$SECONDS" -ge "$render_until" ]; then
      fail "the frame never stopped being near-solid within ${RENDER_TIMEOUT}s: one colour still covers ${SHARE} of it (threshold ${BLANK_MAX_SHARE}). The process is alive and the assets loaded -- open $SCREENCAP to see what is on screen. A splash that never gives way looks like this, and so does an app that paints nothing. If this screen is legitimately near-solid, raise BLANK_MAX_SHARE for this run and say so in the verdict."
    fi
    log "frame still near-solid (${SHARE}) after $((SECONDS - render_started))s; re-capturing"
    sleep 5
    "$ADB" -s "$EMU_SERIAL" exec-out screencap -p > "$SCREENCAP" || fail "screencap failed"
    SHARE="$(python3 "$SHARE_TOOL" "$SCREENCAP" | awk '{print $1}')" || fail "could not measure $SCREENCAP"
  done
  log "dominant colour covers ${SHARE} (threshold ${BLANK_MAX_SHARE}, after $((SECONDS - render_started))s) -- below threshold, which is not a verdict that the app rendered; open $SCREENCAP"
else
  log "WARNING: $SHARE_TOOL or python3 missing — blank-screen check SKIPPED"
fi

# --- foreign-window check -------------------------------------------------
# The painted-frame measurement above cannot tell the app's own pixels from a
# system window drawn on top of it -- a screencap can show the app genuinely
# rendered UNDER a system dialog (e.g. "System UI isn't responding") and still
# clear the density/share thresholds. It also can't be caught downstream: the
# logcat below is scoped --pid="$PID", so a System UI ANR, which belongs to a
# different process, can never appear in it. Name any window visible over the
# app that isn't expected chrome, from the same capture the frame check above
# just accepted.
#
# v1 of this check listed every REGISTERED window and allowlisted a short
# chrome list by name -- on a live device run it flagged most registered
# windows, nearly all of them structural windows that were merely present,
# not drawing anything foreign over the frame (a screen-decor overlay, an
# edge-gesture handler, a taskbar, a notification shade, a drop target, the
# launcher activity, the wallpaper). A registered window is not an on-screen
# window.
#
# v2 gates on real per-window visibility instead of registration (verified
# against AOSP's WindowState.java / WindowManagerService.java): the "windows"
# dumpsys subcommand prints an `isVisible=` line UNCONDITIONALLY inside every
# window's own block, where isVisible() is false for a window that's
# registered but not currently contributing pixels -- an idle gesture-handler
# touch region, a collapsed notification shade, an occluded wallpaper or a
# backgrounded launcher activity all read isVisible=false at rest. Only a
# window whose own block says isVisible=true is a flag candidate.
#
# The visibility gate alone still isn't enough: some chrome (StatusBar,
# NavigationBar, a rounded-corner/cutout screen-decor overlay, a taskbar on a
# gesture-nav skin) is genuinely on screen every frame -- real content, just
# not app content -- so those names stay allowlisted on top of the gate. The
# rest of the v1 fallback list is kept too, as defense in depth in case a
# build's isVisible= semantics differ from what AOSP's source says.
#
# Still a best-effort name, not a guarantee the frame is clean: the dumpsys
# text format is not a stable contract across Android builds, and a
# legitimate window this parser doesn't recognise (a permission prompt, say)
# will show as a false positive if it happens to be visible. Detection here
# is not robust enough to gate the bench on, so it warns rather than fails --
# it is a pointer for the human look, which stays mandatory either way.
WINDOWS="$OUT/evidence-windows.txt"
"$ADB" -s "$EMU_SERIAL" shell dumpsys window windows > "$WINDOWS" 2>&1 || true

foreign_windows() {
  # Per window block: the name from "Window #N Window{hash u0 <name>}:", kept
  # only if that same block's dump also says isVisible=true somewhere before
  # the next "Window #" header.
  awk '
    /Window #[0-9]+ Window\{[^}]*\}/ {
      if (name != "" && visible) print name
      line = $0
      match(line, /Window\{[^}]*\}/)
      inner = substr(line, RSTART + 7, RLENGTH - 8)
      n = split(inner, parts, " ")
      name = parts[3]
      for (i = 4; i <= n; i++) name = name " " parts[i]
      visible = 0
      next
    }
    /isVisible=true/ { visible = 1 }
    END { if (name != "" && visible) print name }
  ' "$1" 2>/dev/null \
    | grep -viE "^(${APP_PKG//./\\.}(/.*)?|StatusBar|NavigationBar[0-9]*|InputMethod|Splash Screen.*|Toast|Wallpaper|com\\.android\\.systemui\\.wallpapers\\.ImageWallpaper|Docked Stack Divider|ScreenDecorOverlay(Bottom)?|EdgeBackGestureHandler[0-9]*|Taskbar|NotificationShade|ShellDropTarget|com\\.google\\.android\\.apps\\.nexuslauncher(/.*)?)\$" \
    || true
}

FRAME_FOREIGN_NOTE=""
FOREIGN_LIST="$(foreign_windows "$WINDOWS")"
if [ -n "$FOREIGN_LIST" ]; then
  log "WARNING: window(s) other than $APP_PKG visible over the frame (best-effort name from dumpsys, not a guarantee -- see $WINDOWS):"
  while IFS= read -r w; do
    [ -n "$w" ] && log "WARNING:   $w"
  done <<<"$FOREIGN_LIST"
  FRAME_FOREIGN_NOTE=" -- WARNING: window(s) other than the app were visible over it, see $WINDOWS"
fi

# --- logcat -------------------------------------------------------------
"$ADB" -s "$EMU_SERIAL" logcat -d --pid="$PID" > "$LOGCAT" || fail "logcat capture failed"
# Smoke pass for a Cordova WebView app. Matches are evidence for the reviewer,
# not a bench failure — this bench proves liveness, not correctness.
grep -iE "FATAL|AndroidRuntime|Uncaught|SystemWebViewClient|ERR_|chromium.*ERROR" "$LOGCAT" > "$ERRORS" || true
log "logcat: $(wc -l < "$LOGCAT" | tr -d ' ') lines, $(wc -l < "$ERRORS" | tr -d ' ') matching the error grep"
if [ -s "$ERRORS" ]; then
  log "runtime errors found — read $ERRORS before approving"
fi

# A www/ asset the WebView could not open is a broken payload, not a judgement
# call: the app is running but its own bundle is incomplete. Hard fail.
#
# www/favicon.ico is the one exception and it is not a judgement call either:
# the WebView asks every origin for a favicon, Cordova never bundles one, and
# the known-good APK logs it 6x on a healthy launch. Anything else under www/
# is a file the app itself asked for and did not get.
grep -E "FileNotFoundException.*www/" "$LOGCAT" | grep -v "www/favicon\.ico" > "$MISSING" || true
if [ -s "$MISSING" ]; then
  cat "$MISSING" >&2
  fail "the WebView could not open $(wc -l < "$MISSING" | tr -d ' ') www/ asset(s) (lines above, also in $MISSING) — broken payload, not a live app"
fi

printf '[bench] PASS: payload + install + clear + launch + liveness + screencap measured + www assets loaded (the screencap still needs a human look)%s (exit 0)\n' "$FRAME_FOREIGN_NOTE" | tee "$OUT/verdict.txt"
exit 0
