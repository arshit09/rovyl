/**
 * The two docks that sit in the corners of the open wheel, as data.
 *
 * A dock is a strip of things placed against one edge of the screen while the wheel is up: the
 * SYSTEM dock reads the clock, the battery, the network and the volume, and the SHORTCUT dock
 * holds icons the user chose. They are deliberately two configurations of one idea rather than one
 * configuration with a mode, because the questions they answer are different — a shortcut dock has
 * a list and no readouts, a system dock has readouts and no list — and every shared field below
 * (`enabled`, `position`, `iconSize`, `gap`) means exactly the same thing in both.
 *
 * It lives away from the components that draw it because three places need the same answers: the
 * wheel, which paints them; the settings panel, which edits them; and `RadialApp`, which has to
 * tell the main process that the overlay window must reach the screen edges when either dock is
 * on. See scripts/screen-docks-smoke.mjs.
 */

import type { AppItem } from '../types';

/**
 * Where a dock may sit.
 *
 * Six regions, not four corners: the middle of an edge is a perfectly good place for a status
 * strip, and it is only the settings GEAR that must avoid it (a wedge aimed straight up or down
 * ends there). The same vocabulary the radial HUD already uses, so a config that names a region
 * means one thing everywhere.
 */
export const DOCK_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type DockPosition = (typeof DOCK_POSITIONS)[number];

/** What every dock is asked: whether it is on, where it sits, and how big and how spread out. */
interface DockPlacement {
  enabled: boolean;
  position: DockPosition;
  /** Edge length of one icon box, in CSS pixels. */
  iconSize: number;
  /** Space between neighbouring items, in CSS pixels. */
  gap: number;
}

/** Time, battery, network and volume — each one optional, because not every desktop has all four. */
export interface StatusDockConfig extends DockPlacement {
  showClock: boolean;
  showBattery: boolean;
  showNetwork: boolean;
  showVolume: boolean;
}

/** The icons the user put there. Ordinary `AppItem`s, so one launch path serves them and the wheel. */
export interface ShortcutDockConfig extends DockPlacement {
  items: AppItem[];
  /** Name under each icon. Off by default: a dock of eight names is a menu, not a strip. */
  showLabels: boolean;
}

export const STATUS_DOCK_ICON_MIN = 12;
export const STATUS_DOCK_ICON_MAX = 32;
export const SHORTCUT_DOCK_ICON_MIN = 24;
export const SHORTCUT_DOCK_ICON_MAX = 88;
export const DOCK_GAP_MIN = 0;
export const DOCK_GAP_MAX = 48;

/**
 * Off, like every other thing Rovyl draws outside the wheel itself.
 *
 * The positions are the ones the docks are FOR — readouts bottom-right where Windows puts them, so
 * the eye already knows where to look, and shortcuts bottom-left where the taskbar's pinned apps
 * are. Turning a dock on should land it somewhere recognisable without a second decision.
 */
export const DEFAULT_STATUS_DOCK: StatusDockConfig = {
  enabled: false,
  position: 'bottom-right',
  iconSize: 18,
  gap: 10,
  showClock: true,
  showBattery: true,
  showNetwork: true,
  showVolume: true,
};

export const DEFAULT_SHORTCUT_DOCK: ShortcutDockConfig = {
  enabled: false,
  position: 'bottom-left',
  iconSize: 40,
  gap: 12,
  items: [],
  showLabels: false,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A stored number, or the default.
 *
 * `typeof value !== 'number'` rather than `Number(value)`, and the difference is `null`: it
 * coerces to 0, which is a finite number, which clamps to the MINIMUM — so a config that had lost
 * the key would come back as the smallest dock the slider can show rather than the default one.
 * A number out of range is clamped instead of replaced, because that was a real choice made on a
 * build whose slider reached further.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeDockPosition(value: unknown, fallback: DockPosition): DockPosition {
  return DOCK_POSITIONS.includes(value as DockPosition) ? (value as DockPosition) : fallback;
}

/**
 * A stored blob as the shape the rest of the code may assume.
 *
 * Anything missing takes its DEFAULT rather than a zero: a config written before a switch existed
 * must not read as "the user turned that off", and a dock whose `iconSize` came back as 0 would be
 * enabled, positioned, and invisible — the hardest kind of thing to report.
 */
export function normalizeStatusDock(value: unknown): StatusDockConfig {
  const raw = (value ?? {}) as Partial<StatusDockConfig>;
  return {
    enabled: bool(raw.enabled, DEFAULT_STATUS_DOCK.enabled),
    position: normalizeDockPosition(raw.position, DEFAULT_STATUS_DOCK.position),
    iconSize: clampInt(raw.iconSize, STATUS_DOCK_ICON_MIN, STATUS_DOCK_ICON_MAX, DEFAULT_STATUS_DOCK.iconSize),
    gap: clampInt(raw.gap, DOCK_GAP_MIN, DOCK_GAP_MAX, DEFAULT_STATUS_DOCK.gap),
    showClock: bool(raw.showClock, DEFAULT_STATUS_DOCK.showClock),
    showBattery: bool(raw.showBattery, DEFAULT_STATUS_DOCK.showBattery),
    showNetwork: bool(raw.showNetwork, DEFAULT_STATUS_DOCK.showNetwork),
    showVolume: bool(raw.showVolume, DEFAULT_STATUS_DOCK.showVolume),
  };
}

export function normalizeShortcutDock(value: unknown): ShortcutDockConfig {
  const raw = (value ?? {}) as Partial<ShortcutDockConfig>;
  return {
    enabled: bool(raw.enabled, DEFAULT_SHORTCUT_DOCK.enabled),
    position: normalizeDockPosition(raw.position, DEFAULT_SHORTCUT_DOCK.position),
    iconSize: clampInt(raw.iconSize, SHORTCUT_DOCK_ICON_MIN, SHORTCUT_DOCK_ICON_MAX, DEFAULT_SHORTCUT_DOCK.iconSize),
    gap: clampInt(raw.gap, DOCK_GAP_MIN, DOCK_GAP_MAX, DEFAULT_SHORTCUT_DOCK.gap),
    items: Array.isArray(raw.items) ? raw.items.filter((item) => !!item && typeof item.id === 'string') : [],
    showLabels: bool(raw.showLabels, DEFAULT_SHORTCUT_DOCK.showLabels),
  };
}

/**
 * Whether the status dock would show anything at all.
 *
 * Enabled with all four readouts switched off is a dock with nothing in it, and it has to be
 * recognised as one HERE rather than by the component: this is what decides that the system-status
 * helper is never started, so a dock left on with everything unticked costs what off costs.
 */
export function statusDockIsActive(dock: StatusDockConfig): boolean {
  if (!dock.enabled) return false;
  return dock.showClock || dock.showBattery || dock.showNetwork || dock.showVolume;
}

/** The readouts that need the helper. A clock-only dock is drawn from `Date` and costs no process. */
export function statusDockNeedsHelper(dock: StatusDockConfig): boolean {
  if (!dock.enabled) return false;
  return dock.showBattery || dock.showNetwork || dock.showVolume;
}

export function shortcutDockIsActive(dock: ShortcutDockConfig): boolean {
  return dock.enabled && dock.items.length > 0;
}

/**
 * Whether a dock forces the overlay window out to the screen edges.
 *
 * The wheel normally opens in a box around itself rather than over the screen (see
 * `radialModeBounds` in the main process). A dock placed in that box does not sit in the corner of
 * anything the user can see — it floats a couple of hundred pixels off the wheel on a diagonal.
 * Exactly the reason the corner gear asks for the same thing.
 *
 * "The screen" is the work area, not the monitor: the window stops at the taskbar, so a dock in a
 * bottom region lands just above it rather than on top of it (`backend/full-bleed-bounds.cjs`).
 */
export function docksNeedFullBleed(status: StatusDockConfig, shortcuts: ShortcutDockConfig): boolean {
  return statusDockIsActive(status) || shortcutDockIsActive(shortcuts);
}

/**
 * Which regions are taken, so a third thing placed in one of them can step out of the way.
 *
 * Only docks with something to draw count: a dock that is on but empty occupies nothing, and the
 * settings gear dodging an invisible strip would leave a hole no one can explain.
 */
export function occupiedDockPositions(
  status: StatusDockConfig,
  shortcuts: ShortcutDockConfig,
): Set<DockPosition> {
  const taken = new Set<DockPosition>();
  if (statusDockIsActive(status)) taken.add(status.position);
  if (shortcutDockIsActive(shortcuts)) taken.add(shortcuts.position);
  return taken;
}

/** Human names for the six regions, used by the settings select and nowhere else. */
export const DOCK_POSITION_LABELS: Record<DockPosition, string> = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
};
