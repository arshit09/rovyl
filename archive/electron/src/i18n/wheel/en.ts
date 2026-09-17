import type { WheelStrings } from './types';

/**
 * The synchronous default, and the only pack allowed in the wheel's critical chunk.
 *
 * It is what the first frame paints from, always: a wheel that waited on a fetch to know the word
 * for "Back" would be a wheel that waited, which is the one thing this window may not do.
 */
export const en: WheelStrings = {
  menuBack: 'Back',
  menuCenter: 'Center',
  menuRecentsFallback: 'Open app (no recent folders found)',
  menuFetchingIcon: 'Fetching icon',
  menuRestartToUpdate: 'Restart to update',
  menuNoMatches: 'no matches',
  menuFilterCount: '{shown} of {total}',
  menuDiscoveryScanning: 'Looking through your Start menu…',
  menuDiscoveryPending: 'Your apps are on their way — this wheel fills itself in a moment.',
  menuDirectionHint: 'Push toward a target to open it — or press %s to close the wheel.',
  hudOpenSettings: 'Open Rovyl settings',
  hudSettingsTitle: 'Rovyl settings',
  dockNetWired: 'Wired network',
  dockNetNone: 'No network',
  dockNetOther: 'Connected',
  dockNetWifiSignal: 'Wi-Fi — {percent}% signal',
  dockNetWifi: 'Wi-Fi',
  dockMute: 'Click to mute',
  dockUnmute: 'Muted — click to unmute',
  dockVolumeNone: 'No audio device',
  dockVolumeLevel: 'Volume {percent}%',
  dockNetOpenSettings: '{name} — click for Windows network settings',
  dockBatteryLevel: 'Battery {percent}%',
  dockBatteryCharging: 'Battery {percent}% — charging',
  dockBatteryAria: 'Battery {percent} percent',
  dockMuteAria: 'Mute',
  dockUnmuteAria: 'Unmute',
};
