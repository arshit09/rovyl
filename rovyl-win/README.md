# Rovyl (native Windows)

A radial launcher for Windows. Hold the middle mouse button anywhere, aim, release.

One executable, one process — no installer to build and nothing to spawn at runtime.

## Requirements

- Windows 10 or later
- [Rust](https://rustup.rs) 1.80 or later, MSVC toolchain (`stable-x86_64-pc-windows-msvc`)
- Visual Studio Build Tools, with "Desktop development with C++" — the build links with `link.exe`

Check the toolchain:

```powershell
rustup show active-toolchain   # should say ...-pc-windows-msvc
cargo --version
```

## Build

```powershell
cargo build --release
```

The binary lands at `target\release\rovyl.exe`. A debug build (`cargo build`) works too and is
usable the same way — only slower to open the wheel.

## Install

The executable installs itself. No setup `.exe` to build, no admin prompt — everything goes under
`%LOCALAPPDATA%` and `HKEY_CURRENT_USER`.

```powershell
.\target\release\rovyl.exe --install
```

That copies itself to `%LOCALAPPDATA%\Programs\Rovyl`, makes a Start menu and a Desktop shortcut,
registers an entry in Windows' "Installed apps" list, and starts it in the tray. If a 1.x (Electron)
build is installed, it is retired first — see [Succession from 1.x](#succession-from-1x).

Options:

| Flag | Effect |
| --- | --- |
| `--beside` | Install to `...\Programs\Rovyl Native` and leave a 1.x build alone |
| `--no-desktop-shortcut` | Start menu shortcut only |
| `--no-launch` | Install without starting it |

`--beside` is for trying this next to a working 1.x install. Both read the same `%APPDATA%\Rovyl`,
so they share your workspaces — run only one at a time, or two launchers fight over the same global
shortcut and one of them silently does nothing.

### Uninstall

```powershell
rovyl.exe --uninstall
```

Removes the shortcuts, the startup entry and the registry entry; the install folder goes on the
next Windows restart. Your workspaces in `%APPDATA%\Rovyl` are left alone.

## Succession from 1.x

Rovyl 1.x was an Electron app installed by NSIS, and every copy of it watches the same GitHub feed
this one publishes to. That is the whole update path: publish the native build as the release's
`.exe` with a hand-written `latest.yml` beside it, and the next update check moves everyone across.

```powershell
scripts\release.ps1
```

That writes `dist\Rovyl-Setup-<version>.exe` and `dist\latest.yml`, and prints the `gh release
create` line to publish them. Nothing is published automatically.

What a 1.x install does with it: downloads the `.exe` named in the feed, checks it against the
feed's `sha512`, and spawns it with NSIS's arguments — `--updated /S --force-run`. There is no
signature to satisfy (1.x shipped unsigned, so electron-updater skips that check) and no installer
format to imitate.

What this build does on the other side of that spawn ([`src/sys/migrate.rs`](src/sys/migrate.rs)):

1. Copies the new executable into `%LOCALAPPDATA%\Programs\Rovyl` **first**, as `Rovyl.new.exe`.
   Nothing is deleted until it is on disk, so a copy that fails leaves the user's launcher intact.
2. Copies `config-v2.json` aside to `config-v2.json.pre-native.bak`.
3. Ends every process running out of the old folder — by path, never by name, because the old
   build's executable is also called `Rovyl.exe`.
4. Deletes the old shortcuts (after reading each one's target, so a shortcut somebody made
   themselves is left alone), the `com.henry.rovyl` Run entry, the NSIS uninstall entry, the
   updater's pending-update note, and the folder's contents.
5. Renames the staged executable to `Rovyl.exe`, writes the shortcuts and the uninstall entry, and
   carries over "start with Windows" and the desktop shortcut exactly as they were.

**It never runs `Uninstall Rovyl.exe`.** That uninstaller was built with electron-builder's
`deleteAppDataOnUninstall: true`, so it deletes `%APPDATA%\Rovyl` — the workspaces, the custom icons
and the settings. Handing the migration to it would empty every migrated user's wheel.

Running the downloaded file by hand instead opens a window — the mark, one sentence about what
happens to your workspaces, Install and Close. Which of the two it does is decided by the file's own
NAME: the same bytes are the application as `Rovyl.exe` and its installer as `Rovyl-Setup-2.0.0.exe`.
`--setup` forces the window from a build tree.

## Run

Run the binary directly, without installing:

```powershell
.\target\release\rovyl.exe          # opens the settings window
.\target\release\rovyl.exe --tray   # starts quietly in the tray
```

Then:

- **Hold the middle mouse button**, aim at a slice, release to launch.
- Or press **Alt+Z**.
- Both the trigger button and the shortcut are configurable in the settings window.

Only one instance runs at a time. Launching a second one wakes the first instead.

### Adding shortcuts by dropping them

The Shortcuts list in a workspace — and the one in the dock — takes a drop. The whole section is
the target, so a near miss on an empty workspace still lands.

| Dropped | Becomes |
| --- | --- |
| A program, or a `.lnk` to one | An application shortcut, keeping the `.lnk` so its arguments and working directory come too |
| A folder, or a `.lnk` to one | A folder shortcut, resolved through the shortcut |
| A `.url` or `.website` file | A web shortcut to the address inside it, which can then find its own favicon and page title |
| Any other file | A file shortcut, opened with whatever Windows has registered |
| A link dragged out of a browser | A web shortcut |
| Text | A path, an address or a command line, whichever it reads as — `npm run dev` becomes a command, `example.com` a website |

Several at once become several shortcuts, in the order they were dropped. Files win over a dragged
link, which wins over text: a link dragged out of a browser brings its own title along as text, and
reading both would add the same site twice.

### Editing a workspace as code

A workspace opens in Settings → Workspaces as a grid of controls. The second button at the top of
that dialog opens the same workspace as JSON, in an editor:

- It holds **one workspace** — its name, key, icon and shortcuts. Nothing else in the
  configuration can be reached from it, so a bad edit cannot take the triggers or the other
  workspaces with it.
- The workspace's `id` and its positional `hotkey` are not in the text. Both are identity rather
  than settings, and both are kept whatever the text says.
- The line under the box says what the text currently reads as, or which line it stopped on.
  **Apply** is only available while it reads.
- Nothing is written until **Apply**. **Revert** goes back to what the workspace holds, and closing
  the dialog with unapplied text asks once before discarding it.

Tab indents (Shift+Tab outdents), Ctrl+Z / Ctrl+Shift+Z undo and redo, Ctrl+A/C/X/V do the usual,
Ctrl+arrows move by word, and Shift+wheel scrolls a long line sideways.

Applying may tidy the text — a shortcut with no `id`, or two sharing one, is given a fresh one, and
a shortcut pointing at a widget this build no longer has is dropped. Whatever it did is said in the
message after it, and the box is rewritten to match what was stored.

## Development

Work against a throwaway profile, so a dev session does not read and write your real
configuration:

```powershell
$env:ROVYL_USER_DATA = "$env:TEMP\rovyl-dev"
.\target\debug\rovyl.exe --seed      # write a fresh first-launch config there
```

A running executable holds its own file open, so a rebuild fails with "Access is denied". Use the
dev wrapper, which stops only the copy under this tree:

```powershell
scripts\dev.ps1 cargo build
```

Two tables are generated from the Electron build rather than retyped, so the two never drift —
the settings panel's seven languages, and the icon picker's English keywords:

```powershell
node scripts\gen-i18n.mjs          <rovyl>\src\i18n\translations.ts              src\i18n\settings_strings.rs
node scripts\gen-icon-keywords.mjs <rovyl>\src\utils\iconPickerEnglishKeywords.ts src\gfx\icon_keywords.rs
```

Tests:

```powershell
cargo test
```

Useful flags — all of them print to the terminal they were launched from and exit:

| Flag | What it shows |
| --- | --- |
| `--diagnose` | This build's view of the config on disk: workspaces, triggers, geometry, unresolved glyphs, displays |
| `--probe <out.png>` | Draws one frame offscreen to a PNG |
| `--bench [rounds]` | Measures the open path against the real window and swapchain |
| `--web <url>` | What a web shortcut would be born with: title, favicon, timings |
| `--recents <label> <command>` | What the MRU ring would show for a shortcut |
| `--updates` | What the release feed would tell the settings panel |
| `--icon-from <file> [n]` | Stores a picture, or one icon out of a program or DLL, and names the reference |
| `--probe-drop` | Reads the clipboard as if it had been dropped on Settings: formats, entries, shortcuts |
| `--probe-settings <out.png>` | Draws the settings window offscreen; `--section`, `--workspace`, `--icons`, `--card`, `--code` pick what |
| `--probe-fonts` | What the three bundled faces resolved to, and a measured width per role and weight |

`--code` opens the workspace's JSON editor rather than its controls. `--code-text <file>` puts that
file in the box instead of the workspace's own text, which is how the broken-text face is captured
— it is otherwise only reachable by typing. With `--code`, `--scroll` counts lines rather than
pixels, and `--code-col <n>` scrolls sideways.

`--icon-search <term>` fills the glyph picker's box, and `--multi [n]` turns the installed list's
multi-select on with the first n rows ticked. Both exist because what they show is a function of
something only typing or clicking can set.

`--drag <x>,<y>` puts a drag over that client point, which is the only way to photograph the drop
sheet — it is raised by OLE telling the window a drag has crossed it, and no click reaches that path.

`--probe-drop` is the other half of the same feature. Drag-and-drop starts with a hand on a mouse,
so the data object cannot be conjured by a test; the clipboard carries the same `IDataObject` with
the same formats, and copying files in Explorer and running this exercises everything the drop
would do with them.

`scripts\shot.ps1 -Class RovylSettings -Out settings.png` captures one of this build's windows.

## Typefaces

Three faces are compiled into the executable and handed to DirectWrite as a private collection, so
the product looks the same on a fresh install as it does on the machine it was built on:

| File | Role | Licence |
| --- | --- | --- |
| `assets/fonts/Inter.ttf` | Settings, menus, every window | SIL OFL 1.1 |
| `assets/fonts/SpaceGrotesk.ttf` | Headings and the wordmark | SIL OFL 1.1 |
| `assets/fonts/InstrumentSans.ttf` | The wheel | SIL OFL 1.1 |

Each is the upstream variable font with its name table normalised to a single family name, and its
licence sits beside it. Nothing is installed on the machine and nothing is left behind.

`--probe-fonts` says whether the collection was built and which family each role resolved to. A
family DirectWrite cannot find is not an error — it substitutes, silently, and the substitute has
different metrics — so that flag is the only way to see it.

## License

GPL-3.0-or-later. The bundled typefaces are under the SIL Open Font License 1.1; see
`assets/fonts`.
