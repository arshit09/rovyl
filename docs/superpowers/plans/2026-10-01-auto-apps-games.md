# Automatic "All apps" and "Games" workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every installed app (with icons, grouped in category folders) and an auto-discovered Games list as two virtual workspaces on the wheel, each switchable in Settings.

**Architecture:** A main-process catalog (`backend/catalog/*`) merges `.desktop`, Steam, Lutris and Heroic into `CatalogEntry[]` and serves it over `get-catalog` / `catalog-changed`. The wheel's renderer (`RadialApp.tsx`, a strict reader of config) derives two **virtual** workspaces from it with `src/utils/autoWorkspaces.ts` and appends them after the user's own; nothing virtual is ever saved. Settings (`App.tsx`/`PrecisionSettings.tsx`, the only config writer) owns a new `autoWorkspaces` config block.

**Tech Stack:** Electron 28 main (CJS), React + TypeScript renderer, `node --test` for backend, vite-ssr smoke scripts (`scripts/*-smoke.mjs`) for TS utils.

**Spec:** `docs/superpowers/specs/2026-10-01-auto-apps-games-design.md`

## Global Constraints

- Linux first; Windows discovery is untouched and the catalog returns `[]` on `win32`.
- `autoWorkspaces` defaults: `apps: true`, `games: true`, all four `sources` true; added silently to older configs.
- Games: flat when ≤ 12 entries, otherwise A–Z folders of at most 12 each (`GAMES_FOLDER_SIZE = 12`).
- All apps: one folder per freedesktop main category, fixed order Internet, Development, Multimedia, Office, Graphics, Utility, System, Settings, Other; empty folders omitted; games excluded; A–Z inside.
- De-duplication key is the normalised launch command (Steam: the appid); source priority desktop, steam, lutris, heroic.
- Steam tools dropped by name: `Proton*`, `Steam Linux Runtime*`, `Steamworks Common Redistributables`.
- Launch commands: `steam steam://rungameid/<appid>`, `lutris lutris:rungameid/<id>`, `heroic heroic://launch/<runner>/<appName>`.
- Every source is best-effort: failure → `[]` plus one `diagLog`/`console.warn` line, never a throw to the renderer.
- Every user-visible string goes through `src/i18n/translations.ts` for every existing language.
- The existing fullscreen "game mode" (`gameMode`, `backend/game-detection.cjs`) is not touched.

## Review Focus

- Steam library with a path containing spaces or a missing/unmounted second library folder → skipped, no crash.
- Same game pinned as a `.desktop` file and present in Steam → listed once.
- `.acf` with missing `name` or `appid`, or a truncated file → entry skipped.
- Zero games found → no empty "Games" workspace on the wheel; same for All apps.
- Exactly 12 and exactly 13 games → flat vs. two folders.
- Config saved before this feature (no `autoWorkspaces`) and a partial block (`{ games: false }`) → defaults fill the rest.
- Virtual workspaces never appear in a saved/exported config or workspace file.

---

### Task 1: Steam source

**Files:**
- Create: `backend/catalog/steam.cjs`, `backend/catalog/steam.test.cjs`, `backend/catalog/fixtures/steam/` (a `libraryfolders.vdf`, two `appmanifest_*.acf`, one Proton tool manifest, one truncated manifest)
- Modify: `package.json` (script `test:catalog`: `node --test backend/catalog/*.test.cjs`)

**Interfaces:**
- Produces: `parseVdf(text: string): object`, `parseAcf(text: string): { appid: string, name: string, installdir: string } | null`, `listSteamGames(options?: { roots?: string[] }): Promise<CatalogEntry[]>` where `CatalogEntry = { id: string, name: string, command: string, iconPath?: string, categories: string[], kind: 'app' | 'game', source: 'desktop' | 'steam' | 'lutris' | 'heroic' }`. Steam entries: `id = 'steam:<appid>'`, `kind: 'game'`, `iconPath = 'steam_icon_<appid>'`.

- [ ] **Step 1: Write the failing tests** in `steam.test.cjs`: `parseVdf` reads the fixture's nested library list; `parseAcf` returns `{appid:'620', name:'Portal 2', installdir:'Portal 2'}` for the fixture and `null` for the truncated one; `listSteamGames({roots:[fixtureRoot]})` returns exactly the two real games, not the Proton tool, with `command === 'steam steam://rungameid/620'`; a root that does not exist yields `[]`.
- [ ] **Step 2: Run** `node --test backend/catalog/steam.test.cjs` — expected FAIL (module not found).
- [ ] **Step 3: Implement** `steam.cjs`. VDF is `"key" "value"` / `"key" { … }`; a small tokenizer, no dependency. Default roots: `~/.local/share/Steam` and `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`; each `libraryfolders.vdf` `path` adds a library; read `<lib>/steamapps/appmanifest_*.acf`. Filter tools by the Global Constraints name patterns.
- [ ] **Step 4: Run** the same command — expected all PASS.
- [ ] **Step 5: Commit** `git add backend/catalog package.json && git commit -m "feat: discover Steam games for the Games workspace"`

### Task 2: Lutris and Heroic sources

**Files:**
- Create: `backend/catalog/lutris.cjs`, `backend/catalog/heroic.cjs`, `backend/catalog/launchers.test.cjs`, `backend/catalog/fixtures/heroic/` (an `installed.json` shaped like Heroic's legendary one, plus an empty object file), `backend/catalog/fixtures/lutris-list.json`

**Interfaces:**
- Consumes: `CatalogEntry` from Task 1.
- Produces: `parseLutrisList(json: string): CatalogEntry[]`, `listLutrisGames(): Promise<CatalogEntry[]>` (runs `lutris --list-games --json` via `execFile`, 5 s timeout, `[]` when the binary is missing), `parseHeroicInstalled(json: string, runner: 'legendary' | 'gog'): CatalogEntry[]`, `listHeroicGames(options?: { configDir?: string }): Promise<CatalogEntry[]>`. Ids: `lutris:<id>`, `heroic:<runner>:<appName>`; `kind: 'game'`.

- [ ] **Step 1: Write failing tests** in `launchers.test.cjs`: `parseLutrisList` keeps only `installed`/runnable rows and builds `lutris lutris:rungameid/<id>`; `parseHeroicInstalled` builds `heroic heroic://launch/legendary/<appName>` with the title as name; garbage input (`'not json'`, `'{}'`, `'[]'`) returns `[]`; `listLutrisGames()` resolves `[]` when `PATH` has no lutris (set `process.env.PATH=''` in the test).
- [ ] **Step 2: Run** `node --test backend/catalog/launchers.test.cjs` — expected FAIL.
- [ ] **Step 3: Implement** both modules. Heroic reads `<configDir>/legendaryConfig/legendary/installed.json` and `<configDir>/gogdlConfig/heroic_gogdl/installed.json` (default `~/.config/heroic`); tolerate either layout (object keyed by appName, or array) and skip rows without a name.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat: discover Lutris and Heroic games`

### Task 3: Apps source, merge and cache

**Files:**
- Create: `backend/catalog/apps.cjs`, `backend/catalog/index.cjs`, `backend/catalog/index.test.cjs`

**Interfaces:**
- Consumes: `listSteamGames`, `listLutrisGames`, `listHeroicGames`; `listInstalledApps()` from `backend/linux-apps.cjs` (entries `{ id, name, command, icon, categories, noDisplay }`).
- Produces: `listDesktopEntries(entries): CatalogEntry[]` in `apps.cjs` (drops `noDisplay`; `kind: 'game'` when `categories` includes `Game`, else `'app'`; `iconPath = icon`; `id = 'desktop:<id>'`), and in `index.cjs`: `mergeEntries(lists: CatalogEntry[][]): CatalogEntry[]` (priority order = list order, de-dup by normalised command: trimmed, lower-cased, whitespace collapsed; Steam entries also collide on `steam://rungameid/<appid>`), `getCatalog(options: { sources: { desktop: boolean, steam: boolean, lutris: boolean, heroic: boolean }, force?: boolean }): Promise<CatalogEntry[]>`, `invalidateCatalog(): void`. Returns `[]` on non-Linux. Results cached by the `sources` signature until `force` or `invalidateCatalog()`.

- [ ] **Step 1: Write failing tests** in `index.test.cjs`: `listDesktopEntries` marks a `Categories=Game;` entry as game and drops `noDisplay`; `mergeEntries` keeps one of a pinned-Steam `.desktop` (`steam steam://rungameid/620`) and the Steam entry for appid 620, keeping the desktop one; a throwing source (inject via `getCatalog`'s internal source table or by mocking a module path) yields the other sources' entries.
- [ ] **Step 2: Run** `node --test backend/catalog/index.test.cjs` — expected FAIL.
- [ ] **Step 3: Implement.** `getCatalog` runs enabled sources with `Promise.allSettled`, logs rejected ones with `console.warn("[Catalog] <source> failed: …")`, merges, caches.
- [ ] **Step 4: Run** `npm run test:catalog` — expected all PASS.
- [ ] **Step 5: Commit** `feat: merge app and game sources into one catalog`

### Task 4: IPC, preload and renderer types

**Files:**
- Modify: `backend/electron-main.js` (near `get-installed-apps`, ~11415), `backend/electron-preload.js:239`, `src/types.ts` (~731 `ElectronAPI`)

**Interfaces:**
- Consumes: `getCatalog`, `invalidateCatalog` (Task 3).
- Produces: `ipcMain.handle("get-catalog", (_e, options) => getCatalog(options))`; main sends `"catalog-changed"` to the overlay and settings windows after `invalidateCatalog()` runs (hook it where the Linux app scan is invalidated and on `ipcMain.on("rescan-catalog")`). Preload: `getCatalog(options)`, `rescanCatalog()`, `onCatalogChanged(cb): () => void`. `types.ts`: exported `CatalogEntry` (same shape as Task 1) and the three methods on `ElectronAPI`.

- [ ] **Step 1: Implement** the handler, the invalidation hook and the preload bridges; `onCatalogChanged` returns its unsubscribe like the existing `onShortcutRecorded`.
- [ ] **Step 2: Verify** `node --check backend/electron-main.js && npx tsc --noEmit -p .` — expected no output, exit 0.
- [ ] **Step 3: Commit** `feat: expose the catalog to the renderer`

### Task 5: `autoWorkspaces` config block

**Files:**
- Modify: `src/types.ts` (`UIConfig`, next to `gameMode`), `src/defaults.ts:366`, `src/configHydration.ts:39`
- Create: `scripts/auto-workspaces-config-smoke.mjs`; add script `test:auto-workspaces-config`

**Interfaces:**
- Produces: `AutoWorkspacesConfig = { apps: boolean, games: boolean, sources: { desktop: boolean, steam: boolean, lutris: boolean, heroic: boolean } }`; `UIConfig.autoWorkspaces: AutoWorkspacesConfig`; `DEFAULT_UI_CONFIG.autoWorkspaces` all `true`; `normalizeStoredConfig` deep-merges a partial block over the defaults and coerces non-booleans to the default.

- [ ] **Step 1: Write the failing smoke** (pattern: `scripts/radial-sectors-smoke.mjs`, vite-ssr build of `src/configHydration.ts`): a config without the key gets all-true; `{ autoWorkspaces: { games: false } }` keeps `games:false` and fills `apps` and every source `true`; `{ autoWorkspaces: { sources: { steam: 'no' } } }` falls back to `steam: true`.
- [ ] **Step 2: Run** `node scripts/auto-workspaces-config-smoke.mjs` — expected FAIL.
- [ ] **Step 3: Implement** types, default and hydration merge (mirror how `gameMode` is merged).
- [ ] **Step 4: Run** the smoke and `npx tsc --noEmit -p .` — expected PASS, exit 0.
- [ ] **Step 5: Commit** `feat: autoWorkspaces config with defaults and migration`

### Task 6: Virtual workspaces builder

**Files:**
- Create: `src/utils/autoWorkspaces.ts`, `scripts/auto-workspaces-smoke.mjs`; add script `test:auto-workspaces`

**Interfaces:**
- Consumes: `CatalogEntry`, `AutoWorkspacesConfig`, `Workspace`, `AppItem` (`src/types.ts`).
- Produces: `GAMES_FOLDER_SIZE = 12`; `mainCategory(categories: string[]): 'Internet' | 'Development' | 'Multimedia' | 'Office' | 'Graphics' | 'Utility' | 'System' | 'Settings' | 'Other'` (map: Network/WebBrowser/Email/Chat→Internet; Development→Development; AudioVideo/Audio/Video/Music→Multimedia; Office→Office; Graphics→Graphics; Utility→Utility; System/Monitor→System; Settings→Settings); `buildAutoWorkspaces(entries: CatalogEntry[], cfg: AutoWorkspacesConfig, icons: Record<string, string>): Workspace[]` returning 0–2 workspaces with ids `auto-apps` / `auto-games`, names "All apps" / "Games", `enabled: true`, `hotkey: 0`, `pickerIconName` `LayoutGrid` / `Gamepad2`; items are `AppItem` with `id = 'auto:' + entry.id`, `command = entry.command`, `commandType: 'app'`, `iconSource: 'native'`, `customIconUrl = icons[entry.id]` when present, `iconName` `Gamepad2`/`AppWindow` as fallback, folders `type: 'folder'` with `children`; `withAutoWorkspaces(config: UIConfig, extra: Workspace[]): UIConfig` appends them (no-op for `[]`); `isAutoWorkspace(ws: Workspace): boolean`.

- [ ] **Step 1: Write the failing smoke** (vite-ssr build like Task 5): 12 games → one flat `Games` workspace of 12 items; 13 → two folders (sizes 7 and 6 or 12 and 1 — assert every folder has ≤ 12 and the union is all 13, A–Z ordered, names like "A–F"); apps with `Categories` `['Network','WebBrowser']` land in "Internet", `['Game']` never in All apps, unknown → "Other"; empty categories omitted; `games:false` → no Games workspace; zero game entries → no Games workspace; `isAutoWorkspace` true only for the two ids; `withAutoWorkspaces(cfg, [])` returns the same object.
- [ ] **Step 2: Run** `node scripts/auto-workspaces-smoke.mjs` — expected FAIL.
- [ ] **Step 3: Implement** `autoWorkspaces.ts`. Chunking: split the sorted list into `ceil(n/12)` groups of near-equal size, labelled by first and last initial.
- [ ] **Step 4: Run** the smoke — expected PASS.
- [ ] **Step 5: Commit** `feat: build All apps and Games workspaces from the catalog`

### Task 7: Wire the wheel

**Files:**
- Modify: `src/RadialApp.tsx` (config state ~78, `applyBlob` ~125, `iterateConfigIconNames` ~42)
- Create: `src/hooks/useCatalog.ts`

**Interfaces:**
- Consumes: `window.electron.getCatalog / onCatalogChanged / getFileIcon`, `buildAutoWorkspaces`, `withAutoWorkspaces` (Tasks 4, 6).
- Produces: `useCatalog(cfg: AutoWorkspacesConfig): { entries: CatalogEntry[], icons: Record<string, string> }` — fetches when `apps || games`, refetches on `catalog-changed` and when `cfg` changes, resolves icons lazily through `getFileIcon(entry.iconPath || entry.command)` with at most 4 in flight, state updates batched.

- [ ] **Step 1: Implement** `useCatalog` and in `RadialApp.tsx` derive `const wheelConfig = useMemo(() => withAutoWorkspaces(config, buildAutoWorkspaces(entries, config.autoWorkspaces, icons)), …)`; every wheel/picker read that used `config.workspaces` for rendering uses `wheelConfig`. Saving/`setConfig` paths keep using the raw `config`. Keep `activeWorkspaceIndex` clamped to the user's own workspaces.
- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` — expected exit 0.
- [ ] **Step 3: Manual check** `npm run build:linux`, start the unpacked app, open the wheel: both workspaces appear after the user's, apps open into category folders, a Steam game launches. Report anything not observed as "not verified".
- [ ] **Step 4: Commit** `feat: show the automatic workspaces on the wheel`

### Task 8: Settings controls and strings

**Files:**
- Modify: `src/components/PrecisionSettings.tsx` (new group next to the `gameMode` rows ~1536), `src/i18n/translations.ts` (every language block), `scripts/i18n-smoke.mjs` only if it enumerates keys

**Interfaces:**
- Consumes: `config.autoWorkspaces`, `update('autoWorkspaces', next)`, `window.electron.rescanCatalog()`.
- Produces: a group "Automatic workspaces" with bool rows `autoApps`, `autoGames`, four source rows (`autoSourceDesktop|Steam|Lutris|Heroic`, rendered only while `games` is on), and an `open`-kind "Rescan" row; translation keys for each title and description in all languages present in `translations.ts`.

- [ ] **Step 1: Add the translation keys** to every language block (English text translated, not left blank).
- [ ] **Step 2: Implement the rows** using the same `kind: 'bool'` / `onToggle` shape as `strictOffline`; toggling Games off must also make `useCatalog` skip game sources (Task 7 already keys on the config).
- [ ] **Step 3: Verify** `npm run test:i18n && npx tsc --noEmit -p .` — expected pass, exit 0.
- [ ] **Step 4: Manual check:** toggle Games off → workspace disappears from the wheel without restart; toggle Steam off → Steam titles vanish; Rescan picks up a newly installed app.
- [ ] **Step 5: Commit** `feat: Settings switches for the automatic workspaces`

### Task 9: Whole-branch verification and docs

**Files:**
- Modify: `README.md` (one short paragraph under Linux), `docs/ARCHITECTURE.md` (catalog row)

- [ ] **Step 1: Run** `npm run test:catalog && npm run test:auto-workspaces && npm run test:auto-workspaces-config && npm run test:persistence-shape && npm run test:linux-apps` — expected all pass.
- [ ] **Step 2: Run** `npx tsc --noEmit -p . && npm run build:linux` — expected exit 0.
- [ ] **Step 3: Confirm** a saved config and an exported workspace file contain no `auto-apps` / `auto-games` workspace (grep the saved `~/.config/Rovyl/config-v2.json` after a run).
- [ ] **Step 4: Document and commit** `docs: describe the automatic workspaces`
