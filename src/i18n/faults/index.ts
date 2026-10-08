import { en } from './en';
import type { LaunchFailureStrings } from './types';
import { normalizeLanguage, type SupportedLanguage } from '../languages';

/**
 * One literal `import()` per language, for the same reason `../wheel/index.ts` spells them out: a
 * template specifier makes rollup emit every pack as a sibling of whatever entry contains it.
 */
const LOADERS: Record<
  Exclude<SupportedLanguage, 'en'>,
  () => Promise<{ default: LaunchFailureStrings }>
> = {
  es: () => import('./es'),
  zh: () => import('./zh'),
  ja: () => import('./ja'),
  pt: () => import('./pt'),
  ru: () => import('./ru'),
  de: () => import('./de'),
  ar: () => import('./ar'),
};

/** A pack that will not load degrades to English: a readable card beats no card. */
export function loadFaultStrings(language: unknown): Promise<LaunchFailureStrings> {
  const code = normalizeLanguage(language);
  if (code === 'en') return Promise.resolve(en);
  return LOADERS[code]()
    .then((module) => module.default)
    .catch(() => en);
}

export { en as DEFAULT_FAULT_STRINGS };
export type { LaunchFailureStrings };
