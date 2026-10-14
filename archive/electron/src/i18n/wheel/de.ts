import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const de: WheelStrings = {
  menuBack: 'Zurück',
  menuCenter: 'Mitte',
  menuRecentsFallback: 'App öffnen (keine zuletzt genutzten Ordner)',
  menuFetchingIcon: 'Symbol wird geladen',
  menuRestartToUpdate: 'Neu starten zum Aktualisieren',
  menuNoMatches: 'keine Treffer',
  menuFilterCount: '{shown} von {total}',
  menuDiscoveryScanning: 'Ihr Startmenü wird durchgesehen…',
  menuDiscoveryPending: 'Ihre Apps sind unterwegs — dieses Rad füllt sich gleich von selbst.',
  menuDirectionHint: 'Zu einem Ziel schieben, um es zu öffnen — oder %s drücken, um das Rad zu schließen.',
  hudOpenSettings: 'Rovyl-Einstellungen öffnen',
  hudSettingsTitle: 'Rovyl-Einstellungen',
};

export default de;
