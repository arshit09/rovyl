/**
 * Which languages exist, and nothing about what they say.
 *
 * This is split from `translations.ts` on purpose, and the split is the whole performance story of
 * this feature. `App.tsx` has to validate the `language` it hydrates from disk on every start, and
 * `App.tsx` is the critical chunk — the JS the radial wheel waits on before it can paint. If it
 * imported the tables to do that, all eight locales would be in that chunk, which is exactly the
 * 167 kB mistake TODO §6.4 deleted.
 *
 * So the codes and their metadata live here — well under a kilobyte, safe anywhere — and the text
 * lives next door, reachable only through `useTranslation`, which only the lazy settings panel
 * imports. `scripts/verify-renderer-budget.mjs` fails the build if that ever stops being true.
 */

export const LANGUAGES = [
  { value: 'en', label: 'English', english: 'English', dir: 'ltr' },
  { value: 'es', label: 'Español', english: 'Spanish', dir: 'ltr' },
  { value: 'zh', label: '简体中文', english: 'Chinese (Simplified)', dir: 'ltr' },
  { value: 'ja', label: '日本語', english: 'Japanese', dir: 'ltr' },
  { value: 'pt', label: 'Português', english: 'Portuguese', dir: 'ltr' },
  { value: 'ru', label: 'Русский', english: 'Russian', dir: 'ltr' },
  { value: 'de', label: 'Deutsch', english: 'German', dir: 'ltr' },
  { value: 'ar', label: 'العربية', english: 'Arabic', dir: 'rtl' },
] as const satisfies ReadonlyArray<{
  value: string;
  /** Endonym — what the picker shows. Someone stranded in a UI they cannot read is looking for
   *  the row that looks like their language, and "Russian" does not look like Русский. */
  label: string;
  /** English name, used as the accessible label so a screen reader announces something sayable. */
  english: string;
  dir: 'ltr' | 'rtl';
}>;

export type SupportedLanguage = (typeof LANGUAGES)[number]['value'];

export const FALLBACK_LANGUAGE: SupportedLanguage = 'en';

const LANGUAGE_CODES: ReadonlySet<string> = new Set(LANGUAGES.map((entry) => entry.value));

/**
 * A stored `config.language` is whatever some earlier build wrote there. `UIConfig['language']`
 * still names three locales that have no table (`fr`, `it`, `ko`), older configs carry them,
 * and a hand-edited file can say anything at all — so every read goes through here.
 */
export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && LANGUAGE_CODES.has(value);
}

export function normalizeLanguage(value: unknown): SupportedLanguage {
  return isSupportedLanguage(value) ? value : FALLBACK_LANGUAGE;
}

/** `'rtl'` for Arabic, `'ltr'` for the rest — asked, never hardcoded at the call site. */
export function directionOf(value: unknown): 'ltr' | 'rtl' {
  const normalized = normalizeLanguage(value);
  return LANGUAGES.find((entry) => entry.value === normalized)?.dir ?? 'ltr';
}
