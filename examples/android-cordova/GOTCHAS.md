# Earned Gotchas (EXAMPLE)

> These are one project's scars — a Cordova Android app. They are shown so you
> recognize the SHAPE of your own, not because they will apply to you. Almost
> none of them will.
>
> The shape is: a specific thing that looked fine, cost real time, and now has a
> sentence naming what it cost. That is what belongs in your project's
> `## This project` sections. It starts empty. It should.

## From the build pipeline

- **A fresh worktree builds a plugin-less artifact that still passes liveness.** `cordova build android` in a clean worktree silently emits an APK with no `cordova_plugins.js`. It installs, launches, holds a process, and shows a blank WebView. Fix: remove and re-add the platform, then verify the payload is in the built artifact before benching. Cost: two false reports before anyone checked the payload.

- **`cordova platform add` and `plugin add` silently re-park `file:` plugin specs into devDependencies.** After running either, re-check the manifest at HEAD before committing. Cost: shipped a false report twice.

- **A generated, gitignored config file missing from a fresh checkout produces a blank app that passes every automated check.** The bundle imported a module that the build generates only when a target is named. Without it the app throws inside the WebView, React never mounts, and the artifact still installs, launches, serves its index and carries a full plugin payload. Fix: the build aborts when the generated file is absent. Cost: a full bench pass on an app that rendered nothing.

- **Regenerating a platform is not reviewable mixed with hand edits.** A regeneration touching thousands of files hides the ten lines a human wrote. Separate commits, always.

## From the bench itself

- **`install -r` keeps the previous run's data.** A bench that does not clear app data inherits whatever the last agent left — including, once, a session whose timestamps straddled a clock change, which rendered nothing and passed.

- **A measurement is not a verdict.** The blank-screen check prints a number. It cannot tell a rendered app from a dialog-covered blank, and it cannot see a gradient-only blank at all. The output says so. Cost: a PASS line that asserted "screen painted" over an app that had painted nothing.

- **Host load produces failures that are not the app's.** Under load the guest's system UI throws its own not-responding dialog over the app, which contaminates any screenshot-based check. Discard those runs rather than reading them.

## From the environment

- **Tool resolution can be silently wrong.** The build tool resolved through a version manager to nothing on the default runtime; it existed only under one specific interpreter version. A wrapper that "is not found" and a wrapper that runs the wrong thing look identical until output disagrees.

- **Two agents, one emulator.** The bench refuses to touch a running instance rather than sharing it. Ownership by serial number is not ownership.
