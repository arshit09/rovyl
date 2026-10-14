import { useEffect, useState } from 'react';
import { DEFAULT_WHEEL_STRINGS, loadWheelStrings, type WheelStrings } from './index';
import { normalizeLanguage, type SupportedLanguage } from '../languages';

/**
 * The wheel's strings for the configured language, English until the pack lands.
 *
 * Call this ONCE, from `RadialApp` — not from `RadialMenu`. `RadialMenu` mounts and unmounts with
 * the open/close cycle, so a hook there would start the loader again on every open and hand back
 * English for a frame each time. `RadialApp` is mounted for the life of the process, and the window
 * it lives in is created hidden at startup, so the pack has resolved long before the first gesture.
 *
 * The language and its pack are held as ONE state value. Kept apart, a pack that resolves after the
 * user has already switched again would paint the language they just left.
 */
export function useWheelStrings(language: string | undefined): WheelStrings {
  const code = normalizeLanguage(language);
  const [loaded, setLoaded] = useState<{ code: SupportedLanguage; strings: WheelStrings }>({
    code: 'en',
    strings: DEFAULT_WHEEL_STRINGS,
  });

  useEffect(() => {
    if (code === 'en') {
      setLoaded({ code: 'en', strings: DEFAULT_WHEEL_STRINGS });
      return;
    }
    let live = true;
    void loadWheelStrings(code).then((strings) => {
      if (live) setLoaded({ code, strings });
    });
    return () => {
      live = false;
    };
  }, [code]);

  return loaded.code === code ? loaded.strings : DEFAULT_WHEEL_STRINGS;
}
