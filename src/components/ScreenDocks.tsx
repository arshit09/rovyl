import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Battery, Cable, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import type { AppItem, SystemPanel, SystemStatus } from '../types';
import {
  shortcutDockIsActive,
  statusDockIsActive,
  type DockPosition,
  type ShortcutDockConfig,
  type StatusDockConfig,
} from '../utils/screenDocks';
import { formatWheelString, type WheelStrings } from '../i18n/wheel';
import { getIcon } from '../iconMap';
import { SmartIcon } from './SmartIcon';

/**
 * The two strips beside the open wheel.
 *
 * One component draws both, and that is not tidiness — it is the only way the shared-region case
 * works. Each dock is placed independently, so both can be asked for `bottom-right`; placed by
 * two components they would be two `position: fixed` boxes against the same edge, drawn on top of
 * one another. Here a region is a single shell and whatever lands in it is stacked inside.
 *
 * Nothing in this file animates with framer-motion. This module is in the wheel's critical chunk,
 * which `scripts/verify-renderer-budget.mjs` measures — the enter/exit rides on `.zn-radial-pill`,
 * the same three CSS variables every other thing that arrives with the wheel uses.
 */

/* -- Geometry ------------------------------------------------------------- */

/** Padding inside a dock's plate, top and bottom, plus its 1px border on each side. */
const DOCK_PLATE_PADDING = 6;
const DOCK_PLATE_BORDER = 1;
/** Height of the name under a shortcut when labels are on. */
const SHORTCUT_LABEL_HEIGHT = 14;
/** Space between two docks that landed in the same region. */
const DOCK_STACK_GAP = 8;

function plateHeight(contentHeight: number): number {
  return contentHeight + 2 * DOCK_PLATE_PADDING + 2 * DOCK_PLATE_BORDER;
}

export function statusDockHeight(dock: StatusDockConfig): number {
  /** The glyphs are the tallest thing on the plate; the readout text is set to fit beside them. */
  return plateHeight(Math.max(dock.iconSize, 16));
}

export function shortcutDockHeight(dock: ShortcutDockConfig): number {
  return plateHeight(dock.iconSize + (dock.showLabels ? SHORTCUT_LABEL_HEIGHT : 0));
}

/**
 * How much room the docks take in one region, for anything else placed against that same edge.
 *
 * The settings gear is the only such thing today, and it steps inboard by exactly this. It is a
 * function rather than a measurement because the gear is positioned before either dock has laid
 * out — reading the DOM would give it last frame's answer, which on the first open is no answer.
 */
export function dockStackHeight(
  position: DockPosition,
  status: StatusDockConfig,
  shortcuts: ShortcutDockConfig,
): number {
  const heights: number[] = [];
  if (statusDockIsActive(status) && status.position === position) heights.push(statusDockHeight(status));
  if (shortcutDockIsActive(shortcuts) && shortcuts.position === position) {
    heights.push(shortcutDockHeight(shortcuts));
  }
  if (heights.length === 0) return 0;
  return heights.reduce((sum, height) => sum + height, 0) + (heights.length - 1) * DOCK_STACK_GAP;
}

function regionShellClass(position: DockPosition): string {
  const base = 'zn-dock-shell';
  const vertical = position.startsWith('top') ? 'top-0' : 'bottom-0';
  if (position.endsWith('center')) return `${base} ${vertical} inset-x-0 justify-center`;
  if (position.endsWith('right')) return `${base} ${vertical} right-0 justify-end`;
  return `${base} ${vertical} left-0 justify-start`;
}

function regionAlignClass(position: DockPosition): string {
  if (position.endsWith('center')) return 'items-center';
  if (position.endsWith('right')) return 'items-end';
  return 'items-start';
}

/* -- Mouse ---------------------------------------------------------------- */

/**
 * Every mouse event a dock takes is stopped dead.
 *
 * The wheel confirms its aim from a `mouseup` on the WINDOW — anywhere on it, because by direction
 * the target is a vector and not whatever the pointer is over. A click that reached the window
 * would launch a dock icon AND whichever slice the corner happens to point at. React 17+
 * propagates `stopPropagation` to the native event, which is what keeps that listener out.
 */
function swallow(event: React.MouseEvent | React.PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
}

const swallowProps = {
  onMouseDown: swallow,
  onMouseUp: swallow,
  onAuxClick: swallow,
  onContextMenu: swallow,
};

/* -- The system readouts --------------------------------------------------- */

function useClock(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    /**
     * Aligned to the next minute rather than ticking every second. The readout has no seconds on
     * it, so a per-second timer would be 59 renders nobody can see — on the wheel's own renderer,
     * during the one gesture that has a frame budget.
     */
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const date = new Date();
      const delay = (60 - date.getSeconds()) * 1000 - date.getMilliseconds();
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, Math.max(1000, delay));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active]);
  return now;
}

function NetworkGlyph({ status, size }: { status: SystemStatus; size: number }) {
  if (status.network === 'ethernet') return <Cable size={size} strokeWidth={1.8} aria-hidden />;
  if (status.network === 'none') return <WifiOff size={size} strokeWidth={1.8} aria-hidden />;
  return <Wifi size={size} strokeWidth={1.8} aria-hidden />;
}

function networkTitle(status: SystemStatus, strings: WheelStrings): string {
  if (status.network === 'ethernet') return strings.dockNetWired;
  if (status.network === 'none') return strings.dockNetNone;
  if (status.network === 'other') return strings.dockNetOther;
  return status.signal >= 0
    ? formatWheelString(strings.dockNetWifiSignal, { percent: status.signal })
    : strings.dockNetWifi;
}

/**
 * The battery, drawn rather than glyphed.
 *
 * A Lucide `Battery` is an outline at a fixed level; what a person reads off a battery indicator is
 * the FILL. So the shape carries a bar whose width is the charge, and the glyph is used only for
 * the charging bolt, which is a state and not a quantity.
 */
function BatteryMeter({ status, size }: { status: SystemStatus; size: number }) {
  const width = Math.round(size * 1.55);
  const height = Math.round(size * 0.72);
  const level = Math.max(0, Math.min(100, status.battery));
  return (
    <span className="zn-dock-battery" style={{ width, height }} aria-hidden>
      <span
        className="zn-dock-battery-fill"
        style={{
          width: `${level}%`,
          /** Red only below 20% and only off the charger: a charging low battery is not a warning. */
          background: level < 20 && !status.charging ? '#f87171' : undefined,
        }}
      />
      {/*
        The bolt is drawn here rather than taken from Lucide, because every battery glyph in the
        set INCLUDES the battery — `BatteryCharging` laid over this shape is a battery inside a
        battery. It is also outlined rather than filled: at 8% it sits over the dark empty part of
        the meter and at 95% over the bright fill, and one flat colour disappears into one of them.
      */}
      {status.charging && (
        <svg className="zn-dock-battery-bolt" viewBox="0 0 24 24" width={Math.round(height * 0.95)} height={Math.round(height * 0.95)}>
          <path d="M13 2 4.5 13.5H11l-1 8.5 9-11.5h-6.5z" />
        </svg>
      )}
    </span>
  );
}

/**
 * The volume bar, which is also the control.
 *
 * Dragging is done on pointer events with capture, not on `mousemove` over the element: the pointer
 * leaves a 60px-tall bar within a few pixels of movement, and a drag that stops the moment the hand
 * strays outside the track is a slider that feels broken. Capture keeps the events coming until the
 * button is released, wherever the pointer has got to.
 */
function VolumeControl({
  status,
  size,
  strings,
  onVolume,
  onMute,
}: {
  status: SystemStatus;
  size: number;
  strings: WheelStrings;
  onVolume: (percent: number) => void;
  onMute: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  /**
   * What the hand is doing, which outranks what the machine last said.
   *
   * The reading comes back from a helper polling once a second. Without this the bar would snap
   * back to the old value between the drag and the next poll — the classic "it does not move".
   */
  const [dragging, setDragging] = useState<number | null>(null);
  const known = status.volume >= 0 ? status.volume : 0;
  const shown = dragging ?? known;
  const unavailable = status.volume < 0;

  const percentAt = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100);
  }, []);

  const trackWidth = Math.round(size * 3.4);

  return (
    <span className="zn-dock-volume">
      <button
        type="button"
        className="zn-dock-icon-button"
        title={status.muted ? strings.dockUnmute : strings.dockMute}
        aria-label={status.muted ? strings.dockUnmuteAria : strings.dockMuteAria}
        tabIndex={-1}
        {...swallowProps}
        onClick={(event) => {
          swallow(event);
          onMute();
        }}
      >
        {status.muted || shown === 0
          ? <VolumeX size={size} strokeWidth={1.8} aria-hidden />
          : <Volume2 size={size} strokeWidth={1.8} aria-hidden />}
      </button>
      <div
        ref={trackRef}
        className={`zn-dock-volume-track${unavailable ? ' is-idle' : ''}`}
        style={{ width: trackWidth }}
        role="slider"
        aria-label="Output volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        title={unavailable
          ? strings.dockVolumeNone
          : formatWheelString(strings.dockVolumeLevel, { percent: shown })}
        {...swallowProps}
        onPointerDown={(event) => {
          if (unavailable) return;
          swallow(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          const next = percentAt(event.clientX);
          setDragging(next);
          onVolume(next);
        }}
        onPointerMove={(event) => {
          if (dragging === null) return;
          const next = percentAt(event.clientX);
          if (next === dragging) return;
          setDragging(next);
          onVolume(next);
        }}
        onPointerUp={(event) => {
          if (dragging === null) return;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            /* the capture was already gone */
          }
          /**
           * Handing control back to the reading only once the helper has had time to answer.
           * Dropping it on `pointerup` shows the pre-drag level for one poll, which reads as the
           * slider springing back.
           */
          window.setTimeout(() => setDragging(null), 1200);
        }}
        onPointerCancel={() => setDragging(null)}
      >
        <span className="zn-dock-volume-fill" style={{ width: `${status.muted ? 0 : shown}%` }} />
      </div>
    </span>
  );
}

function StatusDockPlate({
  dock,
  status,
  strings,
  onOpenPanel,
  onVolume,
  onMute,
  active,
}: {
  dock: StatusDockConfig;
  status: SystemStatus;
  strings: WheelStrings;
  onOpenPanel: (panel: SystemPanel) => void;
  onVolume: (percent: number) => void;
  onMute: () => void;
  active: boolean;
}) {
  const now = useClock(active && dock.showClock);
  const size = dock.iconSize;
  /** The readout text tracks the icon size, so one slider moves the whole strip coherently. */
  const textSize = Math.max(10, Math.round(size * 0.62));

  const time = useMemo(
    () => now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    [now],
  );
  const date = useMemo(
    () => now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
    [now],
  );

  /** A machine with no battery must not show an empty one; -1 is "there is none to report". */
  const batteryKnown = status.battery >= 0;
  const empty = !dock.showClock && !dock.showNetwork && !dock.showVolume && !batteryKnown;

  return (
    <div
      className="zn-dock-plate"
      style={{ gap: dock.gap, padding: `${DOCK_PLATE_PADDING}px ${DOCK_PLATE_PADDING + 4}px`, fontSize: textSize }}
      {...swallowProps}
    >
      {dock.showVolume && (
        <VolumeControl status={status} size={size} strings={strings} onVolume={onVolume} onMute={onMute} />
      )}

      {dock.showNetwork && (
        <button
          type="button"
          className="zn-dock-icon-button"
          title={formatWheelString(strings.dockNetOpenSettings, { name: networkTitle(status, strings) })}
          aria-label={networkTitle(status, strings)}
          tabIndex={-1}
          {...swallowProps}
          onClick={(event) => {
            swallow(event);
            onOpenPanel('network');
          }}
        >
          <NetworkGlyph status={status} size={size} />
          {status.network === 'wifi' && status.signal >= 0 && (
            <span className="zn-dock-readout">{status.signal}%</span>
          )}
        </button>
      )}

      {dock.showBattery && batteryKnown && (
        <button
          type="button"
          className="zn-dock-icon-button"
          title={formatWheelString(
            status.charging ? strings.dockBatteryCharging : strings.dockBatteryLevel,
            { percent: status.battery },
          )}
          aria-label={formatWheelString(strings.dockBatteryAria, { percent: status.battery })}
          tabIndex={-1}
          {...swallowProps}
          onClick={(event) => {
            swallow(event);
            onOpenPanel('battery');
          }}
        >
          <BatteryMeter status={status} size={size} />
          <span className="zn-dock-readout">{status.battery}%</span>
        </button>
      )}

      {/*
        A dock switched on for the battery alone, on a machine that has none, would otherwise be an
        empty plate sitting in the corner with no way to tell it from a bug. It says which it is.
      */}
      {empty && (
        <span className="zn-dock-readout zn-dock-idle">
          <Battery size={size} strokeWidth={1.8} aria-hidden /> No battery
        </span>
      )}

      {dock.showClock && (
        <button
          type="button"
          className="zn-dock-icon-button zn-dock-clock"
          title="Click for Windows date and time settings"
          aria-label={`Time ${time}, ${date}`}
          tabIndex={-1}
          {...swallowProps}
          onClick={(event) => {
            swallow(event);
            onOpenPanel('clock');
          }}
        >
          <span className="zn-dock-clock-time">{time}</span>
          <span className="zn-dock-clock-date" style={{ fontSize: Math.max(9, textSize - 3) }}>{date}</span>
        </button>
      )}
    </div>
  );
}

/* -- The user's own icons --------------------------------------------------- */

function ShortcutTile({
  item,
  size,
  showLabel,
  onLaunch,
  onHover,
}: {
  item: AppItem;
  size: number;
  showLabel: boolean;
  onLaunch: (item: AppItem) => void;
  onHover?: () => void;
}) {
  /**
   * The bitmap, with the glyph behind it.
   *
   * `customIconUrl` names a file the main process keeps in userData and there are ordinary ways for
   * it to be gone — a profile copied by hand, an icon collected while its reference was in flight.
   * Choosing between image and glyph in the parent would render NOTHING when the image fails, which
   * is the failure the wheel already learned to avoid.
   */
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.customIconUrl]);
  const Glyph = getIcon(item.iconName?.trim() || 'AppWindow');
  const glyphSize = Math.round(size * 0.58);

  return (
    <button
      type="button"
      className="zn-dock-tile"
      style={{ width: size, height: size + (showLabel ? SHORTCUT_LABEL_HEIGHT : 0) }}
      title={item.label}
      aria-label={item.label}
      tabIndex={-1}
      {...swallowProps}
      onPointerEnter={onHover}
      onClick={(event) => {
        swallow(event);
        onLaunch(item);
      }}
    >
      <span className="zn-dock-tile-art" style={{ width: size, height: size }}>
        {item.customIconUrl && !failed ? (
          <SmartIcon
            src={item.customIconUrl}
            className="zn-dock-tile-image"
            displayScale={0.72}
            onError={() => setFailed(true)}
          />
        ) : (
          <Glyph size={glyphSize} strokeWidth={1.7} aria-hidden />
        )}
      </span>
      {showLabel && (
        <span className="zn-dock-tile-label" style={{ width: size }}>{item.label}</span>
      )}
    </button>
  );
}

function ShortcutDockPlate({
  dock,
  onLaunch,
  onHover,
}: {
  dock: ShortcutDockConfig;
  onLaunch: (item: AppItem) => void;
  onHover?: () => void;
}) {
  return (
    <div
      className="zn-dock-plate"
      style={{ gap: dock.gap, padding: `${DOCK_PLATE_PADDING}px` }}
      {...swallowProps}
    >
      {dock.items.map((item) => (
        <ShortcutTile
          key={item.id}
          item={item}
          size={dock.iconSize}
          showLabel={dock.showLabels}
          onLaunch={onLaunch}
          onHover={onHover}
        />
      ))}
    </div>
  );
}

/* -- Both, placed --------------------------------------------------------- */

export interface ScreenDocksProps {
  /** True only while the wheel is fully up: drives the enter/exit and stops the clock when it is not. */
  isOpen: boolean;
  status: StatusDockConfig;
  shortcuts: ShortcutDockConfig;
  systemStatus: SystemStatus;
  /** The wheel's pack, handed down: the docks paint in the wheel's own first frame. */
  strings: WheelStrings;
  onLaunch: (item: AppItem) => void;
  onOpenPanel: (panel: SystemPanel) => void;
  onVolume: (percent: number) => void;
  onMute: () => void;
  /** A shortcut icon came under the pointer — the wheel's hover note, when that is switched on. */
  onShortcutHover?: () => void;
  /** `performanceMode` and the closing state come from the wheel's own classes; nothing else is needed. */
  reduceMotion?: boolean;
}

export const ScreenDocks: React.FC<ScreenDocksProps> = ({
  isOpen,
  status,
  shortcuts,
  systemStatus,
  strings,
  onLaunch,
  onOpenPanel,
  onVolume,
  onMute,
  onShortcutHover,
}) => {
  const statusOn = statusDockIsActive(status);
  const shortcutsOn = shortcutDockIsActive(shortcuts);
  if (!statusOn && !shortcutsOn) return null;

  const regions = new Set<DockPosition>();
  if (statusOn) regions.add(status.position);
  if (shortcutsOn) regions.add(shortcuts.position);

  return (
    <>
      {[...regions].map((position) => {
        const isBottom = !position.startsWith('top');
        /**
         * Sharing a region: the readouts sit closest to the edge — where Windows puts them, so the
         * eye already knows to look there — and the shortcuts step inboard.
         */
        const plates: React.ReactNode[] = [];
        const statusPlate = statusOn && status.position === position ? (
          <StatusDockPlate
            key="status"
            dock={status}
            status={systemStatus}
            strings={strings}
            active={isOpen}
            onOpenPanel={onOpenPanel}
            onVolume={onVolume}
            onMute={onMute}
          />
        ) : null;
        const shortcutPlate = shortcutsOn && shortcuts.position === position ? (
          <ShortcutDockPlate key="shortcuts" dock={shortcuts} onLaunch={onLaunch} onHover={onShortcutHover} />
        ) : null;
        if (isBottom) {
          if (shortcutPlate) plates.push(shortcutPlate);
          if (statusPlate) plates.push(statusPlate);
        } else {
          if (statusPlate) plates.push(statusPlate);
          if (shortcutPlate) plates.push(shortcutPlate);
        }

        return (
          <div className={regionShellClass(position)} key={position}>
            <div
              className={`zn-radial-pill zn-dock-stack ${regionAlignClass(position)}`}
              style={{
                gap: DOCK_STACK_GAP,
                ['--zn-tf' as string]: `translate3d(0, ${isOpen ? 0 : (isBottom ? 10 : -10)}px, 0)`,
                ['--zn-op' as string]: isOpen ? 1 : 0,
                ['--zn-dur' as string]: isOpen ? '260ms' : '140ms',
                ['--zn-dur-op' as string]: isOpen ? '200ms' : '120ms',
                pointerEvents: isOpen ? 'auto' : 'none',
              }}
            >
              {plates}
            </div>
          </div>
        );
      })}
    </>
  );
};

/**
 * The live readings, subscribed to only while a dock that needs them is switched on.
 *
 * It lives here rather than in `RadialApp` because the thing that decides whether a helper is worth
 * running is the dock's own configuration, and that is what this file is about. Telling main is
 * part of the same decision: a hook that subscribed without also saying so would leave the wheel
 * listening to a channel nobody is producing on.
 */
export function useSystemStatus(needsHelper: boolean): SystemStatus {
  const [status, setStatus] = useState<SystemStatus>(() => ({
    volume: -1,
    muted: false,
    network: 'none',
    signal: -1,
    battery: -1,
    charging: false,
  }));

  useEffect(() => {
    window.electron?.setStatusDockActive?.(needsHelper);
    if (!needsHelper) return;
    let cancelled = false;
    /**
     * The cached reading first, so the dock's first paint is not four blanks. It resolves without
     * starting anything — main answers from whatever the helper last said, which on a cold session
     * is "unknown", and the push that follows a moment later fills it in.
     */
    void Promise.resolve(window.electron?.getSystemStatus?.()).then((value) => {
      if (!cancelled && value) setStatus(value);
    }).catch(() => {});
    const off = window.electron?.onSystemStatus?.((next) => {
      if (next) setStatus(next);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [needsHelper]);

  return status;
}
