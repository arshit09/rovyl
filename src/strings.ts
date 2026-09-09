/**
 * Every string the live UI shows that is not the user's own text.
 *
 * There are six. `src/translations.ts` carries 429 keys in ten languages, and all ten sat in the
 * chunk the wheel waits on — 167 kB of it, measured — because `getTranslation` indexes the table by
 * a runtime key and nothing can be shaken out of it. Six strings did not justify that, and the ten
 * languages were never reachable anyway: `App.tsx` writes `language: 'en'` over every config it
 * hydrates, and the last language selector left the tree with the dead `SettingsModal` (TODO §2).
 *
 * So this is not a decision to drop i18n — it is recording the one this app already made. If real
 * translation comes back it should come back properly (see TODO §6): a per-language chunk loaded on
 * demand, a `t()` the settings panel actually calls, and a key-parity check in CI. A table of ten
 * locales that only ever renders English is the shape to avoid, not the shape to restore.
 *
 * Keys stay in the `namespace.key` form the old table used, so a future `t()` is a drop-in.
 */
export const UI_STRINGS = {
  "menu.back": "Back",
  "menu.center": "Center",
  "menu.recents_fallback": "Open app (no recent folders found)",
  "iconPicker.search_placeholder": "Search icons…",
  "iconPicker.english_keywords_hint":
    "Tip: English words (work, time, home…) also surface related icons by meaning, not only by name.",
  "iconPicker.no_results": "No icons found.",
} as const;

export type UiStringKey = keyof typeof UI_STRINGS;

/**
 * Typed on purpose. The old `getTranslation(config, key)` took any string and fell back to
 * returning the key itself, so a typo shipped as UI text reading `menu.bakc`. Here a wrong key does
 * not compile.
 */
export function uiString(key: UiStringKey): string {
  return UI_STRINGS[key];
}
