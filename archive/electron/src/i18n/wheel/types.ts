/**
 * Every string the RADIAL WHEEL paints that is not the user's own text.
 *
 * Twenty-seven of them, and they are the reason this is a separate system from `src/i18n/translations.ts`
 * rather than a corner of it. The settings tables are 255 keys across eight locales and they ride
 * the lazy `PrecisionSettings` chunk; the wheel is parsed before its first frame, and `t()` indexes
 * its tables by a runtime key, so nothing there can be tree-shaken. Putting them in front of the
 * gesture is the 167 kB mistake TODO §6.4 deleted.
 *
 * So the wheel gets packs of its own: English static and synchronous, every other language a chunk
 * fetched once the config says which one. `scripts/verify-renderer-budget.mjs` holds both halves of
 * that — English must be in the critical path, the rest must not be.
 */
export interface WheelStrings {
  /** The hub, one level deep: it goes back. */
  menuBack: string;
  /** The hub at the root, when no custom label is set. */
  menuCenter: string;
  /** Recent folders were asked for and none came back. */
  menuRecentsFallback: string;
  /** Screen-reader only: an icon still being extracted. */
  menuFetchingIcon: string;
  /** The update badge beside the hub — a button, so this is an instruction. */
  menuRestartToUpdate: string;
  /** Type-ahead found nothing. */
  menuNoMatches: string;
  /** `{shown}` and `{total}`. Japanese reverses the operands, which is why this is a template and not two numbers joined by a word. */
  menuFilterCount: string;
  /** The Start menu is being read right now. */
  menuDiscoveryScanning: string;
  /** Discovery has not started or has not landed yet. */
  menuDiscoveryPending: string;
  /** One `%s`, replaced by a <kbd>Esc</kbd> element. A single slot rather than a before/after pair, because Japanese needs the key in the middle of the sentence. */
  menuDirectionHint: string;
  /** Screen-reader label for the gear in the corner. */
  hudOpenSettings: string;
  /** Tooltip for the same gear. */
  hudSettingsTitle: string;
  /** The docks beside the wheel. They paint in the same frame, so their words ride the same pack. */
  dockNetWired: string;
  dockNetNone: string;
  dockNetOther: string;
  /** `{percent}` — the Wi-Fi signal strength. */
  dockNetWifiSignal: string;
  dockNetWifi: string;
  dockMute: string;
  dockUnmute: string;
  dockVolumeNone: string;
  /** `{percent}` — the output level. */
  dockVolumeLevel: string;
  /** `{name}` — the network's own label, from the keys above. */
  dockNetOpenSettings: string;
  /** `{percent}` — charge level. */
  dockBatteryLevel: string;
  dockBatteryCharging: string;
  /** Screen readers spell the unit out rather than reading the sign. */
  dockBatteryAria: string;
  dockMuteAria: string;
  dockUnmuteAria: string;
}
