import { useCallback, useMemo } from 'react';
import {
  LANGUAGES,
  directionOf,
  isSupportedLanguage,
  normalizeLanguage,
  translations,
  t as translate,
  tf as translateFormat,
  type SupportedLanguage,
  type TranslationKey,
} from './translations';

export function useTranslation(language: string | undefined = 'en') {
  const currentLang: SupportedLanguage = useMemo(() => normalizeLanguage(language), [language]);

  const t = useCallback(
    (key: TranslationKey) => translate(key, currentLang),
    [currentLang],
  );

  /** `t` with `{name}` slots filled — see `tf` in `./translations`. */
  const tf = useCallback(
    (key: TranslationKey, vars: Record<string, string | number>) =>
      translateFormat(key, vars, currentLang),
    [currentLang],
  );

  return {
    t,
    tf,
    language: currentLang,
    dir: directionOf(currentLang),
    isRtl: directionOf(currentLang) === 'rtl',
  };
}

export {
  LANGUAGES,
  directionOf,
  isSupportedLanguage,
  normalizeLanguage,
  translations,
  type TranslationKey,
  type SupportedLanguage,
};
