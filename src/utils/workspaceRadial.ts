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

/**
 * Whether a workspace has more shortcuts than the wheel can be aimed at, and what that costs.
 *
 * The ring divides 360° by the item count and nothing caps it, so the geometry degrades quietly:
 * eight shortcuts are 45° each and effortless, twenty are 18° and a coin toss. Nowhere in the app
 * said so — the editor let you add the twenty-first exactly as easily as the second.
 *
 * The thresholds come from the slice, not from taste. A flick of the wrist lands within roughly
 * ±15° of where it was aimed, so a 30° slice — twelve items — is the last one whose whole width is
 * inside that error. Past that, aiming starts costing attention; at 18° and below it is a guess.
 *
 * Pointer mode is a different failure and gets different words. There the target is the icon, not
 * the sector, and `computeRadialLayout` answers a crowded ring by shrinking the icons rather than
 * by narrowing anything — so what runs out is not angle but the icon itself.
 */
export function radialCrowding(
  itemCount: number,
  selectionMode: UIConfig['radialSelectionMode'],
): { severity: 'caution' | 'warning'; message: string } | null {
  if (itemCount <= 12) return null;
  const byDirection = selectionMode !== 'cursor';
  const degrees = Math.round(360 / itemCount);
  const severity = itemCount > 18 ? 'warning' : 'caution';

  /** "is ${n}° wide" and not "is a ${n}° slice": 8, 11 and 18 are all reachable, and all take "an". */
  const cost = byDirection
    ? `each target is only ${degrees}° wide`
    : 'each icon has to shrink to keep the ring on screen';
  const advice =
    severity === 'warning'
      ? 'Group related shortcuts into a folder — a group is one slice, and opens a ring of its own.'
      : 'Adding many more will make them hard to hit; a folder keeps several behind one slice.';

  return { severity, message: `${itemCount} shortcuts on the wheel, so ${cost}. ${advice}` };
}
