import { useEffect, useState } from 'react';
import { DEFAULT_FAULT_STRINGS, loadFaultStrings, type LaunchFailureStrings } from './index';
import { normalizeLanguage, type SupportedLanguage } from '../languages';

/**
 * The fault card's sentences for the configured language, English until the pack lands.
 *
 * Language and pack move as one value, so a pack resolving after a second switch cannot paint the
 * language the user just left — the same rule as `../wheel/useWheelStrings.ts`, and for the same
 * reason.
 */
export function useFaultStrings(language: string | undefined): LaunchFailureStrings {
  const code = normalizeLanguage(language);
  const [loaded, setLoaded] = useState<{ code: SupportedLanguage; strings: LaunchFailureStrings }>({
    code: 'en',
    strings: DEFAULT_FAULT_STRINGS,
  });

  useEffect(() => {
    if (code === 'en') {
      setLoaded({ code: 'en', strings: DEFAULT_FAULT_STRINGS });
      return;
    }
    let live = true;
    void loadFaultStrings(code).then((strings) => {
      if (live) setLoaded({ code, strings });
    });
    return () => {
      live = false;
    };
  }, [code]);

  return loaded.code === code ? loaded.strings : DEFAULT_FAULT_STRINGS;
}
