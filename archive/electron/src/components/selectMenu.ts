/**
 * The two pieces of `SelectSettingControl` that are arithmetic rather than rendering.
 *
 * They are out here because a custom dropdown takes over jobs the platform used to do for free,
 * and these are the two it is easiest to get subtly wrong in ways nobody notices until the window
 * is short or someone types the same letter twice: where the popup goes, and where a keystroke
 * lands. As pure functions they can be checked directly — `scripts/select-menu-smoke.mjs` — which
 * is the only reason this file exists rather than another hundred lines inside the component.
 */

export interface SelectChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface MenuRect {
  top: number;
  bottom: number;
  right: number;
  width: number;
}

/** The help mark the bubble belongs to. Only its column decides anything. */
export interface TipAnchor {
  left: number;
  right: number;
}

/** The popup's vertical extent, which the bubble clears rather than covers. */
export interface TipSpan {
  top: number;
  bottom: number;
}

/**
 * `left`/`top` are what the bubble is painted at; `drop` is the decision behind them, returned
 * so the tests can assert the choice itself rather than re-deriving a coordinate to compare.
 */
export interface TipPlacement {
  left: number;
  top: number;
  drop: 'down' | 'up';
}

/**
 * The box the popup must stay inside, in viewport coordinates — the settings shell, not the window.
 *
 * It is also the element the popup is positioned against, and that is not a free choice. The panel
 * is wrapped in a `motion.div` carrying `filter: blur()` and an `x` transform (`PanelTransition`),
 * and a filter creates a containing block for `position: fixed` — so "fixed" inside the panel is
 * not viewport-relative at all, it is relative to a box that starts below the title bar. The first
 * version of this menu used fixed and viewport coordinates and opened one title-bar's-height too
 * low, every time. Absolute coordinates against a measured container cannot drift that way,
 * whatever a future ancestor does with transforms.
 */
export interface MenuBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  width: number;
  drop: 'down' | 'up';
}

/**
 * Mirrors the CSS, and has to be kept in step with it by hand.
 *
 * An option is `min-height: var(--zn-ctl)` (32px) and the list adds `var(--zn-1)` (4px) of padding
 * top and bottom. These numbers only decide whether the popup FLIPS, so drift shows up as a list
 * that opens downward into a space it does not quite fit, never as a broken layout — which is
 * exactly why it would go unnoticed.
 */
export const MENU_ROW_HEIGHT = 32;
export const MENU_LIST_PADDING = 8;
export const MENU_MAX_HEIGHT = 320;
export const MENU_MIN_WIDTH = 208;
/** Breathing room from the trigger, and the smallest gap tolerated at a window edge. */
export const MENU_GAP = 6;
export const MENU_MARGIN = 8;

export function menuHeight(count: number): number {
  return Math.min(count * MENU_ROW_HEIGHT + MENU_LIST_PADDING, MENU_MAX_HEIGHT);
}

/**
 * The help bubble's width, and the other number this file shares with the stylesheet.
 *
 * `.zs-select-tip` states the same width, and it has to: the bubble is measured for its height
 * before it is positioned, so the CSS must already have decided how wide it is or the height
 * measured is the height of a different box than the one that gets painted.
 */
export const TIP_WIDTH = 240;

/**
 * Where an option's help bubble goes: under the mark it belongs to, centred on it, clear of the
 * popup.
 *
 * Under, rather than out beside the popup, because the mark is what the pointer is resting on and
 * the bubble should read as coming out of it — parked off to one side of the whole list it was a
 * panel that happened to appear, with nothing tying it to the row that opened it.
 *
 * "Clear of" is the part that is not obvious, and it is why the drop is measured from the popup's
 * foot and not from the mark's own bottom edge. Hanging it off the mark covers whatever options
 * are below, and on a two-option list that means the first mark hides the second option outright
 * — a popup that appears to lose a row when you ask it a question. Dropping from the foot puts it
 * directly under the last mark and only a row lower for the ones above, and the column keeps it
 * tied to the mark either way.
 *
 * It flips above when there is no room below, clearing the popup's top edge the same way. The left
 * edge is clamped into the shell — the mark sits at the end of the option, so a bubble centred on
 * it always wants to hang off the right of the panel, and in Arabic off the left.
 */
export function helpTipPlacement(
  anchor: TipAnchor,
  list: TipSpan,
  bounds: MenuBounds,
  height: number,
): TipPlacement {
  const minLeft = bounds.left + MENU_MARGIN;
  const maxLeft = bounds.left + bounds.width - MENU_MARGIN - TIP_WIDTH;
  const centred = (anchor.left + anchor.right) / 2 - TIP_WIDTH / 2;
  /** `Math.max` last, so a shell narrower than the bubble pins it to the near edge, not the far one. */
  const left = Math.max(minLeft, Math.min(centred, maxLeft));
  const below = list.bottom + MENU_GAP;
  const floor = bounds.top + bounds.height - MENU_MARGIN;
  const drop: 'down' | 'up' = below + height <= floor ? 'down' : 'up';
  const top =
    drop === 'down' ? below : Math.max(bounds.top + MENU_MARGIN, list.top - MENU_GAP - height);
  return { drop, left: left - bounds.left, top: top - bounds.top };
}

/**
 * Where the popup sits, as offsets INSIDE `bounds` — both inputs are viewport coordinates, the
 * result is relative, because that is what an absolutely positioned child of `bounds` needs.
 *
 * Down unless down does not fit and up fits better — "better", not "at all", because a panel short
 * enough to squeeze both should still take the roomier side rather than flipping to a list that is
 * merely less clipped. The left edge is clamped twice over: once to hold the popup's right edge to
 * the trigger's, and once so a popup wider than its trigger cannot leave the panel on either side,
 * which is the case a single `Math.max` silently gets wrong in RTL.
 */
export function selectMenuPlacement(
  rect: MenuRect,
  bounds: MenuBounds,
  count: number,
): MenuPlacement {
  const height = menuHeight(count);
  const width = Math.max(rect.width, MENU_MIN_WIDTH);
  const floor = bounds.top + bounds.height;
  const roomBelow = floor - rect.bottom - (MENU_GAP + MENU_MARGIN);
  const roomAbove = rect.top - bounds.top - (MENU_GAP + MENU_MARGIN);
  const drop: 'down' | 'up' = roomBelow >= height || roomBelow >= roomAbove ? 'down' : 'up';
  const minLeft = bounds.left + MENU_MARGIN;
  const left = Math.min(
    Math.max(minLeft, rect.right - width),
    Math.max(minLeft, bounds.left + bounds.width - width - MENU_MARGIN),
  );
  const top =
    drop === 'down'
      ? rect.bottom + MENU_GAP
      : Math.max(bounds.top + MENU_MARGIN, rect.top - MENU_GAP - height);
  return {
    width,
    drop,
    /** Back into the container's own coordinate space, which is where it will be painted. */
    left: left - bounds.left,
    top: top - bounds.top,
  };
}

/**
 * Type-ahead: which option a typed buffer should land on, or `null` for no match.
 *
 * Two behaviours matter and they pull in opposite directions. A single character CYCLES — press
 * `e` repeatedly and you should walk English, Español, Deutsch in turn — so the scan starts one
 * past the current row. A longer buffer REFINES: `d`,`e` is still aiming at the Deutsch that `d`
 * already found, so the scan must include the current row or every second keystroke would skip
 * past the answer. Both wrap, so the search never dead-ends at the bottom of the list.
 *
 * Matching runs over the endonym and the English name alike, because someone hunting for German
 * may reasonably type either `De…` or `Ge…`.
 */
export function typeAheadIndex(
  choices: readonly SelectChoice[],
  activeIndex: number,
  buffer: string,
): number | null {
  const needle = buffer.trim().toLowerCase();
  if (!needle || !choices.length) return null;
  const from = needle.length === 1 ? activeIndex + 1 : activeIndex;
  for (let offset = 0; offset < choices.length; offset += 1) {
    /** `+ choices.length` keeps the modulo positive when `activeIndex` is still -1. */
    const index = (((from + offset) % choices.length) + choices.length) % choices.length;
    const choice = choices[index];
    if (
      choice.label.toLowerCase().startsWith(needle)
      || (choice.hint ?? '').toLowerCase().startsWith(needle)
    ) {
      return index;
    }
  }
  return null;
}

/** Idle gap after which the next keystroke starts a fresh buffer instead of extending it. */
export const TYPE_AHEAD_RESET_MS = 900;

export function nextTypeAheadBuffer(previous: string, key: string, sinceLastKeyMs: number): string {
  return sinceLastKeyMs > TYPE_AHEAD_RESET_MS ? key : previous + key;
}
