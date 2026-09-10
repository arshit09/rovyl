import React, { useMemo } from 'react';
import { computeRadialLayout, getLabelPlacement, radialScrimGradient } from './RadialMenu';
import { getIcon } from '../iconMap';
import { SmartIcon } from './SmartIcon';
import type { AppItem, UIConfig } from '../types';

/**
 * The wheel, drawn at a fraction of its size, next to the sliders that shape it.
 *
 * Orbital radius, icon size, spacing and background dimming had no visible effect until the panel
 * was closed and the wheel triggered — so tuning them meant a round trip per nudge, against a
 * memory of what the last value looked like.
 *
 * It is a scaled photograph, not a drawing of one. `computeRadialLayout` and `radialScrimGradient`
 * come from `RadialMenu` itself, which exports them for exactly this reason: the licence gate had
 * already learned that a second surface with its own constants drifts, and drifts silently. So the
 * geometry here is computed at full size, against the real screen, and only the last step — one
 * `scale()` on the whole layer — makes it small. Everything the real wheel does with those numbers
 * happens here too, including the clamp that shrinks icons once the ring outgrows the display.
 *
 * What it deliberately does not show: hover, dwell, submenus, aiming. Those are behaviour, and a
 * still frame that implied them would be making a promise it cannot keep. It shows one slice lit
 * because the hover colour is a setting on this page and has to be visible somewhere.
 */

/** Height of the stage. The wheel is fitted into it; nothing here depends on a particular value. */
const STAGE_HEIGHT = 188;
/** Breathing room so the outermost tile edge never touches the frame. */
const STAGE_INSET = 14;

/** The display the wheel will actually open on. Only `min(w, h)` matters — see `maxScreenRadius`. */
function screenSize(): { width: number; height: number } {
  const width = window.screen?.width || window.innerWidth || 1920;
  const height = window.screen?.height || window.innerHeight || 1080;
  return { width, height };
}

/**
 * Enough items to judge spacing by, without inventing a wheel the user does not have.
 *
 * A workspace with two shortcuts really does put them opposite each other, and showing six would
 * be a lie about their own wheel. An EMPTY workspace is the one case with nothing true to draw, and
 * there the placeholders are labelled as such by the caption underneath.
 */
const PLACEHOLDERS: AppItem[] = Array.from({ length: 6 }, (_, index) => ({
  id: `preview-${index}`,
  type: 'app',
  label: ['Editor', 'Browser', 'Terminal', 'Files', 'Music', 'Chat'][index],
  iconName: ['Code', 'Globe', 'Terminal', 'Folder', 'Music', 'MessageCircle'][index],
  iconSource: 'lucide',
  command: '',
  commandType: 'app',
  description: '',
}));

export const WheelPreview: React.FC<{ config: UIConfig; apps: AppItem[] }> = ({ config, apps }) => {
  const isPlaceholder = apps.length === 0;
  const items = isPlaceholder ? PLACEHOLDERS : apps;

  const iconSizePx = config.iconSize || 64;
  const minGap = config.appSpacing || 0;
  const hoverColor = config.radialHoverColor || '#FFFFFF';
  const backdropOpacity = config.backdropOpacity ?? 1;
  const showLabels = config.alwaysShowAppLabels ?? false;

  const { actualMenuRadius, actualIconSize } = useMemo(
    () =>
      computeRadialLayout({
        numberOfApps: items.length,
        iconSizePx,
        minGap,
        menuRadius: config.menuRadius,
        activationThreshold: config.activationThreshold,
        viewportSize: screenSize(),
      }),
    [items.length, iconSizePx, minGap, config.menuRadius, config.activationThreshold],
  );

  /** The hub's own rule, copied from `RadialMenu`: it follows the SETTING, not the slice size. */
  const hubDiameter =
    Math.max(
      32,
      Math.min(
        Math.round(iconSizePx * 0.82 * 1.2),
        Math.round((actualMenuRadius - actualIconSize / 2 - 10) * 2),
      ),
    ) & ~1;

  /**
   * Half the box the wheel needs at full size — ring, plus the tile that straddles it, plus the
   * labels when they are on.
   *
   * Labels are why the two axes are measured separately. `getLabelPlacement` puts them OUTSIDE the
   * ring on the side their slice points to, so a name adds a pill's height above and below but a
   * whole pill's WIDTH to the left and right — and the stage clips. The width is estimated from
   * the longest label rather than measured: an estimate that runs long only draws the wheel a
   * little smaller, while measuring would mean laying out once to find out how much to scale.
   */
  const longestLabel = showLabels
    ? items.reduce((longest, item) => Math.max(longest, (item.label || '').length), 0)
    : 0;
  const ringExtent = actualMenuRadius + actualIconSize / 2;
  const labelOffset = actualIconSize / 2 + 10;
  const verticalExtent = ringExtent + (showLabels ? labelOffset + 26 : 0);
  const horizontalExtent = ringExtent + (showLabels ? labelOffset + 24 + longestLabel * 7.2 : 0);

  /**
   * The stage is fluid, and the wheel has to fit the width it actually got — the panel is resized
   * by the window, by the sidebar collapsing, and by Windows display scaling.
   */
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = React.useState(560);
  React.useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStageWidth(node.clientWidth || 560);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const scale = Math.min(
    1,
    (STAGE_HEIGHT / 2 - STAGE_INSET) / Math.max(verticalExtent, 1),
    (stageWidth / 2 - STAGE_INSET) / Math.max(horizontalExtent, 1),
  );

  /**
   * The dimming is drawn on the stage rather than inside the scaled layer, with the radius scaled
   * to match: a gradient inside a `scale()` would shrink its own falloff and report the setting as
   * gentler than it is.
   */
  const scrim = radialScrimGradient(
    { x: 0, y: 0 },
    backdropOpacity,
    Math.max(actualMenuRadius * scale, 1),
  );

  return (
    <div className="zs-wheel-preview">
      <div className="zs-wheel-stage" ref={stageRef} style={{ height: STAGE_HEIGHT }} aria-hidden>
        {/* Stand-in for the desktop. Neutral on purpose: the dimming has to be readable against
            something, and a mock wallpaper with character would be judged instead of the setting. */}
        <div className="zs-wheel-desk" />
        <div className="zs-wheel-scrim" style={{ backgroundImage: scrim }} />

        <div className="zs-wheel-layer" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          <div
            className="zs-wheel-hub"
            style={{ width: hubDiameter, height: hubDiameter, borderColor: `${hoverColor}55` }}
          />

          {items.map((item, index) => {
            const angleDeg = (index * (360 / items.length)) - 90;
            const angleRad = angleDeg * (Math.PI / 180);
            const x = actualMenuRadius * Math.cos(angleRad);
            const y = actualMenuRadius * Math.sin(angleRad);
            /** One lit slice, and always the first, so dragging a slider never moves the highlight. */
            const isActive = index === 0;
            const label = getLabelPlacement(angleDeg, actualIconSize);
            const Icon = getIcon(item.iconName);

            return (
              <div
                key={item.id}
                className="zs-wheel-slot"
                style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
              >
                <div
                  className="zs-wheel-tile"
                  style={{
                    width: actualIconSize,
                    height: actualIconSize,
                    /** The real tile is opaque and takes its grey from the dimming; so does this one. */
                    backgroundColor: isActive
                      ? hoverColor
                      : `rgb(${12 + Math.round(backdropOpacity * 10)}, ${12 + Math.round(backdropOpacity * 10)}, ${12 + Math.round(backdropOpacity * 10)})`,
                    borderColor: isActive ? hoverColor : `rgba(255,255,255,${0.28 + backdropOpacity * 0.08})`,
                    color: isActive ? '#0b0b0d' : '#fff',
                  }}
                >
                  {item.customIconUrl ? (
                    <SmartIcon src={item.customIconUrl} alt="" className="object-contain" />
                  ) : (
                    <Icon size={Math.round(actualIconSize * 0.55)} strokeWidth={1.75} />
                  )}
                </div>

                {showLabels && (
                  <span
                    className="zs-wheel-label"
                    style={{
                      transform:
                        `translate(${label.originX}, ${label.originY})` +
                        ` translate(${label.x}px, ${label.y}px)`,
                      background: isActive ? hoverColor : 'rgba(6,7,9,0.95)',
                      borderColor: isActive ? hoverColor : 'rgba(255,255,255,0.2)',
                      color: isActive ? '#0b0b0d' : '#fff',
                    }}
                  >
                    {item.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="zs-wheel-caption">
        {isPlaceholder
          ? 'Example shortcuts — this workspace is empty.'
          : `Your ${items.length === 1 ? 'shortcut' : `${items.length} shortcuts`}, at ${Math.round(scale * 100)}% of actual size.`}
      </p>
    </div>
  );
};
