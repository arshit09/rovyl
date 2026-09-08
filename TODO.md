# Rovyl — improvement backlog

Audit of the current tree (v1.2.5). Grouped by impact. Checked items are done and note what
changed; the rest is untouched.

---

## 1. Product promise vs. actual behaviour

- [ ] **The wheel does not open at the cursor.** `showMenuAtCursor` hardcodes the centre of
  `screen.getPrimaryDisplay()` (`backend/electron-main.js:1267`). On multi-monitor setups the wheel
  always lands on monitor 1 regardless of where you are working. Single biggest usability defect.
- [ ] **`fixedPosition` is unreachable.** Default `true` (`src/defaults.ts:219`), toggle exists only
  in dead `SettingsModal.tsx`. Users cannot turn it off. Wire it into `PrecisionSettings` or drop
  the config key.
- [ ] **README claims cursor-centred opening** ("appears centred on your cursor") — currently false.
  Fix the behaviour or fix the copy.
- [ ] **README claims "nothing leaves your machine"** — false. Live network calls: license API
  (`rovyl-red.vercel.app`), `unavatar.io` + `google.com/s2/favicons` on every web shortcut
  (`src/siteFavicon.ts`), `wttr.in` weather (`RadialMenu.tsx:1723`), GitHub update checks.
  Restate honestly, or add a strict-offline mode that hard-disables all of them.
- [ ] **Decide the cursor-follow architecture.** The idle 988×988 always-visible layered window
  (`electron-main.js:~1598`) exists to avoid DWM flash — that is what forced fixed positioning.
  Right fix: a dedicated lightweight overlay `BrowserWindow` (warm, pre-painted, repositioned per
  display) separate from the settings window.

## 2. Dead code and orphaned features

- [ ] **Delete `src/components/SettingsModal.tsx` (4,964 lines)** — nothing imports it.
- [ ] **Delete `WelcomeScreen.tsx` (659)**, **`SystemCenter.tsx` (262)**, **`AppSelector.tsx` (461,
  only reachable via SettingsModal)**. ~6,300 dead lines ≈ 22% of `src/`.
- [ ] **Weather/battery HUD is orphaned** — `showWeather`, `showBattery`, `clockPosition` have no UI
  in `PrecisionSettings`. Either expose them or remove `RadialHud`, the `wttr.in` fetch and the keys.
- [ ] **Licensing/subscription surface is vestigial** — `SubscriptionTier`, `isPremium`, `planTier`,
  `deviceLimit`, `trialEndsAt` in `src/types.ts`; activation/deactivation IPC in main. Decide: keep
  and gate, or strip entirely from this fork.
- [ ] **`radialInstantActivate: 'swipe'`** reserved in the type, never implemented — build or remove.
- [ ] Prune deps once the above lands — verify `active-win`, `sql.js`,
  `node-global-key-listener` each still earn their install size.

## 3. Performance / RAM / CPU

- [x] **The whole lucide icon set is in the critical chunk.** `src/iconMap.ts:1` did
  `import * as icons from "lucide-react"`, and `RadialMenu` imports `getIcon` — so ~1,350 icons
  (4,059 exports, with Lucide's aliases) shipped in the bundle the wheel needs.
  **Done:** 282 curated glyphs stay static, the rest moved to an async chunk fetched by the icon
  picker or by a config that names one. `index-*.js` 671.9 → 315.5 KB. The barrel cannot be
  dynamically imported while anything imports it statically (`INEFFECTIVE_DYNAMIC_IMPORT`), so the
  lazy set is a `virtual:lucide-icon-set` module of deep paths. Guarded by
  `scripts/verify-renderer-budget.mjs` (in `npm run build`) and `npm run test:icon-map`.
- [ ] **All three font families load eagerly** (`src/main.tsx:3-5`) including cyrillic, greek,
  vietnamese and latin-ext subsets (~280 KB woff2) for an English-only UI. Load only used subsets;
  defer fonts the wheel does not need.
- [ ] **`translations.ts` (3,451 lines, 10 languages) ships for ~5 live strings.** See §6.
- [ ] **Base64 icons stored in JSON.** `config-v2.json` is 456 KB here, rewritten (plus a `.bak`) on
  every debounced change and mirrored into three `localStorage` keys on the same tick
  (`src/App.tsx:1378-1380`) — ~1.4 MB serialised per settings tweak, scaling with shortcut count.
  Fix: write icons as PNG files in userData, store paths.
- [ ] **`icon-cache.json` is parsed synchronously at startup** and held as a `Map` of base64 strings
  capped at 600 entries (`electron-main.js:6521-6527`) — a permanently resident, potentially
  multi-MB string blob. Same fix: files on disk, let Chromium cache and decode lazily.
- [ ] **No `localStorage` quota handling.** At ~5 MB writes start throwing; the only guard is a
  `console.warn`.
- [ ] **`dist/folder.svg` is 596 KB** for a folder glyph. Replace.
- [ ] **8 ms cursor poll during hold** (`MMB_CURSOR_POLL_MS`, `electron-main.js:4539`) sends IPC at
  125 Hz. Coalesce to rAF cadence, or skip sends when the resolved slice has not changed.
- [ ] **Only settings is code-split.** Split out the icon picker, installed-app scanner and
  workspace editor so they are not in first paint.
- [ ] **`App.tsx`: 33 `useState` + 32 `useEffect` in one 2,838-line component.** Every wheel open
  re-runs the whole orchestration tree. Extract persistence, discovery, IPC wiring and window mode
  into hooks/reducers.
- [ ] Record idle RAM/CPU with the always-visible 988×988 layered window before/after the
  overlay-window split, so §1 has a number attached.

## 4. UX and intuitiveness

- [ ] **Launch failures are silent.** `execute-command` is `ipcMain.on`, not `handle`
  (`electron-main.js:5069`) — the renderer never learns a target is missing. Return a result; toast
  with a "fix this shortcut" action.
- [ ] **No live preview in settings.** Changing orbital radius, icon size, spacing, opacity or
  backdrop means closing settings and triggering the wheel to see the effect. Add an inline preview.
- [ ] **`window.confirm` for workspace deletion** (`PrecisionSettings.tsx:332`) — a native blocking
  dialog inside a frameless transparent window, and untranslated. Replace with in-app confirm, or
  better: delete + undo toast.
- [ ] **No undo anywhere.** Deleting a shortcut or workspace, or "Restore defaults", is permanent.
- [ ] **No shortcut-conflict detection while recording.** Conflict surfaces later as a toast; warn
  during the key capture instead.
- [ ] **No per-setting "reset to default".**
- [ ] **Tray menu is two items** (Open Settings / Quit). Add: open wheel, pause trigger for N
  minutes, switch workspace, check for updates, version.
- [ ] **No keyboard entry to settings search** — bind Ctrl+K / Ctrl+F to `#zs-search-input`.
- [ ] **No wheel type-ahead.** Past ~12 shortcuts the slices get thin; "start typing to filter"
  scales the wheel beyond what aiming alone supports.
- [ ] **No item-count guidance.** `360 / totalApps` with no cap — 20 items gives 18° slices, close to
  unaimable in `angle` mode. Warn in the editor, or auto-page.
- [ ] **First-run onboarding is gone** (WelcomeScreen is dead) — new users get a wheel and no
  explanation of the trigger, workspaces, or aiming modes.
- [ ] **Start Menu discovery has no progress UI** — 20 s deferral at login leaves an empty wheel with
  nothing on screen explaining it (`App.tsx:47`).
- [ ] **Dwell mode has no in-app cancel explanation** — the arc is the only signal.
- [ ] Settings sections are discoverable only by clicking each; consider group counts and a
  recently-changed marker.

## 5. Accessibility

- [ ] **The wheel is mouse-only.** `Escape` is the only key handled (`RadialMenu.tsx:1503`). Add
  arrow-key / number-key navigation plus Enter to confirm, so the launcher works without a pointer.
- [ ] **The wheel has no accessible semantics** — no `role="menu"`/`menuitem`, no per-slice
  `aria-label`, no live region announcing the aimed target. A screen reader user gets nothing.
- [ ] **`--zn-text-3: rgba(255,255,255,.34)` on `#151515` is ≈3.1:1** (`src/index.css:46`) — below
  WCAG AA 4.5:1, and used at 9–11 px. Raise to ≈.45, or restrict to non-essential text.
- [ ] **Text runs very small**: 8 declarations at 9.5 px, 13 at 11.5 px, plus 9/10/10.5 px. Add a UI
  scale setting, or lift the base to 12–13 px.
- [ ] **No `forced-colors` / `prefers-contrast` support** — invisible in Windows High Contrast mode.
- [ ] **`AppSelector`, `IconPicker`, `SmartIcon`, `Toast`, `Tooltip`, `SystemCenter` have zero ARIA
  attributes.** IconPicker (a ~1,500-cell grid) needs `role="grid"` and a roving tabindex.
- [ ] **Focus is not trapped in settings modals**, and several controls set `outline: none` without a
  `:focus-visible` replacement (pattern leaked from `SettingsModal` into `AppSelector`/`IconPicker`).
- [ ] `prefers-reduced-motion` is handled well (`index.css:857`, `:950`) — keep that discipline for
  any new animation.

## 6. Internationalisation

- [ ] **i18n is effectively dead.** `PrecisionSettings` — the live settings panel — is hardcoded
  English and never imports `getTranslation`. Only `RadialMenu` (4 strings) and `IconPicker` still
  translate.
- [ ] **No language selector in the live UI** — `LANGUAGES` is referenced only by dead
  `SettingsModal`.
- [ ] **Key parity is broken**: pt/en 429 keys, es 281, fr/de/it/ja/zh/ko/ru 257–258. The surplus
  pt/en keys belong to the dead modal.
- [ ] Decide: (a) delete `translations.ts`, ship English-only, drop 3,451 lines from the bundle, or
  (b) re-adopt properly — a real `t()` in `PrecisionSettings`, lazy per-language chunks, parity check
  in CI. **(a) is the honest default.**

## 7. Engineering hygiene

- [ ] **`tsconfig.json` has no `strict`** — no `strictNullChecks`, `noImplicitAny`, `noUnusedLocals`.
  34 `any` / `as any` in `src/`.
- [ ] **No linter, no formatter, no CI.** Add ESLint + Prettier and a GitHub Actions run of
  `npm run build` plus the existing tests.
- [ ] **Two unit test files for 28,000 lines** (`win32-launch`, `game-detection`). Highest-value
  additions: `resolveAimAtPoint` trigonometry, persistence normalise round-trip, dwell arming rules.
- [ ] **`backend/electron-main.js` is 7,081 lines / 270 KB in one file.** Split by concern: window
  lifecycle, IPC, persistence, icons, updates, licensing, launch.
- [ ] **167 `catch (e) {}` blocks in main**, many silent. Route through `diagLog` at minimum so field
  diagnosis is possible.
- [ ] **Comments are Portuguese, code and UI are English.** For a fork with an English-speaking
  maintainer that is a real onboarding tax on the densest reasoning in the codebase
  (`RadialMenu.tsx`, `electron-main.js`). Translate incrementally as files are touched.
- [ ] **`docs/ARCHITECTURE.md` is stale** — references `LicenseGate.tsx` (does not exist) and lists
  the dead `SettingsModal` alongside `PrecisionSettings`.
- [ ] Dev scratch scripts shipped in `backend/` (`reproduce_icon_issue.ps1`, `find_lnks.ps1`,
  `simulate-keys.ps1`) — move to `scripts/dev/` or delete.

## 8. Quick wins (do these first)

1. Delete the four dead components (§2) — 6,300 lines, zero risk.
2. Fix `src/iconMap.ts`'s barrel import (§3) — largest bundle win for one file.
3. Trim font subsets in `src/main.tsx` (§3).
4. Replace `dist/folder.svg` (§3).
5. Raise `--zn-text-3` contrast (§5).
6. Make `execute-command` return a result and toast on failure (§4).
7. Correct the two false claims in `README.md` (§1).
