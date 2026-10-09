import React, { useCallback, useRef } from 'react';
import { DOCK_POSITIONS, DOCK_POSITION_LABELS, type DockPosition } from '../utils/screenDocks';

/**
 * Where a dock sits, chosen by pointing at the place rather than by reading its name.
 *
 * A dock is a strip against an edge of the screen, and "Bottom center" is a translation of that
 * fact into words the user then has to translate back. The box below IS the screen: the wheel in
 * the middle for orientation, and a strip drawn in each region that can hold one. Picking is
 * recognition, and the answer is checkable at a glance afterwards — which the old dropdown could
 * not offer, since it showed one name and hid the other five.
 *
 * It also has to say what is already there. Both docks can be placed in the same region (ScreenDocks
 * stacks them on purpose), so the sibling's strip is drawn in its region, faint: choosing to share a
 * corner stays possible, and doing it by accident stops being easy.
 */

/**
 * The regions as they are laid out on the screen — three across the top edge, three across the
 * bottom. Also the order the arrow keys walk, which is why it is a grid here rather than the flat
 * list `DOCK_POSITIONS` is: on a picture, Right has to mean right.
 *
 * `scripts/screen-docks-smoke.mjs` holds it to covering `DOCK_POSITIONS` exactly. A seventh region
 * added to the model and not to this grid would be a position the wheel honours and the settings
 * panel cannot reach.
 */
export const DOCK_POSITION_GRID: ReadonlyArray<ReadonlyArray<DockPosition>> = [
  ['top-left', 'top-center', 'top-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
];

interface DockPositionPickerProps {
  value: DockPosition;
  onChange: (position: DockPosition) => void;
  /** The row's title element, so the group is announced as the setting it edits. */
  labelledBy?: string;
  describedBy?: string;
  /** The OTHER dock, when it is switched on: drawn faint in its own region. */
  occupied?: { position: DockPosition; label: string };
}

function cellClass(position: DockPosition): string {
  const [band, side] = position.split('-');
  return `zs-dockpick-cell is-${band} is-${side}`;
}

export function DockPositionPicker({
  value,
  onChange,
  labelledBy,
  describedBy,
  occupied,
}: DockPositionPickerProps) {
  const cells = useRef(new Map<DockPosition, HTMLButtonElement | null>());

  /**
   * Arrow keys move the CHOICE, not just the focus — the behaviour a radio group owes the keyboard,
   * and the reason this is one tab stop rather than six.
   */
  const select = useCallback(
    (next: DockPosition) => {
      onChange(next);
      cells.current.get(next)?.focus();
    },
    [onChange],
  );

  const step = useCallback(
    (from: DockPosition, dx: number, dy: number) => {
      const row = DOCK_POSITION_GRID.findIndex((positions) => positions.includes(from));
      if (row < 0) return DOCK_POSITION_GRID[0][0];
      const column = DOCK_POSITION_GRID[row].indexOf(from);
      const rows = DOCK_POSITION_GRID.length;
      const columns = DOCK_POSITION_GRID[row].length;
      /** Wrapping, because a two-row grid with no wrap makes Down a dead key half the time. */
      return DOCK_POSITION_GRID[(row + dy + rows) % rows][(column + dx + columns) % columns];
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const moves: Record<string, [number, number]> = {
        ArrowRight: [1, 0],
        ArrowLeft: [-1, 0],
        ArrowDown: [0, 1],
        ArrowUp: [0, -1],
      };
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        select(step(value, move[0], move[1]));
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        select(event.key === 'Home' ? DOCK_POSITIONS[0] : DOCK_POSITIONS[DOCK_POSITIONS.length - 1]);
      }
    },
    [select, step, value],
  );

  return (
    <div
      className="zs-dockpick"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
    >
      {/* The wheel, so the box reads as a screen rather than as six buttons in a rectangle. */}
      <span className="zs-dockpick-wheel" aria-hidden="true" />
      {DOCK_POSITION_GRID.map((row) =>
        row.map((position) => {
          const selected = position === value;
          const shared = occupied?.position === position;
          const label = DOCK_POSITION_LABELS[position];
          return (
            <button
              key={position}
              type="button"
              role="radio"
              aria-checked={selected}
              /** One tab stop for the group: the arrows do the rest. */
              tabIndex={selected ? 0 : -1}
              ref={(node) => {
                cells.current.set(position, node);
              }}
              className={`${cellClass(position)}${selected ? ' is-selected' : ''}${shared ? ' is-shared' : ''}`}
              aria-label={shared ? `${label} — ${occupied.label} is here too` : label}
              title={shared ? `${label} — shared with the ${occupied.label.toLowerCase()}` : label}
              onClick={() => select(position)}
            >
              <span className="zs-dockpick-strip" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </button>
          );
        }),
      )}
    </div>
  );
}
