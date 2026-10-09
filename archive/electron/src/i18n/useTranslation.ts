import { useCallback, useMemo } from 'react';
import {
  LANGUAGES,
  directionOf,
  isSupportedLanguage,
  normalizeLanguage,
  translations,
  t as translate,
  type SupportedLanguage,
  type TranslationKey,
} from './translations';

export function useTranslation(language: string | undefined = 'en') {
  const currentLang: SupportedLanguage = useMemo(() => normalizeLanguage(language), [language]);

  const t = useCallback(
    (key: TranslationKey) => translate(key, currentLang),
    [currentLang],
  );

  return {
    t,
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
