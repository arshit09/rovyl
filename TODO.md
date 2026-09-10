# Rovyl — improvement backlog

Audit of the current tree (v1.2.5). Grouped by impact. Checked items are done and note what
changed; the rest is untouched.

Every item carries a stable `§.n` id (`3.4`, `5.1`, …) — section number, then position within
the section. Refer to items by id. Ids are append-only: a new item takes the next free number in
its section, and a retired one keeps its number rather than being reused.

---

## 1. Product promise vs. actual behaviour

- [ ] **1.1** **The wheel does not open at the cursor.** `showMenuAtCursor` hardcodes the centre of
  `screen.getPrimaryDisplay()` (`backend/electron-main.js:1267`). On multi-monitor setups the wheel
  always lands on monitor 1 regardless of where you are working. Single biggest usability defect.
- [ ] **1.2** **`fixedPosition` is unreachable.** Default `true` (`src/defaults.ts:219`), toggle exists only
  in dead `SettingsModal.tsx`. Users cannot turn it off. Wire it into `PrecisionSettings` or drop
  the config key.
- [ ] **1.3** **README claims cursor-centred opening** ("appears centred on your cursor") — currently false.
  Fix the behaviour or fix the copy.
- [ ] **1.4** **README claims "nothing leaves your machine"** — false. Live network calls: license API
  (`rovyl-red.vercel.app`), `unavatar.io` + `google.com/s2/favicons` on every web shortcut
  (`src/siteFavicon.ts`), `wttr.in` weather (`RadialMenu.tsx:1723`), GitHub update checks.
  Restate honestly, or add a strict-offline mode that hard-disables all of them.
- [ ] **1.5** **Decide the cursor-follow architecture.** The idle 988×988 always-visible layered window
  (`electron-main.js:~1598`) exists to avoid DWM flash — that is what forced fixed positioning.
  Right fix: a dedicated lightweight overlay `BrowserWindow` (warm, pre-painted, repositioned per
  display) separate from the settings window.

## 2. Dead code and orphaned features

- [x] **2.1** **Delete `src/components/SettingsModal.tsx` (4,961 lines)** — nothing imports it.
- [ ] **2.2** **Delete `WelcomeScreen.tsx` (659)**, **`SystemCenter.tsx` (262)**, **`AppSelector.tsx` (461,
  only reachable via SettingsModal)**. ~6,300 dead lines ≈ 22% of `src/`.
- [ ] **2.3** **Weather/battery HUD is orphaned** — `showWeather`, `showBattery`, `clockPosition` have no UI
  in `PrecisionSettings`. Either expose them or remove `RadialHud`, the `wttr.in` fetch and the keys.
- [ ] **2.4** **Licensing/subscription surface is vestigial** — `SubscriptionTier`, `isPremium`, `planTier`,
  `deviceLimit`, `trialEndsAt` in `src/types.ts`; activation/deactivation IPC in main. Decide: keep
  and gate, or strip entirely from this fork.
- [ ] **2.5** **`radialInstantActivate: 'swipe'`** reserved in the type, never implemented — build or remove.
- [ ] **2.6** Prune deps once the above lands — verify `active-win`, `sql.js`,
  `node-global-key-listener` each still earn their install size. Measured while fixing §3's font
  item: `app.asar` is 69.7 MB and 5,385 of its 5,430 entries are `node_modules`, because
  `build.files` never mentions node_modules but electron-builder packs the production dependency
  tree anyway. `lucide-react` alone is 2,738 entries, `framer-motion` 379 — both are bundled into
  `dist/` by Vite and never `require`d at runtime, so like the fonts they belong in
  `devDependencies`. `electron-updater` (212) and `active-win` (37) are genuinely runtime.

## 3. Performance / RAM / CPU

- [x] **3.1** **The whole lucide icon set is in the critical chunk.** `src/iconMap.ts:1` did
  `import * as icons from "lucide-react"`, and `RadialMenu` imports `getIcon` — so ~1,350 icons
  (4,059 exports, with Lucide's aliases) shipped in the bundle the wheel needs.
  **Done:** 282 curated glyphs stay static, the rest moved to an async chunk fetched by the icon
  picker or by a config that names one. `index-*.js` 671.9 → 315.5 KB. The barrel cannot be
  dynamically imported while anything imports it statically (`INEFFECTIVE_DYNAMIC_IMPORT`), so the
  lazy set is a `virtual:lucide-icon-set` module of deep paths. Guarded by
  `scripts/verify-renderer-budget.mjs` (in `npm run build`) and `npm run test:icon-map`.
- [x] **3.2** **All three font families load eagerly** (`src/main.tsx:3-5`) including cyrillic, greek,
  vietnamese and latin-ext subsets (~280 KB woff2) for an English-only UI. Load only used subsets;
  defer fonts the wheel does not need.
  **Done:** `src/fonts.css` declares latin + latin-ext of Inter and Instrument Sans and nothing
  else; Space Grotesk is settings-only, so it moved to `src/fonts-display.css` and rides the
  settings chunk. Shipped woff2 307.7 → 215.8 KB. The bigger find was upstream of that: the three
  `@fontsource-variable` packages sat in `dependencies`, so electron-builder packed all 57 of their
  woff2 into `app.asar` on top of the six Vite emits — nothing reads them at runtime. Moved to
  `devDependencies`: `app.asar` 72.21 → 69.69 MB. `unicode-range` already made unused subsets lazy
  at runtime, so this is installer weight, not RAM.
- [x] **3.3** **`translations.ts` (3,451 lines, 10 languages) ships for ~5 live strings.** See §6.
  **Done:** it no longer ships. The six keys live code reached moved to `src/strings.ts` (English,
  typed keys), and `RadialMenu` / `IconPicker` call that instead of `getTranslation`. Entry chunk
  315.5 → 148.8 KB; critical JS 548.1 → 385.2 KB. The table itself is still on disk because three
  dead components import it — deleting those, and it, is §2/§6. Guarded: the build fails if any
  locale's text reappears in any emitted chunk.
- [x] **3.4** **Base64 icons stored in JSON.** `config-v2.json` is 456 KB here, rewritten (plus a `.bak`) on
  every debounced change and mirrored into three `localStorage` keys on the same tick
  (`src/App.tsx:1378-1380`) — ~1.4 MB serialised per settings tweak, scaling with shortcut count.
  Fix: write icons as PNG files in userData, store paths.
  **Done:** `backend/icon-store.cjs` keeps icon bytes in `userData/icons/<sha256>.<ext>` and
  `customIconUrl` holds an 85-byte `rovyl-icon://` reference, served over a registered scheme.
  Measured on this profile: `config-v2.json` 456,139 → 12,755 B, so config + `.bak` per save went
  912 KB → 25.5 KB and each `localStorage` mirror shrank with it. Twenty-three fields were only
  nine distinct icons — content addressing makes the mirroring free. Conversion happens on the
  read path, so the renderer never holds the base64 at all.
- [x] **3.5** **`icon-cache.json` is parsed synchronously at startup** and held as a `Map` of base64 strings
  capped at 600 entries (`electron-main.js:6521-6527`) — a permanently resident, potentially
  multi-MB string blob. Same fix: files on disk, let Chromium cache and decode lazily.
  **Done** with the same store: the map keeps its job of remembering which icon belongs to which
  target (its keys are AUMIDs, which no filename encodes) but its values are references.
  `icon-cache.json` 144,360 → 664 B. Migration of existing entries is deferred 3 s so it cannot
  delay the first window.
- [x] **3.6** **No `localStorage` quota handling.** At ~5 MB writes start throwing; the only guard is a
  `console.warn`.
  **Done:** `src/persistenceMirror.ts`. Two failures were worse than the item said. The debounced
  save wrote the three keys *unguarded* and only then called `saveFullConfig`, so a quota throw on
  the cache skipped the write to disk — the authoritative one. And a write that failed on the third
  key left a torn mirror, a new `zenith_user` beside a stale `zenith_config`, which the fallback
  hydration reads as one blob. Now it is all three keys or none: on failure the mirror is cleared
  (which is also what frees the room a retry needs) and reported once through `savePersistenceLog`.
  Nine assertions in `npm run test:persistence-mirror`. The §3 icon work also took each key from
  ~456 KB to ~12.5 KB, so reaching the quota at all is now unlikely.
- [x] **3.7** **`dist/folder.svg` is 596 KB** for a folder glyph. Replace.
  **Done:** 596,000 → 11,154 B. 98.3% of it was a 500×500 PNG of random noise, inlined as base64 and
  tiled at 10–12% opacity as a grain overlay — noise being precisely what a compressor cannot
  shrink, so only noticing it could. `feTurbulence` generates the same grain procedurally. Rendered
  both revisions in Chromium and compared: 1 pixel in 262,144 differs by more than 8/255, mean
  difference 0.23. A 120 KB per-asset ceiling in `verify-renderer-budget` keeps the next one out.
- [x] **3.8** **8 ms cursor poll during hold** (`MMB_CURSOR_POLL_MS`, `electron-main.js:4539`) sends IPC at
  125 Hz. Coalesce to rAF cadence, or skip sends when the resolved slice has not changed.
  **Measured, and deliberately left alone.** The rAF coalescing this asks for is already there:
  `RadialMenu`'s `handleMouseMove` records `lastPointerRef` synchronously and defers the highlight
  to `requestAnimationFrame`, so React work is already capped at the display rate — a 50,000-event
  benchmark produced zero frame callbacks. What is left costs, per tick:
  `screen.getCursorScreenPoint()` 2.3 µs, `webContents.send` 7.5 µs, the synthesised `mousemove`
  5.2 µs — **0.22% of one core, and only between MIDDLE_DOWN and MIDDLE_UP** in hold mode. Main
  already skips the send when the cursor has not moved, and the poll only runs while the wheel is
  open in hold mode.
  Halving the rate is the one change that would help, and it is the wrong trade: the same samples
  feed `lastPointerRef`, which is what the release reads to decide the slice, so an 8 ms staler
  point is ~16 px of travel on a fast flick — enough to cross a boundary. On the 239 Hz display
  this fork was debugged against, 125 Hz is already slower than the frame rate.
- [x] **3.9** **Only settings is code-split.** Split out the icon picker, installed-app scanner and
  workspace editor so they are not in first paint.
  **Done — though not where the item pointed.** Those three were already off first paint: all live
  inside the lazy `PrecisionSettings` chunk, and the icon picker's real weight (the full Lucide set)
  became its own on-demand chunk earlier in this section. The weight actually left in first paint
  was `framer-motion`, 111 KB, which the wheel never uses — `RadialMenu` has zero `motion.` usages.
  It was there because `App.tsx` imported it for a settings transition, an error banner and a toast.
  All three moved to lazy modules (`PanelTransition`, `ErrorOverlays`), and the `manualChunks` rule
  that forced framer-motion into one chunk was **removed**: grouping by name overrode rolldown's
  reachability analysis, so a single binding reachable from the entry made all 111 KB a static
  dependency of it. Critical JS **393 → 281.5 KB**; across §3 as a whole, **806 → 281.5 KB**.
- [x] **3.10** **`App.tsx`: 33 `useState` + 32 `useEffect` in one 2,838-line component.** Every wheel open
  re-runs the whole orchestration tree. Extract persistence, discovery, IPC wiring and window mode
  into hooks/reducers.
  **Started, and the premise corrected.** "Every wheel open re-runs the whole orchestration tree" is
  not what happens: of 39 effects, **9** re-run when `isMenuOpen` flips, and all nine *are* the work
  of opening the wheel — window sizing, position sync, menu state. There is no orchestration being
  re-run for nothing, so this is a maintainability item, not a performance one, and it belongs with
  §7 rather than here.
  Extracted so far, as pure moves: `mirrorPersistenceToLocalStorage` → `src/persistenceMirror.ts`
  (tested, 9 assertions), the icon-healing loop → `src/hooks/useIconHealing.ts` (241 lines, the
  largest single-purpose piece), and `isRemoteIconUrl` / `isWebShortcutItem` → `src/iconRef.ts`.
  **App.tsx 2,862 → 2,606 lines.** The healing effect moved verbatim — same body, same dependency
  array — and was verified by clearing a shortcut's icon on disk and watching it re-resolve in 2 s.
  What remains — Start Menu discovery, IPC wiring, window mode — is entangled with the window
  lifecycle that `verify-radial-windowing` exists to protect, and is worth doing against a way to
  see the wheel.
- [x] **3.11** Record idle RAM/CPU with the always-visible 988×988 layered window before/after the
  overlay-window split, so §1 has a number attached.
  **Before, measured.** Packaged build (`--dir`), app idle, nothing on screen, sampled over 60 s
  after a 30 s settle:

  | process | working set | CPU |
  |---|---|---|
  | browser (main) | 96.2 MB | 0.049% of one core |
  | renderer | 81.1 MB | 0.172% of one core |
  | gpu-process | 86.5 MB | 0.000% |
  | network service | 46.0 MB | 0.000% |
  | **total** | **309.7 MB** (peak 311.1) | **0.221% of one core** (0.018% of 12) |

  The two figures §1 should be judged against are the **86.5 MB GPU process** — which exists to
  composite a 988×988 transparent window that is showing nothing — and the **0.172% the renderer
  burns while idle**. Note what this does *not* say: 988×988×4 B is ~3.9 MB of pixels, so the GPU
  process is mostly Chromium's own baseline, not the buffer. The honest claim is that the idle
  overlay keeps a GPU process alive at all; a hidden window would not need one. Dev mode measured
  317.6 MB / 0.503% for comparison — do not compare that number with a packaged one.
  Method: `Get-Process` working set and `.CPU` deltas per PID; script kept out of the repo.

## 4. UX and intuitiveness

- [ ] **4.7** **Tray menu is two items** (Open Settings / Quit). Add: open wheel, pause trigger for N
  minutes, switch workspace, check for updates, version.
- [ ] **4.8** **No keyboard entry to settings search** — bind Ctrl+K / Ctrl+F to `#zs-search-input`.
- [ ] **4.9** **No wheel type-ahead.** Past ~12 shortcuts the slices get thin; "start typing to filter"
  scales the wheel beyond what aiming alone supports.
- [ ] **4.10** **No item-count guidance.** `360 / totalApps` with no cap — 20 items gives 18° slices, close to
  unaimable in `angle` mode. Warn in the editor, or auto-page.
- [ ] **4.11** **First-run onboarding is gone** (WelcomeScreen is dead) — new users get a wheel and no
  explanation of the trigger, workspaces, or aiming modes.
- [ ] **4.12** **Start Menu discovery has no progress UI** — 20 s deferral at login leaves an empty wheel with
  nothing on screen explaining it (`App.tsx:47`).
- [ ] **4.13** **Dwell mode has no in-app cancel explanation** — the arc is the only signal.
- [ ] **4.14** Settings sections are discoverable only by clicking each; consider group counts and a
  recently-changed marker.

## 5. Accessibility

- [ ] **5.1** **The wheel is mouse-only.** `Escape` is the only key handled (`RadialMenu.tsx:1503`). Add
  arrow-key / number-key navigation plus Enter to confirm, so the launcher works without a pointer.
- [ ] **5.2** **The wheel has no accessible semantics** — no `role="menu"`/`menuitem`, no per-slice
  `aria-label`, no live region announcing the aimed target. A screen reader user gets nothing.
- [ ] **5.3** **`--zn-text-3: rgba(255,255,255,.34)` on `#151515` is ≈3.1:1** (`src/index.css:46`) — below
  WCAG AA 4.5:1, and used at 9–11 px. Raise to ≈.45, or restrict to non-essential text.
- [ ] **5.4** **Text runs very small**: 8 declarations at 9.5 px, 13 at 11.5 px, plus 9/10/10.5 px. Add a UI
  scale setting, or lift the base to 12–13 px.
- [ ] **5.5** **No `forced-colors` / `prefers-contrast` support** — invisible in Windows High Contrast mode.
- [ ] **5.6** **`AppSelector`, `IconPicker`, `SmartIcon`, `Toast`, `Tooltip`, `SystemCenter` have zero ARIA
  attributes.** IconPicker (a ~1,500-cell grid) needs `role="grid"` and a roving tabindex.
- [ ] **5.7** **Focus is not trapped in settings modals**, and several controls set `outline: none` without a
  `:focus-visible` replacement (pattern leaked from `SettingsModal` into `AppSelector`/`IconPicker`).
- [ ] **5.8** `prefers-reduced-motion` is handled well (`index.css:857`, `:950`) — keep that discipline for
  any new animation.

## 6. Internationalisation

- [ ] **6.1** **i18n is effectively dead.** `PrecisionSettings` — the live settings panel — is hardcoded
  English and never imports `getTranslation`. Only `RadialMenu` (4 strings) and `IconPicker` still
  translate.
- [ ] **6.2** **No language selector in the live UI** — `LANGUAGES` is referenced only by dead
  `SettingsModal`.
- [ ] **6.3** **Key parity is broken**: pt/en 429 keys, es 281, fr/de/it/ja/zh/ko/ru 257–258. The surplus
  pt/en keys belong to the dead modal.
- [x] **6.4** Decide: (a) delete `translations.ts`, ship English-only, drop 3,451 lines from the bundle, or
  (b) re-adopt properly — a real `t()` in `PrecisionSettings`, lazy per-language chunks, parity check
  in CI. **(a) is the honest default.**
  **Decided (a)**, and the bundle half is done — see §3. `src/strings.ts` holds the six live strings
  and `translations.ts` is out of every chunk. What remains is deleting the file, which has to wait
  for §2 to delete `SettingsModal` / `SystemCenter` / `WelcomeScreen`, its only importers. The three
  bullets above are all about that file and go with it.

## 7. Engineering hygiene

- [ ] **7.1** **`tsconfig.json` has no `strict`** — no `strictNullChecks`, `noImplicitAny`, `noUnusedLocals`.
  34 `any` / `as any` in `src/`.
- [ ] **7.2** **No linter, no formatter, no CI.** Add ESLint + Prettier and a GitHub Actions run of
  `npm run build` plus the existing tests.
- [ ] **7.3** **Two unit test files for 28,000 lines** (`win32-launch`, `game-detection`). Highest-value
  additions: `resolveAimAtPoint` trigonometry, persistence normalise round-trip, dwell arming rules.
- [ ] **7.4** **`backend/electron-main.js` is 7,081 lines / 270 KB in one file.** Split by concern: window
  lifecycle, IPC, persistence, icons, updates, licensing, launch.
- [ ] **7.5** **167 `catch (e) {}` blocks in main**, many silent. Route through `diagLog` at minimum so field
  diagnosis is possible.
- [ ] **7.6** **Comments are Portuguese, code and UI are English.** For a fork with an English-speaking
  maintainer that is a real onboarding tax on the densest reasoning in the codebase
  (`RadialMenu.tsx`, `electron-main.js`). Translate incrementally as files are touched.
- [ ] **7.7** **`docs/ARCHITECTURE.md` is stale** — references `LicenseGate.tsx` (does not exist) and lists
  the dead `SettingsModal` alongside `PrecisionSettings`.
- [ ] **7.8** Dev scratch scripts shipped in `backend/` (`reproduce_icon_issue.ps1`, `find_lnks.ps1`,
  `simulate-keys.ps1`) — move to `scripts/dev/` or delete.

## 8. Quick wins (do these first)

Pointers into the sections above, not items in their own right — each line names the id to work on.

- [ ] **8.1** Delete the four dead components — 6,300 lines, zero risk. → **2.1** (done), **2.2**.
- [x] **8.2** Fix `src/iconMap.ts`'s barrel import — largest bundle win for one file. → **3.1**.
- [x] **8.3** Trim font subsets in `src/main.tsx`. → **3.2**.
- [x] **8.4** Replace `dist/folder.svg`. → **3.7**.
- [ ] **8.5** Raise `--zn-text-3` contrast. → **5.3**.
- [x] **8.6** Make `execute-command` return a result and toast on failure. → **4.1** (done).
- [ ] **8.7** Correct the two false claims in `README.md`. → **1.3**, **1.4**.
