import type { AppItem, UIConfig } from '../types';

export function pickWorkspaceSwitchMode(cfg: UIConfig): 'hotkeys' | 'picker' {
  return cfg.workspaceSwitchMode === 'picker' ? 'picker' : 'hotkeys';
}

export function enabledWorkspaceCount(cfg: UIConfig): number {
  return cfg.workspaces.filter((w) => w.enabled).length;
}

/** Synthetic radial items — one per enabled workspace (real workspace index in id). */
export function buildWorkspacePickerItems(cfg: UIConfig): AppItem[] {
  const items: AppItem[] = [];
  cfg.workspaces.forEach((ws, index) => {
    if (!ws.enabled) return;
    items.push({
      id: `__zenith_ws_pick__${index}`,
      type: 'app',
      label: ws.name,
      iconName: ws.pickerIconName?.trim() || 'Layers',
      iconSource: 'lucide',
      command: '',
      commandType: 'app',
      description: ws.hotkey ? `(${ws.hotkey})` : '',
    });
  });
  return items;
}

/** Root level of the radial: either current workspace apps or workspace picker. */
export function getRootRadialApps(
  cfg: UIConfig,
  currentWorkspaceApps: AppItem[],
): AppItem[] {
  if (pickWorkspaceSwitchMode(cfg) !== 'picker') return currentWorkspaceApps;
  if (enabledWorkspaceCount(cfg) <= 1) return currentWorkspaceApps;
  return buildWorkspacePickerItems(cfg);
}

/** Plain boolean guard — a type predicate on `id` would wrongly narrow the false branch to `never`. */
export function isWorkspacePickItem(app: AppItem | null | undefined): boolean {
  return !!app?.id?.startsWith('__zenith_ws_pick__');
}

export function parseWorkspacePickIndex(id: string): number {
  return parseInt(id.replace('__zenith_ws_pick__', ''), 10);
}

/**
 * The level, narrowed to what has been typed on the wheel.
 *
 * Two rules, in order, and the order is the point. A prefix match is what someone typing "sp" for
 * Spotify means, so those come first and in their original ring order; a match anywhere in the name
 * is what saves them when the app is called "Visual Studio Code" and they typed "code". Mixing the
 * two by score would reorder the ring on nearly every keystroke, and a ring that reshuffles as you
 * type is one you cannot aim at — the whole reason for filtering in the first place.
 *
 * The second rule waits for a second character. One letter is inside almost every name — "s" is in
 * Discord and in Visual Studio Code — so applying it there kept five of seven slices and narrowed
 * nothing. A single letter therefore means "the ones that START with it", which is what pressing
 * one letter has meant in every list since menus had letters.
 *
 * Case- and space-insensitive, so "visual studio" — typed the way anyone types it — matches
 * "Visual Studio Code". It is NOT an initials match: "vscode" does not find that app, because
 * matching initials means scoring, and scoring means the ring reorders on a keystroke.
 *
 * Nothing else is normalised; this runs on every keystroke while a wheel is on screen.
 */
export function filterRadialApps(apps: AppItem[], query: string): AppItem[] {
  const needle = query.replace(/\s+/g, '').toLowerCase();
  if (!needle) return apps;
  const useContains = needle.length >= 2;

  const prefix: AppItem[] = [];
  const contains: AppItem[] = [];
  for (const app of apps) {
    const label = (app.label || '').replace(/\s+/g, '').toLowerCase();
    if (!label) continue;
    if (label.startsWith(needle)) prefix.push(app);
    else if (useContains && label.includes(needle)) contains.push(app);
  }
  return prefix.concat(contains);
}
