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
  dockNetWired: 'Kabelnetzwerk',
  dockNetNone: 'Kein Netzwerk',
  dockNetOther: 'Verbunden',
  dockNetWifiSignal: 'WLAN — {percent}% Signal',
  dockNetWifi: 'WLAN',
  dockMute: 'Klicken zum Stummschalten',
  dockUnmute: 'Stumm — klicken zum Aufheben',
  dockVolumeNone: 'Kein Audiogerät',
  dockVolumeLevel: 'Lautstärke {percent}%',
  dockNetOpenSettings: '{name} — klicken für die Netzwerkeinstellungen von Windows',
  dockBatteryLevel: 'Akku {percent}%',
  dockBatteryCharging: 'Akku {percent}% — lädt',
  dockBatteryAria: 'Akku {percent} Prozent',
  dockMuteAria: 'Stummschalten',
  dockUnmuteAria: 'Stummschaltung aufheben',
};

export default de;
