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
  system-status.cjs     the helper that reads volume, network and battery for the system dock
src/              Renderer
  App.tsx               orchestration: state, persistence, IPC wiring, window modes
  components/
    RadialMenu.tsx      the wheel: layout, aiming, gestures, slices
    ScreenDocks.tsx     the two corner strips drawn beside the open wheel
    DockShortcuts.tsx   the list that edits the shortcut dock (Settings only)
    LicenseGate.tsx     the locked wheel shown without a license
    PrecisionSettings.tsx  the settings panel
  index.css             design tokens and every non-Tailwind style
  utils/
    screenDocks.ts      what a dock is, and whether it costs a window or a process
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
gesture needs the pointer to start at the wheel centre, and by default it does not: the wheel opens
at the centre of a monitor while the cursor stays where it was, and the radial window is a box
(~988 px), so a cursor in a screen corner produces no `mousemove` at all. `radialMonitor: 'cursor'`
does not change this — it picks the screen the pointer is on, which shortens the gap without
closing it. `radialPlacement: 'cursor'` does close it, but only while that setting is on, and a
gesture may not be implemented for one branch of a setting. Making it work unconditionally means
warping the cursor from the main process — that is, editing the mouse hook, which has already
stopped all system input once.

## Where the wheel opens

Two settings, and they answer two different questions.

`radialMonitor` chooses the screen: `'primary'` (the default, and what shipped) or `'cursor'`, the
one the pointer is on. It picks a SCREEN and never a point.

`radialPlacement` chooses the point on it: `'center'` (the default, and what shipped) or `'cursor'`,
under the pointer. This is not the old free positioning returning — that stored a point the user had
dragged the wheel to and pinned it there across sessions, and it is still gone. `radialPlacement`
stores no point at all; the pointer is read once, inside `showMenuAtCursor`, at the moment of the
open. `radialModeBounds` has always taken a centre point and still does; what changed is that
something other than the display's midpoint is now allowed to supply it.

`radialOpenCenter` is where the two meet, and it holds the one piece of arithmetic worth knowing:
the pointer is pulled back from each edge by `radialRingReach` (the renderer's radius plus one tile,
sent through `setRadialViewport` — main cannot derive it, because `size` has the gesture margin
baked in and is several hundred px wider than anything drawn). Without that clamp, opening in a
corner puts half the ring off the screen, and the targets on that half cannot be aimed at. The clamp
is also why the box, when `radialModeBounds` runs out of display and clips it, only ever clips on a
side that coincides with the physical screen edge — so the scrim's cut-off is never visible.

At the pointer, placement decides the screen too: `radialTargetDisplay` follows the cursor whenever
either setting asks it to, since a wheel under a pointer that is on the second monitor *is* on the
second monitor. Choosing `'primary'` and `'cursor'` together is asking for two places at once, and
the pointer wins because it is the one the hand can see.

`radialTargetDisplay()` is the single answer to "which monitor", and every caller that decides the
wheel's geometry goes through it — `showMenuAtCursor`, `applySmallModeCollapsedBounds` and
`collapse-idle-overlay`. They have to agree: idle parks the transparent box on the monitor the next
open will use precisely so that opening costs no resize, and a resize on this window is a DWM flash.
When the pointer has moved to another screen since the collapse, `showMenuAtCursor` catches it
through `nativeResizeRisk` and hides the window before moving it.

`windowedBoundsForWorkArea` is NOT one of those callers and must not become one: it is the Settings
panel's default rect, which belongs on the main screen.

The setting reaches main twice over, and both paths are load-bearing. `set-radial-viewport` carries
it from the renderer, which owns the config — the same channel as the box size and the full-bleed
flag, because all three are geometry needed *before* an open. But the global shortcut is registered
before React has committed anything, so on a cold start the first press can beat that message; main
therefore also seeds the flag from `config-v2.json` at boot. `applyRadialMonitorSetting` ignores any
value that is not one of the two, so a renderer that sends nothing cannot wipe what disk supplied.

Two rules came out of making this work, and both are load-bearing for anything that moves the wheel
between screens:

1. **One HWND cannot span two monitors.** Settings and the wheel share a single window, so opening
   the wheel on monitor B necessarily takes a visible Settings off monitor A. That is fine. What is
   not fine is the frame-reuse path doing the opposite: it hands the hook Settings' rect as the only
   clickable region *and* tells it to block the monitor the wheel was aimed at. On one screen those
   are the same place; on two they need not be, and then the allowed rect does not intersect the
   blocked monitor at all and every click on it is swallowed — the launch click included — while the
   wheel is drawn somewhere else entirely. `isMainWindowOnDisplay` is the guard, and it also clears
   `panelOverlayActive` so the box is not stretched toward a panel on another screen.
2. **Screen→client conversion uses main's `windowOrigin`, never `window.screenX/Y`.** Those metrics
   describe the window one frame late — the trap `openMenu` already calls out for the first paint —
   and a window that has just changed monitors makes the stale value wrong by a whole screen instead
   of by the difference between two rects. The hold gesture's `mmb-cursor` replay feeds the AIM, so
   an origin that is wrong does not smudge a pixel: it confirms a slice the hand never pointed at.

### Known limitation: the hook's coordinate space on mixed-DPI layouts

`setRadialMouseBlocking` hands the hook DIP rects, and `WARP` hands it DIP points, while the hook
reads `MSLLHOOKSTRUCT.pt` and calls `SetCursorPos`. **This is correct only while every monitor shares
the primary's scale factor, and it is a real defect when they do not.** It has not been fixed, and the
reasoning matters more than the symptom, because the obvious half-fix is worse than leaving it.

The helper runs under `powershell.exe`, which is DPI-unaware — measured, not assumed:
`GetProcessDpiAwareness` returns 0 (`DPI_AWARENESS_UNAWARE`) for the exact invocation
`ensureRadialMouseBlocker` uses. An unaware process is virtualised by the **system** DPI, uniformly
across the whole virtual desktop; Electron derives DIP **per display**. Those two spaces agree on any
monitor whose scale factor equals the primary's — so on an all-100% or otherwise uniform setup they
agree everywhere, which is why this has never been seen. Worked example of when they do not: primary
2560×1440 @150%, secondary 1920×1080 @100% to its right. Origins still match, but the secondary's
1920 DIP width reaches the hook as 1280 of its virtualised units. The allowed box then lands partly
off the wheel, so the confirming click can be swallowed — a selection that never fires — and a band of
the monitor is left unblocked, so a click meant for the scrim reaches the app underneath.

`radialMonitor: 'cursor'` is what makes this reachable, since it is the only way the wheel lands on a
non-primary monitor.

The fix is three coupled parts and must land as one change: convert the `BLOCK` rects
(`dipToScreenRect`), convert the `WARP` points (`dipToScreenPoint`), **and** give `mouse-blocker.ps1`
the `MatchElectronDpiAwareness()` call that `foreground-focus.ps1` already carries. Doing only the
last one breaks clickless cursor parking for everyone on a scaled *primary* monitor — current users,
regardless of this setting — because the same process's `SetCursorPos` is fed those same DIP points.
Note also that `TRIGGER_PASSTHROUGH_SLOP_PX` and `MMB_CLICK_DRAG_PX` are main-authored numbers the
hook compares against deltas in its own space, so they move with it.

## The corner docks

Two strips drawn beside the open wheel and gone when it closes: the **shortcut dock**, which holds
icons the user chose, and the **system dock**, which reads the clock, the battery, the network and
the volume. Both are off by default, and the shortcut dock is empty within that — this is the only
thing Rovyl paints outside the wheel itself, and a strip appearing in someone's corner because they
updated is a fault report, not a feature arriving.

They replaced `taskbarOverlay`, which hid parts of the real Windows taskbar while the wheel was up.
That feature is gone entirely, along with `backend/taskbar-control.ps1`. It was never reliable: on
Windows 11 22H2 and later the Start button, the clock, the tray and the task buttons are XAML
visuals inside a single `DesktopWindowContentBridge` with no HWNDs at all, so no outside process can
touch them without running code inside `explorer.exe`. What worked on Windows 10 worked by
enumerating undocumented window classes, and the bar's background could never be restored exactly,
because `GetWindowCompositionAttribute` reports `ACCENT_DISABLED` on a bar that is visibly
translucent. Drawing our own strip asks nothing of explorer and looks the same on every build.

### Where a dock is, and what that costs the window

`src/utils/screenDocks.ts` is the whole model: six regions, sizes, gaps, and the predicates that
decide whether anything happens at all. Three places read it and they must not disagree —
`RadialApp` (which sizes the overlay window), `RadialMenu` (which draws them) and the settings
panel (which edits them) — so it lives apart from all three.

A dock in a corner forces the overlay window to take the whole monitor
(`docksNeedFullBleed` → `setRadialViewport({ fullBleed })`). The wheel normally opens in a box
around itself, which is what keeps the DWM off a monitor-sized layered surface; a dock placed in
that box floats a couple of hundred pixels off the wheel on a diagonal, in the corner of nothing
the user can see. The corner gear already asked for the same thing for the same reason.

Two docks can be asked for the same region, so `ScreenDocks` draws BOTH: a region is one
`position: fixed` shell and whatever lands in it is stacked inside, readouts closest to the edge.
Two components would have been two boxes against the same edge, one on top of the other. Anything
else placed from that edge steps inboard by `dockStackHeight(...)` — a computed number, not a
measurement, because the gear is positioned before either dock has laid out.

Docks are withdrawn entirely in direction mode (`radialInstantActivate: 'dwell'`), where the
pointer is hidden and parked at the centre. An icon that cannot be pressed is worse than no icon,
and the click that tried would launch the slice it was aiming across. Every mouse event a dock
takes is stopped dead, the same as the gear's: the wheel confirms its aim from a `mouseup` on the
WINDOW, so a click that reached it would launch a dock icon *and* a slice.

### The readings

`rovyl-helper.exe system-status` is a third long-lived helper, spoken to over stdin exactly like the
mouse hook: `POLL`, `WATCH <ms>`, `VOL <0-100>`, `MUTE <0|1|2>`, `EXIT`, with `READY` and
`STATUS <volume> <muted> <network> <signal> <battery> <charging>` on stdout.
`backend/system-status.cjs` owns the process and `scripts/screen-docks-smoke.mjs` reads both it and
the `.cs` to pin that field order — nothing type-checks across that boundary, and getting it wrong
means the battery pill showing the volume.

Four decisions are worth keeping:

1. **The helper follows the SETTING; the polling follows the WHEEL.** `setActive` is driven by
   `statusDockNeedsHelper`, so a dock switched on keeps a process and the first wheel of the session
   does not pay to start one. `setWatching` is driven by the open and close paths, so an idle
   session polls nothing — the helper sits on a `WaitOne(Infinite)`. A clock-only dock needs no
   helper at all: `Date` answers it.
2. **Every reading carries its own "unknown", and it is `-1`.** A desktop PC has no battery and a
   cable has no signal quality. A readout that cannot tell those from "empty" shows a flat battery
   and no bars to somebody whose machine is fine.
3. **The last reading survives the helper exiting,** and it survives the wheel closing. It is held
   in `RadialApp`, not in `RadialMenu`, because that component is remounted on every open
   (`radialMountKey`) — a reading kept inside it would reset to unknown at the start of every
   gesture and the dock would paint four blanks until the next poll.
4. **The volume bar owns itself while the hand is on it.** The reading comes back once a second;
   without holding the dragged value the bar snaps back to the old one between the drag and the next
   poll, which is the classic "the slider does nothing". Dragging uses pointer capture, because the
   pointer leaves a 5px rail within a few pixels of movement.

Clicking a readout opens Windows' own panel, and the renderer names it (`"network"`) rather than
spelling it (`"ms-availablenetworks:"`) — a renderer that can hand main an arbitrary URI is a
renderer that can ask the shell to run anything. The wheel comes down first and the panel is asked
for second, the order the corner gear already follows: a panel opening behind a wheel that still
holds the mouse is a window nobody can reach.

### Launching from a dock

A dock icon is an ordinary `AppItem` and it launches through the wheel's own path —
`onClose(item.id, item)`, with the item passed explicitly because it is not in any workspace. One
launch path means one place where a failure is reported. The failure card offers no "Fix" for a
dock icon (there is no `rootId`), which is correct: the shortcut it would open is not in the
workspace Settings would show.

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
the Store forbids one, and a submission that runs an installer of its own fails
certification — and skips the license gate, because the Store collected payment before it
handed over the package.

The direct build keeps both: `electron-updater` against this repository's releases, and a
license key. There is no native update dialog — the main process emits `update-state`, the
wheel shows a badge on the hub, and Settings → General offers the restart.

A downloaded update installs on the next LAUNCH, and `autoInstallOnAppQuit` is off. The
default does the opposite: it spawns the silent NSIS installer behind the closing app, so a
user who quit Rovyl in order to update it and reopened it moments later landed inside that
install — the installer's own taskkill killed the instance they had just started, and the
quit-time install relaunches nothing, so the launch simply appeared to fail. Instead,
`update-downloaded` writes `pending-update.json` into userData, and
`installPendingUpdateAndExit()` reads it at startup — after the single-instance lock, before
a window exists — spawns the installer with `--updated /S --force-run` and exits. The
installer has the folder to itself and reopens the new version when it is done.
`backend/pending-update.cjs` holds the branching (already installed, installer gone, one
already running, two failed attempts) and `npm run test:pending-update` covers it.

The user watches that install happen. The `update-splash` verb of the native helper
(`backend/native-helper/rovyl-helper.cs`) puts up a WinForms window in the product's
palette — logo, version, indeterminate bar. It is not a `BrowserWindow` because a running
`Rovyl.exe` holds handles on the files NSIS is replacing; an Electron splash would either be
killed mid-install or break the install. Helper and logo are copied to the temp folder
first, so nothing reads out of the directory being rewritten, and the copy is spawned
detached — which it can be, and a PowerShell one could not: a console program given no
console exits before it runs a line, and one spawned attached dies with Rovyl a second into
the install.

The bar's smoothness is a requirement, not a detail — it is the only moving thing on screen.
Position comes from a `Stopwatch` rather than a tick count, so a late frame lands where it
belongs; frames are requested from a threading timer (`WM_TIMER` is coalesced to ~15.6 ms,
low priority, and cannot hold 60 fps); and process watching runs off the UI thread, because
enumerating processes costs tens of milliseconds and would show up as a stumble. The splash
follows the installer by pid, switches to "Starting Rovyl" when that process ends, and closes
once a Rovyl newer than itself is on screen — or after a timeout, so it can never outlive
what it is describing.

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

- **Comments explain *why*, in English.** A comment that restates the code is noise; the
  ones here carry the reason a line exists, usually a bug that motivated it. That is the
  single most useful thing in this codebase — read them before changing behaviour that
  looks arbitrary. (They were written in Portuguese until `5b273eb`, which translated all
  ~1,760 lines of them. Three kinds stay Portuguese because they are data and not prose:
  the Windows error patterns in `launchFailure.ts`, the `pt` block in `translations.ts`,
  and the glyph samples in `verify-renderer-budget.mjs`.)
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
