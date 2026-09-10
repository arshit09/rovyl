import React, { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Coordinates, AppItem, UIConfig, Workspace } from '../types';
import { getIcon } from '../iconMap';
import { CornerUpLeft } from 'lucide-react';
import { SmartIcon } from './SmartIcon';
import { RovylLogo } from './RovylLogo';
import { uiString } from '../strings';
import { RadialHud } from './RadialHud';
import {
  filterRadialApps,
  getRootRadialApps,
  isWorkspacePickItem,
  parseWorkspacePickIndex,
} from '../utils/workspaceRadial';
import { clampDwellMs, directionCommitPx } from '../constants/radialDwell';

// PERF FIX #3: Module-level weather cache — persists across menu open/close cycles
// Prevents a new HTTP fetch on every menu open; refreshes only after 10 minutes or location change
const weatherCache: { data: { temp: number; condition: string } | null; lastFetch: number; location: string } = {
  data: null, lastFetch: 0, location: ''
};
const WEATHER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Subset of the Battery API — avoids `BatteryManager` when the local TS/DOM does not expose it. */
type ZenithBattery = {
  level: number;
  addEventListener(type: 'levelchange', listener: () => void): void;
  removeEventListener(type: 'levelchange', listener: () => void): void;
};

// Helper to extract a normalized path from a command string for deduplication
const normalizePathForDedup = (item: any): string => {
  if (!item) return '';
  // NEVER use item.description as it might be "Quick Access Folder" or "Application"
  let pathStr = item.command || '';
  
  // 1. Handle commands with multiple arguments (e.g. "exe" "path" or code "path")
  // We want the LAST argument which is usually the file/folder path
  const allQuotes = [...pathStr.matchAll(/"([^"]+)"/g)];
  if (allQuotes.length > 0) {
    // If multiple quotes, take the last one (the folder path)
    // If one quote and it's an IDE command, take that quote
    pathStr = allQuotes[allQuotes.length - 1][1];
  } else {
    // No quotes, handle unquoted IDE prefixes (e.g., code C:\Path)
    const lower = pathStr.toLowerCase();
    const ideCommands = ['antigravity', 'cursor', 'code', 'vs code', 'vscode', 'code.exe', 'cursor.exe', 'antigravity.exe'];
    for (const cmd of ideCommands) {
      if (lower.startsWith(cmd + ' ')) {
        pathStr = pathStr.substring(cmd.length + 1).trim();
        break;
      }
    }
  }
  
  // 3. Absolute Normalization
  // - Lowercase for case-insensitivity
  // - Replace all backslashes with forward slashes
  // - Trim any trailing slashes or spaces
  // - Ensure drive letter is consistent (c: vs C:)
  let normalized = pathStr
    .toLowerCase()
    .trim()
    .replace(/[\\/]+/g, '/')     // Multiple slashes to single forward slash
    .replace(/\/+$/, '')         // Remove trailing slashes
    .replace(/^(['"]+)|(['"]+)$/g, ''); // Remove wrapping quotes if they managed to survive
    
  // Handle Windows Drive Letter consistency (e.g., c:/path -> c:/path)
  // We keep it lowercase as we already called .toLowerCase()
  if (/^[a-z]:/.test(normalized)) {
    // Already lowercased, just return
    return normalized;
  }
  
  return normalized;
};

/**
 * The root level is rebuilt (a new array) every time the sync effect runs — in `picker` mode the
 * items are synthetic. Swapping the list for an equivalent one re-renders the whole wheel and, now
 * that opening is a CSS transition tied to the level's identity, would make the wheel "reborn".
 */
function sameRadialLevel(a: AppItem[], b: AppItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.id === b[i].id && item.label === b[i].label);
}

/** When "recent folders" is enabled but MRU fetch is empty or fails, show one explicit slice — never auto-launch the parent IDE. */
function buildRecentsEmptyFallback(parent: AppItem): AppItem[] {
  return [
    {
      id: `${parent.id}__recents-empty-fallback`,
      label: uiString('menu.recents_fallback'),
      command: parent.command,
      commandType: parent.commandType || 'app',
      iconName: parent.iconName || 'AppWindow',
      iconSource: parent.iconSource || 'lucide',
      customIconUrl: parent.customIconUrl,
      description: parent.label,
    },
  ];
}

/** Parent IDE setting: MRU slices open a terminal cwd'd to the project path (see executeCommand + IDE branch). */
function applyOpenTerminalForRecents(recents: AppItem[], parent: AppItem): AppItem[] {
  const commands = (parent.terminalCommands || []).filter((command) => command.trim().length > 0);
  if (!parent.openTerminalForRecents && commands.length === 0) return recents;
  return recents.map((recent) => ({
    ...recent,
    openTerminal: parent.openTerminalForRecents || commands.length > 0,
    terminalCommands: commands.length > 0 ? commands : recent.terminalCommands,
    launchMode: parent.launchMode,
  }));
}

/**
 * Wheel calibration. Pulled out to module scope because the licence gate paints the SAME wheel
 * (locked): radius, tile size and breathing room have to come from here, never from parallel
 * constants.
 */
export function computeRadialLayout({
  numberOfApps,
  iconSizePx,
  minGap,
  menuRadius,
  activationThreshold,
  viewportSize,
}: {
  numberOfApps: number;
  iconSizePx: number;
  minGap: number;
  menuRadius: number;
  activationThreshold?: number;
  viewportSize: { width: number; height: number };
}): { actualMenuRadius: number; actualIconSize: number } {
  // Allow the menu to occupy up to 52% of the smallest screen dimension (Phase 3)
  const maxScreenRadius = Math.min(viewportSize.width, viewportSize.height) * 0.52;
  const sinHalfSlice = numberOfApps > 1 ? Math.sin(Math.PI / numberOfApps) : 0;

  // Icon size ramps continuously with the item count rather than stepping at
  // 4 and 6 items: a sparse wheel reads better slightly compact, a dense one
  // wants the configured size, and adding one app should not resize the rest.
  const density = Math.max(0, Math.min(1, (numberOfApps - 3) / 6));
  let currentIconSize = Math.round(iconSizePx * (0.82 + 0.18 * density));

  // The ring grows only as fast as the icons need to keep a constant edge gap
  // between neighbours.
  const neighbourGap = minGap + 14;
  const packedRadius = (size: number) =>
    numberOfApps > 1 ? (size + neighbourGap) / 2 / sinHalfSlice : 0;

  // Floor: clear of the central hub, clear of the centre dead zone that
  // cancels selection, and scaled by the saved radius.
  const radiusScale = (menuRadius + minGap) / 150;
  const floorRadius = (size: number) =>
    Math.max(
      size * 1.1 + minGap + 12,                // hub is size * 1.2 wide
      (activationThreshold ?? 60) + size / 2 + 8, // stay outside the dead zone
      92,
    ) * radiusScale;

  let targetRadius = Math.max(floorRadius(currentIconSize), packedRadius(currentIconSize));

  // If the ring outgrows the screen, shrink the icons instead of overlapping.
  if (targetRadius > maxScreenRadius && numberOfApps > 1) {
    const possibleScale = (2 * maxScreenRadius * sinHalfSlice - neighbourGap) / currentIconSize;
    const scaleFactor = Math.max(0.5, Math.min(1.0, possibleScale));
    currentIconSize = Math.round(currentIconSize * scaleFactor);
    targetRadius = Math.max(floorRadius(currentIconSize), packedRadius(currentIconSize));
  }

  return { actualMenuRadius: targetRadius, actualIconSize: currentIconSize };
}

/**
 * Radial scrim: a radial pool in smoothstep across 9 stops (2 stops that wide band at 8-bit, and
 * banding reads as blur). Shared with the licence gate.
 */
export function radialScrimGradient(
  position: { x: number; y: number },
  backdropOpacity: number,
  backdropRadius: number,
): string {
  const scrimPeak = 0.22 + backdropOpacity * 0.3;
  const scrimRadius = Math.round(backdropRadius * 2);
  const stops = [0, 0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1]
    .map((t) => {
      const falloff = 1 - (3 * t * t - 2 * t * t * t);
      return `rgba(4,5,7,${(scrimPeak * falloff).toFixed(3)}) ${Math.round(t * scrimRadius)}px`;
    })
    .join(', ');
  return `radial-gradient(circle at ${Math.round(position.x)}px ${Math.round(position.y)}px, ${stops})`;
}

interface RadialMenuProps {
  /**
   * Whether the Start Menu scan is still to come. An empty wheel is otherwise indistinguishable
   * from one that has lost its shortcuts, and at login the scan is deferred twenty seconds.
   */
  discoveryPhase?: 'idle' | 'waiting' | 'scanning';
  isOpen: boolean;
  position: Coordinates;
  viewportSize: { width: number; height: number };
  /** Pass `selectedApp` when launching an item that may not exist in saved config (e.g. MRU `recent-*` ids). */
  onClose: (selectedId: string | null, selectedApp?: AppItem | null) => void;
  apps: AppItem[];
  config: UIConfig;
  triggerSource?: 'mmb' | 'mmb-click' | 'shortcut';
  onWorkspaceSwitch?: (workspaceIndex: number) => void;
  currentWorkspace?: Workspace;
  /** False while the hidden HWND takes its first transparent paint. */
  animationReady?: boolean;
  /** Update downloaded and waiting on a restart — badge on the hub. */
  updateReady?: boolean;
  /**
   * The direction-mode hint has been read: fires once, ever, on the way out of an open that showed
   * it. Deferred to the close on purpose — spending the flag with the wheel still up would pull the
   * hint off screen mid-sentence, punishing the one person it was written for.
   */
  onDirectionHintSeen?: () => void;
}

/**
 * Launching without a click ("dwell aim"): holding on a target for `dwellMs` launches it.
 *
 * The arming delay counts from the wheel's FIRST PAINT, not from `openingTimeRef`. That one is
 * written inside `openMenu`'s `flushSync`, before main reveals the HWND — and the reveal has a
 * 120ms fallback (240ms when restoring from minimised). Measured from there, the delay could
 * expire with the wheel still invisible and every tile still `pointer-events: none`: the user got
 * a launch before seeing anything at all.
 *
 * `INSTANT_ARM_DISPLACEMENT_PX` is displacement OBSERVED from a reference set by an earlier
 * `mousemove` — never `hasMoved`, which measures distance to the wheel's CENTRE and is therefore
 * already true as soon as the pointer sits still far from the centre, which is the dangerous case.
 */
const INSTANT_ARM_DELAY_MS = 120;
const INSTANT_ARM_DISPLACEMENT_PX = 24;
/** Absorbs the reflex click that lands right after a dwell launch. */
const INSTANT_QUARANTINE_MS = 300;
/**
 * How long the direction-mode hint has to stay on screen before it counts as read.
 *
 * The hint leaves the moment the hand moves, so an open that began with the mouse already in
 * motion flashes it for a frame or two. Without this floor that flash would spend the single
 * showing, and the person who never got to read it is exactly the person who needed it.
 */
const DIRECTION_HINT_SEEN_MS = 900;
/**
 * Settle before counting.
 *
 * Without this the timer measured "how long have I been in this wedge", not "how long have I been
 * held on a target" — and in angle mode a wedge has no distance limit. On a level with ONE item
 * the wedge is the whole plane: crossing the dead zone started the clock and 400ms later it
 * launched, whatever the pointer did on the way.
 *
 * The count only starts once the pointer stays within `DWELL_SETTLE_PX` for `DWELL_SETTLE_MS`.
 * While it moves, what gets rescheduled is this `setTimeout` — there is no React commit per frame,
 * which is what resetting the arc directly would cost.
 */
const DWELL_SETTLE_PX = 10;
const DWELL_SETTLE_MS = 90;
/**
 * Once counting, the tolerance is a different one — and larger. The two phases measure different
 * things: settling asks "has the hand stopped?", counting asks "is the hand still on this target?".
 * With a single radius, and one still measured from the last MOVING sample, a 1.1s count inherited
 * an almost spent budget and a slow drag got stuck in a loop — the arc appearing and dying without
 * ever opening.
 */
const DWELL_HOLD_PX = 26;
/**
 * Below this the arc is not information, it is a flash: it would appear and die within the same
 * pair of frames. With the optional wait (0ms) that became a REAL case and not a theoretical one,
 * so a short count runs without drawing anything — the feedback for that choice is the app itself
 * opening.
 */
const DWELL_ARC_MIN_MS = 90;
/**
 * Direction aiming — the mode the clickless launch lives in.
 *
 * The pointer is hidden and parked at the wheel's centre, so the slice comes from the VECTOR the
 * hand drew from there, not from the position the cursor happened to already be at. The vector is
 * accumulated from the deltas of each `mousemove`, which makes it immune to the starting point —
 * which was exactly the defect: opening the wheel with the mouse low lit the bottom item on the
 * first tremor, and dwell aim launched it without anyone having chosen anything.
 *
 * The vector is clamped to a multiple of the sensitivity because this is a DIRECTION, not a
 * position: with no ceiling, turning from top to bottom after a wide gesture meant undoing the
 * whole path. With a ceiling, reversing always costs roughly the same.
 *
 * The factor is not free: what is left above the threshold (1.5x it) is the slack that separates
 * "committed" from "back at the centre", and it has to be larger than `DWELL_HOLD_PX` -- otherwise
 * a tremor that dwell aim still accepts as a still hand already undid the direction, and the arc
 * died on its own.
 */
const DIRECTION_CLAMP_FACTOR = 2.5;
/**
 * The parking `SetCursorPos` reaches the DOM as an ordinary `mousemove` — and as a jump of
 * hundreds of pixels, which added to the vector would point opposite to the gesture. While a
 * parking is pending, the sample that lands at the centre (or that jumps further than a hand can
 * in one event) is the teleport's: it becomes the new reference and its delta is thrown away.
 */
const PARK_LANDING_PX = 28;
const PARK_JUMP_PX = 120;
/** No landing at all — Windows without the helper, another system — and the gesture goes back to normal. */
const PARK_TIMEOUT_MS = 400;
/** Slack to the window edge; past this a re-park is requested before the cursor leaves (and reappears). */
const PARK_STRAY_MARGIN_PX = 140;

/**
 * Launch echo — the only window in which the user sees what they chose.
 *
 * Confirming was a CUT: the wheel vanished on the same frame the command was dispatched, and what
 * followed was the bare desktop for as long as the app took to open — half a second on a warm app,
 * several on a cold one. Nothing in that gap said which of the icons had been caught, or even that
 * any had: a successful launch and a click that hit nothing were, to the eye, the same event.
 *
 * The echo holds the confirmed icon where it already was, fades everything else around it and
 * sends a wave out of it. That is why the delay PRECEDES the dispatch rather than running over it:
 * the radial window is `alwaysOnTop` and the app that opens steals the foreground — animating
 * afterwards left the wave competing with the new window, or hidden behind it.
 *
 * The cost is real and it is this number: the command leaves `LAUNCH_ECHO_MS` later. It is kept
 * short on purpose — long enough for the eye to register WHICH icon, short enough not to read as
 * the launcher being slow.
 */
const LAUNCH_ECHO_MS = 520;
/** `performanceMode` shortens everything else on the wheel; the echo follows the same rule. */
const LAUNCH_ECHO_FAST_MS = 340;

interface RadialMenuItemProps {
  app: AppItem;
  index: number;
  isActive: boolean;
  /** Circular distance in slices from the aimed one; `null` while nothing is aimed. */
  angularDistance: number | null;
  actualMenuRadius: number;
  actualIconSize: number;
  totalApps: number;
  /** Narrow style props so parent config identity does not bust memo for every App re-render. */
  backdropOpacity: number;
  hoverColor: string;
  showLabels: boolean;
  alwaysShowAppLabels: boolean;
  folderStackLength: number;
  /** `false` keeps the slice collapsed at the hub — the frame before the bloom and the whole closed state. */
  bloom: boolean;
  /** Small chip inside the label pill (workspace number, "recents"…). Omitted when the slice has no hint. */
  shortcutHint?: string;
  /**
   * Duration of the dwell aim arc. Set ONLY on the tile whose timer is running — `undefined` on
   * every other one, so their `React.memo` is not invalidated on each dwell.
   */
  dwellMs?: number;
  /** Attempt id. Changing it remounts the `<svg>`, and that is what restarts the CSS animation. */
  dwellKey?: number;
  /**
   * This slice's role in the launch echo: `fired` is the confirmed one (it stays, pulses and emits
   * the wave), `faded` is all the others (they leave at once). `undefined` outside the echo — and
   * that is how the whole wheel's `React.memo` stays intact in normal life.
   */
  echo?: 'fired' | 'faded';
  /** Echo duration, so the CSS animations track the timer that dispatches the command. */
  echoMs?: number;
  onClick: (app: AppItem) => void;
}

/**
 * Labels sit OUTSIDE the wheel, on the side the slice points to, so a dense wheel never
 * stacks a pill over the neighbouring icon (the old below-the-icon placement did).
 */
export function getLabelPlacement(angleDeg: number, iconSize: number) {
  const rad = angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const edge = iconSize / 2 + 10;

  if (cos > 0.35) return { x: edge, y: 0, originX: '0%', originY: '-50%' };
  if (cos < -0.35) return { x: -edge, y: 0, originX: '-100%', originY: '-50%' };
  if (sin < 0) return { x: 0, y: -edge, originX: '-50%', originY: '-100%' };
  return { x: 0, y: edge, originX: '-50%', originY: '0%' };
}

/**
 * Binary highlight: the aimed slice lights up and every other one looks the same as the rest.
 * Varying presence by angular distance made the neighbours look partly selected.
 *
 * Container opacity is NOT the "not selected" channel. Each slice carries its own background, and
 * alpha multiplies that background too: at 0.5 the tile stopped being an object and became a
 * smudge over the desktop — worse still with a monochrome icon (workspaces) and a light wallpaper,
 * where the white glyph at half alpha disappeared. Here opacity only gives the minimum remove;
 * selection reads through colour, ring and scale, which are signals that do not destroy the
 * contrast of what sits underneath.
 */
function getSlicePresence(distance: number | null) {
  if (distance === null) return { opacity: 0.96, scale: 1 };
  if (distance === 0) return { opacity: 1, scale: 1.06 };
  return { opacity: 0.9, scale: 1 };
}

/**
 * The scale the confirmed slice STAYS at during the launch echo — the same as the aimed slice, not
 * a new value. Confirming by aim already had it there: changing the number would make the slice
 * take a sideways step at the very moment the user is reading it. Only someone confirming by
 * clicking a tile that was not aimed sees movement here, and there the small jump is the response
 * to the click itself.
 */
const FIRED_SLICE_SCALE = 1.06;

/**
 * Snaps a value to the monitor's PHYSICAL pixel grid. The wheel positions each slice by
 * trigonometry, which produces fractional coordinates (`84.0, 48.5`). A tile has three 1px
 * outlines — light border, dark outer ring and inner light — and on a half pixel each of them is
 * spread across two physical pixels with different alphas: that is what reads as a "hand-drawn"
 * edge, with burrs and uneven dots. With Windows scaling at 125/150% the error is not even half a
 * CSS pixel, so rounding is not enough — it has to be divided by the `devicePixelRatio`.
 */
/**
 * Rounded rectangle that STARTS at the top, centred.
 *
 * A `<rect>`'s implicit path begins at the end of the top-left arc, that is, offset to the right
 * by the corner radius — the progress ring started filling at an arbitrary point on the top edge,
 * and the offset changed with the icon size because the radius changes too. A clock that does not
 * start at twelve reads as a bug.
 */
export function roundedRectPathFromTop(size: number, inset: number, radius: number): string {
  const near = inset;
  const far = size - inset;
  const mid = size / 2;
  const r = Math.max(0, Math.min(radius, (far - near) / 2));
  return [
    `M ${mid} ${near}`,
    `L ${far - r} ${near}`,
    `A ${r} ${r} 0 0 1 ${far} ${near + r}`,
    `L ${far} ${far - r}`,
    `A ${r} ${r} 0 0 1 ${far - r} ${far}`,
    `L ${near + r} ${far}`,
    `A ${r} ${r} 0 0 1 ${near} ${far - r}`,
    `L ${near} ${near + r}`,
    `A ${r} ${r} 0 0 1 ${near + r} ${near}`,
    'Z',
  ].join(' ');
}

export function snapToDevicePixel(value: number): number {
  const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.round(value * ratio) / ratio;
}

/** Keeps icons and labels readable when the user picks a light or dark hover. */
function getReadableForeground(background: string): '#000000' | '#FFFFFF' {
  const hex = background.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#000000';
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.56 ? '#000000' : '#FFFFFF';
}

function normalizeHoverColor(value?: string): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value!.toUpperCase() : '#FFFFFF';
}

const RadialMenuItem = React.memo(({
  app,
  index,
  isActive,
  angularDistance,
  actualMenuRadius,
  actualIconSize,
  totalApps,
  backdropOpacity,
  hoverColor,
  showLabels,
  alwaysShowAppLabels,
  folderStackLength,
  bloom,
  shortcutHint,
  dwellMs,
  dwellKey,
  echo,
  echoMs,
  onClick,
}: RadialMenuItemProps) => {
  const Icon = getIcon(app.iconName);
  const [remoteIconFailed, setRemoteIconFailed] = React.useState(false);
  React.useEffect(() => {
    setRemoteIconFailed(false);
  }, [app.customIconUrl]);
  const sliceAngle = 360 / totalApps;
  const angleDeg = (index * sliceAngle) - 90;
  const angleRad = angleDeg * (Math.PI / 180);
  const pos = {
    x: actualMenuRadius * Math.cos(angleRad),
    y: actualMenuRadius * Math.sin(angleRad),
  };

  // PERF FIX #2: useMemo instead of IIFE so this only recomputes when app.command/label/iconSource change
  const shouldUseCustomIcon = React.useMemo(() => {
    const LUCIDE_ICON_EXCEPTIONS = [
      'Microsoft.WindowsTerminal',
      'WindowsTerminal',
      'Terminal',
      'cmd.exe',
      'powershell.exe'
    ];
    const isException = LUCIDE_ICON_EXCEPTIONS.some(exception =>
      app.command?.toLowerCase().includes(exception.toLowerCase()) ||
      app.label?.toLowerCase().includes(exception.toLowerCase())
    );
    if (isException) return false;
    return app.iconSource === 'native' && !!app.customIconUrl;
  }, [app.command, app.label, app.iconSource, app.customIconUrl]);

  const labelPlacement = React.useMemo(
    () => getLabelPlacement(angleDeg, actualIconSize),
    [angleDeg, actualIconSize],
  );

  const hasRasterIcon = Boolean(app.customIconUrl) && !remoteIconFailed;
  /**
   * Unresolved icon: native item, with a command, but still without an image. It happens right
   * after a restore or the first discovery, while PowerShell extracts the icons — and a generic
   * glyph at that moment looks like a wrong icon, not a missing one.
   */
  const iconPending = app.iconSource === 'native' && !app.customIconUrl && Boolean(app.command);
  /**
   * The indicator has a deadline. An icon that will never resolve — invalid target, uninstalled
   * app — left the slice spinning indefinitely, and an endless wait reads worse than a generic
   * icon. After 10 seconds the glyph is shown and the slice becomes usable.
   */
  const [pendingExpired, setPendingExpired] = React.useState(false);
  React.useEffect(() => {
    if (!iconPending) {
      setPendingExpired(false);
      return;
    }
    const timer = window.setTimeout(() => setPendingExpired(true), 10000);
    return () => window.clearTimeout(timer);
  }, [iconPending, app.command]);
  const presence = getSlicePresence(angularDistance);
  const activeForeground = getReadableForeground(hoverColor);
  /**
   * Ring concentric with the tile. What has to be concentric is the stroke's CENTRE LINE, not its
   * outer edge: the rectangle is inset 1.25 on each side (half of the 2.5 stroke), so the centre
   * line runs 5.75px outside the tile and the right radius is 18 + 5.75, not 18 + 7.
   * The clamp is also measured against the rectangle's REAL side — against the SVG's box, an icon
   * at the minimum fell into the browser's silent clipping, which is exactly what this clamp avoids.
   */
  const dwellRingSize = actualIconSize + 14;
  const dwellRingInset = (dwellRingSize - actualIconSize) / 2 - 1.25;
  const dwellRingRadius = Math.min(18 + dwellRingInset, (dwellRingSize - 2.5) / 2);
  const dwellRingPath = roundedRectPathFromTop(dwellRingSize, 1.25, dwellRingRadius);

  /**
   * The wave is born with the TILE's shape, not as a circle: it comes out of the silhouette of the
   * icon the user just aimed at, and it is that continuity that makes it read as "this came from
   * here" rather than an effect pasted on top. As it scales, the `border-radius` scales with it and
   * the shape opens into an ever rounder square — which is exactly the intended reading.
   *
   * Scale and opacity and nothing else: the only two attributes the compositor animates without
   * touching the main thread, which is where the app being launched is already competing for time.
   */
  const fired = echo === 'fired';
  const waveSize = actualIconSize + 6;
  const waveRadius = 21;

  return (
    <div
      /**
       * The wrapper NEVER takes clicks. Its layout box sits at the origin of the slice's point and
       * grows right and down, while the tile is PAINTED centred on that point (the
       * `-translate-*-1/2` is transform, not layout). The box ends up half a tile out of place, and
       * the top-left slice's box even reaches into the wheel's centre — clicking the hub's top-left
       * corner landed on it, always the same one, and launched it. What takes the click is now the
       * tile, whose hit area follows the transform and therefore matches the paint.
       */
      className={`zn-radial-slice absolute top-0 left-0 pointer-events-none${
        echo ? ` zn-radial-slice--${echo}` : ''
      }`}
      style={{
        /* One transform per slice: position + presence. Hover only swaps this value. */
        ['--zn-tf' as string]: bloom
          ? `translate3d(${snapToDevicePixel(pos.x)}px, ${snapToDevicePixel(pos.y)}px, 0) scale(${
              /**
               * The confirmed one stays FIXED at the point it was already at — moving it would ask
               * the eye to follow it at the exact moment it has to identify it. The others shrink a
               * little on the way out, so their exit reads as a retreat and not as a fade-out.
               */
              fired
                ? FIRED_SLICE_SCALE
                : echo === 'faded'
                  ? presence.scale * 0.88
                  : presence.scale
            })`
          : 'translate3d(0px, 0px, 0) scale(0.2)',
        /**
         * The confirmed one stays at 1 and it is the inner animation that fades it, so its exit is
         * not confused with the others' — the whole echo exists to separate them.
         */
        ['--zn-op' as string]: fired ? 1 : echo === 'faded' ? 0 : bloom ? presence.opacity : 0,
        ...(echoMs ? { ['--zn-echo-ms' as string]: `${echoMs}ms` } : null),
        /** The confirmed one above everything: its wave crosses where the neighbours sit. */
        zIndex: fired ? 300 : isActive ? 200 : 100,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(app);
      }}
    >
      <div className="relative flex items-center justify-center -translate-x-1/2 -translate-y-1/2">
        {/*
          Dwell aim arc. It only appears in `startDwell`, from an aim RESOLVED AGAIN at that
          instant, and both `startDwell` and `fireDwell` revalidate the triple `{level, index, id}`
          — one before drawing, the other before opening. That is why what the ring shows and what
          will launch cannot diverge: lighting one icon and opening another is what the comment on
          `resolveAimAtPoint` calls the worst possible defect in a launcher.

          `pathLength={1}` normalises the perimeter: the stroke animates from 1 to 0 with no
          arithmetic at all over the path's real length, which changes with the icon size.
        */}
        {dwellMs != null && (
          <svg
            key={dwellKey}
            /**
             * `z-10`, below the tile. The ring runs entirely OUTSIDE the tile's square, so none of
             * it is lost — and above it would cut across the folder badge, which lives at `z-30`
             * inside the wrapper and is larger than the gap between the tile and the ring.
             */
            className="absolute pointer-events-none z-10"
            /**
             * Explicit centring. An absolute child of a flex container inherits its static position
             * from the flex alignment, which would already centre it — but relying on that leaves
             * the ring half a tile away if someone swaps `justify-center` for something else.
             */
            style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
            width={dwellRingSize}
            height={dwellRingSize}
            viewBox={`0 0 ${dwellRingSize} ${dwellRingSize}`}
            shapeRendering="geometricPrecision"
            aria-hidden
          >
            {/*
              Three layers, for the same reason the tile has a double outline: the ring runs
              OUTSIDE the tile's opaque plate, so what sits behind it is the scrim and, through it,
              a wallpaper we do not control. On its own, white at 18% does not read over a light
              background — and an invisible progress ring is the only thing warning that something
              is about to open by itself.

              An OPAQUE dark wrapper underneath (the same role as the tile's
              `0 0 0 1px rgba(0,0,0,.5)`), then the track, then the arc. The track can be
              translucent because it already has the wrapper beneath it — alpha is not doing duty
              as the de-emphasis channel.
            */}
            <path
              d={dwellRingPath}
              fill="none"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={4.5}
            />
            <path
              d={dwellRingPath}
              fill="none"
              stroke="rgba(255,255,255,0.30)"
              strokeWidth={2.5}
            />
            <path
              className="zn-dwell-arc"
              d={dwellRingPath}
              fill="none"
              stroke={hoverColor}
              strokeWidth={2.5}
              pathLength={1}
              style={{ ['--zn-dwell-ms' as string]: `${dwellMs}ms` }}
            />
          </svg>
        )}

        {/*
          Launch wave. Two offset rings, not one: a single ring reads as an outline that grew, two
          read as something that CAME OUT of the icon. The second leaves halfway through the first,
          which is the gap in which the eye is still following the first and gets the impression of
          continuity rather than repetition.

          `z-0`, below the tile: the wave passes behind the icon and comes out around it. Above it,
          each ring cut across the icon's plate on its way through — and the icon is the only thing
          this whole moment exists to show.
        */}
        {fired && (
          <>
            <span
              className="zn-launch-wave absolute pointer-events-none z-0"
              style={{
                left: '50%',
                top: '50%',
                width: `${waveSize}px`,
                height: `${waveSize}px`,
                borderRadius: `${waveRadius}px`,
                border: `2px solid ${hoverColor}`,
              }}
              aria-hidden
            />
            <span
              className="zn-launch-wave zn-launch-wave--late absolute pointer-events-none z-0"
              style={{
                left: '50%',
                top: '50%',
                width: `${waveSize}px`,
                height: `${waveSize}px`,
                borderRadius: `${waveRadius}px`,
                border: `2px solid ${hoverColor}`,
              }}
              aria-hidden
            />
          </>
        )}

        {/* WRAPPER FOR BADGE & MASKED CONTENT */}
        <div
          className={`relative z-20 ${fired ? 'zn-launch-pop ' : ''}${bloom ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none cursor-default'}`}
          style={{
            width: `${actualIconSize}px`,
            height: `${actualIconSize}px`,
          }}
        >
          {/* INNER MASKED CONTAINER (Overflow Hidden) */}
          <div
            /**
             * `overflow-hidden` turns on a rounded mask, and Chromium antialiases masks worse than
             * borders — the corners come out jagged over a transparent window. The mask only exists
             * to clip raster icons, so it is only turned on when there is one.
             */
            className={`w-full h-full rounded-[18px] flex items-center justify-center transition-[background-color,border-color,box-shadow] duration-150 relative ${hasRasterIcon ? 'overflow-hidden' : ''}`}
            style={{
              /**
               * The tile has to hold up on its own over a desktop we do not control: the background
               * is almost opaque and the idle border is strong enough to cut it out without
               * depending on the global scrim or on the wallpaper's contrast.
               */
              /**
               * FULLY opaque background. The window is `transparent: true`: with alpha < 1 every
               * pixel is premultiplied and requantised to 8 bits as Windows composites it. On the
               * straight sides coverage is 0% or 100% and the error does not exist; on the curve
               * the pixels have partial coverage and the rounding falls now up, now down — the line
               * comes out uneven, with some dots lighter and others disappearing. At 0.985 the
               * visual difference from opaque is nil, but the cost on the edge is not.
               */
              backgroundColor: isActive
                ? hoverColor
                : `rgb(${12 + Math.round(backdropOpacity * 10)}, ${12 + Math.round(backdropOpacity * 10)}, ${12 + Math.round(backdropOpacity * 10)})`,
              border: isActive ? `1px solid ${hoverColor}` : `1px solid rgba(255,255,255,${0.28 + backdropOpacity * 0.08})`,
              color: isActive ? activeForeground : '#fff',
              /**
               * Double outline: light border on the inside + a dark 1px ring on the outside.
               * The tile separates itself from the desktop — on a light background the ring reads,
               * on a dark one the border does — without depending on the global scrim.
               */
              /* `inset` at the top = a single light source for the whole wheel: the tiles read as objects. */
              boxShadow: isActive
                ? `0 0 0 1px rgba(0,0,0,0.45), 0 0 0 5px ${hoverColor}24, 0 12px 28px rgba(0,0,0,0.5)`
                : 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(0,0,0,0.5), 0 8px 22px rgba(0,0,0,0.42)',
            }}
          >
            {/* Icon Container: Show either native icon OR vector icon, not both */}
            <div className="w-full h-full flex items-center justify-center relative">
              {app.customIconUrl && !remoteIconFailed ? (
                /* Native / remote favicon */
                <SmartIcon
                  src={app.customIconUrl!}
                  alt={app.label}
                  className="object-contain relative z-10"
                  size={actualIconSize}
                  referenceScale={0.88}
                  onError={() => setRemoteIconFailed(true)}
                />
              ) : (
                /* Vector Icon (Only when no custom icon) */
                /**
                 * A monochrome glyph (workspaces, shortcuts without a native icon) has no colour of
                 * its own holding it up: legibility comes entirely from the stroke, so it is
                 * thicker than an app icon's, which arrives with its own shape and colour.
                 */
                <Icon size={Math.round(actualIconSize * 0.55)} strokeWidth={1.75} />
              )}

              {/* A wait is said with an indicator, not with an icon that is not the app's. */}
              {iconPending && !pendingExpired && !hasRasterIcon && (
                <span
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: 'rgba(6,7,9,0.72)' }}
                  aria-label="Fetching icon"
                >
                  <span
                    className="rounded-full border-2 border-white/15 border-t-white/70 animate-spin"
                    style={{
                      width: Math.round(actualIconSize * 0.3),
                      height: Math.round(actualIconSize * 0.3),
                    }}
                  />
                </span>
              )}
            </div>
          </div>

          {/* FOLDER BADGE (Outside Mask, Inside Wrapper) */}
          {app.type === 'folder' && (
            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center border-2 border-[#1A1A1A] z-30 shadow-md">
              <div className="w-1 h-1 bg-black rounded-full" />
              <div className="w-1 h-1 bg-black rounded-full ml-0.5" />
            </div>
          )}
        </div>

        {showLabels && (
          <div
            /**
             * The confirmed slice's label leaves WITH the icon, not before or after: during the
             * echo it is the only thing that says in writing what was launched, and the whole slice
             * is no longer fading (`--zn-op` stays at 1), so without this it would hang around
             * until the window disappeared.
             */
            className={`zn-radial-label absolute pointer-events-none z-30${fired ? ' zn-launch-fade' : ''}`}
            style={{
              left: '50%',
              top: '50%',
              /* Anchor (it sits outside the wheel) + offset + scale in a single transform. */
              ['--zn-tf' as string]:
                `translate(${labelPlacement.originX}, ${labelPlacement.originY})` +
                ` translate3d(${snapToDevicePixel(labelPlacement.x)}px, ${snapToDevicePixel(labelPlacement.y)}px, 0)` +
                ` scale(${alwaysShowAppLabels ? (isActive ? 1 : 0.94) : (isActive ? 1 : 0.9)})`,
              /** The label has its own plate too: dimming it to 0.72 faded the text, not the highlight. */
              ['--zn-op' as string]: alwaysShowAppLabels
                ? (isActive ? 1 : 0.9)
                : (isActive ? 1 : 0),
            }}
          >
            <div
              className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full whitespace-nowrap"
              style={{
                background: isActive ? hoverColor : 'rgba(6,7,9,0.95)',
                border: `1px solid ${isActive ? hoverColor : 'rgba(255,255,255,0.2)'}`,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.45), 0 6px 18px rgba(0,0,0,0.45)',
                paddingRight: shortcutHint ? undefined : '0.75rem',
              }}
            >
              <span
                className="text-[12px] leading-none"
                style={{
                  color: isActive ? activeForeground : 'rgba(255,255,255,0.7)',
                  fontFamily: 'var(--font-radial)',
                  fontWeight: 500,
                  letterSpacing: '-0.005em',
                }}
              >
                {app.label}
              </span>
              {shortcutHint && (
                <span
                  className="text-[10px] leading-none px-1.5 py-1 rounded-[5px]"
                  style={{
                    color: isActive ? activeForeground : 'rgba(255,255,255,0.5)',
                    background: isActive
                      ? (activeForeground === '#000000' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.14)')
                      : 'rgba(255,255,255,0.10)',
                  }}
                >
                  {shortcutHint}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

const RadialMenuInner: React.FC<RadialMenuProps> = ({
  isOpen,
  position,
  viewportSize,
  /**
   * The RAW `onClose`: it closes the wheel and launches, with no echo at all. Everything else in
   * the file calls the wrapped `onClose` defined further down — that is the one that holds the
   * confirmed icon on screen through the launch echo before letting App close the window.
   */
  onClose: onCloseNow,
  apps,
  config,
  triggerSource = 'shortcut',
  onWorkspaceSwitch,
  onDirectionHintSeen,
  currentWorkspace,
  animationReady = true,
  updateReady = false,
  discoveryPhase = 'idle',
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isCenterActive, setIsCenterActive] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  /**
   * "This wheel has started closing". Written SYNCHRONOUSLY by every cancellation path — Escape,
   * right button, context menu and the trigger's toggle event — before `onClose`.
   *
   * It exists because `!stateRef.current.isOpen` arrives late: it goes through `onClose` → App's
   * `setIsMenuOpen` → React batching → render. A click does not suffer from that (the listener has
   * already been unmounted), but a dwell aim timer survives that window and would fire against a
   * wheel the user has just sent away. Before this the ref existed but was never read: it described
   * a protection that was not there.
   */
  const closingRef = useRef(false);
  const isCenterActiveRef = useRef(isCenterActive);
  const openingTimeRef = useRef<number>(0);
  /**
   * Opening is a CSS transition, not a JS animation: the slices mount collapsed at the hub and a
   * single `rAF` later move to the final state — the compositor does the rest. One re-render per
   * open (and per level), instead of a spring per icon on every frame.
   */
  const [bloom, setBloom] = useState(false);

  /**
   * Dwell aim engine.
   *
   * The design rule that governs everything here: ARMING IS AN OBSERVED FACT. The gesture only
   * becomes able to launch after a REAL `mousemove` lands more than `INSTANT_ARM_DISPLACEMENT_PX`
   * from a reference set by an earlier real `mousemove`. Nothing is inferred from the wheel's
   * state, because the dangerous state — pointer still, far from the centre, with a slice already
   * lit — is indistinguishable from a deliberate aim if you do not look at the movement.
   */
  const levelGenRef = useRef(0);
  const dwellArmedRef = useRef(false);
  const dwellBaselineRef = useRef<{ x: number; y: number } | null>(null);
  const dwellTimerRef = useRef<number | null>(null);
  const dwellTargetRef = useRef<{ gen: number; index: number; itemId: string } | null>(null);
  /** Target waiting for the hand to settle; it does not count or draw anything yet. */
  const dwellPendingRef = useRef<{ gen: number; index: number; itemId: string } | null>(null);
  const dwellSettleTimerRef = useRef<number | null>(null);
  /** Point where the current attempt started — it is what tells whether the pointer has stopped. */
  const dwellAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const dwellStartedAtRef = useRef(0);
  const paintReadyAtRef = useRef<number | null>(null);
  const quarantineUntilRef = useRef(0);
  const dwellSeqRef = useRef(0);
  /**
   * The interaction effect registers the listeners once per open, and the engine is defined after
   * it (it needs `handleAppClick`). A ref is what links the two without inverting the file's order
   * or recreating listeners on every render.
   */
  const armAndTrackDwellRef = useRef<
    (point: { x: number; y: number }, aim: { isCenter: boolean; index: number | null }) => void
  >(() => {});
  /** One commit per arc start/cancel. Zero per frame: the animation is CSS. */
  const [dwellTick, setDwellTick] = useState<{ index: number; key: number } | null>(null);

  /**
   * Direction aim state. `gestureVectorRef` is the displacement accumulated from the centre — the
   * virtual pointer the wheel aims with; `gestureSampleRef` is the last REAL position, only to
   * work out the next delta. Zero in both means "there is no direction yet": nothing lit.
   */
  const gestureVectorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const gestureSampleRef = useRef<{ x: number; y: number } | null>(null);
  /** Instant a parking was requested; `0` when there is none waiting to land. */
  const gestureParkAtRef = useRef(0);

  const resetDirectionGesture = useCallback((expectPark: boolean) => {
    gestureVectorRef.current = { x: 0, y: 0 };
    gestureSampleRef.current = null;
    gestureParkAtRef.current = expectPark ? Date.now() : 0;
  }, []);

  useEffect(() => {
    isCenterActiveRef.current = isCenterActive;
  }, [isCenterActive]);

  /** Kills the timer and the arc. It does NOT disarm: sitting on the hub cancels the count, not the gesture. */
  const cancelDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (dwellSettleTimerRef.current !== null) {
      window.clearTimeout(dwellSettleTimerRef.current);
      dwellSettleTimerRef.current = null;
    }
    dwellPendingRef.current = null;
    dwellAnchorRef.current = null;
    /** The commit only happens if there really was an arc on screen — repeat calls cost nothing. */
    if (dwellTargetRef.current !== null) {
      dwellTargetRef.current = null;
      setDwellTick(null);
    }
  }, []);

  /** Back to the state where launching demands fresh, observed displacement. */
  const disarmDwell = useCallback(() => {
    cancelDwell();
    dwellArmedRef.current = false;
    dwellBaselineRef.current = null;
  }, [cancelDwell]);

  /** Full reset — opening and closing. */
  const resetDwell = useCallback(() => {
    disarmDwell();
    paintReadyAtRef.current = null;
    quarantineUntilRef.current = 0;
  }, [disarmDwell]);

  /**
   * Launch echo target: the index of the confirmed slice, or `-1` for the hub. `null` while
   * nothing has been confirmed — which is the state through the wheel's whole normal life.
   *
   * The `key` remounts the rings: a second confirmation without it would reuse the same elements
   * and the CSS animation, already finished, would not run again.
   */
  const [launchEcho, setLaunchEcho] = useState<{ index: number; key: number } | null>(null);
  const launchEchoTimerRef = useRef<number | null>(null);
  const launchEchoSeqRef = useRef(0);
  const launchEchoMs = config.performanceMode ? LAUNCH_ECHO_FAST_MS : LAUNCH_ECHO_MS;

  /**
   * The `onClose` the rest of the file uses. Confirming a launchable target now draws the echo and
   * only then lets App close; everything else passes straight through untouched.
   *
   * Cancelling has NO echo, and the distinction is not cosmetic: a cancellation launches nothing,
   * so there is nothing to confirm and any delay there is just the wheel being slow to get out of
   * the way. The centre follows the same rule through its configuration — a hub set to `cancel` is
   * a cancellation.
   *
   * `prefers-reduced-motion` turns the echo off entirely rather than shortening it: without the
   * wave and without the scale, what was left was pure delay before the app opened.
   */
  const onClose = useCallback(
    (selectedId: string | null, selectedApp?: AppItem | null) => {
      const fireNow = () => onCloseNow(selectedId, selectedApp);
      if (selectedId === null) return void fireNow();
      /** There is already an echo running: the second confirmation would be a second launch. */
      if (launchEchoTimerRef.current !== null) return;
      if (typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        return void fireNow();
      }

      let index: number;
      if (selectedId === '__CENTER__') {
        /**
         * `cancel` and `none` launch nothing — App returns without dispatching any command — and an
         * echo over a launch that did not happen would be a confirmation telling a lie.
         */
        const centerType = stateRef.current.config.centerButton?.type;
        if (!centerType || centerType === 'cancel' || centerType === 'none') return void fireNow();
        index = -1;
      } else {
        index = stateRef.current.currentLevelApps.findIndex((item) => item.id === selectedId);
        /** With no slice on screen there is nothing to echo — a keyboard shortcut over a level already swapped. */
        if (index === -1) return void fireNow();
      }

      /**
       * The wheel goes inert during the echo. `closingRef` is the same synchronous signal the
       * cancellations write, and it is what stops a dwell aim timer — which survives the echo's
       * entire window — from confirming a SECOND target on top of this one.
       */
      closingRef.current = true;
      gestureConsumedRef.current = true;
      cancelDwell();
      launchEchoSeqRef.current += 1;
      setLaunchEcho({ index, key: launchEchoSeqRef.current });
      launchEchoTimerRef.current = window.setTimeout(() => {
        /** Cleared BEFORE dispatching: the `isOpen` effect that follows has nothing left to cancel. */
        launchEchoTimerRef.current = null;
        fireNow();
      }, launchEchoMs);
    },
    [onCloseNow, cancelDwell, launchEchoMs],
  );

  /**
   * The wheel closed by another route while the echo was running — Escape, right button, the
   * trigger toggling. The still-pending timer is a launch nobody asked for any more: a cancellation
   * halfway through the wave has to cancel the app too.
   */
  useEffect(() => {
    if (isOpen) return;
    if (launchEchoTimerRef.current !== null) {
      window.clearTimeout(launchEchoTimerRef.current);
      launchEchoTimerRef.current = null;
    }
    setLaunchEcho(null);
  }, [isOpen]);

  useEffect(
    () => () => {
      if (launchEchoTimerRef.current !== null) window.clearTimeout(launchEchoTimerRef.current);
    },
    [],
  );

  // Folder Navigation State
  // Seeded with the root level, not the raw app list: in picker mode the two
  // differ, and mounting with the wrong one costs a frame of the wrong wheel.
  const [rawLevelApps, setCurrentLevelApps] = useState<AppItem[]>(() => getRootRadialApps(config, apps));
  /**
   * Type-ahead: what has been typed since the wheel opened, and the level narrowed to match.
   *
   * Past about a dozen shortcuts a slice is 30° or less and aiming stops being the skill it was —
   * the wheel that made eight targets effortless makes twenty a lottery. Typing narrows the ring
   * until the remaining slices are wide again; aiming still does the launching.
   *
   * The narrowing is applied HERE, between the state and everything that reads it, and that is the
   * whole implementation. Layout, hit-testing, the dwell timer, the folder stack and the render all
   * read `currentLevelApps`; none of them needs to know a filter exists, and none of them can fall
   * out of step with one. The twenty-six places that SET the level are equally untouched — they
   * write the level, not the view of it.
   */
  const [typeAhead, setTypeAhead] = useState('');
  const currentLevelApps = React.useMemo(
    () => filterRadialApps(rawLevelApps, typeAhead),
    [rawLevelApps, typeAhead],
  );
  const typeAheadRef = useRef(typeAhead);
  typeAheadRef.current = typeAhead;
  /** A level change is a new set of names, so whatever was typed no longer means anything. */
  useEffect(() => { setTypeAhead(''); }, [rawLevelApps]);
  const [folderStack, setFolderStack] = useState<{ label: string, apps: AppItem[] }[]>([]);
  const [isLoadingRecents, setIsLoadingRecents] = useState(false);
  /**
   * An MRU fetch in flight does not change the level: the PREVIOUS level's slices stay in view and
   * the level-change effect does not run, so nothing disarms on its own. While the hub spins,
   * nothing launches by dwell — the user has already chosen and is waiting.
   */
  const isLoadingRecentsRef = useRef(isLoadingRecents);
  isLoadingRecentsRef.current = isLoadingRecents;

  const menuRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  configRef.current = config;
  /**
   * The chosen time is the TOTAL until it opens, and it is split between the two phases: settling
   * the hand and then counting. Settling takes `DWELL_SETTLE_MS`, but never more than the whole
   * budget — hence the `min`.
   *
   * There used to be a floor here, because the settings' minimum (250ms) was larger than the
   * settle phase and no split could come out negative. With the optional wait that stopped being
   * true: at 0ms a floor would mean the wheel promising "instant" and waiting 90ms anyway, and at
   * 50ms it would mean waiting 90. Splitting instead of applying a floor keeps the settings' number
   * honest across the whole range — at zero, both phases measure zero and the direction launches as
   * soon as it commits.
   */
  const dwellMsRef = useRef(0);
  dwellMsRef.current = clampDwellMs(config.radialInstantDwellMs);
  const dwellSettleMsRef = useRef(0);
  dwellSettleMsRef.current = Math.min(DWELL_SETTLE_MS, dwellMsRef.current);
  const dwellRunMsRef = useRef(0);
  dwellRunMsRef.current = Math.max(0, dwellMsRef.current - dwellSettleMsRef.current);
  /**
   * The clickless-launch switch turns on BOTH halves of the same gesture: aiming by direction with
   * the pointer hidden, and launching at the end of the aim time. One expression for both, because
   * a wheel that hides the cursor and keeps aiming by position cannot be used at all.
   *
   * The interaction effect depends only on `[isOpen]`, so it captures its callbacks once per open —
   * whatever changes with the settings has to reach it through a ref, not a closure.
   *
   * `swipe` is read as off on purpose: the value is reserved in the type, not implemented. MMB in
   * hold mode is left out because it already launches on release, and its aim comes from main's
   * polling (`mmb-cursor`), whose first point is where the button was pressed — feeding a timer
   * with that would be firing on a poll tick, not on an intention. That is also why main does not
   * park the cursor on that path.
   */
  const directionMode =
    config.radialInstantActivate === 'dwell' && triggerSource !== 'mmb';
  const directionModeRef = useRef(false);
  directionModeRef.current = directionMode;
  const dwellEnabledRef = useRef(false);
  dwellEnabledRef.current = directionMode;
  /** Displacement a direction needs before it lights the slice on that side. */
  const directionCommitRef = useRef(0);
  directionCommitRef.current = directionCommitPx(config.radialInstantSensitivity);
  /** The radial window: it is what sets the radius past which the real cursor is re-parked. */
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const radialHoverColor = normalizeHoverColor(config.radialHoverColor);
  const radialHoverForeground = getReadableForeground(radialHoverColor);
  const iconSizePx = config.iconSize || 64;
  const minGap = config.appSpacing || 0;
  const numberOfApps = currentLevelApps.length;

  // Intelligent Layout Calibration
  const { actualMenuRadius, actualIconSize } = React.useMemo(
    () =>
      computeRadialLayout({
        numberOfApps,
        iconSizePx,
        minGap,
        menuRadius: config.menuRadius,
        activationThreshold: config.activationThreshold,
        viewportSize,
      }),
    [config.menuRadius, config.activationThreshold, numberOfApps, iconSizePx, minGap, viewportSize.width, viewportSize.height],
  );

  // Sync root radial when workspace config / active workspace apps change while
  // menu stays open. Also pre-paint, for the same reason as the open reset:
  // in picker mode the root level is a synthetic workspace list, not `apps`, so
  // a passive effect showed one wheel and replaced it on the next frame.
  useLayoutEffect(() => {
    if (!isOpen || folderStack.length > 0) return;
    const next = getRootRadialApps(config, apps);
    setCurrentLevelApps((prev) => (sameRadialLevel(prev, next) ? prev : next));
  }, [isOpen, folderStack.length, apps, config.workspaceSwitchMode, config.workspaces, config]);

  /**
   * Triggers the slices coming out: they mount collapsed at the hub and the next frame takes the
   * final state. It also runs on every level swap (folder / workspace), so the same movement serves
   * both.
   */
  useLayoutEffect(() => {
    if (!isOpen) {
      setBloom(false);
      paintReadyAtRef.current = null;
      return;
    }
    setBloom(false);
    /**
     * The "the wheel is really in view" mark. This effect's dependencies include
     * `currentLevelApps`, so the `INSTANT_ARM_DELAY_MS` settling window is won back on every LEVEL
     * and not only on every open — which is exactly the guarantee a dwell launch needs when a
     * folder swaps the slices under a still pointer.
     */
    paintReadyAtRef.current = null;
    cancelDwell();
    if (!animationReady) return;
    const raf = requestAnimationFrame(() => {
      paintReadyAtRef.current = Date.now();
      setBloom(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, currentLevelApps, animationReady, cancelDwell]);

  /** Empty list: keep the visual focus on the centre (back / centre) — before, the mouse did not update the hub. */
  useEffect(() => {
    if (!isOpen || currentLevelApps.length > 0) return;
    setActiveIndex(null);
    setIsCenterActive(true);
  }, [isOpen, currentLevelApps.length]);

  // The root hub carries the Rovyl identity; deeper levels keep the Back affordance.
  const isRoot = folderStack.length === 0;
  const centerLabel = !isRoot ? uiString('menu.back') : (config.centerButton?.label || uiString('menu.center'));


  // Reset state when menu opens.
  // This runs before paint: as a passive effect it landed one frame late, so
  // reopening after browsing into a folder painted the previous level first and
  // only then swapped to the root — read as the wheel rendering twice, the
  // first as a flash. The wheel it flashed had a different item count, hence a
  // different radius and icon size, which made the swap impossible to miss.
  useLayoutEffect(() => {
    if (isOpen) {
      openingTimeRef.current = Date.now();
      /** A fresh open: nothing inherited from the previous gesture may launch anything. */
      resetDwell();
      closingRef.current = false;
      levelGenRef.current += 1;
      setHasMoved(false);
      setIsCenterActive(false);
      setFolderStack([]);
      setCurrentLevelApps(getRootRadialApps(configRef.current, apps));
      setActiveIndex(null);
      setBloom(false);

      // CRITICAL: Focus window and body to ensure keyboard events are captured
      // This is especially important when menu is opened via MMB or after dashboard interaction
      window.focus();
      document.body.focus();
      if (menuRef.current) {
        menuRef.current.focus();
      }
    }
  }, [isOpen]);

  // Stable Interaction Logic (Performance Optimization)
  // We use refs to access current state inside stable event listeners
  // to avoid destroying/recreating listeners on every hover (index change).
  /**
   * Centre size: constant, taken from the settings' `iconSize` and NOT from the slices' computed
   * size. Slice size grows with the item count, so the hub shrank in a workspace with 3 apps and
   * grew in another with 8 — the same button, two sizes, and the target moved depending on the
   * workspace. It only shrinks if the ring has no room for it.
   *
   * Even diameter: the hub centres with `translate(-50%)`, and half an odd number lands on a half
   * pixel.
   */
  const hubDiameter = Math.max(
    32,
    Math.min(
      /**
       * The compact size — the one the wheel had with few apps, which is the one that reads best.
       * The density ramp (0.82 → 1.0) is reserved for the slices; the centre does not grow with the
       * item count, or the same button ends up with one size per workspace.
       */
      Math.round((config.iconSize || 64) * 0.82 * 1.2),
      Math.round((actualMenuRadius - actualIconSize / 2 - 10) * 2),
    ),
  ) & ~1;

  /** The target covers the hub's box already at the active state's scale, plus 4px of slack. */
  const hubHitSize = Math.round(hubDiameter * 1.06) + 4;
  /**
   * Cancel zone — it has to cover the hub's BOX, not the circle.
   *
   * The hub is a square `<div>` with `rounded-full`, and `border-radius` clips the hit test too: a
   * click on the box's corner falls outside the circle, passes through to the overlay and becomes a
   * direction. Except that corner is `r × √2` from the centre (41% further than the circle's edge)
   * and the user reads it as "inside the button" — hence clicking the top-left corner of the back
   * button and launching a slice. The `× 1.06` follows the scale the hub gains when it is active,
   * which is exactly the state this click happens in.
   */
  const deadZoneRadius = Math.max(
    config.activationThreshold ?? 60,
    Math.ceil((hubDiameter / 2) * 1.06 * Math.SQRT2) + 4,
  );

  /**
   * Radius past which the aim stops being "centre" and becomes a slice.
   *
   * By direction, what rules is the sensitivity and not the cancel zone: the dead zone is the size
   * of the middle BUTTON — it measures a click target, and in a clickless gesture there is not even
   * a pointer to hit it with. Keeping it here made high sensitivity indistinguishable from medium,
   * because nothing would light before the hub's ~60px.
   */
  const aimGateRef = useRef(deadZoneRadius);
  aimGateRef.current = directionMode ? directionCommitRef.current : deadZoneRadius;

  /**
   * Confirmation diagnostics. It lands in the persistence log (`rovyl-persistence.log`) and says,
   * for every gesture that launches something, where the decision came from: point, assumed centre,
   * distance, dead zone and the chosen item. Without it, an "it opened what I did not click" is
   * impossible to pin down.
   */
  const logRadialConfirm = useCallback(
    (
      origin: 'click' | 'mmb-release' | 'dwell',
      point: { x: number; y: number } | null,
      aim: { isCenter: boolean; index: number | null },
    ) => {
      const { position, currentLevelApps } = stateRef.current;
      const deadZoneRadius = aimGateRef.current;
      const distance = point
        ? Math.round(Math.hypot(point.x - position.x, point.y - position.y))
        : -1;
      const label = aim.index !== null ? currentLevelApps[aim.index]?.label ?? '?' : '—';
      /**
       * A dwell launch has no human gesture for a report to hold on to — without these fields, an
       * "it opened what I did not aim at" is impossible to tell from a badly aimed click.
       */
      const dwellForensics =
        origin === 'dwell'
          ? ` base=${
              dwellBaselineRef.current
                ? `${Math.round(dwellBaselineRef.current.x)},${Math.round(dwellBaselineRef.current.y)}`
                : 'null'
            } waited=${Date.now() - dwellStartedAtRef.current}ms level=${levelGenRef.current} ` +
            `target=${dwellTargetRef.current?.itemId ?? '?'}`
          : '';
      window.electron?.savePersistenceLog?.(
        `[RadialConfirm] ${origin} point=${point ? `${Math.round(point.x)},${Math.round(point.y)}` : 'null'} ` +
          `centre=${Math.round(position.x)},${Math.round(position.y)} dist=${distance} deadZone=${Math.round(deadZoneRadius)} ` +
          `→ ${aim.isCenter ? 'CENTRE' : `slice ${aim.index} (${label})`}${dwellForensics}`,
      );
    },
    [],
  );

  /** Centre action: go back one level inside a folder, close at the root. */
  const handleCenterActivate = useCallback(() => {
    /** Reflex click right after a dwell launch — and the hub has already changed level. */
    if (Date.now() < quarantineUntilRef.current) return;
    /** Echo running: the centre has stopped being a target just as much as the slices have. */
    if (launchEchoTimerRef.current !== null) return;
    const { folderStack, currentLevelApps: _ignored, apps, config, onClose } = stateRef.current;
    if (folderStack.length > 0) {
      const newStack = folderStack.slice(0, -1);
      setFolderStack(newStack);
      setCurrentLevelApps(
        newStack.length === 0 ? getRootRadialApps(config, apps) : newStack[newStack.length - 1].apps,
      );
      setHasMoved(false);
      setIsCenterActive(false);
      return;
    }
    onClose('__CENTER__');
  }, []);

  const stateRef = useRef({
    isOpen,
    position,
    activeIndex,
    onClose,
    currentLevelApps,
    config,
    isCenterActive,
    hasMoved,
    folderStack,
    apps,
    actualMenuRadius,
    actualIconSize,
    deadZoneRadius,
  });

  /** Layout: pointer math uses `position` — must match props before paint or first rAF sees stale center (fullscreen vs island small). */
  useLayoutEffect(() => {
    stateRef.current = {
      isOpen,
      position,
      activeIndex,
      onClose,
      currentLevelApps,
      config,
      isCenterActive,
      hasMoved,
      folderStack,
      apps,
      actualMenuRadius,
      actualIconSize,
      deadZoneRadius,
    };
  }, [isOpen, position, activeIndex, onClose, currentLevelApps, config, isCenterActive, hasMoved, folderStack, apps, actualMenuRadius, actualIconSize, deadZoneRadius]);

  /**
   * The point the wheel AIMS at, written in the event itself — without going through a render. By
   * direction it is the virtual pointer (centre + gesture vector); in the other modes it is the
   * cursor's real position.
   */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Where the HAND is, always real. Dwell aim asks "has the hand stopped?", and by direction the
   * virtual pointer saturates at the vector's ceiling: pushing on left it motionless and the count
   * concluded the hand had settled while it was still halfway through the gesture.
   */
  const lastAnchorPointRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * Translates a real sample into the point the wheel should aim at.
   *
   * Outside direction mode it is the identity. Inside it, it accumulates this sample's delta into
   * the gesture vector, cuts out the parking jump and asks for a re-park before the cursor leaves
   * the window — outside it there is no `mousemove` at all and the pointer would be drawn again.
   */
  const trackAimPoint = useCallback(
    (point: { x: number; y: number }): { x: number; y: number } => {
      if (!directionModeRef.current) return point;
      const { position } = stateRef.current;
      const previous = gestureSampleRef.current;
      gestureSampleRef.current = point;

      const virtual = () => ({
        x: position.x + gestureVectorRef.current.x,
        y: position.y + gestureVectorRef.current.y,
      });

      /**
       * The signature of our own `SetCursorPos`: a large jump that LANDS on the wheel's centre. The
       * two halves together describe no hand at all — a hand that crosses 120px in a single event
       * does not stop on top of the centre — so this identifies the teleport by what it is, and not
       * by us expecting it.
       *
       * It has to be unconditional. The `WARP` is queued while the PowerShell helper starts up
       * (`writeRadialCursorCommand` holds it until READY), and a session's first radial can open
       * before that: the "parking pending" flag expires after `PARK_TIMEOUT_MS` and the jump
       * arrived AFTER, by then being added to the vector as if it were gesture — the wheel jumping
       * to the opposite side from the hand halfway through an aim.
       */
      const teleported =
        !!previous &&
        Math.hypot(point.x - previous.x, point.y - previous.y) >= PARK_JUMP_PX &&
        Math.hypot(point.x - position.x, point.y - position.y) <= PARK_LANDING_PX;
      if (teleported) {
        gestureParkAtRef.current = 0;
        return virtual();
      }

      if (gestureParkAtRef.current !== 0) {
        /**
         * A parking we asked for: the first sample to land on the centre closes the wait and its
         * delta dies here. Discarding everything until the landing ate the start of the movement,
         * which is precisely where high sensitivity is decided.
         */
        if (Math.hypot(point.x - position.x, point.y - position.y) <= PARK_LANDING_PX) {
          gestureParkAtRef.current = 0;
          return virtual();
        }
        /** No landing — no helper, or another system: the gesture carries on without parking. */
        if (Date.now() - gestureParkAtRef.current > PARK_TIMEOUT_MS) {
          gestureParkAtRef.current = 0;
        } else {
          return virtual();
        }
      }

      if (previous) {
        const next = {
          x: gestureVectorRef.current.x + (point.x - previous.x),
          y: gestureVectorRef.current.y + (point.y - previous.y),
        };
        /**
         * The vector's ceiling. Only the direction counts — the virtual pointer never needs to
         * reach the icon ring, because by direction the aim is the sector and not the icon.
         */
        const clamp = directionCommitRef.current * DIRECTION_CLAMP_FACTOR;
        const length = Math.hypot(next.x, next.y);
        gestureVectorRef.current =
          length > clamp
            ? { x: (next.x / length) * clamp, y: (next.y / length) * clamp }
            : next;
      }

      /**
       * The real cursor keeps travelling even after the vector saturates. Re-parking it at the
       * centre keeps it inside the window — the only surface where we can hide it — and the gesture
       * never notices, because it only sums deltas.
       */
      if (gestureParkAtRef.current === 0 && window.electron?.parkRadialCursor) {
        const { width, height } = viewportSizeRef.current;
        const strayRadius = Math.max(
          160,
          Math.min(width, height) / 2 - PARK_STRAY_MARGIN_PX,
        );
        if (Math.hypot(point.x - position.x, point.y - position.y) > strayRadius) {
          gestureParkAtRef.current = Date.now();
          window.electron.parkRadialCursor();
        }
      }

      return virtual();
    },
    [],
  );
  /**
   * One open confirms once. Between `onClose` and the render that unmounts the listeners there is a
   * window in which another `mouseup` (or the MMB release arriving right after the click) is still
   * delivered — and that was what launched an app with the radial already closing.
   */
  const gestureConsumedRef = useRef(false);

  /**
   * Resolves the target from a concrete point, with the same maths as `mousemove`.
   *
   * Confirmation cannot read `activeIndex`/`isCenterActive` from state: those values travel through
   * `mousemove` → rAF → `setState` → render → `stateRef`, and the button can be released before
   * that cycle closes. In that case the radial confirmed the slice the cursor WAS on, not the one
   * it is on — hence opening items that were not aimed at, and the feeling of a click with a lag.
   * Recomputing at the moment of release costs one square root and removes the race entirely.
   */
  const resolveAimAtPoint = useCallback(
    (point: { x: number; y: number } | null): { isCenter: boolean; index: number | null } => {
      const { position, currentLevelApps, config, actualMenuRadius, actualIconSize } =
        stateRef.current;
      if (!point) return { isCenter: true, index: null };

      const deltaX = point.x - position.x;
      const deltaY = point.y - position.y;
      if (Math.hypot(deltaX, deltaY) < aimGateRef.current) {
        return { isCenter: true, index: null };
      }
      if (currentLevelApps.length === 0) return { isCenter: false, index: null };

      const sliceAngle = 360 / currentLevelApps.length;

      /**
       * Cursor mode: the target is the icon UNDER the pointer, not the direction it lies in.
       *
       * With angle aiming, being on the right of the screen lights the right-hand item even with
       * the cursor hundreds of pixels from it — fast for anyone who already knows where things are,
       * and disorienting for anyone who does not. Here nothing lights outside the icon's radius,
       * and releasing while over none of them opens nothing.
       *
       * It does not apply to the clickless launch, and that exception is the whole feature: there
       * is no pointer on screen to rest on top of anything. There the wheel is a pie of EQUAL
       * sectors — with two items, half a screen each; with four, a quadrant each — and pointing the
       * right way is enough, however far the hand travels. Letting the aim setting decide here left
       * the user hunting an icon with a cursor they cannot see.
       */
      if (config.radialSelectionMode === 'cursor' && !directionModeRef.current) {
        const hitRadius = Math.max(actualIconSize * 0.85, 22);
        let nearest: number | null = null;
        let nearestDistance = Infinity;
        for (let i = 0; i < currentLevelApps.length; i += 1) {
          const itemRad = ((i * sliceAngle) - 90) * (Math.PI / 180);
          const distance = Math.hypot(
            deltaX - actualMenuRadius * Math.cos(itemRad),
            deltaY - actualMenuRadius * Math.sin(itemRad),
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = i;
          }
        }
        return { isCenter: false, index: nearestDistance <= hitRadius ? nearest : null };
      }

      /**
       * No distance limit: aiming is giving a direction, and the slice stays the target with the
       * cursor at the other end of the screen. Anyone who wants out uses the centre or Escape.
       */
      let angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI) + 90;
      if (angle < 0) angle += 360;
      const index = Math.floor(((angle + sliceAngle / 2) % 360) / sliceAngle);
      return {
        isCenter: false,
        index: index >= 0 && index < currentLevelApps.length ? index : null,
      };
    },
    [],
  );

  /**
   * Entering or leaving a level (workspace, folder, recents) swaps the slices under a cursor that
   * has not moved — and since the highlight is only recomputed on `mousemove`, the new level came
   * up entirely dark until the mouse was nudged. Here the aim is re-evaluated at the real position
   * as soon as the level changes, so the slice under the cursor already arrives lit.
   */
  useLayoutEffect(() => {
    if (!isOpen) return;
    /**
     * Entering or leaving a level disarms the clickless launch, no exceptions: arming again always
     * costs `INSTANT_ARM_DISPLACEMENT_PX` of fresh, observed displacement. This is what stops a
     * dwell launch from cascading through nested folders — and it also covers the level swaps
     * nobody gestured for: the delayed `setConfig` from switching workspace with the mouse wheel,
     * and an MRU promise resolving after the user has already navigated elsewhere.
     *
     * `lastPointerRef` is left untouched on purpose: the re-evaluation below is what makes the new
     * level arrive with the slice under the cursor already lit.
     */
    levelGenRef.current += 1;
    disarmDwell();
    /** Changing level is navigating, not confirming: the next gesture has to count again. */
    gestureConsumedRef.current = false;
    /**
     * By direction the new level has to be born neutral. The direction that opened the folder went
     * on pointing the same way inside it, and dwell aim immediately opened the item on that side —
     * one folder chained into the next without anyone choosing anything. Zeroing the vector does
     * the same thing the arming rule already did by position: demand NEW movement.
     */
    if (directionModeRef.current) {
      resetDirectionGesture(false);
      lastPointerRef.current = null;
      lastAnchorPointRef.current = null;
    }
    const aim = resolveAimAtPoint(lastPointerRef.current);
    setIsCenterActive(aim.isCenter);
    setActiveIndex(aim.isCenter ? null : aim.index);
  }, [isOpen, currentLevelApps, folderStack.length, resolveAimAtPoint, disarmDwell, resetDirectionGesture]);

  useEffect(() => {
    if (!isOpen) return;

    /**
     * A fresh open, pointer unknown. Without this the PREVIOUS open's position was left over, and
     * it sits far from the new centre: releasing the button without moving the mouse would confirm
     * a slice. `null` resolves to the centre, that is, to cancelling — the only safe default.
     */
    lastPointerRef.current = null;
    lastAnchorPointRef.current = null;
    /**
     * By direction main has already sent the cursor to the centre before this `open-menu`. That
     * jump's landing is still on its way as a `mousemove` — marking it as pending is what stops the
     * vector from summing it and pointing to the opposite side from the hand.
     */
    resetDirectionGesture(directionModeRef.current);
    gestureConsumedRef.current = false;

    let rafId: number | null = null;

    const processMouseMove = () => {
      rafId = null;
      /**
       * The point has already been resolved in the event itself: by direction, the gesture vector
       * has to sum EVERY sample, and a rAF coalesces them. Here we only read the result.
       */
      const aimPoint = lastPointerRef.current;
      const anchorPoint = lastAnchorPointRef.current;
      if (!aimPoint || !anchorPoint) return;
      const { position, currentLevelApps, hasMoved, activeIndex } = stateRef.current;

      const deltaX = aimPoint.x - position.x;
      const deltaY = aimPoint.y - position.y;
      const distance = Math.hypot(deltaX, deltaY);
      const MOVEMENT_BUFFER = 15;

      if (currentLevelApps.length === 0) {
        /** Empty level: there is no slice to launch, and `resolveAimAtPoint` returns a null index. */
        cancelDwell();
        if (!hasMoved && distance > MOVEMENT_BUFFER) {
          setHasMoved(true);
        }
        if (distance < aimGateRef.current) {
          if (activeIndex !== null) setActiveIndex(null);
          if (!stateRef.current.isCenterActive) setIsCenterActive(true);
        } else {
          if (stateRef.current.isCenterActive) setIsCenterActive(false);
          if (activeIndex !== null) setActiveIndex(null);
        }
        return;
      }

      if (!hasMoved && distance > MOVEMENT_BUFFER) {
        setHasMoved(true);
      }

      if (distance < aimGateRef.current) {
        /** Coming back to the hub is the gesture for giving up: it kills the count, not the right to start over. */
        cancelDwell();
        if (activeIndex !== null) setActiveIndex(null);
        if (!stateRef.current.isCenterActive) setIsCenterActive(true);
        return;
      }

      if (stateRef.current.isCenterActive) setIsCenterActive(false);

      /**
       * One set of maths for the highlight and for the confirmation.
       *
       * They were duplicated, and any divergence between the two means lighting one icon and
       * opening another — the worst possible defect in a launcher. Both now go through here.
       */
      const aim = resolveAimAtPoint(aimPoint);
      if (activeIndex !== aim.index) setActiveIndex(aim.index);

      /**
       * Fed the SAME `aim` object that just wrote the highlight, on the same tick — hence the
       * candidate target can never be anything but the one that is lit. Even so, whoever draws the
       * ring and whoever launches resolve the aim again on their own (`startDwell`, `fireDwell`):
       * almost half a second passes between marking a target and opening it, and in that gap the
       * level can change under a pointer that has not moved.
       */
      armAndTrackDwellRef.current(anchorPoint, aim);
    };

    const handleMouseMove = (e: MouseEvent) => {
      /** Synchronous: the highlight can wait for the next frame, the confirmation cannot. */
      const raw = { x: e.clientX, y: e.clientY };
      lastAnchorPointRef.current = raw;
      lastPointerRef.current = trackAimPoint(raw);
      if (rafId === null) {
        rafId = requestAnimationFrame(processMouseMove);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      /**
       * MMB is handled exclusively by the `mmb-release` IPC in hold mode and by main in click mode.
       * Accepting it here too made the same gesture confirm the slice and toggle the modal.
       */
      if (e.button === 1) return;
      if (e.button !== 0) return;
      /** A reflex click arriving after a dwell launch has already changed what is in view. */
      if (Date.now() < quarantineUntilRef.current) return;
      if (gestureConsumedRef.current || !stateRef.current.isOpen) return;
      /**
       * Same rule as `handleAppClick`: a click is a choice, and whatever was being counted has
       * stopped counting. This path has its own copy of the async recents branch — in angle mode it
       * IS the normal path, because the slice is the target even with the cursor far from the icon
       * — and during that wait the level does not change, so nothing else would disarm: the arc
       * went on filling over a tile that is no longer going to open anything.
       */
      disarmDwell();
      gestureConsumedRef.current = true;
      const { folderStack, apps, currentLevelApps, onClose, config } = stateRef.current;

      /** The target is where the aim is NOW, not what the last render managed to record. */
      const point = trackAimPoint({ x: e.clientX, y: e.clientY });
      const aim = resolveAimAtPoint(point);
      logRadialConfirm('click', point, aim);
      const selectedItemObj = aim.index !== null ? currentLevelApps[aim.index] : null;

      if (aim.isCenter) {
        if (folderStack.length > 0) {
          const newStack = [...folderStack];
          newStack.pop();
          setFolderStack(newStack);

          if (newStack.length === 0) {
            setCurrentLevelApps(getRootRadialApps(config, apps));
          } else {
            setCurrentLevelApps(newStack[newStack.length - 1].apps);
          }
          setHasMoved(false);
          setIsCenterActive(false);
        } else {
          onClose('__CENTER__');
        }
        return;
      }

      if (selectedItemObj && isWorkspacePickItem(selectedItemObj)) {
        const idx = parseWorkspacePickIndex(selectedItemObj.id);
        if (onWorkspaceSwitch) onWorkspaceSwitch(idx);
        const ws = config.workspaces[idx];
        if (ws?.enabled) {
          const list = ws.apps;
          setFolderStack([{ label: ws.name, apps: list }]);
          setCurrentLevelApps(list);
          setHasMoved(false);
          setActiveIndex(null);
        }
        return;
      }

      const selectedItem = selectedItemObj as any;
      if (!selectedItem) return;
        // Core Folder Integration Logic
        const isKnownIDE = (item: any) => {
          const l = item.label?.toLowerCase() || '';
          return l.includes('antigravity') || l.includes('cursor') || l.includes('vs code') || l.includes('vscode');
        };

        const hasRecentFetch = (selectedItem.hasRecents) && window.electron?.getAppRecents;
        const hasManualFolders = selectedItem.children && selectedItem.children.length > 0;

        if (selectedItem.type === 'folder' && selectedItem.children) {
          // Standard Folder Group
          setFolderStack([...folderStack, { label: selectedItem.label, apps: selectedItem.children }]);
          setCurrentLevelApps(selectedItem.children);
          setHasMoved(false);
          setActiveIndex(null);
        } else if (hasRecentFetch || hasManualFolders) {
          // App with Recents/QuickAccess
          setIsLoadingRecents(true);
          const manualFolders = selectedItem.children || [];

          if (hasRecentFetch) {
            window.electron!.getAppRecents(selectedItem.label, selectedItem.command).then(recents => {
              setIsLoadingRecents(false);
              const seenPathsMap = new Map();
              const seenLabels = new Set();
              manualFolders.forEach(c => {
                 const norm = normalizePathForDedup(c);
                 if (norm) seenPathsMap.set(norm, c.label || c.command);
                 if (c.label) seenLabels.add(c.label.toLowerCase());
              });
              
              const seenPaths = new Set(seenPathsMap.keys());
              
              const seenNormalized = new Set(seenPaths); // Start with manual folders
              const uniqueRecents = recents.filter(r => {
                const normalized = normalizePathForDedup(r);
                if (!normalized) return false;
                
                const isDuplicatePath = seenNormalized.has(normalized);
                const rLabelLower = (r.label || '').toLowerCase();
                const isDuplicateLabel = rLabelLower && seenLabels.has(rLabelLower);
                
                if (isDuplicatePath || isDuplicateLabel) {
                   return false;
                }
                
                seenNormalized.add(normalized);
                if (rLabelLower) seenLabels.add(rLabelLower);
                return true;
              });
              
              const combined = [...manualFolders, ...applyOpenTerminalForRecents(uniqueRecents, selectedItem)];

              if (combined.length > 0) {
                setFolderStack([...folderStack, { label: selectedItem.label, apps: combined }]);
                setCurrentLevelApps(combined);
                setHasMoved(false);
                setActiveIndex(null);
              } else if (selectedItem.hasRecents) {
                setIsLoadingRecents(false);
                const fallback = buildRecentsEmptyFallback(selectedItem);
                setFolderStack([...folderStack, { label: selectedItem.label, apps: fallback }]);
                setCurrentLevelApps(fallback);
                setHasMoved(false);
                setActiveIndex(null);
              } else {
                onClose(selectedItem.id, selectedItem);
              }
            }).catch(() => {
              setIsLoadingRecents(false);
              if (selectedItem.hasRecents) {
                const fallback = buildRecentsEmptyFallback(selectedItem);
                setFolderStack([...folderStack, { label: selectedItem.label, apps: fallback }]);
                setCurrentLevelApps(fallback);
                setHasMoved(false);
                setActiveIndex(null);
              } else {
                onClose(selectedItem.id, selectedItem);
              }
            });
          } else {
            // Only manual folders
            setIsLoadingRecents(false);
            setFolderStack([...folderStack, { label: selectedItem.label, apps: manualFolders }]);
            setCurrentLevelApps(manualFolders);
            setHasMoved(false);
            setActiveIndex(null);
          }
        } else {
          onClose(selectedItem.id, selectedItem);
        }
    };

    /**
     * Cancelling can never launch anything. `closingRef` is written here, synchronously, because
     * the "this is closing" signal only reaches React state after `onClose` → `setIsMenuOpen` →
     * batching → render, and a dwell aim timer survives that whole window: it would fire against a
     * wheel the user has already sent away.
     */
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        closingRef.current = true;
        cancelDwell();
        stateRef.current.onClose(null);
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      closingRef.current = true;
      cancelDwell();
      onClose(null);
    };

    /** See `handleMouseDown`: the trigger toggling to closed is a cancellation like any other. */
    const handleToggleClose = () => {
      closingRef.current = true;
      cancelDwell();
    };

    /**
     * The pointer left the window, or the window lost focus.
     *
     * This is the ONLY defence against an abandoned target, and it has to be event-driven. The
     * radial window is a box (~988px), not the screen: the pointer leaves it easily and, from then
     * on, `lastPointerRef` stays frozen at a point that in angle mode still resolves to a perfectly
     * valid slice. Comparing timestamps is no good — a still hand produces no events either, and
     * being still is the gesture.
     */
    const handleWindowBlur = () => disarmDwell();
    const handleDocumentMouseOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) disarmDwell();
    };
    const handleDocumentMouseLeave = () => disarmDwell();

    const handleWheel = (e: WheelEvent) => {
      if (!onWorkspaceSwitch) return;
      const { config, folderStack } = stateRef.current;
      if (config.workspaceSwitchMode === 'picker' && folderStack.length === 0) return;
      const numWorkspaces = config.workspaces.length;
      if (numWorkspaces <= 1) return;

      const currentIndex = config.activeWorkspaceIndex;
      let nextIndex = currentIndex;

      if (e.deltaY < 0) {
        nextIndex = (currentIndex - 1 + numWorkspaces) % numWorkspaces;
      } else if (e.deltaY > 0) {
        nextIndex = (currentIndex + 1) % numWorkspaces;
      }

      if (nextIndex !== currentIndex) {
        const nextWs = config.workspaces[nextIndex];
        if (!nextWs) return;
        const list = nextWs.apps;
        setFolderStack([]);
        setActiveIndex(null);
        setHasMoved(false);
        setCurrentLevelApps(list);
        onWorkspaceSwitch(nextIndex);
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('zenith-radial-toggle-close', handleToggleClose);
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('mouseout', handleDocumentMouseOut);
    document.addEventListener('mouseleave', handleDocumentMouseLeave);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelDwell();
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('mouseout', handleDocumentMouseOut);
      document.removeEventListener('mouseleave', handleDocumentMouseLeave);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('zenith-radial-toggle-close', handleToggleClose);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [isOpen]);

  // Sync workspace shortcuts state with main process (Fix for initial focus issue)
  useEffect(() => {
    if (window.electron?.setWorkspaceShortcutsState) {
      window.electron.setWorkspaceShortcutsState(
        isOpen,
        config.workspaceSwitchMode === 'picker' ? 'picker' : 'hotkeys',
      );
    }
  }, [isOpen, config.workspaceSwitchMode]);

  // STABLE KEYBOARD LISTENER (Decoupled from interaction states to avoid missing events)
  // NOTE: Workspace switching (1-9) is handled exclusively by global shortcuts registered in
  // the backend (set-workspace-shortcuts IPC). Having a duplicate listener here caused double-firing.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // diagLog(`[RadialMenu.tsx] KeyDown detected: ${e.key}, Ctrl: ${e.ctrlKey}, Alt: ${e.altKey}, Shift: ${e.shiftKey}`);
      if (e.key === 'Escape') {
        e.preventDefault();
        /**
         * One Escape, one thing undone. With something typed, Escape gives back the whole ring —
         * closing the wheel as well would throw away the gesture that opened it over a typo.
         */
        if (typeAheadRef.current) {
          setTypeAhead('');
          return;
        }
        /** See `handleMouseDown`: cancelling has to silence the timer before React unmounts. */
        closingRef.current = true;
        cancelDwell();
        onClose(null);
        return;
      }

      /**
       * Echo running: an app is already on its way. The keyboard goes deaf to everything but the
       * Escape above, which remains the way out — switching workspace or typing into the filter
       * during the wave touched a level that is on its way out and whose target has already been
       * decided.
       */
      if (launchEchoTimerRef.current !== null) return;

      if (e.key === 'Backspace') {
        if (!typeAheadRef.current) return;
        e.preventDefault();
        setTypeAhead((current) => current.slice(0, -1));
        return;
      }

      /**
       * A modifier means the key belongs to someone else — Alt+Z reopening the wheel, Ctrl+anything
       * — and a key name longer than one character is Tab, Shift, F5 or an arrow, none of which is
       * a letter someone meant to type.
       */
      const isTypedCharacter =
        e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== ' ';

      // Workspace Switching (1-9) — disabled in picker mode (user chooses workspace on the radial)
      if (
        onWorkspaceSwitch &&
        configRef.current.workspaceSwitchMode !== 'picker'
      ) {
        const num = parseInt(e.key);
        /**
         * The digits stay the workspace keys, and only while nothing has been typed. Once a filter
         * is running they are characters like any other: an app called "Photoshop 2024" cannot be
         * reached if the 2 keeps changing workspace.
         */
        if (!isNaN(num) && num >= 1 && num <= 9 && !typeAheadRef.current) {
          e.preventDefault();
          onWorkspaceSwitch(num - 1);
          return;
        }
      }

      if (isTypedCharacter) {
        e.preventDefault();
        setTypeAhead((current) => (current.length >= 24 ? current : current + e.key));
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, onClose, onWorkspaceSwitch]);

  /**
   * "Hold" mode: the window opens with the middle button still pressed, and on Windows the mouse
   * capture stays with the window that took the click — this one gets no `mousemove` at all until
   * the release, so the angle never updated and nothing was selectable. Main polls the cursor
   * (`mmb-cursor`) and here we replay it as a real `mousemove`, to feed exactly the same aim
   * pipeline.
   */
  useEffect(() => {
    if (!isOpen || triggerSource !== 'mmb' || !window.electron?.onMmbCursor) return;

    const cleanup = window.electron.onMmbCursor(({ x, y }) => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: x - window.screenX,
          clientY: y - window.screenY,
        }),
      );
    });

    return () => {
      if (cleanup) cleanup();
    };
  }, [isOpen, triggerSource]);

  // MMB Release Logic (Hold to Open -> Release to Execute)
  // Uses stateRef so the native listener is not torn down on every hover (activeIndex) update.
  useEffect(() => {
    if (!isOpen || triggerSource !== 'mmb' || !window.electron?.onMmbRelease) return;
    let delayedReleaseTimer: number | undefined;

    const handleMmbRelease = () => {
      const elapsed = Date.now() - openingTimeRef.current;
      const GRACE_PERIOD_MS = 250; // Ensure menu stays open for at least 250ms to prevent flickers

      const executeClose = () => {
        if (gestureConsumedRef.current || !stateRef.current.isOpen) return;
        gestureConsumedRef.current = true;
        const { folderStack, currentLevelApps, apps, onClose, config } = stateRef.current;

        /** Same rule as the click: the target comes from the real position, including the one main polls for MMB. */
        const aim = resolveAimAtPoint(lastPointerRef.current);
        logRadialConfirm('mmb-release', lastPointerRef.current, aim);
        const activeIndex = aim.index;

        if (aim.isCenter) {
          if (folderStack.length > 0) {
            const newStack = folderStack.slice(0, -1);
            setFolderStack(newStack);
            if (newStack.length === 0) setCurrentLevelApps(getRootRadialApps(config, apps));
            else setCurrentLevelApps(newStack[newStack.length - 1].apps);
            setHasMoved(false);
            setIsCenterActive(false);
          } else {
            onClose('__CENTER__');
          }
          return;
        }

        const selectedItem = activeIndex !== null ? currentLevelApps[activeIndex] : null;

        if (selectedItem && isWorkspacePickItem(selectedItem)) {
          const idx = parseWorkspacePickIndex(selectedItem.id);
          if (onWorkspaceSwitch) onWorkspaceSwitch(idx);
          const ws = config.workspaces[idx];
          if (ws?.enabled) {
            const list = ws.apps;
            setFolderStack([{ label: ws.name, apps: list }]);
            setCurrentLevelApps(list);
            setHasMoved(false);
            setActiveIndex(null);
          }
          return;
        }

        if (selectedItem) {
          const hasRecentFetch = (selectedItem.hasRecents) && window.electron?.getAppRecents;
          const hasManualFolders = selectedItem.children && selectedItem.children.length > 0;

          if (selectedItem.type === 'folder' && selectedItem.children) {
            setFolderStack(prev => [...prev, { label: selectedItem.label, apps: selectedItem.children! }]);
            setCurrentLevelApps(selectedItem.children);
            setHasMoved(false);
            setActiveIndex(null);
          } else if (hasRecentFetch || hasManualFolders) {
            setIsLoadingRecents(true);
            const manualFolders = selectedItem.children || [];

            if (selectedItem.hasRecents && window.electron?.getAppRecents) {
              window.electron!.getAppRecents(selectedItem.label, selectedItem.command).then(recents => {
                setIsLoadingRecents(false);
                const seenPaths = new Set(manualFolders.map(c => normalizePathForDedup(c)));
                const uniqueRecents = recents.filter(r => {
                  const normalized = normalizePathForDedup(r);
                  return normalized && !seenPaths.has(normalized);
                });
                const combined = [...manualFolders, ...applyOpenTerminalForRecents(uniqueRecents, selectedItem)];

                if (combined.length > 0) {
                  setFolderStack(prev => [...prev, { label: selectedItem.label, apps: combined }]);
                  setCurrentLevelApps(combined);
                  setHasMoved(false);
                  setActiveIndex(null);
                } else if (selectedItem.hasRecents) {
                  setIsLoadingRecents(false);
                  const fallback = buildRecentsEmptyFallback(selectedItem);
                  setFolderStack(prev => [...prev, { label: selectedItem.label, apps: fallback }]);
                  setCurrentLevelApps(fallback);
                  setHasMoved(false);
                  setActiveIndex(null);
                } else {
                  onClose(selectedItem.id, selectedItem);
                }
              }).catch(() => {
                setIsLoadingRecents(false);
                if (selectedItem.hasRecents) {
                  const fallback = buildRecentsEmptyFallback(selectedItem);
                  setFolderStack(prev => [...prev, { label: selectedItem.label, apps: fallback }]);
                  setCurrentLevelApps(fallback);
                  setHasMoved(false);
                  setActiveIndex(null);
                } else {
                  onClose(selectedItem.id, selectedItem);
                }
              });
            } else {
              setIsLoadingRecents(false);
              setFolderStack(prev => [...prev, { label: selectedItem.label, apps: manualFolders }]);
              setCurrentLevelApps(manualFolders);
              setHasMoved(false);
              setActiveIndex(null);
            }
          } else {
            onClose(selectedItem.id, selectedItem);
          }
        } else {
          onClose(null);
        }
      };

      const { hasMoved } = stateRef.current;
      if (!hasMoved && elapsed < GRACE_PERIOD_MS) {
        delayedReleaseTimer = window.setTimeout(executeClose, GRACE_PERIOD_MS - elapsed);
      } else {
        executeClose();
      }
    };

    const cleanup = window.electron.onMmbRelease(handleMmbRelease);
    return () => {
      if (cleanup) cleanup();
      if (delayedReleaseTimer !== undefined) window.clearTimeout(delayedReleaseTimer);
    };
  }, [isOpen, triggerSource, onWorkspaceSwitch]);

  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [weather, setWeather] = useState<{ temp: number; condition: string } | null>(null);

  // Battery & Weather Logic
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const weatherAbort = new AbortController();
    let batteryObj: ZenithBattery | null = null;
    const onBatteryLevel = () => {
      if (cancelled || !batteryObj) return;
      setBatteryLevel(Math.round(batteryObj.level * 100));
    };

    const nav = navigator as Navigator & { getBattery?: () => Promise<ZenithBattery> };
    if (config.showBattery && typeof nav.getBattery === 'function') {
      void nav.getBattery().then((battery) => {
        if (cancelled) return;
        batteryObj = battery;
        setBatteryLevel(Math.round(battery.level * 100));
        battery.addEventListener('levelchange', onBatteryLevel);
      });
    }

    // Real Weather Logic (wttr.in) with 10-minute cache
    if (config.showWeather) {
      const loc = config.weatherLocation || '';
      const now = Date.now();
      const cacheValid = weatherCache.data &&
        weatherCache.location === loc &&
        (now - weatherCache.lastFetch) < WEATHER_TTL_MS;

      if (cacheValid) {
        setWeather(weatherCache.data);
      } else {
        const fetchWeather = async () => {
          try {
            const response = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
              signal: weatherAbort.signal,
            });
            if (!response.ok) throw new Error('Weather fetch failed');
            const data = await response.json();
            const current = data.current_condition[0];
            const result = { temp: parseInt(current.temp_C), condition: current.weatherDesc[0].value };
            weatherCache.data = result;
            weatherCache.lastFetch = Date.now();
            weatherCache.location = loc;
            if (!cancelled) setWeather(result);
          } catch (err) {
            if (weatherAbort.signal.aborted) return;
            console.error("Failed to fetch weather:", err);
            if (!cancelled && !weatherCache.data) setWeather({ temp: 0, condition: '---' });
          }
        };
        fetchWeather();
      }
    }

    return () => {
      cancelled = true;
      weatherAbort.abort();
      if (batteryObj) {
        try {
          batteryObj.removeEventListener('levelchange', onBatteryLevel);
        } catch {
          /* ignore */
        }
      }
    };
  }, [isOpen, config.showBattery, config.showWeather, config.weatherLocation]);

  const handleAppClick = React.useCallback((app: AppItem) => {
    /**
     * This is the path for a real click on an icon: the tile stops propagation, so the window's
     * `handleMouseUp` — which has this same guard — never gets to see it.
     *
     * The quarantine is for the trained click the user gives ~200ms AFTER a dwell launch has
     * already gone down a level: without it, that click launches whatever happened to be in the
     * same direction on the new level. The dwell engine calls this function through a ref and only
     * marks the quarantine AFTERWARDS — the guard never blocks its own launch, only a following
     * human click.
     */
    if (Date.now() < quarantineUntilRef.current) return;
    /** Echo running: the target is already decided and the wheel on its way out — nothing under it opens anything. */
    if (launchEchoTimerRef.current !== null) return;
    /**
     * Disarm here, and not only on a level change.
     *
     * Every branch below swaps the level synchronously — and it is the level effect that disarms —
     * EXCEPT the recents fetch, which only turns on the spinner and waits for the IPC. In that gap
     * the level is the same, the generation is the same and nothing disarms: a timer already
     * counting over this very tile reached its end and stacked the folder a second time, and the
     * gesture stayed armed to launch whatever the pointer caught while the user waited for the
     * folder they asked for. A click is a choice; whatever was being counted has stopped counting.
     */
    disarmDwell();
    const cfg = configRef.current;
    if (isWorkspacePickItem(app)) {
      const idx = parseWorkspacePickIndex(app.id);
      if (onWorkspaceSwitch) onWorkspaceSwitch(idx);
      const ws = cfg.workspaces[idx];
      if (ws?.enabled) {
        const list = ws.apps;
        setFolderStack([{ label: ws.name, apps: list }]);
        setCurrentLevelApps(list);
        setHasMoved(false);
        setActiveIndex(null);
      }
      return;
    }
    const hasRecentFetch = (app.hasRecents) && window.electron?.getAppRecents;
    const hasManualFolders = app.children && app.children.length > 0;

    if (app.type === 'folder' && app.children) {
      setFolderStack(prev => [...prev, { label: app.label, apps: app.children! }]);
      setCurrentLevelApps(app.children);
      setHasMoved(false);
      setActiveIndex(null);
    } else if (hasRecentFetch || hasManualFolders) {
      setIsLoadingRecents(true);
      const manualFolders = app.children || [];

      if (app.hasRecents && window.electron?.getAppRecents) {
        window.electron!.getAppRecents(app.label, app.command).then(recents => {
          setIsLoadingRecents(false);
          const seenPaths = new Set(manualFolders.map(c => c.command));
          const uniqueRecents = recents.filter(r => !seenPaths.has(r.command));
          const combined = [...manualFolders, ...applyOpenTerminalForRecents(uniqueRecents, app)];

          if (combined.length > 0) {
            setFolderStack(prev => [...prev, { label: app.label, apps: combined }]);
            setCurrentLevelApps(combined);
            setHasMoved(false);
            setActiveIndex(null);
          } else if (app.hasRecents) {
            setIsLoadingRecents(false);
            const fallback = buildRecentsEmptyFallback(app);
            setFolderStack(prev => [...prev, { label: app.label, apps: fallback }]);
            setCurrentLevelApps(fallback);
            setHasMoved(false);
            setActiveIndex(null);
          } else {
            onClose(app.id, app);
          }
        }).catch(() => {
          setIsLoadingRecents(false);
          if (app.hasRecents) {
            const fallback = buildRecentsEmptyFallback(app);
            setFolderStack(prev => [...prev, { label: app.label, apps: fallback }]);
            setCurrentLevelApps(fallback);
            setHasMoved(false);
            setActiveIndex(null);
          } else {
            onClose(app.id, app);
          }
        });
      } else {
        setIsLoadingRecents(false);
        setFolderStack(prev => [...prev, { label: app.label, apps: manualFolders }]);
        setCurrentLevelApps(manualFolders);
        setHasMoved(false);
        setActiveIndex(null);
      }
    } else {
      onClose(app.id, app);
    }
  }, [onClose, onWorkspaceSwitch, disarmDwell]);

  /** `handleAppClick` is not stable; the engine has to call the current render's version every time. */
  const handleAppClickRef = useRef(handleAppClick);
  handleAppClickRef.current = handleAppClick;

  /**
   * Dwell aim engine — three rules that cannot be read off the code.
   *
   * 1. The target is the TRIPLE `{ level, index, id }`, never just the index. A workspace switch
   *    with the mouse wheel, or an MRU resolving late, replaces the level under a still pointer and
   *    keeps the index: a timer tied to the index completed and launched item N of a level the user
   *    never aimed at.
   * 2. On firing, the aim is RESOLVED AGAIN and compared with the arc's. If they do not match, it
   *    starts over instead of launching — the decision always belongs to the pointer of now.
   * 3. Freshness is measured against the raw event's stamp: a pointer outside the radial window
   *    produces no events at all, and in angle mode a frozen point goes on resolving to a perfectly
   *    valid slice.
   */
  const fireDwell = useCallback(() => {
    dwellTimerRef.current = null;
    const target = dwellTargetRef.current;
    if (!target) return;
    if (!dwellEnabledRef.current) return void cancelDwell();
    if (closingRef.current || !stateRef.current.isOpen) return void cancelDwell();
    if (paintReadyAtRef.current === null) return void cancelDwell();
    if (target.gen !== levelGenRef.current) return void cancelDwell();

    /**
     * There is NO "how long since a `mousemove`" check. It looks like the obvious defence against a
     * pointer that left the radial window and froze `lastPointerRef` at a point that, in angle
     * mode, goes on resolving to a slice — but it is the wrong defence: a still hand produces no
     * events at all, and being still is EXACTLY the gesture. With that check the arc closed and
     * nothing launched, ever. Leaving the window is an event (`mouseout` with a null
     * `relatedTarget`, `mouseleave`, `blur`) and that is where it is handled.
     */
    const aim = resolveAimAtPoint(lastPointerRef.current);
    if (aim.isCenter || aim.index === null || aim.index !== target.index) return void cancelDwell();
    const item = stateRef.current.currentLevelApps[aim.index];
    if (!item || item.id !== target.itemId) return void cancelDwell();
    if (gestureConsumedRef.current) return void cancelDwell();
    /**
     * The PREVIOUS launch's quarantine stops this one too.
     *
     * `handleAppClick` already honours it, but honouring it in there is too late: the line below
     * consumes the gesture first, and a call that returns without swapping level leaves nothing
     * behind to release it again — `gestureConsumedRef` is only cleared on a level change and on
     * opening. The result was an inert wheel: neither dwell nor click confirmed anything again.
     *
     * With the 250ms minimum this was unreachable, because the earliest possible second launch fell
     * at paint+120+250 = 370ms, already outside the 300ms. With the optional wait the second launch
     * arrives at ~140ms, and chaining became trivial: opening a folder with a shove leaves the hand
     * still braking, and that braking crosses the threshold again inside it.
     */
    if (Date.now() < quarantineUntilRef.current) return void cancelDwell();

    gestureConsumedRef.current = true;
    logRadialConfirm('dwell', lastPointerRef.current, aim);
    cancelDwell();
    dwellArmedRef.current = false;
    dwellBaselineRef.current = null;
    /**
     * The quarantine is marked AFTER launching, never before: `handleAppClick` opens with the same
     * guard, and marking it first made this call block itself — the dwell counted, the arc closed
     * and absolutely nothing happened. It exists for the next HUMAN click.
     */
    handleAppClickRef.current(item);
    quarantineUntilRef.current = Date.now() + INSTANT_QUARANTINE_MS;
  }, [cancelDwell, disarmDwell, resolveAimAtPoint, logRadialConfirm]);

  /**
   * The hand has settled. Only now does the visible count start — and this is the only point where
   * the arc appears.
   */
  const startDwell = useCallback(() => {
    dwellSettleTimerRef.current = null;
    const pending = dwellPendingRef.current;
    if (!pending) return;
    if (!dwellEnabledRef.current) return void cancelDwell();
    if (closingRef.current || !stateRef.current.isOpen) return void cancelDwell();
    if (paintReadyAtRef.current === null) return void cancelDwell();
    if (isLoadingRecentsRef.current) return void cancelDwell();
    if (pending.gen !== levelGenRef.current) return void cancelDwell();

    /** Re-evaluate: between scheduling and settling, the level may have changed under the pointer. */
    const aim = resolveAimAtPoint(lastPointerRef.current);
    if (aim.isCenter || aim.index === null || aim.index !== pending.index) return void cancelDwell();
    const item = stateRef.current.currentLevelApps[aim.index];
    if (!item || item.id !== pending.itemId) return void cancelDwell();

    /**
     * Re-anchor at the point the hand is at NOW. The previous anchor is the last moving sample, up
     * to 90ms old: keeping it made the count start with the budget already spent.
     */
    if (lastAnchorPointRef.current) dwellAnchorRef.current = lastAnchorPointRef.current;
    dwellPendingRef.current = null;
    dwellTargetRef.current = pending;
    dwellStartedAtRef.current = Date.now();
    dwellSeqRef.current += 1;
    /** With no arc there is no React commit at all in this count — only the `setTimeout` that launches. */
    if (dwellRunMsRef.current >= DWELL_ARC_MIN_MS) {
      setDwellTick({ index: pending.index, key: dwellSeqRef.current });
    }
    dwellTimerRef.current = window.setTimeout(fireDwell, dwellRunMsRef.current);
  }, [cancelDwell, fireDwell, resolveAimAtPoint]);

  const armAndTrackDwell = useCallback(
    (point: { x: number; y: number }, aim: { isCenter: boolean; index: number | null }) => {
      if (!dwellEnabledRef.current) return void cancelDwell();
      if (closingRef.current || !stateRef.current.isOpen) return void cancelDwell();
      /** The wheel has not been through a paint yet: no tile is clickable, nothing can launch. */
      if (paintReadyAtRef.current === null) return void cancelDwell();
      if (isLoadingRecentsRef.current) return void cancelDwell();

      /** The first sample after opening or after a level change only serves to set the reference. */
      if (dwellBaselineRef.current === null) {
        dwellBaselineRef.current = point;
        /**
         * By direction this sample is NOT swallowed. You only get here after the vector has already
         * crossed the threshold (`processMouseMove` returns before that), so this is the committed
         * gesture's first sample — and if the hand stops right here, no other arrives. Returning
         * left the slice lit forever and nothing launching it.
         */
        if (!directionModeRef.current) return;
      }

      if (!dwellArmedRef.current) {
        if (Date.now() - paintReadyAtRef.current < INSTANT_ARM_DELAY_MS) return;
        /**
         * Arming is an observed fact — and by direction the fact has already been observed.
         *
         * The threshold exists because, aiming by position, a STILL pointer far from the centre
         * lights a slice without anyone having moved anything: real displacement had to be seen
         * before letting dwell launch. By direction that state does not exist — the vector is born
         * at zero on every open and every level, and the only thing that takes it past the
         * sensitivity threshold is real movement of the hand. Demanding as much again on top here
         * meant asking for double what the setting advertises (36px on "high", 108px on "low")
         * and, worse, never launching when the hand committed to the direction and stopped — which
         * is literally the gesture the feature describes.
         */
        if (directionModeRef.current) {
          dwellArmedRef.current = true;
        } else {
          const baseline = dwellBaselineRef.current;
          if (Math.hypot(point.x - baseline.x, point.y - baseline.y) < INSTANT_ARM_DISPLACEMENT_PX) {
            return;
          }
          dwellArmedRef.current = true;
        }
      }

      /** The hub never launches by dwell: coming back to the centre is the gesture for giving up. */
      if (aim.isCenter || aim.index === null) return void cancelDwell();
      const level = stateRef.current.currentLevelApps;
      /**
       * A single item in angle mode: the slice is the whole plane, and there is no direction that
       * points at anything else. Aiming stops being choosing, so nothing here can count as intent —
       * this is the empty-MRU fallback level, which exists precisely so the parent IDE never
       * launches on its own. In cursor mode the test is against the icon and still holds.
       */
      if (
        level.length === 1 &&
        (directionModeRef.current || stateRef.current.config.radialSelectionMode !== 'cursor')
      ) {
        return void cancelDwell();
      }
      const item = level[aim.index];
      if (!item) return void cancelDwell();

      const next = { gen: levelGenRef.current, index: aim.index, itemId: item.id };
      const running = dwellTargetRef.current ?? dwellPendingRef.current;
      const anchor = dwellAnchorRef.current;
      const sameTarget =
        !!running &&
        running.gen === next.gen &&
        running.index === next.index &&
        running.itemId === next.itemId;
      /** Already counting: hold tolerance (wide). Still settling: stop tolerance (tight). */
      const holdRadius = dwellTargetRef.current !== null ? DWELL_HOLD_PX : DWELL_SETTLE_PX;
      const stillSettled =
        anchor !== null && Math.hypot(point.x - anchor.x, point.y - anchor.y) <= holdRadius;

      /** Same target and a still hand: the count in progress carries on — a tremor does not restart it. */
      if (sameTarget && stillSettled) return;

      /**
       * Still moving, or a new target: it starts over from here. While the pointer travels, what
       * gets rescheduled is only this `setTimeout`; the `cancelDwell` above no longer commits
       * anything after the first one, so dragging the mouse around the wheel does not cost a render
       * per frame.
       */
      cancelDwell();
      dwellAnchorRef.current = point;
      dwellPendingRef.current = next;
      dwellSettleTimerRef.current = window.setTimeout(startDwell, dwellSettleMsRef.current);
    },
    [cancelDwell, startDwell],
  );

  armAndTrackDwellRef.current = armAndTrackDwell;

  /**
   * The Electron window is larger than the menu so that wide gestures keep receiving mouse events.
   * The visual backdrop, though, follows only the wheel (icons + a small margin) and uses the
   * menu's real position as its centre — important when the radial opens near the monitor's edge.
   */
  const bo = config.backdropOpacity;

  /** Echo in progress, and whether the confirmed target was the hub rather than a slice. */
  const echoActive = launchEcho !== null;
  const centerFired = launchEcho?.index === -1;
  /** The scrim lifts across the echo: the wave ends over the bare desktop, with no cut. */
  const echoStyle = echoActive
    ? ({ ['--zn-echo-ms' as string]: `${launchEchoMs}ms` } as React.CSSProperties)
    : null;


  /**
   * The direction-mode hint, and its one showing.
   *
   * The flag is read straight off `config`, with no per-open snapshot, precisely because it is only
   * ever raised on the CLOSE — while the wheel is up the value cannot change under the reader.
   *
   * `…ShownRef` is this wheel's own record that the hint stood long enough to count;
   * `…ReportedRef` keeps a wheel that is opened and closed repeatedly from telling App again while
   * the saved config is still on its way back down as a prop.
   */
  const directionHintVisible =
    isOpen &&
    !echoActive &&
    bloom &&
    directionMode &&
    !hasMoved &&
    !typeAhead &&
    rawLevelApps.length > 0 &&
    config.hasSeenDirectionHint !== true;

  const directionHintShownRef = useRef(false);
  const directionHintReportedRef = useRef(false);
  const onDirectionHintSeenRef = useRef(onDirectionHintSeen);
  onDirectionHintSeenRef.current = onDirectionHintSeen;

  useEffect(() => {
    if (!directionHintVisible || directionHintShownRef.current) return;
    const timer = setTimeout(() => {
      directionHintShownRef.current = true;
    }, DIRECTION_HINT_SEEN_MS);
    return () => clearTimeout(timer);
  }, [directionHintVisible]);

  const reportDirectionHintSeen = useCallback(() => {
    if (!directionHintShownRef.current || directionHintReportedRef.current) return;
    directionHintReportedRef.current = true;
    onDirectionHintSeenRef.current?.();
  }, []);

  useEffect(() => {
    if (isOpen) return;
    reportDirectionHintSeen();
  }, [isOpen, reportDirectionHintSeen]);

  /** The other way out: a wheel remounted by `radialMountKey` never sees `isOpen` fall. */
  useEffect(() => reportDirectionHintSeen, [reportDirectionHintSeen]);

  const backdropRadius = Math.ceil(
    actualMenuRadius + actualIconSize * 0.75 + Math.max(18, minGap),
  );

  /**
   * The window is `transparent: true` over the desktop, so `backdrop-filter` has nothing to sample
   * on Windows — we only composite alpha. Two design consequences:
   *
   * 1. Legibility does NOT depend on the scrim: every icon and every pill already carries its own
   *    background at 0.92 and a border. The scrim is only there to focus. So it can be light —
   *    and it was the weight that produced the grey smear over light desktops.
   * 2. No uniform alpha on `inset-0`: it paints the window's rectangle and gives it away as a
   *    square on the screen. The scrim has to be only the radial pool, reaching true zero inside
   *    the window's bounds — with no straight edge anywhere.
   */
  /** Memoised: rebuilding the string on every hover forced Chromium to repaint a full-screen gradient. */
  const overlayDim = React.useMemo(
    () => radialScrimGradient(position, bo, backdropRadius),
    [bo, backdropRadius, position.x, position.y],
  );

  return (
    <div
      data-zenith-radial-modal="true"
      className={`fixed inset-0 z-[70] ${config.performanceMode ? 'zn-radial--fast' : ''} ${isOpen ? '' : 'zn-radial--closing'} ${directionMode ? 'zn-radial--nocursor' : ''}`}
      style={{
        /* No delay on close — otherwise the radial HUD stayed visible over/behind the compact island. */
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
    >
        <>
          {/* A single scrim (no radial mask — avoids a halo / “glow” around the radial) */}
          <div
            className={`zn-radial-scrim fixed inset-0 z-[2]${echoActive ? ' zn-launch-scrim' : ''}`}
            style={{
              pointerEvents: isOpen && !echoActive ? 'auto' : 'none',
              background: overlayDim,
              ['--zn-op' as string]: isOpen && bloom ? 1 : 0,
              ['--zn-dur-op' as string]: isOpen ? '150ms' : '100ms',
              willChange: 'opacity',
              ...echoStyle,
            }}
          />

          <RadialHud
            /** Clock, battery and weather leave with the rest of the wheel — the echo leaves only the icon on screen. */
            isOpen={isOpen && bloom && !echoActive}
            config={config}
            batteryLevel={batteryLevel}
            weather={weather}
          />

          {/*
            What has been typed, and what it left. Fixed to the viewport rather than hung off the
            ring: the ring's radius changes with every keystroke that changes the match count, and
            a readout that moved while being read would be the one thing worse than no readout.
          */}
          {isOpen && !echoActive && typeAhead && (
            <div className="zn-radial-filter" role="status" aria-live="polite">
              <span className="zn-radial-filter-query">{typeAhead}</span>
              <span className="zn-radial-filter-count">
                {currentLevelApps.length === 0
                  ? 'no matches'
                  : `${currentLevelApps.length} of ${rawLevelApps.length}`}
              </span>
            </div>
          )}

          {/*
            An empty wheel that is empty ON PURPOSE, said in the same place and the same plate as
            the type-ahead readout — the two can never be on screen together, since a filter needs
            something to filter. Only at the root: an empty FOLDER is empty because it is empty.
          */}
          {isOpen && !echoActive && !typeAhead && discoveryPhase !== 'idle' && rawLevelApps.length === 0 && folderStack.length === 0 && (
            <div className="zn-radial-filter is-notice" role="status" aria-live="polite">
              <span className="zn-radial-filter-count">
                {discoveryPhase === 'scanning'
                  ? 'Looking through your Start menu…'
                  : 'Your apps are on their way — this wheel fills itself in a moment.'}
              </span>
            </div>
          )}

          {/*
            How to leave without launching anything — the one thing direction mode gives no way to
            work out. The pointer is HIDDEN in this mode, so the usual answer (move away and click
            nothing) is not available, and until now the countdown arc was the only thing on screen
            that acknowledged the mode at all.

            Only until the hand moves. From that moment the arc is the explanation and the user is
            aiming, not deciding whether to.

            And only once, ever. Shown again on every open it became furniture for anyone who uses
            this daily — read the first time, then a thing to look past for the next thousand. It is
            spent the first time it has stood for `DIRECTION_HINT_SEEN_MS` (see
            `directionHintVisible`), which is what keeps a spend from happening on an open where it
            merely flickered.
          */}
          {directionHintVisible && (
            <div className="zn-radial-filter is-hint" role="note">
              <span className="zn-radial-filter-count">
                Push toward a target to open it — or press <kbd>Esc</kbd> to close the wheel.
              </span>
            </div>
          )}

          {/* Menu Container */}
          <div
            ref={menuRef}
            style={{
              left: Math.round(position.x),
              top: Math.round(position.y),
              width: 0,
              height: 0,
            }}
            className="fixed z-[10] pointer-events-none"
            tabIndex={-1}
          >

            {/*
              Centre target: a transparent SQUARE over the hub, slightly larger than it.
              The hub is `rounded-full`, and `border-radius` clips the hit test too — a click on the
              box's corner misses it, passes through to the overlay and becomes a direction.
              This was what opened the slice on that side with the cursor visibly inside the button.
              Here the target depends on no threshold at all: inside the square it is always the centre.
            */}
            {isOpen && (
              <div
                data-zn-radial-center="true"
                className="absolute top-0 left-0 z-30 pointer-events-auto cursor-pointer"
                style={{
                  width: `${hubHitSize}px`,
                  height: `${hubHitSize}px`,
                  transform: 'translate(-50%, -50%)',
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCenterActivate();
                }}
                aria-hidden
              />
            )}

            {/*
              The same wave as the tile's, around the hub, when it is the centre that launches.
              Circular because the hub is circular — the wave still comes out of the silhouette of
              what was confirmed.
            */}
            {centerFired && (
              <>
                <span
                  className="zn-launch-wave absolute top-0 left-0 pointer-events-none z-10"
                  style={{
                    width: `${hubDiameter + 6}px`,
                    height: `${hubDiameter + 6}px`,
                    borderRadius: '50%',
                    border: `2px solid ${radialHoverColor}`,
                    ['--zn-echo-ms' as string]: `${launchEchoMs}ms`,
                  }}
                  aria-hidden
                />
                <span
                  className="zn-launch-wave zn-launch-wave--late absolute top-0 left-0 pointer-events-none z-10"
                  style={{
                    width: `${hubDiameter + 6}px`,
                    height: `${hubDiameter + 6}px`,
                    borderRadius: '50%',
                    border: `2px solid ${radialHoverColor}`,
                    ['--zn-echo-ms' as string]: `${launchEchoMs}ms`,
                  }}
                  aria-hidden
                />
              </>
            )}

            {/* Central Hub */}
            <div
              className={`
                zn-radial-hub absolute top-0 left-0
                rounded-full flex items-center justify-center z-20
                ${centerFired ? 'zn-launch-pop-center' : ''}
                ${isOpen ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none cursor-default'}
                ${isCenterActive ? '' : 'text-white/70'}
              `}
              style={{
                /** Even side: `translate(-50%)` of an odd number lands on a half pixel and jags the circle. */
                width: `${hubDiameter}px`,
                height: `${hubDiameter}px`,
                /**
                 * No border and no 1px ring. On a circle, a thin high-contrast line is what makes
                 * every antialiasing step visible: the eye follows the line and watches it thicken
                 * and thin. Here the disc is defined by its own fill — a filled→transparent
                 * transition, which is the case the rasteriser handles best — and its separation
                 * from the desktop comes from DIFFUSE shadows, which have no edge to jag. The
                 * background goes from .78 to .90 because there is no longer a ring holding the
                 * outline over a light wallpaper.
                 */
                backgroundColor: isCenterActive ? radialHoverColor : 'rgba(6,7,9,0.90)',
                /** The border is not CSS — it is an SVG `<circle>` inside. See the ring's comment. */
                border: 'none',
                color: isCenterActive ? radialHoverForeground : undefined,
                boxShadow: isCenterActive
                  ? `0 0 22px ${radialHoverColor}3d, 0 8px 22px rgba(0,0,0,0.55)`
                  : '0 1px 3px rgba(0,0,0,0.55), 0 8px 20px rgba(0,0,0,0.5)',
                ['--zn-tf' as string]: `translate(-50%, -50%) scale(${bloom ? (isCenterActive ? 1.06 : 1) : 0.82})`,
                /**
                 * A slice launching fades the hub, just as it fades the other slices: the echo
                 * isolates what was chosen, and the hub is the part of the wheel that would compete
                 * hardest with it — it is the only other large opaque object on screen. When it is
                 * IT that launches, `zn-launch-pop-center`'s animation rules and this opacity never
                 * gets read.
                 */
                ['--zn-op' as string]: echoActive && !centerFired ? 0 : bloom ? 1 : 0,
                ['--zn-dur' as string]: '130ms',
                ...(echoActive && !centerFired ? { ['--zn-dur-op' as string]: '140ms' } : null),
                ...(centerFired ? { ['--zn-echo-ms' as string]: `${launchEchoMs}ms` } : null),
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
            >
              {/*
                Update badge. Informative, never clickable: the centre is the gesture for closing,
                and a target glued to it reintroduced the class of swapped-click bugs that cost a
                whole session to fix. The action lives in Settings.

                The arrow is drawn, not a typographic glyph: a glyph brings its own side bearings
                and baseline, and in a 24px circle that is enough to set it crooked. The points
                below come from the INK's bounds — a 1.7 stroke with round caps grows 0.85 past each
                end — and not from the bare geometry.
              */}
              {updateReady && (
                <span
                  className="absolute pointer-events-none"
                  style={{
                    top: -Math.round(hubDiameter * 0.03),
                    right: -Math.round(hubDiameter * 0.03),
                    width: Math.round(hubDiameter * 0.32),
                    height: Math.round(hubDiameter * 0.32),
                    borderRadius: '50%',
                    background: '#0A84FF',
                    /** Ring in the background colour: it separates from the hub without adding a new outline. */
                    border: `${Math.max(2, Math.round(hubDiameter * 0.026))}px solid #0a0a0a`,
                    boxSizing: 'border-box',
                    zIndex: 40,
                  }}
                  aria-label="Update ready"
                >
                  <svg viewBox="0 0 24 24" fill="none" style={{ display: 'block', width: '100%', height: '100%' }}>
                    <path
                      d="M12 7.2V13.6M8.9 10.5L12 13.6l3.1-3.1M7.7 16.7h8.6"
                      stroke="#fff"
                      strokeWidth={1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              )}

              {/*
                The ring is an SVG `<circle>`, not a CSS `border`.
                They are two different rasterisers: the border of a box with `border-radius` is
                drawn as four corner arcs stitched around a rectangle, and it is at those seams —
                and in the fractional width — that the steps and the wobbling thickness show up. A
                `<circle>` is ONE vector path, stroked in a single pass by Skia with
                `geometricPrecision`: coverage is computed from the real distance to the arc, the
                same all the way round. `vectorEffect` keeps the stroke at the same thickness when
                the hub scales, instead of stretching it with the texture.
              */}
              <svg
                className="absolute inset-0 pointer-events-none"
                width={hubDiameter}
                height={hubDiameter}
                viewBox={`0 0 ${hubDiameter} ${hubDiameter}`}
                shapeRendering="geometricPrecision"
                aria-hidden
              >
                <circle
                  cx={hubDiameter / 2}
                  cy={hubDiameter / 2}
                  /** Half a stroke inwards: that way the ring lines up with the disc's edge. */
                  r={(hubDiameter - 1.5) / 2}
                  fill="none"
                  stroke={isCenterActive ? radialHoverColor : 'rgba(255,255,255,0.30)'}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              {isLoadingRecents ? (
                <div className="flex flex-col items-center justify-center animate-in fade-in duration-300">
                  <div className="w-6 h-6 border-2 border-white/10 border-t-white/60 rounded-full animate-spin" />
                </div>
              ) : isRoot ? (
                <div
                  className={`flex items-center justify-center transition-opacity duration-150 ${isCenterActive ? 'opacity-100' : 'opacity-70'}`}
                >
                  <RovylLogo
                    size={Math.round(actualIconSize * 0.64)}
                    color={isCenterActive ? radialHoverForeground : '#F4F2ED'}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-1">
                  {/* Inside a folder the center remains the explicit Back control. */}
                  <CornerUpLeft size={Math.round(actualIconSize * 0.45)} strokeWidth={1.5} />
                  {!isCenterActive && (
                      <div className="flex gap-0.5 mt-0.5">
                        {folderStack.map((_, i) => (
                          <div key={i} className="w-1 h-1 rounded-full bg-white/40" />
                        ))}
                      </div>
                  )}
                </div>
              )}
            </div>

            {/* Context pill: where you are in the wheel + the gesture that goes back. */}
            <div
              className="zn-radial-pill absolute left-0 top-0 pointer-events-none z-30"
              style={{
                ['--zn-tf' as string]: `translate(-50%, 0) translate3d(0, ${Math.round(
                  actualMenuRadius + actualIconSize * 0.75 + 34,
                )}px, 0)`,
                /** Where you are in the wheel stops being information the moment you leave it. */
                ['--zn-op' as string]: isOpen && bloom && !echoActive ? 1 : 0,
                ...(echoActive ? { ['--zn-dur-op' as string]: '130ms' } : null),
              }}
            >
              <div
                className="flex items-center gap-2 px-3 py-1.5 rounded-full whitespace-nowrap"
                style={{
                  /* Opaque on its own: a translucent white wash disappeared over light desktops. */
                  background: 'rgba(4,5,7,0.92)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
                }}
              >
                {/* Inside a workspace its name is enough — "Rovyl" identifies the root. */}
                {(isRoot ? ['Rovyl'] : folderStack.map((level) => level.label)).map((label, i) => (
                  <React.Fragment key={`${label}-${i}`}>
                    {i > 0 && <span className="text-[11px] leading-none text-white/25">/</span>}
                    <span
                      className="text-[11px] leading-none text-white/60"
                      style={{ fontFamily: 'var(--font-radial)', fontWeight: 500 }}
                    >
                      {label}
                    </span>
                  </React.Fragment>
                ))}
                <span
                  className="text-[10px] leading-none text-white/45 px-1.5 py-1 rounded-[5px]"
                  style={{ background: 'rgba(255,255,255,0.09)' }}
                >
                  {isRoot ? centerLabel : uiString('menu.back')}
                </span>
              </div>
            </div>

            {/* App Icons — the swap between levels is the bloom itself (see the `bloom` effect). */}
            {currentLevelApps.map((app, index) => {
                /**
                 * During the echo the highlight is the CONFIRMED TARGET, not the aim. The two
                 * diverge: the pointer goes on producing events over a wheel that is already
                 * leaving, and one of them swapped the tile's background colour halfway through the
                 * wave — the confirmed icon lost the highlight and an invisible neighbour got it.
                 */
                const isActive = launchEcho ? launchEcho.index === index : index === activeIndex;
                let angularDistance: number | null = null;
                if (activeIndex !== null) {
                  const raw = Math.abs(index - activeIndex);
                  angularDistance = Math.min(raw, currentLevelApps.length - raw);
                }
                /* Workspace slices carry the 1–9 global shortcut, which was previously invisible. */
                const shortcutHint = isWorkspacePickItem(app)
                  ? String(parseWorkspacePickIndex(app.id) + 1)
                  : undefined;
                return (
                  <RadialMenuItem
                    key={`${app.id}-${folderStack.length}-${index}`}
                    app={app}
                    index={index}
                    isActive={isActive}
                    angularDistance={angularDistance}
                    actualMenuRadius={actualMenuRadius}
                    actualIconSize={actualIconSize}
                    totalApps={currentLevelApps.length}
                    backdropOpacity={config.backdropOpacity}
                    hoverColor={radialHoverColor}
                    showLabels={config.showLabels}
                    alwaysShowAppLabels={config.alwaysShowAppLabels ?? false}
                    folderStackLength={folderStack.length}
                    bloom={isOpen && bloom}
                    shortcutHint={shortcutHint}
                    /** `undefined` on every other tile — their `React.memo` is not invalidated. */
                    dwellMs={dwellTick && dwellTick.index === index ? dwellRunMsRef.current : undefined}
                    dwellKey={dwellTick && dwellTick.index === index ? dwellTick.key : undefined}
                    /** Outside the echo it is `undefined` across the whole wheel — no tile loses its memo over this. */
                    echo={launchEcho ? (launchEcho.index === index ? 'fired' : 'faded') : undefined}
                    echoMs={launchEcho ? launchEchoMs : undefined}
                    onClick={handleAppClick}
                  />
                );
              })}
          </div>
        </>
    </div>
  );
};

export const RadialMenu = React.memo(RadialMenuInner);
