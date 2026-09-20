import type { UIConfig } from './types';
import { DEFAULT_UI_CONFIG, stripInternalWidgetsFromConfig } from './defaults';
import { normalizeLanguage } from './i18n/languages';
import { BACKDROP_DIM_SCALE, legacyBackdropOpacityToDim } from './utils/radialScrim';

/**
 * Everything a config has to be put through between coming off disk and being believed.
 *
 * It lives here, apart from either app, because there are now two renderers reading the same file
 * and only one of them writes it. Settings hydrates to edit; the wheel hydrates to draw. If the two
 * disagreed by so much as a default, the wheel would render a config nobody has — and the
 * divergence would appear only for the settings that happen to be missing from an older file,
 * which is the hardest kind to notice.
 *
 * Pure, and deliberately blind to `workspaces` contents: the Start Menu discovery and the
 * persistence-meta stamping are the settings window's business alone and run around this, not
 * inside it.
 */
export function normalizeStoredConfig(raw: unknown): UIConfig {
  const loaded = (raw && typeof raw === 'object' ? raw : {}) as Partial<UIConfig> & Record<string, unknown>;

  /**
   * Old configs carry `internal:*` shortcuts from the removed widgets — discard them on read.
   *
   * The defaults go in BEFORE whatever came off disk. Without that base, every setting added in a
   * version later than the saved file reaches the renderer as `undefined` instead of its default.
   * The symptom misleads: it looks like the backup did not keep the settings, when in truth they
   * were never in the file and nobody restored them on read.
   */
  let config = stripInternalWidgetsFromConfig({
    ...DEFAULT_UI_CONFIG,
    ...loaded,
    /**
     * The opening point is no longer configurable: the wheel is always born at the centre of its
     * own window. Old configs can carry `false` — normalize on read, otherwise a state the
     * interface can no longer show or undo would survive.
     */
    fixedPosition: true,
    gameMode: {
      ...DEFAULT_UI_CONFIG.gameMode,
      ...((loaded as any).gameMode || {}),
      /** Drops the old demo list: the selection is visual now, per application. */
      blockedApps:
        ((loaded as any).gameMode?.blockedApps || '').trim().toLowerCase() ===
        'csgo.exe, valorant.exe, dota2.exe, overwatch.exe'
          ? ''
          : ((loaded as any).gameMode?.blockedApps || ''),
    },
  } as UIConfig);

  /**
   * Contiguous hotkeys by position, on read too.
   *
   * Renumbering only on mutations would leave out the files already saved with gaps — the
   * "1, 2, 4" left over from a workspace deleted in the middle on an earlier version. The
   * operation is idempotent: whatever is already right is not touched.
   */
  config = {
    ...config,
    workspaces:
      config.workspaces?.map((workspace, index) => {
        const hotkey = index < 9 ? index + 1 : 0;
        return workspace.hotkey === hotkey ? workspace : { ...workspace, hotkey };
      }) ?? config.workspaces,
  };

  /**
   * A config written before this flag existed belongs to someone already using Rovyl, and the
   * welcome card is for people who are not. The spread above fills the missing key with `false`,
   * so without this every existing user would be welcomed to an app they have had for months.
   *
   * The test is that the key is ABSENT, not that a config exists at all. A first run saves one
   * within seconds — before anybody has read the card, let alone dismissed it.
   */
  if (!('hasSeenOnboarding' in loaded)) {
    config = { ...config, hasSeenOnboarding: true };
  }

  /**
   * "Start with Windows" ships on, but only for installs that begin with it. A config written
   * before the default changed belongs to somebody who has been using Rovyl without it, and an
   * update must not put an entry in their startup list on its own.
   *
   * Same test as the card above — the key is ABSENT, not `false`. The main process keeps the
   * identical rule over settings.json, so the toggle and the registry cannot come apart.
   */
  if (!('openAtLogin' in loaded)) {
    config = { ...config, openAtLogin: false };
  }

  /**
   * "Background dimming" used to top out at half a pool; it now reaches an opaque screen. The saved
   * number therefore means something darker than it did, and the default was the top of the old
   * scale — so left alone, every existing profile would have blacked the screen out on the first
   * open after updating, having changed nothing.
   *
   * Converted once, to the value that paints exactly the pixels the person already had. The test is
   * the missing marker, not the value: 1 was both the default and a deliberate choice, and the two
   * are indistinguishable here — which does not matter, because they looked the same on screen and
   * so they still do.
   */
  if (Number((loaded as any).backdropDimScale) !== BACKDROP_DIM_SCALE) {
    config = {
      ...config,
      backdropDimScale: BACKDROP_DIM_SCALE,
      backdropOpacity: legacyBackdropOpacityToDim(
        'backdropOpacity' in loaded ? Number((loaded as any).backdropOpacity) : 1,
      ),
    };
  }

  /**
   * Normalize, do not overwrite. A stored choice has to survive a reload — but only for a language
   * that actually has a table. `UIConfig['language']` still types four that do not (`fr`, `it`,
   * `ja`, `ko`), so a config carrying one still lands on English.
   */
  return { ...config, language: normalizeLanguage(config.language) };
}
