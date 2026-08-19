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
#   BOOT_TIMEOUT (seconds)  LIVENESS_WAIT (seconds)
#   BLANK_MAX_SHARE (0..1)   RENDER_TIMEOUT (seconds)

set -euo pipefail

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

log()  { printf '[bench] %s\n' "$*"; }
fail() { printf '[bench] FAIL: %s\n' "$*" >&2; exit 1; }

# Always kill the guest. A leaked headless emulator eats ~2GB of RAM silently,
# so this runs on success, on failure, and on Ctrl-C alike.
# shellcheck disable=SC2329  # invoked by trap
cleanup() {
  local rc=$?
  if [ -n "$EMU_PID" ]; then
    log "shutting down emulator (pid $EMU_PID)"
    "$ADB" -s "$EMU_SERIAL" emu kill >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      kill -0 "$EMU_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$EMU_PID" 2>/dev/null; then
      log "emu kill did not take; pkill -f emulator.*$AVD_NAME"
      pkill -f "emulator.*$AVD_NAME" 2>/dev/null || true
      sleep 2
    fi
    if kill -0 "$EMU_PID" 2>/dev/null; then
      printf '[bench] WARNING: emulator pid %s survived cleanup\n' "$EMU_PID" >&2
    else
      log "emulator down"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

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
if "$ADB" devices 2>/dev/null | grep -q "^${EMU_SERIAL}[[:space:]]"; then
  fail "$EMU_SERIAL is already running; not touching another agent's emulator"
fi

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
nohup "$EMU" -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -no-snapshot \
  > "$EMULOG" 2>&1 &
EMU_PID=$!

"$ADB" -s "$EMU_SERIAL" wait-for-device &
WAIT_PID=$!
waited=0
while kill -0 "$WAIT_PID" 2>/dev/null; do
  kill -0 "$EMU_PID" 2>/dev/null || { wait "$WAIT_PID" 2>/dev/null || true; fail "emulator died during boot; see $EMULOG"; }
  [ "$waited" -lt "$BOOT_TIMEOUT" ] || { kill "$WAIT_PID" 2>/dev/null || true; fail "device never appeared within ${BOOT_TIMEOUT}s"; }
  sleep 2
  waited=$((waited + 2))
done

# wait-for-device returns while the framework is still coming up. Poll the
# property or every command in that window fails confusingly.
log "waiting for sys.boot_completed"
while [ "$("$ADB" -s "$EMU_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
  kill -0 "$EMU_PID" 2>/dev/null || fail "emulator died before boot completed; see $EMULOG"
  [ "$waited" -lt "$BOOT_TIMEOUT" ] || fail "sys.boot_completed never reached 1 within ${BOOT_TIMEOUT}s"
  sleep 3
  waited=$((waited + 3))
done
log "booted in ~${waited}s"

# --- install ------------------------------------------------------------
log "installing $(basename "$APK")"
"$ADB" -s "$EMU_SERIAL" install -r "$APK" || fail "adb install failed (release APKs are unsigned — use the debug APK)"
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

# A launch that crashes still prints "Starting: Intent{...}". pidof after the
# wait is the actual liveness check.
log "waiting ${LIVENESS_WAIT}s for liveness"
sleep "$LIVENESS_WAIT"
PID="$("$ADB" -s "$EMU_SERIAL" shell pidof "$APP_PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
[ -n "$PID" ] || fail "$APP_PKG is not running ${LIVENESS_WAIT}s after launch (crashed on start)"
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
  waited_render=0
  SHARE="$(python3 "$SHARE_TOOL" "$SCREENCAP" | awk '{print $1}')" || fail "could not measure $SCREENCAP"
  while awk -v s="$SHARE" -v m="$BLANK_MAX_SHARE" 'BEGIN {exit !(s >= m)}'; do
    if [ "$waited_render" -ge "$RENDER_TIMEOUT" ]; then
      fail "the frame never stopped being near-solid within ${RENDER_TIMEOUT}s: one colour still covers ${SHARE} of it (threshold ${BLANK_MAX_SHARE}). The process is alive and the assets loaded -- open $SCREENCAP to see what is on screen. A splash that never gives way looks like this, and so does an app that paints nothing. If this screen is legitimately near-solid, raise BLANK_MAX_SHARE for this run and say so in the verdict."
    fi
    log "frame still near-solid (${SHARE}) after ${waited_render}s; re-capturing"
    sleep 5
    waited_render=$((waited_render + 5))
    "$ADB" -s "$EMU_SERIAL" exec-out screencap -p > "$SCREENCAP" || fail "screencap failed"
    SHARE="$(python3 "$SHARE_TOOL" "$SCREENCAP" | awk '{print $1}')" || fail "could not measure $SCREENCAP"
  done
  log "dominant colour covers ${SHARE} (threshold ${BLANK_MAX_SHARE}, after ${waited_render}s) -- below threshold, which is not a verdict that the app rendered; open $SCREENCAP"
else
  log "WARNING: $SHARE_TOOL or python3 missing — blank-screen check SKIPPED"
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

log "PASS: payload + install + clear + launch + liveness + screencap measured + www assets loaded (the screencap still needs a human look)"
exit 0
