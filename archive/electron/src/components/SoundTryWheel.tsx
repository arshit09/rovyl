import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getIcon } from '../iconMap';
import { SmartIcon } from './SmartIcon';
import { getReadableForeground } from './RadialMenu';
import { sectorIndexForDelta } from '../utils/radialSectors';
import {
  HUB_TARGET,
  noteForHighlight,
  playRadialSound,
  sleepRadialSound,
  wakeRadialSound,
  type RadialSounds,
} from '../utils/radialSound';
import type { AppItem } from '../types';

/**
 * A wheel to move around in, inside Settings, to hear the sound effects as the real one plays them.
 *
 * It is not a smaller copy of the wheel — `WheelPreview` is that, and it is a still frame on
 * purpose. This one is only about how the notes FEEL: how often they come on a sweep across your
 * own number of shortcuts, and which one the center answers with. So the geometry is its own,
 * sized to the box, and what it shares with the wheel is everything that decides a note: the aim
 * (`sectorIndexForDelta`, the hub's cancel-zone rule) and `noteForHighlight` itself.
 */

const RING_RADIUS = 80;
/** The square the ring is centred in. The name pill gets its own strip below it rather than
 *  covering whichever tile sits at the bottom of the ring. */
const RING_BOX = 240;
const STAGE_HEIGHT = RING_BOX + 28;
const HUB_DIAMETER = 44;
/** `RadialMenu`'s cancel zone — the hub's box, not its circle, at the scale it takes when lit. */
const DEAD_ZONE = Math.ceil((HUB_DIAMETER / 2) * 1.06 * Math.SQRT2) + 4;

export const SoundTryWheel: React.FC<{
  apps: AppItem[];
  sounds: RadialSounds;
  hoverColor: string;
  targeting: 'area' | 'cursor';
  labelledBy?: string;
  describedBy?: string;
}> = ({ apps, sounds, hoverColor, targeting, labelledBy, describedBy }) => {
  const count = apps.length;
  /** As large as the wheel's own default tile allows, and smaller once the ring gets crowded. */
  const tileSize = Math.max(20, Math.min(44, Math.floor((2 * Math.PI * RING_RADIUS) / Math.max(count, 1)) - 10));
  const foreground = getReadableForeground(hoverColor);

  const [lit, setLit] = useState<string | null>(null);
  /** Bumped by every replayed opening: it remounts the ring, which restarts the bloom. */
  const [openings, setOpenings] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  /** The three things the wheel keeps: what is lit, whether the aim has been out, when it opened. */
  const litRef = useRef<string | null>(null);
  const aimedAwayRef = useRef(false);
  /** The box is already open when the page shows it, and that opening made no sound. */
  const openedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;

  const land = useCallback((target: string | null) => {
    if (target === litRef.current) return;
    litRef.current = target;
    setLit(target);
    const aimedAway = aimedAwayRef.current;
    if (target !== null && target !== HUB_TARGET) aimedAwayRef.current = true;
    const note = noteForHighlight(target, aimedAway, performance.now() - openedAtRef.current, soundsRef.current);
    if (note) playRadialSound(note);
  }, []);

  /** The wheel's aim, in this box's coordinates. */
  const aimAt = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || count === 0) return;
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + RING_BOX / 2);
    if (dx * dx + dy * dy < DEAD_ZONE * DEAD_ZONE) return land(HUB_TARGET);
    const index = sectorIndexForDelta(dx, dy, count);
    if (index === null) return land(null);
    if (targeting === 'cursor') {
      const rad = (index * (360 / count) - 90) * (Math.PI / 180);
      const offX = dx - RING_RADIUS * Math.cos(rad);
      const offY = dy - RING_RADIUS * Math.sin(rad);
      const hit = Math.max(tileSize * 0.85, 22);
      if (offX * offX + offY * offY > hit * hit) return land(null);
    }
    land(apps[index].id);
  };

  /** The wheel opening again, with its note, from wherever the aim is now. */
  const replay = () => {
    openedAtRef.current = performance.now();
    aimedAwayRef.current = litRef.current !== null && litRef.current !== HUB_TARGET;
    setOpenings((n) => n + 1);
    wakeRadialSound();
    if (soundsRef.current.open) playRadialSound(soundsRef.current.open);
  };

  const step = (delta: number) => {
    const current = apps.findIndex((item) => item.id === litRef.current);
    const from = current === -1 ? (delta > 0 ? -1 : 0) : current;
    land(apps[(from + delta + count) % count].id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (count === 0) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        return step(1);
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        return step(-1);
      case 'Home':
        event.preventDefault();
        return land(HUB_TARGET);
      case 'Enter':
      case ' ':
        event.preventDefault();
        return replay();
    }
  };

  const release = () => {
    land(null);
    sleepRadialSound();
  };
  useEffect(() => () => sleepRadialSound(), []);

  const litLabel = lit === HUB_TARGET ? 'Center' : apps.find((item) => item.id === lit)?.label;

  return (
    <div
      ref={stageRef}
      className="zs-trywheel"
      style={{ height: STAGE_HEIGHT, ['--zs-ring-y' as string]: `${RING_BOX / 2}px` }}
      role="group"
      aria-roledescription="practice wheel"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={0}
      onPointerEnter={wakeRadialSound}
      onPointerMove={(event) => aimAt(event.clientX, event.clientY)}
      onPointerLeave={release}
      onClick={replay}
      onFocus={wakeRadialSound}
      onBlur={release}
      onKeyDown={onKeyDown}
    >
      <div
        key={openings}
        className={`zs-trywheel-ring${openings > 0 ? ' is-blooming' : ''}`}
        style={{ height: RING_BOX }}
        aria-hidden
      >
        <div
          className="zs-trywheel-hub"
          style={{
            width: HUB_DIAMETER,
            height: HUB_DIAMETER,
            background: lit === HUB_TARGET ? hoverColor : undefined,
            borderColor: lit === HUB_TARGET ? hoverColor : undefined,
            ['--zn-tf' as string]: `scale(${lit === HUB_TARGET ? 1.06 : 1})`,
          }}
        />
        {apps.map((item, index) => {
          const rad = (index * (360 / count) - 90) * (Math.PI / 180);
          const isLit = item.id === lit;
          const Icon = getIcon(item.iconName);
          return (
            <div
              key={item.id}
              className="zs-trywheel-tile"
              style={{
                width: tileSize,
                height: tileSize,
                borderRadius: Math.round(tileSize * 0.3),
                background: isLit ? hoverColor : undefined,
                borderColor: isLit ? hoverColor : undefined,
                color: isLit ? foreground : undefined,
                ['--zn-tf' as string]:
                  `translate(${(RING_RADIUS * Math.cos(rad)).toFixed(1)}px, ${(RING_RADIUS * Math.sin(rad)).toFixed(1)}px)` +
                  ` scale(${isLit ? 1.08 : 1})`,
              }}
            >
              {item.customIconUrl ? (
                <SmartIcon src={item.customIconUrl} alt="" className="object-contain" />
              ) : (
                <Icon size={Math.round(tileSize * 0.55)} strokeWidth={1.75} />
              )}
            </div>
          );
        })}
      </div>
      <span className="zs-trywheel-name" aria-live="polite">{litLabel ?? ''}</span>
    </div>
  );
};
