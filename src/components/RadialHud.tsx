import React from 'react';
import { Cloud, Settings } from 'lucide-react';
import { CLOCK_HUD_POSITIONS, ClockHudPosition, SETTINGS_CORNERS, SettingsCorner, UIConfig } from '../types';

export type ClockHudRegion = ClockHudPosition;

type HudAlign = 'start' | 'center' | 'end';

function resolveHudRegion(clockPosition: UIConfig['clockPosition']): ClockHudRegion {
  return CLOCK_HUD_POSITIONS.includes(clockPosition)
    ? clockPosition
    : 'top-center';
}

function isCenterRegion(region: ClockHudRegion): boolean {
  return region === 'top-center' || region === 'bottom-center';
}

function alignToFlex(align: HudAlign): string {
  if (align === 'center') return 'items-center text-center';
  if (align === 'end') return 'items-end text-right';
  return 'items-start text-left';
}

function alignToJustify(align: HudAlign): string {
  if (align === 'center') return 'justify-center';
  if (align === 'end') return 'justify-end';
  return 'justify-start';
}

function getHudLayout(region: ClockHudRegion) {
  const isBottom = region.startsWith('bottom');
  const align: HudAlign = isCenterRegion(region)
    ? 'center'
    : region === 'top-right' || region === 'bottom-right'
      ? 'end'
      : 'start';

  const shellClass = (() => {
    const z = 'fixed z-[10] pointer-events-none text-white';
    switch (region) {
      case 'bottom-left':
        return `${z} bottom-0 left-0`;
      case 'bottom-center':
        return `${z} bottom-0 inset-x-0 flex justify-center`;
      case 'bottom-right':
        return `${z} bottom-0 right-0`;
      case 'top-left':
        return `${z} top-0 left-0`;
      case 'top-center':
        return `${z} top-0 inset-x-0 flex justify-center`;
      case 'top-right':
        return `${z} top-0 right-0`;
      default:
        return `${z} top-0 inset-x-0 flex justify-center`;
    }
  })();

  const innerClass = (() => {
    const pad = 'p-5 sm:p-6 md:pt-7 md:px-8 md:pb-8';
    const cluster = `flex flex-col ${alignToFlex(align)} gap-3 sm:gap-3.5`;
    const width = isCenterRegion(region)
      ? 'w-max max-w-[min(92vw,560px)]'
      : 'max-w-[min(92vw,420px)]';
    return `${cluster} ${pad} ${width}`;
  })();

  return { region, isBottom, align, shellClass, innerClass };
}

/** Ghost pill — no backdrop-blur (transparent HWND on Windows). */
const hudPillClass =
  'inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-[rgba(8,8,10,0.72)] px-3 py-1.5 shadow-[0_4px_20px_rgba(0,0,0,0.35)]';

interface HudStatusStripProps {
  align: HudAlign;
  showBattery: boolean;
  showWeather: boolean;
  performanceMode: boolean;
  batteryLevel: number | null;
  weather: { temp: number; condition: string } | null;
}

const HudStatusStrip: React.FC<HudStatusStripProps> = ({
  align,
  showBattery,
  showWeather,
  performanceMode,
  batteryLevel,
  weather,
}) => {
  const showBatteryChip = showBattery && batteryLevel !== null;
  const showWeatherChip = showWeather && !performanceMode && !!weather;
  if (!showBatteryChip && !showWeatherChip) return null;

  return (
    <div
      className={`flex flex-wrap gap-2 sm:gap-2.5 ${alignToJustify(align)} ${align === 'center' ? 'w-auto' : 'w-full'}`}
    >
      {showBatteryChip && (
        <div className={hudPillClass}>
          <div
            className="relative h-3 w-7 shrink-0 rounded-full border border-white/[0.2] bg-white/[0.06] p-[2px]"
            aria-hidden
          >
            <div
              className="h-full max-w-full rounded-full bg-white transition-[width] duration-500 ease-out"
              style={{
                width: `${batteryLevel}%`,
                backgroundColor: batteryLevel! < 20 ? '#f87171' : undefined,
              }}
            />
          </div>
          <span className="text-[11px] font-semibold tabular-nums tracking-wide text-white/80">
            {batteryLevel}%
          </span>
        </div>
      )}

      {showWeatherChip && (
        <div className={`${hudPillClass} max-w-[min(100%,14rem)]`}>
          <Cloud className="h-3.5 w-3.5 shrink-0 text-white/45" strokeWidth={1.75} aria-hidden />
          <span className="truncate text-[11px] font-semibold tabular-nums tracking-tight text-white/85">
            {weather!.temp}°
          </span>
          {weather!.condition && weather!.condition !== '---' && (
            <>
              <span className="text-white/25" aria-hidden>
                ·
              </span>
              <span className="truncate text-[10px] font-medium uppercase tracking-wider text-white/45">
                {weather!.condition}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Radial overlay: battery/weather only (off by default). Clock, date and workspace chip
 * were removed — the radial window shows only the wheel, and nothing is painted outside it.
 */
export interface RadialHudProps {
  isOpen: boolean;
  config: UIConfig;
  batteryLevel: number | null;
  weather: { temp: number; condition: string } | null;
}

/**
 * Whether the strip has anything to paint at all.
 *
 * Exported because the settings gear has to know: the two are placed independently and can be
 * asked for the same corner, and only something that already answers this question can tell an
 * occupied corner from an empty one.
 */
export function hudStatusVisible(
  config: UIConfig,
  batteryLevel: number | null,
  weather: { temp: number; condition: string } | null,
): boolean {
  return (
    (config.showBattery && batteryLevel !== null) ||
    (config.showWeather && !config.performanceMode && !!weather)
  );
}

/** The corner the strip occupies, or `null` when it is not on screen — see `hudStatusVisible`. */
export function hudOccupiedRegion(
  config: UIConfig,
  batteryLevel: number | null,
  weather: { temp: number; condition: string } | null,
): ClockHudRegion | null {
  return hudStatusVisible(config, batteryLevel, weather)
    ? resolveHudRegion(config.clockPosition)
    : null;
}

export const RadialHud: React.FC<RadialHudProps> = ({
  isOpen,
  config,
  batteryLevel,
  weather,
}) => {
  const region = resolveHudRegion(config.clockPosition);
  const { isBottom, align, shellClass, innerClass } = getHudLayout(region);

  if (!hudStatusVisible(config, batteryLevel, weather)) return null;

  const enterY = isBottom ? 10 : -10;

  return (
    <div className={shellClass}>
      <div
        className={`zn-radial-pill ${innerClass}`}
        style={{
          ['--zn-tf' as string]: `translate3d(0, ${isOpen ? 0 : enterY}px, 0)`,
          ['--zn-op' as string]: isOpen ? 1 : 0,
          ['--zn-dur' as string]: isOpen ? '260ms' : '140ms',
          ['--zn-dur-op' as string]: isOpen ? '200ms' : '120ms',
        }}
      >
        <HudStatusStrip
          align={align}
          showBattery={config.showBattery}
          showWeather={config.showWeather}
          performanceMode={config.performanceMode}
          batteryLevel={batteryLevel}
          weather={weather}
        />
      </div>
    </div>
  );
};


/** Absent or unknown → top-right, which is what `DEFAULT_UI_CONFIG` says and where a gear is looked for. */
export function resolveSettingsCorner(corner: UIConfig['settingsCorner']): SettingsCorner {
  return corner && SETTINGS_CORNERS.includes(corner) ? corner : 'top-right';
}

/** One pill's height, which is what the battery/weather strip occupies when it is on screen. */
export const HUD_STATUS_HEIGHT = 46;

export interface RadialSettingsCornerProps {
  /** The wheel's pack supplies both — this component never reaches for the tables itself. */
  openLabel: string;
  openTitle: string;
  isOpen: boolean;
  corner: SettingsCorner;
  /**
   * How much is already in this corner, in pixels — the battery/weather strip, a dock, or both.
   *
   * The gear steps inboard by exactly that rather than sharing the spot: everything here is placed
   * from the same edge, so left alone they stack on top of each other. A NUMBER and not a flag,
   * because a dock's height follows the icon size the user chose and a fixed step would clear a
   * strip of 18px glyphs while sitting squarely on one of 88px tiles.
   */
  dodgeBy?: number;
  onOpen: () => void;
}

/**
 * The gear, in a corner of the open wheel.
 *
 * Every mouse event it takes is stopped dead. The wheel confirms its aim from a `mouseup` on the
 * WINDOW — anywhere on the window, because by direction the target is a vector and not whatever
 * the pointer is over — so a click that reached it would open Settings AND launch whichever slice
 * the corner happens to point at. React 17+ propagates the stop to the native event (the same
 * mechanism `.zn-radial--nocursor` relies on, in reverse), which is what keeps that listener out.
 */
export const RadialSettingsCorner: React.FC<RadialSettingsCornerProps> = ({
  isOpen,
  corner,
  dodgeBy = 0,
  openLabel,
  openTitle,
  onOpen,
}) => {
  const isBottom = corner.startsWith('bottom');
  const isRight = corner.endsWith('right');
  const shellClass = [
    'fixed z-[12] p-5 sm:p-6 md:p-7',
    isBottom ? 'bottom-0' : 'top-0',
    isRight ? 'right-0' : 'left-0',
  ].join(' ');

  const swallow = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className={shellClass} style={{ [isBottom ? 'marginBottom' : 'marginTop']: Math.max(0, dodgeBy) }}>
      <button
        type="button"
        className={`zn-radial-pill zn-radial-gear ${isOpen ? '' : 'pointer-events-none'}`}
        style={{
          ['--zn-tf' as string]: `translate3d(0, ${isOpen ? 0 : (isBottom ? 10 : -10)}px, 0)`,
          ['--zn-op' as string]: isOpen ? 1 : 0,
          ['--zn-dur' as string]: isOpen ? '260ms' : '140ms',
          ['--zn-dur-op' as string]: isOpen ? '200ms' : '120ms',
        }}
        aria-label={openLabel}
        title={openTitle}
        tabIndex={-1}
        onMouseDown={swallow}
        onMouseUp={swallow}
        onAuxClick={swallow}
        onContextMenu={swallow}
        onClick={(event) => {
          swallow(event);
          onOpen();
        }}
      >
        <Settings size={16} strokeWidth={1.9} aria-hidden />
      </button>
    </div>
  );
};
