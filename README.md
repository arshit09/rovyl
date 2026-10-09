<div align="center">

# Rovyl

**One gesture. Any destination.**

A radial launcher for Windows. Hold the middle mouse button anywhere, aim, release.

[![Download Rovyl for Windows](https://img.shields.io/badge/Download%20for%20Windows-2ea44f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/arshit09/rovyl/releases/latest)

![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4?style=flat-square)
![Rust](https://img.shields.io/badge/Rust-1.80%2B-dea584?style=flat-square&logo=rust&logoColor=white)
![Native](https://img.shields.io/badge/Win32-Direct2D-6e56cf?style=flat-square)
![Size](https://img.shields.io/badge/download-3.5%20MB-2ea44f?style=flat-square)

<img src="docs/media/banner.png" alt="" width="720">

</div>

---

## New in 2.0.0 — Rovyl is now a native Windows app

Rovyl was an Electron app. It is now a single Rust executable that draws the wheel through
Direct2D and DirectComposition — the same wheel, the same workspaces, the same settings.
**Already running Rovyl? It updates itself into this**, and nothing in `%APPDATA%\Rovyl` is
touched: your workspaces, your custom icons and your settings carry straight over.

| | 1.19.0 (Electron) | 2.0.0 (native) |
| --- | --- | --- |
| Download | 85.7 MB | **3.5 MB** — 24x smaller |
| Installed on disk | 296 MB | **3.5 MB** — 83x smaller |
| Files installed | 138 | **1** |
| Processes while it runs | a main process, a Chromium renderer per window, and separate helpers for the mouse hook, the foreground and the system readouts | **1** |
| Every update downloads | 85.7 MB | **3.5 MB** |

Measured on Windows 10, comparing the published 1.19.0 release and its unpacked install tree
against the 2.0.0 release. Idle in the tray, 2.0.0 holds about 60 MB of working set — in that
one process.

**Why it is quicker, and not only smaller**

- **The first frame exists before the window does.** The wheel paints from a surface that is
  already resident, so the gesture is not waiting on a paint handshake across a process
  boundary — which is what the Electron build needed, and needed a verification script to keep.
- **Nothing is spawned at runtime.** The mouse and keyboard hooks are callbacks on a thread of
  this process. The Electron build ran a long-lived PowerShell for the mouse hook, another for
  taking the foreground, another for extracting icons, and a C# helper for the system readouts.
- **One coordinate space.** The hook and the renderer are the same process, so there is no DIP
  rectangle handed to a DPI-unaware helper — the Electron build's standing mixed-DPI defect,
  absent here rather than worked around.
- **It never takes the foreground.** Keystrokes come from the hook, so the window you were
  typing in keeps the keyboard the whole time the wheel is open.

The port lives in [`rovyl-win/`](rovyl-win/), and
[its README](rovyl-win/README.md#succession-from-1x) explains how a 1.x install hands itself
over to it.

## Why

Every launcher asks you to stop what you are doing. Open a window, type a few letters,
read a list, pick a row. It is fast, but it is still an interruption — and your hand
leaves the mouse.

Rovyl takes a different bet: **you already know where your things are.** Hold the middle
mouse button and a wheel blooms in the middle of your screen. Move toward what you want.
Release. The whole thing takes less than a second, happens wherever you already were, and
never puts a window between you and your work.

<div align="center">
<img src="docs/media/wheel.png" alt="The Rovyl wheel open over the desktop" width="620">
</div>

## Features

- **Opens over anything** — any window, including fullscreen apps
- **Where you want it** — centred on the main screen, on the monitor your pointer is on, or right under the pointer
- **Launch anything** — applications, folders, files, websites, custom commands
- **Automatic discovery** — reads your Start Menu and extracts real app icons
- **Custom icons** — any workspace or shortcut can wear a glyph, a picture (PNG, JPG, SVG, WebP, ICO…) or any icon inside an EXE or DLL
- **Workspaces** — separate wheels for work, games, streaming; switch from the picker or with a number key
- **Your trigger** — middle mouse button, a side button, a global hotkey, or both; each can be turned off
- **Three aiming modes** — by direction for speed, by pointer for precision, or by area with each slice's share drawn on screen
- **Keyboard driven** — optional: press 1–9 to open a slice, and Q to step back out of a folder
- **Docks** — optional: your own shortcuts and a system dock (clock, battery, network, volume) beside the wheel
- **Launch without clicking** — optional: hides the pointer, picks by direction, and opens on its own
- **Focus protection** — stays out of the way while you are in a fullscreen game
- **Fully offline** — no account, no telemetry, no ads, nothing leaves your machine

## Install

<div align="center">

[![Download Rovyl for Windows](https://img.shields.io/badge/Download%20for%20Windows-2ea44f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/arshit09/rovyl/releases/latest)

**Windows 10 and 11 — free, no account, nothing to sign up for.**

</div>

The button opens the latest release on GitHub. Never downloaded from there? It is four
steps:

1. Under **Assets**, click the file ending in **`.exe`**. It saves to your `Downloads`
   folder like any other file.
2. Open it — from your browser's download bar, or by double-clicking it in `Downloads`.
3. Windows shows a blue **"Windows protected your PC"** screen, because the file is not
   signed. Click **More info**, then **Run anyway**.
4. One window appears: press **Install**. Rovyl then lives in your system tray — there is no
   wizard, no folder to choose and no admin prompt, because the whole program is that one
   3.5 MB file and it installs itself into your own account.

**From source** — see [Building](#building) below.

## How it works

<table>
<tr>
<td width="50%" valign="top">

**Hold**

Press and hold the middle mouse button anywhere in Windows. The screen dims and the wheel
appears — one throw in any direction reaches every shortcut. It opens in the centre by
default; Appearance → **Where it opens** can put it under the pointer instead. Two monitors?
Activation → **Monitor** picks between **Main screen** and **Follow pointer**.

</td>
<td width="50%" valign="top">

**Aim**

Move toward the shortcut you want. In direction mode the slice you point at lights up from
anywhere on screen; area mode does the same and draws each slice's share; in pointer mode
only the icon under the cursor lights up. With keyboard launching on, a number key picks the
slice outright.

</td>
</tr>
<tr>
<td valign="top">

**Release**

The target opens and the wheel disappears. Release in the centre, or press Escape, to
cancel without launching anything.

</td>
<td valign="top">

**Switch**

By default the wheel opens on a picker of your workspaces. Prefer number keys? General →
**Workspace switching** → **Keys**, and 1–9 move between them while the wheel is open.

</td>
</tr>
</table>

## Screenshots

<div align="center">
<img src="docs/media/workspaces.png" alt="Workspace cards, each previewing its own wheel" width="440">
<img src="docs/media/settings.png" alt="Appearance settings with a live preview of the wheel" width="440">
</div>

## Building

> **The shipped app is [`rovyl-win/`](rovyl-win/) — Rust, no Node.** `cargo build --release`
> there produces the whole program, and [its README](rovyl-win/README.md) covers the build,
> the install and the release. Everything below builds the 1.x Electron line, which 2.0.0
> replaced; it is kept because the website, the generated icon and language tables and the
> update feed still come from here.

Requires **Windows 10 or 11** and **Node 20+**. Windows-only by design: the trigger, the
icon pipeline and the window handling all depend on Win32 behaviour.

```bash
git clone https://github.com/arshit09/rovyl
cd rovyl
npm install
npm start
```

`npm start` builds once if `dist/` is missing, then runs the production renderer under
Electron — no dev server. For hot reload, `npm run start:dev` brings up Vite and waits for it
before launching Electron; to run the halves separately, use `npm run dev` and
`npm run electron`. Anything that only exists in a real install (the updater, for one) needs
`npm run start:packaged`, which packages the app without an installer and runs it.

Google sign-in needs credentials of your own — copy `.env.example` to `.env.local` and
fill in a client ID from your own Google Cloud project. There is deliberately no default,
so a fork never inherits someone else's OAuth client.

> The dev app and the packaged app share `%APPDATA%\Rovyl`, because Electron derives it
> from `productName`. A dev session therefore reads and writes your real configuration.
> Pass `--user-data-dir` to work against a clean profile.

<details>
<summary><b>All scripts</b></summary>

| Command | What it does |
| --- | --- |
| `npm start` | Production build under Electron, builds first if needed |
| `npm run start:dev` | Vite dev server + Electron |
| `npm run start:packaged` | Packaged app without an installer, built to `%LOCALAPPDATA%` |
| `npm run dev` | Vite only |
| `npm run electron` | Electron only, waits for port 5173 |
| `npm run build` | Native helper → `tsc` → Vite build → radial and renderer-budget checks → icons and Store assets |
| `npm run dist` | `build` + electron-builder, installer in `build-out/` |
| `npm run dist:store` | `build` + electron-builder, MSIX package for the Store |
| `npm run release` | Cuts a release (`release:check` to dry-run) |
| `npm run verify:radial-windowing` | Checks the wheel/Settings window-split invariants |
| `npm run verify:renderer-budget` | Keeps the wheel's bundle within its size budget |
| `npm run test:win32-launch` | Command parsing and quoting |
| `npm run test:persistence-shape` | Persistence blob normalisation |
| `npm run test:window-split` | Starts the real app on a throwaway profile and opens the wheel |

The other `test:*` scripts in `package.json` are focused smoke tests, one per feature.

</details>

## Contributing

Issues and pull requests are welcome. Before changing anything that looks arbitrary, read
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — most of it exists because something
broke, and the reason is written down.

Two things worth knowing up front: the code comments explain *why* rather than *what*, and
`npm run build` runs verification scripts that enforce the wheel's window contract and bundle
budget. If one fails, the contract was broken, not the test.

## Links

- **Download** — [latest release](https://github.com/arshit09/rovyl/releases/latest)
- **Website and docs** — [rovyl.arshitvaghasiya.com](https://rovyl.arshitvaghasiya.com)
- **All releases** — [github.com/arshit09/rovyl/releases](https://github.com/arshit09/rovyl/releases), or the [changelog](https://rovyl.arshitvaghasiya.com/changelog)
- **Upstream** — [HenryCauan/rovyl](https://github.com/HenryCauan/rovyl)
- **Privacy policy** — [rovyl.arshitvaghasiya.com/privacy](https://rovyl.arshitvaghasiya.com/privacy)

## License

Copyright © 2026 Henry Cauan.

Rovyl is free software, licensed under the **GNU General Public License v3.0** — see
[LICENSE](LICENSE). You may use, study, modify and share it. If you distribute a modified
version, you have to release its source under the same licence.

The copyright holder is not bound by that outbound licence, so the build sold on the
Microsoft Store is distributed under Microsoft's standard terms. Both are the same code.
