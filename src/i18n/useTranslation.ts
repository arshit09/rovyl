import { useCallback } from 'react';
import { translations, t as translate, type TranslationKey, type SupportedLanguage } from './translations';

export function useTranslation(language: string = 'en') {
  const currentLang: SupportedLanguage = language === 'ar' ? 'ar' : 'en';
  
  const t = useCallback(
    (key: TranslationKey) => translate(key, currentLang),
    [currentLang],
  );

  return { t, language: currentLang, isRtl: currentLang === 'ar' };
}

export { translations, type TranslationKey, type SupportedLanguage };
