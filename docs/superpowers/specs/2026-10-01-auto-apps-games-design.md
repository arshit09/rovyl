# Automatic "All apps" and "Games" workspaces — design

Date: 2026-10-01 · Scope: Linux first (Windows keeps its current discovery) · Status: awaiting review

## Intent

Rovyl should show every application installed on the machine, with its icon, and a separate Games
section that finds installed games by itself. Both are controlled from Settings, where each can be
switched off. Agreed with the user in chat:

- Presentation: two **special workspaces** on the existing wheel, not a new panel.
- Apps are grouped into **category folders** (the wheel already supports `folder` slices).
- Game sources: **Steam**, **`.desktop` entries with `Categories=Game`**, **Lutris**, **Heroic**.
- Settings: switch Games on/off, switch All apps on/off, switch each game source on/off.
- Out of scope: hiding single items, per-game artwork editing, Windows game discovery, changing
  the existing fullscreen "game mode" (`backend/game-detection.cjs`), which is a different feature.

## Architecture

```
backend/catalog/            main process, one module per source, each returns CatalogEntry[]
  apps.cjs      <- wraps backend/linux-apps.cjs listInstalledApps()
  steam.cjs     <- libraryfolders.vdf + appmanifest_*.acf
  lutris.cjs    <- lutris pga.db (sql.js is already a dependency) or `lutris --list-games`
  heroic.cjs    <- heroic library JSON caches (Epic/GOG)
  index.cjs     <- merges sources, de-duplicates, caches, exposes `getCatalog(options)`
IPC  get-catalog (renderer asks) · catalog-changed (main pushes after a rescan)
src/utils/autoWorkspaces.ts renderer: CatalogEntry[] + settings -> virtual Workspace[]
```

`CatalogEntry`: `{ id, name, command, iconPath?, categories[], kind: 'app' | 'game', source:
'desktop' | 'steam' | 'lutris' | 'heroic' }`. Entries carry data only; the renderer owns grouping.

### Data flow

1. Main builds the catalog on start (after the existing app scan), caches it in memory, and rebuilds
   when the app directories change (`linux-apps` already has a scan signature) or when Settings
   asks for a refresh.
2. The renderer receives it via `get-catalog` and `catalog-changed`, and `autoWorkspaces.ts`
   turns it into two **virtual** workspaces appended after the user's own ones. They are never
   written to `config` or to workspace files, so exporting, reordering and the positional hotkeys
   of real workspaces are unchanged.
3. The wheel renders them like any workspace: `AppItem` rows, `type: 'folder'` with `children`
   for groups. Launching reuses `execute-command`, so launch behaviour is identical to
   hand-added shortcuts.

### Grouping

- **All apps**: one folder per freedesktop main category found in `Categories`
  (Internet, Development, Multimedia, Office, Graphics, Utility, System, Settings, Other),
  ordered by that fixed list; apps without a main category go to Other. Empty folders are
  omitted. Games are excluded from All apps (they live in Games). Within a folder: A–Z by name.
- **Games**: flat when 12 or fewer entries; above that, A–Z folders of at most 12 each
  (e.g. "A–D", "E–K"). The 12 matches what a ring can show legibly and is one constant.
- If only one virtual workspace is enabled and no user workspaces exist, the existing rule
  ("one workspace opens directly") applies unchanged.

### Game sources

- **Steam**: read `~/.local/share/Steam/steamapps/libraryfolders.vdf` (and the Flatpak path
  `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`), then every `appmanifest_*.acf` for
  `appid`, `name`, `installdir`. Tools are dropped by name (Proton*, Steam Linux Runtime*,
  Steamworks Common Redistributables). Launch command: `steam steam://rungameid/<appid>`.
- **`.desktop`**: any entry from `linux-apps` whose `Categories` includes `Game` and is not
  `NoDisplay`. Steam creates such entries for games the user pinned; those are merged away below.
- **Lutris**: games with `installed = 1` in `pga.db`; launch `lutris lutris:rungameid/<id>`.
- **Heroic**: installed games from its library caches; launch `heroic heroic://launch/<runner>/<appName>`.
- **De-duplication**: key = normalised launch command; for Steam, the appid. First source wins
  in the order desktop, steam, lutris, heroic, so a pinned Steam game does not appear twice.
- Every source is best-effort: missing launcher, unreadable file or parse error yields zero
  entries and one log line, never an exception to the wheel.

### Icons

Same pipeline as today (`linux-icons.cjs`, `get-file-icon`, the icon store and healing pass).
`.desktop` entries pass their `Icon=`. Steam games try the icon theme name `steam_icon_<appid>`
first, then the cached library art under `appcache/librarycache/<appid>/` if present, and fall
back to the Gamepad glyph, so no entry ever renders blank. 110 apps resolve through the existing
batched healing, not one blocking call per slice.

## Settings

New block in `UIConfig`, default-on, migrated through `persistence-normalize.cjs` and
`configHydration.ts` so older configs gain it silently:

```ts
autoWorkspaces: {
  apps: boolean;                       // "All apps" workspace
  games: boolean;                      // "Games" workspace + automatic game scan
  sources: { desktop: boolean; steam: boolean; lutris: boolean; heroic: boolean };
}
```

Settings gets a section "Automatic workspaces" with two switches and four source switches
(sources are disabled while Games is off). Switching Games off also skips the scans, so an
off feature costs nothing. A "Rescan" button calls the same refresh as the directory watcher.
All strings go through `src/i18n/translations.ts` for every existing language.

## Error handling

- Source failure: logged via `diagLog`, treated as empty. The Settings section shows
  "not found" beside a source whose launcher is not installed, so a gap reads as a message.
- Catalog not ready yet: virtual workspaces are hidden until the first result, never shown empty.
- A game that no longer launches goes through the existing `launchFailure` path.

## Testing

- Unit (`node --test`, like `win32-launch.test.cjs`): `.acf` / `libraryfolders.vdf` parsing, tool
  filtering, de-duplication, category bucketing, A–Z chunking at the 12 boundary, config
  migration adds `autoWorkspaces` with defaults. Fixtures are small files under `backend/catalog/fixtures`.
- Manual on the user's machine: wheel shows both workspaces, folders open, icons resolve,
  toggles hide a workspace, a Steam game launches.
- `npx tsc --noEmit`, `npm run build:linux`, and the packaged build starts without errors.

## Risks

- Steam and Heroic file formats are not a stable API; parsers are tolerant and tested with
  fixtures, and a break degrades to "source not found".
- 100+ items inside folders must not slow the first open: folders are built once per catalog
  change in the renderer, not per gesture.

## Open decisions

None. Win32 parity (Start menu / Steam on Windows) is a follow-up, not part of this change.
