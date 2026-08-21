# Review Bench — Android emulator (EXAMPLE IMPLEMENTATION)

> This is ONE project's bench: a Cordova Android app, benched on an emulator.
> It is included because reading a real one beats reading a spec. Yours will
> share the contract in `contracts/BENCH.md` and share almost none of these
> details. Do not copy it; read it, then write your own against the contract.

The executable half of review. A static read plus a green build tells you the APK assembled; the bench tells you what the app does when it runs. Use it before any APPROVE that claims the software works.

Built and verified on one developer machine (Apple silicon, 16GB, macOS 15) in August 2026. Every number below is from that machine; yours will differ.

## What exists

- AVD name: `app-review` — Pixel 6 profile, 1080x2400 @ 420dpi, 2GB RAM, 10G data partition
- System image: `system-images;android-36;google_apis;arm64-v8a` (Android 16, API 36, arm64-v8a — matches the app's targetSdk 36)
- Emulator: `37.1.11`, config at `~/.android/avd/app-review.avd/config.ini`
- Cold headless boot to `sys.boot_completed=1`: 59 seconds

## Environment

Every command below assumes these. `adb` is not on PATH by default — use the absolute path or export it.

```sh
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

ADB=$ANDROID_HOME/platform-tools/adb
EMU=$ANDROID_HOME/emulator/emulator
```

## Boot

Headless, no audio, no boot animation, no snapshot (a clean boot every time — snapshots hide install-state bugs):

```sh
nohup $EMU -avd app-review -no-window -no-audio -no-boot-anim -no-snapshot > /tmp/emulator.log 2>&1 &

$ADB wait-for-device
until [ "$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done
$ADB devices   # expect: emulator-5554  device
```

Never `sleep 60` and hope. Poll `sys.boot_completed` — `wait-for-device` returns while the framework is still coming up, and every command you run in that window fails confusingly.

## Install

Debug APK only. Release artifacts are unsigned and `adb install` rejects them.

```sh
$ADB install -r /path/to/app-debug.apk        # expect: Success
$ADB shell pm list packages | grep app     # expect: package:com.example.app
```

bench.sh prints adb's own error text verbatim on a failed install rather than asserting a cause. An unsigned release APK is one known cause, but not the only one: a stale, signature-mismatched install already on the AVD from a previous run (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) produces the exact same failed-install shape from a signed, fine APK. A guard that explains into the wrong diagnosis is worse than one that stays quiet, so both causes are named and whoever reads adb's own error decides which applies. Remedy for the second: `adb uninstall <package>`, then retry.

## Launch and confirm it stayed up

```sh
$ADB logcat -c                                          # clear first, so the capture is this run only
$ADB shell am start -n com.example.app/.MainActivity
sleep 10
$ADB shell pidof com.example.app                   # non-empty = process alive
$ADB shell dumpsys activity activities | grep -m1 topResumedActivity
```

A launch that crashes still prints `Starting: Intent{...}`. `pidof` after 10 seconds is the actual liveness check.

## Screencap

```sh
$ADB exec-out screencap -p > evidence-launch.png
file evidence-launch.png     # expect: PNG image data, 1080 x 2400
```

Use `exec-out`, not `shell`, or adb's line-ending translation corrupts the PNG. Attach the file to the verdict.

## Logcat

Scope to the app's pid, or you drown in system noise:

```sh
PID=$($ADB shell pidof com.example.app | tr -d '\r')
$ADB logcat -d --pid=$PID > evidence-logcat.txt

grep -iE "FATAL|AndroidRuntime|Uncaught|SystemWebViewClient|ERR_|chromium.*ERROR" evidence-logcat.txt
```

That grep is the smoke pass for a Cordova WebView app. What it catches, from the real run that commissioned this bench:

```
E SystemWebViewClient: Exception handling Web resource at "index.html"
E SystemWebViewClient: java.io.FileNotFoundException: www/index.html
D SystemWebViewClient: CordovaWebViewClient.onReceivedError: Error code=-6
    Description=net::ERR_CONNECTION_REFUSED URL=https://localhost/index.html
```

An APK built without `www/` assembles, installs, launches, and stays resident. It fails only at runtime, in the WebView, and the screencap shows an "Application Error" dialog on a black screen. Nothing in a static review or a green Gradle build would have told you.

## Render check (h6i)

bench.sh now `pm clear`s the package before launch (every bench sees first-run state) and measures the screencap: a near-solid frame (dominant colour ≥0.90 of pixels) polls every 5s up to RENDER_TIMEOUT (90s) and FAILS if it never breaks up. Read its output as a **measurement, never a verdict**: below-threshold means "not near-solid", not "the app rendered" — gradient-only blanks (~0.075) and dialog-covered blanks (~0.77) pass the number, so **looking at the screencap stays mandatory**. A healthy app transits 0.92–0.94 mid-paint on the way up; a near-solid reading mid-poll is normal, only the timeout is a failure. Gradient-blank detection is app-mvv.

## Foreign-window check

The painted-frame measurement above cannot tell the app's own pixels from a system window drawn on top of it — a screencap can show the app genuinely rendered *under* a system dialog (e.g. "System UI isn't responding") and that frame can still clear the density/share thresholds. It also can't be caught downstream: the logcat capture is scoped `--pid=$PID` to the app's own process, so a System UI ANR, which belongs to a different process, can never appear in it.

bench.sh runs `adb shell dumpsys window windows` right after the frame check, writes it to `evidence-windows.txt`, and warns (does not fail) when a window other than the app and known chrome is visible over the frame. **This is a best-effort name, not a guarantee the frame is clean.**

The check gates on real per-window *visibility*, not mere registration — an earlier version listed every registered window and allowlisted a short chrome list by name, and on a live device run it flagged nearly every registered window: structural windows that were merely present, not drawing anything foreign over the frame (a screen-decor overlay, an edge-gesture handler, a taskbar, a notification shade, a drop target, the launcher activity, the wallpaper). A registered window is not an on-screen window, and a warning that fires every run is noise a reviewer learns to ignore.

`dumpsys window windows` prints an `isVisible=` line inside every window's own block (verified against AOSP's `WindowState.java` / `WindowManagerService.java`), and only a window whose block says `isVisible=true` is a flag candidate — an idle gesture-handler touch region, a collapsed notification shade, an occluded wallpaper, or a backgrounded launcher activity all read `isVisible=false` at rest. Genuinely always-visible chrome (`StatusBar`, `NavigationBar`, a rounded-corner/cutout screen-decor overlay, a taskbar on a gesture-nav skin) still needs a name allowlist on top of the visibility gate — it's real content on screen every frame, just not app content.

The `dumpsys` text format is not a stable contract across Android builds, and a legitimate window the parser doesn't recognise (a permission prompt, say) will show as a false positive if it happens to be visible. Detection here is not robust enough to gate the bench on, so it warns rather than fails.

**Opening the screencap and reading `evidence-windows.txt` when it warns stays mandatory** — the same rule as the render check above: a below-threshold or clean-window PASS is a measurement, never a verdict that the app rendered the right screen with nothing foreign on top of it.

## Verdict file

bench.sh tees its final PASS/FAIL line, with the exit code, into `<output-dir>/verdict.txt` as well as stdout/stderr — every other check (logcat, error grep, missing-assets, screencap) already lands in the output directory, and the verdict itself should too, so a reviewer checking the evidence directory sees the conclusion, not just what fed it. An arg-count or missing-APK failure can happen before the output directory is created; in that case there is nowhere to write the file, so bench.sh falls back to stderr only.

## Shut down

Always, when done. A leaked headless emulator eats ~2GB of RAM silently.

```sh
$ADB emu kill
$ADB devices   # expect: empty list
```

If it doesn't die: `pkill -f "emulator.*app-review"`.

## Gotchas

- **`avdmanager create avd -d <profile>` prints `Error: Could not load devices from .../devices.xml` and still succeeds.** The profile is applied — check `hw.device.name` in `config.ini` before believing the error.
- **`hw.gpu.enabled` defaults to `no`** on an avdmanager-created AVD, which breaks rendering under `-no-window`. This AVD is set to `hw.gpu.enabled=yes` / `hw.gpu.mode=swiftshader_indirect` — software rendering, no dependency on a logged-in window server, which is what makes screencap work from a background agent.
- **No HAXM, no hypervisor setup.** On Apple Silicon the arm64 image runs natively under Hypervisor.framework. Do not install an x86 image; it would emulate the CPU and be unusably slow.
- **Disk:** emulator 1.2GB + system image 4.3GB + AVD userdata 1.2GB after one boot = 6.7GB measured. The data partition is sparse with a 10G ceiling, so budget ~8GB.
- **RAM:** the AVD is capped at 2GB guest. Fine alongside a build on a 16GB machine — but don't run the emulator and a Gradle build concurrently on this hardware if you can sequence them.
- **`adb` starts a daemon on first use** (`tcp:5037`). Harmless; it survives the emulator and costs nothing.
- **Dismiss Cordova's "Application Error" dialog with BACK, never OK** — tapping OK ends the activity and kills the WebView devtools socket mid-measurement (found on app-mc9).
- **Never trust `adb forward tcp:9222` blindly** — it can silently attach to a desktop Chrome already bound to 9222 and hand you someone else's viewport. Use port 9333 and verify `/json/version` reports an `Android 16 ... wv` UA before trusting any measurement (found on app-mc9).
- **Check host load before benching.** At load averages ~11+/30+/60 (e.g. Backblaze/WindowServer churn), the guest ANRs SystemUI and kills the app with `start timeout` — two emulator cycles were lost to this. If `uptime` looks hot, wait or kill the offender first.
- **Launch the emulator as a background task, never from a foreground shell that can time out** — the timeout takes the emulator down with it.
- **Snapshot bench.sh before a run** (`cp` to your tmp dir and execute the copy) — bash re-reads a running script by file offset, so an edit landing mid-run produces phantom syntax errors on a file that parses clean (bit seat-worker-2 on app-5ri).
- **On a loaded host, raise LIVENESS_WAIT (e.g. 60)** — the default 10s can capture the splash under a "System UI isn't responding" card whose white panel drags the dominant-colour reading below threshold, passing a frame the app hasn't painted. Same family as the ANR-discard rule: check `uptime` first, distrust any capture with a dialog in it.
