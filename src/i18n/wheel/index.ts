/**
 * Which wheel pack to fetch, and how.
 *
 * The loaders are written out one literal `import()` per language on purpose. A single
 * `` import(`./${lang}`) `` looks like the same thing and is not: Rollup cannot know which files a
 * template specifier will ask for, so it emits every match as a sibling of the entry that contains
 * it — and the packs, whose entire reason for existing is to stay out of the wheel's critical
 * chunk, would end up in it. That failure is quiet, too: the bytes are small enough that the budget
 * check would still pass, and only the lazy check would notice.
 */
import { en } from './en';
import type { WheelStrings } from './types';
import { normalizeLanguage, type SupportedLanguage } from '../languages';

const LOADERS: Record<
  Exclude<SupportedLanguage, 'en'>,
  () => Promise<{ default: WheelStrings }>
> = {
  es: () => import('./es'),
  zh: () => import('./zh'),
  ja: () => import('./ja'),
  pt: () => import('./pt'),
  ru: () => import('./ru'),
  de: () => import('./de'),
  ar: () => import('./ar'),
};

/**
 * A pack that cannot be fetched degrades to English rather than throwing. The caller is a render
 * with a gesture waiting on it; an unreadable label is a worse outcome than an English one, and a
 * thrown promise here would take the wheel with it.
 */
export function loadWheelStrings(language: unknown): Promise<WheelStrings> {
  const code = normalizeLanguage(language);
  if (code === 'en') return Promise.resolve(en);
  return LOADERS[code]()
    .then((module) => module.default)
    .catch(() => en);
}

/**
 * Fills `{name}` slots. Same rule as `tf()` next door: an unknown slot is left standing, because
 * `{total}` on screen gets reported and a silent gap does not.
 */
export function formatWheelString(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) =>
    name in vars ? String(vars[name]) : slot,
  );
}

export { en as DEFAULT_WHEEL_STRINGS };
export type { WheelStrings };
