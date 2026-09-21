import React, { useMemo } from 'react';
import { computeRadialLayout, getLabelPlacement } from './RadialMenu';
import {
  annularSectorPath,
  polarPoint,
  sectorBoundsDeg,
  sectorBeamAlphas,
  sectorBeamLean,
  sectorBeamStops,
  sectorCentreDeg,
  sectorGradientStops,
  sectorReachStops,
  SECTOR_EDGE_ALPHA,
  SECTOR_FILL_ALPHA,
  SECTOR_SEAM_ALPHA,
  SECTOR_SEAM_FALLOFF_SCALE,
  SECTOR_SEAM_REACH,
} from '../utils/radialSectors';
import { radialScrimGradient } from '../utils/radialScrim';
import { getIcon } from '../iconMap';
import { SmartIcon } from './SmartIcon';
import { uiString } from '../strings';
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

/**
 * The orbital radius slider's own bounds, exported so the row in `PrecisionSettings` and the scale
 * below cannot drift apart: the preview measures itself against the top of this range, so a row
 * that offered a different maximum would either overflow the stage or never reach its edge.
 */
export const MENU_RADIUS_RANGE = { min: 90, max: 220 } as const;

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
  const showPill = config.showWorkspacePill !== false;
  /** The workspace whose shortcuts are drawn, so the pill names the wheel on screen. */
  const pillName = config.workspaces[config.activeWorkspaceIndex]?.name || 'Rovyl';
  const pillHint = config.centerButton?.label || uiString('menu.center');

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
   * The area wedges' radii — `RadialMenu`'s, not new ones. Inner is the dead zone, floored at the
   * hub so the seams never cross the middle button; outer is `backdropRadius`, where the scrim's
   * pool starts fading.
   */
  const sectorInnerRadius = Math.max(
    Math.max(config.activationThreshold ?? 60, Math.ceil((hubDiameter / 2) * 1.06 * Math.SQRT2) + 4),
    hubDiameter / 2 + 8,
  );
  const sectorOuterRadiusFull = Math.ceil(actualMenuRadius + actualIconSize * 0.75 + Math.max(18, minGap));

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
  const extentsOf = (menuRadiusPx: number, iconPx: number) => {
    const ring = menuRadiusPx + iconPx / 2;
    const labelOffset = iconPx / 2 + 10;
    const vertical = ring + (showLabels ? labelOffset + 26 : 0);
    const horizontal = ring + (showLabels ? labelOffset + 24 + longestLabel * 7.2 : 0);
    if (!showPill) return { vertical, horizontal };
    /** The pill hangs below the ring (same offset as the pill below); ~32px tall, width estimated like the labels. */
    const pillBottom = menuRadiusPx + iconPx * 0.75 + 34 + 32;
    const pillHalfWidth = (48 + (pillName.length + pillHint.length) * 6.2) / 2;
    return { vertical: Math.max(vertical, pillBottom), horizontal: Math.max(horizontal, pillHalfWidth) };
  };
  const extents = extentsOf(actualMenuRadius, actualIconSize);

  /**
   * The biggest wheel the slider can ask for, drawn with everything else left as it is.
   *
   * This — not the wheel on screen — is what the stage is fitted to, and it is the whole reason
   * orbital radius has anything to show. Fitting every frame to its own extent divided the setting
   * straight back out again: the ring grew, the scale shrank by exactly the same factor, and the
   * tiles landed on the same pixels at 90 px as at 220 px. The one control the preview was added
   * for was the one it could not move. Measured against a fixed ceiling instead, the wheel grows
   * across the slider and only touches the frame at the top of the range.
   *
   * The wheel being drawn is still taken as a floor for the box, because the ceiling is not a
   * guarantee: `computeRadialLayout` shrinks icons once a ring outgrows the display, and a clamped
   * wheel can land wider than the unclamped reference. The stage crops, so the larger of the two
   * wins and nothing reaches the frame that should not.
   */
  const reference = computeRadialLayout({
    numberOfApps: items.length,
    iconSizePx,
    minGap,
    menuRadius: MENU_RADIUS_RANGE.max,
    activationThreshold: config.activationThreshold,
    viewportSize: screenSize(),
  });
  const referenceExtents = extentsOf(reference.actualMenuRadius, reference.actualIconSize);

  const verticalExtent = Math.max(extents.vertical, referenceExtents.vertical);
  const horizontalExtent = Math.max(extents.horizontal, referenceExtents.horizontal);

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
   * The wedges, capped to the stage.
   *
   * The real wheel caps them at its window's edge for one reason — the gradient has to reach zero
   * before anything cuts it, or the wedge ends in a straight line. Here the thing that cuts is the
   * stage's own frame, and its short side is the height, so that is what the radius is measured
   * against. The stops below are then placed as fractions of whichever radius won.
   */
  const sectorOuterRadius = Math.max(
    Math.round(actualMenuRadius + actualIconSize * 0.6),
    Math.floor(STAGE_HEIGHT / 2 / Math.max(scale, 0.01)),
  );
  const sectorInnerStop = sectorInnerRadius / sectorOuterRadius;
  /**
   * Where the hold ends — the pool's edge, as on the wheel, but never past 55% of the stage.
   *
   * On the wheel the dissolve gets hundreds of pixels, because the wedge runs to the edge of the
   * radial's window. The stage is 188px tall and crops rather than rescales, so that much room does
   * not exist here at any setting. Given the choice between a preview that is proportionally exact
   * and one that SHOWS what the mode does, this takes the second: the ceiling buys back enough of
   * the stage for the fade to read as a fade. A preview whose wedge ended in a hard ring would be
   * advertising the defect this mode was tuned to avoid.
   */
  const sectorFalloffStop = Math.min(
    0.55,
    Math.max(sectorInnerStop + 0.02, sectorOuterRadiusFull / sectorOuterRadius),
  );
  const sectorSeamInnerStop = sectorInnerStop / SECTOR_SEAM_REACH;
  const sectorSeamFalloffStop = Math.min(
    0.9,
    Math.max(
      sectorSeamInnerStop + 0.02,
      (sectorOuterRadiusFull * SECTOR_SEAM_FALLOFF_SCALE) / (sectorOuterRadius * SECTOR_SEAM_REACH),
    ),
  );
  /** The wheel's own beam and reach, multiplied the same way. See `RadialSectors`. */
  const sectorLean = sectorBeamLean(items.length);
  const sectorSeamEnd = sectorOuterRadius * SECTOR_SEAM_REACH;
  const sectorGradient = (
    id: string,
    color: string,
    stops: { offset: number; opacity: number }[],
    deg: number,
    length: number,
  ) => {
    const far = polarPoint(sectorOuterRadius, length, deg);
    return (
      <linearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        x1={sectorOuterRadius}
        y1={sectorOuterRadius}
        x2={far.x.toFixed(2)}
        y2={far.y.toFixed(2)}
      >
        {stops.map((stop, index) => (
          <stop key={index} offset={stop.offset.toFixed(4)} stopColor={color} stopOpacity={stop.opacity.toFixed(4)} />
        ))}
      </linearGradient>
    );
  };

  /**
   * The dimming is drawn on the stage rather than inside the scaled layer, with the radius scaled
   * to match: a gradient inside a `scale()` would shrink its own falloff and report the setting as
   * gentler than it is.
   *
   * Centred on the stage, because that is where the wheel is. It used to be built at (0, 0) — the
   * top-left CORNER of a scrim that is `inset: 0` — so the pool the slider draws was pushed off
   * into the corner and the wheel sat in the undimmed part of it. The one control on this page
   * whose whole job is to be judged against the preview was the one the preview did not show.
   */
  const scrim = radialScrimGradient(
    { x: stageWidth / 2, y: STAGE_HEIGHT / 2 },
    backdropOpacity,
    Math.max(actualMenuRadius * scale, 1),
  );

  /**
   * `data-sticky-top` is read by `Collapse`. Pinned to the top of the list, the preview covers the
   * first rows of the scroller, and a revealed row brought to the very top would be brought behind
   * it — visible to the arithmetic, not to the user.
   */
  return (
    <div className="zs-wheel-preview" data-sticky-top>
      <div className="zs-wheel-stage" ref={stageRef} style={{ height: STAGE_HEIGHT }} aria-hidden>
        {/* Stand-in for the desktop. Neutral on purpose: the dimming has to be readable against
            something, and a mock wallpaper with character would be judged instead of the setting. */}
        <div className="zs-wheel-desk" />
        <div
          className="zs-wheel-scrim"
          style={{ backgroundImage: scrim }}
        />

        <div className="zs-wheel-layer" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          {/*
            Area targeting, in the preview for the same reason the hover colour is: it is a setting
            on this page, and a segmented control that changes nothing visible is indistinguishable
            from one that is broken. The geometry is the wheel's own — `annularSectorPath`, the same
            radii — so what is shown here is the division that will actually be drawn.
          */}
          {config.radialSelectionMode !== 'cursor' && config.radialAreaWedges === true && sectorOuterRadius > sectorInnerRadius + 8 && (
            <svg
              className="zs-wheel-sectors"
              width={sectorOuterRadius * 2}
              height={sectorOuterRadius * 2}
              viewBox={`0 0 ${sectorOuterRadius * 2} ${sectorOuterRadius * 2}`}
              shapeRendering="geometricPrecision"
            >
              {/* The wheel's own gradients — beam, lit edges, the reach they are masked by, seams. */}
              <defs>
                {/* One pair per wedge, because each one is aimed somewhere else. */}
                {items.map((_, index) => (
                  <React.Fragment key={`grad-${index}`}>
                    {sectorGradient(
                      `zs-wheel-beam-${index}`, hoverColor,
                      sectorBeamStops(
                        sectorInnerStop, sectorFalloffStop,
                        ...sectorBeamAlphas(SECTOR_FILL_ALPHA, items.length), sectorLean,
                      ),
                      sectorCentreDeg(index, items.length),
                      sectorOuterRadius,
                    )}
                    {sectorGradient(
                      `zs-wheel-beam-edge-${index}`, hoverColor,
                      sectorBeamStops(
                        sectorInnerStop, sectorFalloffStop,
                        ...sectorBeamAlphas(SECTOR_EDGE_ALPHA, items.length), sectorLean,
                      ),
                      sectorCentreDeg(index, items.length),
                      sectorOuterRadius,
                    )}
                  </React.Fragment>
                ))}
                <radialGradient id="zs-wheel-reach" cx="50%" cy="50%" r="50%">
                  {sectorReachStops(sectorInnerStop, sectorFalloffStop, sectorLean).map((stop, index) => (
                    <stop
                      key={index}
                      offset={stop.offset.toFixed(4)}
                      stopColor="#FFFFFF"
                      stopOpacity={stop.opacity.toFixed(4)}
                    />
                  ))}
                </radialGradient>
                <mask
                  id="zs-wheel-reach-mask"
                  maskUnits="userSpaceOnUse"
                  x={0}
                  y={0}
                  width={sectorOuterRadius * 2}
                  height={sectorOuterRadius * 2}
                >
                  <rect
                    width={sectorOuterRadius * 2}
                    height={sectorOuterRadius * 2}
                    fill="url(#zs-wheel-reach)"
                  />
                </mask>
                {items.map((_, index) => (
                  <React.Fragment key={`seam-grad-${index}`}>
                    {sectorGradient(
                      `zs-wheel-beam-seam-${index}`, '#FFFFFF',
                      sectorGradientStops(
                        sectorSeamInnerStop, sectorSeamFalloffStop,
                        SECTOR_SEAM_ALPHA[0], SECTOR_SEAM_ALPHA[1],
                      ),
                      sectorBoundsDeg(index, items.length).startDeg,
                      sectorSeamEnd,
                    )}
                  </React.Fragment>
                ))}
              </defs>
              {/* The beams, under the one reach that takes them all to nothing at the rim. */}
              <g mask="url(#zs-wheel-reach-mask)">
                {items.map((item, index) => {
                  const { startDeg, endDeg } = sectorBoundsDeg(index, items.length);
                  return (
                    <path
                      key={item.id}
                      d={annularSectorPath(sectorInnerRadius, sectorOuterRadius, startDeg, endDeg)}
                      fill={`url(#zs-wheel-beam-${index})`}
                      stroke={`url(#zs-wheel-beam-edge-${index})`}
                      strokeWidth={1.25}
                      vectorEffect="non-scaling-stroke"
                      /** The same lit slice as the tiles': the preview shows one aim, not a live one. */
                      opacity={index === 0 ? 1 : 0}
                    />
                  );
                })}
              </g>
              {items.map((item, index) => {
                const { startDeg } = sectorBoundsDeg(index, items.length);
                const near = polarPoint(sectorOuterRadius, sectorInnerRadius, startDeg);
                /** Seams stop short of the wedges — see `SECTOR_SEAM_REACH`. */
                const far = polarPoint(sectorOuterRadius, sectorSeamEnd, startDeg);
                return (
                  <line
                    key={item.id}
                    x1={near.x}
                    y1={near.y}
                    x2={far.x}
                    y2={far.y}
                    stroke={`url(#zs-wheel-beam-seam-${index})`}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </svg>
          )}

          <div
            className="zs-wheel-hub"
            style={{ width: hubDiameter, height: hubDiameter, borderColor: `${hoverColor}55` }}
          />

          {showPill && (
            <div
              className="zs-wheel-pill"
              style={{
                /** `RadialMenu`'s own offset for the pill, so it lands where the real one does. */
                transform: `translate(-50%, 0) translate(0, ${Math.round(actualMenuRadius + actualIconSize * 0.75 + 34)}px)`,
              }}
            >
              <span>{pillName}</span>
              <span>{pillHint}</span>
            </div>
          )}

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
          : 'Your own shortcuts, shown smaller than they open.'}
      </p>
    </div>
  );
};
