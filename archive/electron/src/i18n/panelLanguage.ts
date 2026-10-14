import { createContext, useContext } from 'react';

/**
 * Which language the settings window is speaking, for the parts of it that are too deep to hand a
 * prop to.
 *
 * The panel is one component with a dozen small ones inside it — the colour control, the shortcut
 * recorders, the protected-apps manager, the workspace cards — and none of them has any other
 * reason to know about config. Threading `language` through all of them would be a prop that exists
 * solely to be passed on, in files that would then have to be edited again for the next one.
 *
 * This file holds the code and nothing else, exactly as `./languages.ts` does and for the same
 * reason: it can be imported from anywhere, including modules that must never pull in the tables.
 * Reach the text through `useTranslation(usePanelLanguage())`.
 */
const PanelLanguageContext = createContext<string>('en');

export const PanelLanguageProvider = PanelLanguageContext.Provider;

export function usePanelLanguage(): string {
  return useContext(PanelLanguageContext);
}
