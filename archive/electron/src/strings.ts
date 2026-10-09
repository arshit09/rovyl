/**
 * Every string the RADIAL WHEEL shows that is not the user's own text.
 *
 * There are six, and they are still English in every locale. That is a scope line, not an
 * oversight (TODO §6.5). The wheel renders from the critical chunk — the JS parsed before the
 * first frame — and `src/i18n/translations.ts` cannot be tree-shaken, because `t()` indexes it by a
 * runtime key. Six strings do not justify putting seven locale tables in front of first paint; the
 * settings panel, with 107 keys' worth and a lazy chunk of its own, does.
 *
 * So the split is by chunk, not by conviction: `useTranslation` for anything inside
 * `PrecisionSettings`, this file for anything the wheel paints. Translating these six properly
 * means a per-language chunk fetched when the language is picked — and until that exists, an i18n
 * import here would fail `scripts/verify-renderer-budget.mjs`, which is exactly the point.
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
