# Architecture

Notes on the parts of Rovyl that are not obvious from reading the code, and the reasons
behind decisions that look arbitrary until you know what broke.

## Layout

```
backend/          Electron main, preload, and the PowerShell helpers
  electron-main.js      window lifecycle, IPC, licensing, updates, icon extraction
  electron-preload.js   the entire renderer-facing API surface
  mouse-blocker.ps1     captures the trigger button and blocks input outside the wheel
  foreground-focus.ps1  steals foreground when Windows refuses focus
  extract-icon.ps1      the icon pipeline
  game-detection.cjs    fullscreen/game detection for focus protection
  win32-launch.js       command parsing and quoting for launching targets
  persistence-normalize.cjs   disk-blob → renderer shape
src/              Renderer
  App.tsx               orchestration: state, persistence, IPC wiring, window modes
  components/
    RadialMenu.tsx      the wheel: layout, aiming, gestures, slices
    LicenseGate.tsx     the locked wheel shown without a license
    PrecisionSettings.tsx  the settings panel
  index.css             design tokens and every non-Tailwind style
scripts/          Build, launch and verification scripts
nsis/             Installer customisation
build/            Icon sources and generated assets
```

## Radial windowing

The wheel is a transparent, frameless, always-on-top window that is resized to fill the
monitor and then revealed. Getting this wrong on Windows produces visible flashes — the
DWM presenting a stale texture, or a black frame, or the window appearing at the previous
bounds.

The order is a handshake, not a sequence of calls:
`prepare-radial-show` → renderer paints a neutral cover → `radial-prep-paint-done` →
`open-menu` → renderer paints the wheel transparent → `radial-open-paint-done` → main
reveals → `radial-native-revealed` → the bloom animation starts.

`scripts/verify-radial-windowing.mjs` enforces the markers that keep this intact and runs
as part of `npm run build`. If it fails, the handshake was broken, not the test.

## Mouse trigger

The trigger button is captured by a `WH_MOUSE_LL` hook living in `mouse-blocker.ps1`,
which runs as a separate PowerShell process and reports `TRIGGER_DOWN` / `TRIGGER_UP` on
stdout.

It has to be a hook rather than a poll, and the reason is not obvious. An earlier version
polled `GetAsyncKeyState` every 16 ms, which only ever *observed* the button — the event
still reached the window underneath, and on any scrollable surface Windows started
autoscroll, so aiming at the wheel dragged the page behind it. Swallowing the event
requires returning 1 from a low-level hook, and a swallowed button also disappears from
`GetAsyncKeyState`. Whatever swallows the event must therefore also be what detects it.

A short, stationary press is not a gesture, so the hook synthesises a middle click back
into the window underneath — closing a browser tab still works. The synthetic events carry
a signature in `dwExtraInfo` so the hook does not re-interpret its own injection.

Left and right buttons are rejected outright: watching them globally would collide with
the primary click and the context menu.

While the button is held, Windows keeps pointer capture in whichever window received the
click, so the renderer sees no `mousemove`. The main process polls the cursor and sends
`mmb-cursor`; the renderer replays it as a real `mousemove` so aiming uses one pipeline.

## Aiming and confirmation

Two rules that cost a long debugging session, both worth preserving:

1. **Confirmation resolves from the live pointer**, never from React state. State travels
   `mousemove → rAF → setState → render → ref`; releasing mid-flight used to confirm the
   slice the pointer had already left.
2. **A slice's hit area must match its paint.** The slice wrapper is positioned at the
   slice's point and its content is centred with a transform — so the wrapper's layout box
   sits half a tile off. It is `pointer-events: none`; the visible tile takes the clicks.

Highlight and confirmation share one function, `resolveAimAtPoint`. They used to be
separate copies of the same trigonometry, and any divergence between them means lighting
up one icon and opening another — the worst possible defect in a launcher.

Targeting has two modes. `angle` picks the slice you point toward, from anywhere on
screen. `cursor` only highlights the icon actually under the pointer, and releasing away
from every icon cancels.

The centre's dead zone is `max(activationThreshold, hub box diagonal)`, and the hub also
carries a square hit target, because `border-radius` clips hit-testing and a click in the
circle's corner would otherwise fall through to a slice.

## Launching without a click

`radialInstantActivate: 'dwell'` makes the wheel launch whatever you hold your aim on for
`radialInstantDwellMs`. It is off by default, and deliberately so: it turns aiming — a neutral
act — into a destructive one, which is not a thing to switch on under someone who did not ask.

The whole engine lives in `RadialMenu.tsx` and touches nothing outside the renderer. Five rules
carry it, and all five exist because the obvious version is wrong:

1. **Arming is observed, never inferred.** A dwell may only start after a real `mousemove` lands
   more than 24 px from a baseline set by an earlier real `mousemove`. The tempting rail is
   `hasMoved`, and it does not work: it measures distance from the wheel *centre*, so it is
   already true whenever the pointer sits still far from the centre — exactly the state that must
   not launch anything.
2. **The arming delay is measured from the first paint,** not from `openingTimeRef`. The latter is
   written inside `openMenu`'s `flushSync`, before the main process reveals the window — whose
   fallback is 120 ms, or 240 ms restoring from minimised. Measured from there, the delay can
   expire while the wheel is still invisible.
3. **The target is `{ level, index, itemId }`, never the index alone.** A workspace switch on the
   scroll wheel, or an MRU fetch resolving late, replaces the level under a parked pointer and
   keeps the index. Every level change bumps the generation and disarms, so re-arming always costs
   a fresh 24 px — which is also what stops a dwell cascading through nested folders.
4. **Cancelling has to be synchronous.** `closingRef` is set by Escape, right-click and the trigger
   toggle before `onClose`, because `isOpen` only becomes false after React has batched and
   rendered — a window a click cannot outlive but a timer can.
5. **The clock measures a settled pointer, not an occupied wedge.** Starting it the moment the aim
   resolves measures "how long since you entered this slice", which in `angle` mode has no distance
   limit at all — and on a one-item level the slice is the whole plane, so crossing the dead zone
   in any direction would launch 400 ms later regardless of what the pointer did in between. The
   count therefore only begins once the pointer has stayed within 10 px for 90 ms. While it is
   moving, the thing being rescheduled is a bare `setTimeout`, not React state, so dragging across
   the wheel does not cost a commit per frame. A one-item level in `angle` mode refuses dwell
   outright — `buildRecentsEmptyFallback` exists so the parent IDE is never launched on its own.

A click also disarms the engine, and that matters in exactly one place. Every branch of
`handleAppClick` changes the level synchronously — which is what normally disarms — except the MRU
fetch, which only starts a spinner and awaits IPC. Without an explicit disarm, a timer already
counting on the tile you just clicked would push the same folder a second time, and the gesture
would stay live to launch whatever the pointer drifted onto while you waited.

There is deliberately **no "how long since the last `mousemove`" check**, and the omission looks
like one until you try it. It is the obvious guard against a pointer that has left the wheel's
box — the window is ~988 px, not the screen, and once the pointer is outside it `lastPointerRef`
freezes on a point that in `angle` mode still resolves to a perfectly good slice. But a still hand
emits no events either, and being still *is* the gesture: with that check the ring fills and
nothing ever launches. Leaving the window is an event — `mouseout` with a null `relatedTarget`,
`mouseleave`, `blur` — and that is where it is handled.

After a dwell fires, a 300 ms quarantine swallows the next click. Without it the user's trained
click lands ~200 ms later, on a wheel that has already descended a level, and launches whatever
happens to sit in the same direction.

The progress arc is CSS on `stroke-dashoffset`, restarted by remounting the `<svg>` through its
`key`. It is three stacked paths, not one, for the same reason the tile has a double contour: the
ring runs *outside* the tile's opaque plate, so the only thing behind it is the scrim and then a
wallpaper nobody controls. An opaque dark casing carries the light track, which carries the arc.
The path starts at top-centre — an `<svg>` `<rect>` begins its implicit path at the end of the
top-left corner arc, so the ring filled from an offset that moved with the icon size, and a clock
that does not start at twelve reads as a bug. It appears only once the pointer has settled, from an aim re-resolved at that moment, and
both the moment it is drawn and the moment it launches re-check `{ level, index, itemId }` — nearly
half a second separates the two, and the level can change under a pointer that never moved. That is
why the ring and the thing that launches cannot disagree, which is the defect `resolveAimAtPoint`
exists to prevent.

`'swipe'` is declared in the union and implemented nowhere; every read coerces it to `'off'`. The
gesture needs the pointer to start at the wheel centre, and it does not: the wheel opens at the
centre of the primary display while the cursor stays where it was, and the radial window is a box
(~988 px), so a cursor in a screen corner produces no `mousemove` at all. Making it work means
warping the cursor from the main process — that is, editing the mouse hook, which has already
stopped all system input once.

## Icons

`extract-icon.ps1` produces a normalised 256px PNG data URL. Order matters:

- **Packaged apps** — read `AppxManifest.xml`, prefer the `Square44x44Logo` family (the
  app icon) over `Square150x150Logo` (the Start-menu tile), take the largest variant, skip
  `contrast-*` (high-contrast themes), and give `altform-unplated` a modest bonus rather
  than an automatic win.
- **Desktop apps** — `IShellItemImageFactory` without `SIIGBF_SCALEUP` first, so the shell
  returns the largest native asset and only one resample happens.
- Every candidate is **measured** (`IconExtractor.Analyze`) for a white halo — the
  signature of an icon composited over a light plate and then alpha-cut. A dirty candidate
  loses to a clean one from another source.

`ICON_PIPELINE_VERSION` in `electron-main.js` must be bumped whenever this script changes;
the cache is discarded when it does not match.

## Persistence

`config-v2.json` in `userData`, written atomically, with a `.bak` and a quarantine path
for corrupt blobs. `persistence-normalize.cjs` accepts both the legacy flat shape and the
v2 nested shape and always returns `{ user, apps, config }`.

On read, the stored config is spread **over `DEFAULT_UI_CONFIG`**. Without that base, any
setting introduced after a file was written arrives as `undefined` instead of its default,
which reads as "the backup lost my settings" when they were never in the file at all.

Two rules learned the hard way: never gate a *write* on `cancelled` — cancellation exists
to stop work in flight, not to discard results already obtained — and merge asynchronous
results **by id**, never by array identity, because the config legitimately changes while
slow work is running.

## Distribution channels

The same source produces two builds, and they differ in one respect that matters.

`process.windowsStore` is set by Electron when the process runs from an MSIX package.
`isStoreBuild()` reads it, and the Store build consequently disables the self-updater —
the Store forbids one, and a submission with `autoInstallOnAppQuit` active fails
certification — and skips the license gate, because the Store collected payment before it
handed over the package.

The direct build keeps both: `electron-updater` against this repository's releases, and a
license key. There is no native update dialog — the main process emits `update-state`, the
wheel shows a badge on the hub, and Settings → Advanced offers the restart.

For direct clients to see an update, `version` in `package.json` must be higher than the
installed one, and the release must carry `latest.yml` alongside the installer. For the
Store, the version must simply be higher than the published one and end in `.0`.

## Licensing (direct channel)

The activated profile lives in `user` inside `config-v2.json`. The device identifier is
derived from the Windows `MachineGuid`, hashed with SHA-256 before it leaves the machine,
so reinstalling or resetting the profile does not consume one of the three slots.

**Known limitation:** the app trusts `isPremium` as read from disk and never revalidates
against the server after activation. Copying the persistence file to another machine
therefore carries the activation with it. Revalidation on launch, with an offline grace
period, is the fix.

## Conventions

- **Comments explain *why*, and are written in Portuguese.** A comment that restates the
  code is noise; the ones here carry the reason a line exists, usually a bug that
  motivated it. That is the single most useful thing in this codebase — read them before
  changing behaviour that looks arbitrary.
- **Design tokens live in `src/index.css`.** The radial is monochrome — white and black,
  plus the user's hover colour. Don't introduce new hues; the update badge is the single
  deliberate exception.
- **Opacity is not a de-emphasis channel** for elements that carry their own background:
  alpha multiplies the plate too, and the object stops being readable over an unknown
  desktop. Use content contrast instead.

## Release

```bash
$env:GH_TOKEN = "<token with contents:write on this repository>"
npm run dist -- --publish always
```

Always go through `scripts/run-electron-builder.mjs` — which is what `npm run dist` does —
rather than calling `electron-builder` directly. The runner picks the output directory, and
`ZENITH_BUILD_OUTPUT` overrides it. That override is the escape hatch for a real and
recurring failure: Windows security software opens `build-out/win-unpacked/resources/app.asar`
to inspect it and does not always let go, and the next packaging run dies on
`EnsureEmptyDir` because it cannot delete a file nothing of yours is holding. Build
somewhere else and the run completes; the stale file disappears on the next reboot.

`build.publish` in `package.json` points at this repository, so the source and the builds
made from it live in one place. It must be public: the updater reads `latest.yml` from the
release assets anonymously.

The Store package is built with `npm run dist:store` and uploaded manually in Partner
Center. `build.appx` carries the identity values issued by the Store; a fork will need its
own.
