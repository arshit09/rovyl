/**
 * The mouse button that opens the wheel, shared by the settings recorder, the welcome card and —
 * through `backend/mouse-trigger.cjs`, which mirrors this grammar — the global hook in main.
 *
 * WHY A GRAMMAR AND NOT THREE NAMES
 *
 * The setting used to be three fixed choices (wheel, back, forward) because those are the three
 * buttons Windows reports that nothing else in the system already owns. But a modern mouse has
 * more buttons than Windows has names for, and the ones it does have — left and right — are only
 * unusable BARE. Held with a modifier they are as free as any side button, and on a mouse whose
 * extra keys the driver maps onto left/right they may be the only ones Rovyl can be given.
 *
 * So a binding is a button plus the modifiers held with it, written as one string:
 *
 *     middle            Ctrl+left            Alt+Shift+x2
 *
 * The three old values are exactly the modifier-free forms of three of the buttons, so every
 * config written before this still parses and still means what it meant.
 */

/** In the order the recorder's help text names them: the free ones first. */
export const MOUSE_TRIGGER_BUTTONS = ['middle', 'x1', 'x2', 'left', 'right'] as const;

export type MouseTriggerButton = (typeof MOUSE_TRIGGER_BUTTONS)[number];

export const DEFAULT_MOUSE_TRIGGER = 'middle';

export interface MouseTrigger {
  button: MouseTriggerButton;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The Windows key. Named `meta` to match `MouseEvent`, written `Super` to match the shortcut field. */
  meta: boolean;
}

/**
 * The two buttons the whole operating system is built on. Binding one bare would take the primary
 * click or the context menu away from every application at once, so the recorder refuses them
 * until a modifier is held — see `rejectMouseTrigger`.
 */
const NEEDS_MODIFIER: ReadonlySet<string> = new Set(['left', 'right']);

/** Short enough for the chip in the row. */
export const MOUSE_BUTTON_LABELS: Record<MouseTriggerButton, string> = {
  middle: 'Wheel',
  x1: 'Mouse 4',
  x2: 'Mouse 5',
  left: 'Left',
  right: 'Right',
};

/** The long form, for a sentence rather than a chip. */
export const MOUSE_BUTTON_NAMES: Record<MouseTriggerButton, string> = {
  middle: 'the mouse wheel button',
  x1: 'the back side-button',
  x2: 'the forward side-button',
  left: 'the left button',
  right: 'the right button',
};

/** `MouseEvent.button`, which is the only thing that tells the recorder what was pressed. */
const BUTTON_BY_EVENT_CODE: Record<number, MouseTriggerButton> = {
  0: 'left',
  1: 'middle',
  2: 'right',
  3: 'x1',
  4: 'x2',
};

const MODIFIER_ALIASES: Record<string, keyof Omit<MouseTrigger, 'button'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
  meta: 'meta',
  cmd: 'meta',
};

/** What a hand-written or pre-1.16 config may call a button. */
const BUTTON_ALIASES: Record<string, MouseTriggerButton> = {
  middle: 'middle',
  wheel: 'middle',
  mouse3: 'middle',
  x1: 'x1',
  mouse4: 'x1',
  xbutton1: 'x1',
  back: 'x1',
  x2: 'x2',
  mouse5: 'x2',
  xbutton2: 'x2',
  forward: 'x2',
  left: 'left',
  mouse1: 'left',
  leftclick: 'left',
  right: 'right',
  mouse2: 'right',
  rightclick: 'right',
};

/**
 * A stored value back into its parts, or `null` if it is not a binding this build can arm.
 *
 * Deliberately strict about the rules and forgiving about the spelling: a config can be hand
 * edited or written by an older version, but a binding the hook will not accept must not survive
 * into the UI as a row that displays a button and opens nothing.
 */
export function parseMouseTrigger(value: unknown): MouseTrigger | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return null;

  const trigger: MouseTrigger = { button: 'middle', ctrl: false, alt: false, shift: false, meta: false };
  let button: MouseTriggerButton | null = null;

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) {
      trigger[modifier] = true;
      continue;
    }
    const named = BUTTON_ALIASES[part];
    /** Two buttons in one binding is not a binding: the hook watches exactly one. */
    if (!named || button) return null;
    button = named;
  }

  if (!button) return null;
  trigger.button = button;
  return rejectMouseTrigger(trigger) ? null : trigger;
}

/** The canonical string: modifiers in the order the shortcut field writes them, then the button. */
export function formatMouseTrigger(trigger: MouseTrigger): string {
  const parts: string[] = [];
  if (trigger.ctrl) parts.push('Ctrl');
  if (trigger.alt) parts.push('Alt');
  if (trigger.shift) parts.push('Shift');
  if (trigger.meta) parts.push('Super');
  parts.push(trigger.button);
  return parts.join('+');
}

/** The stored form of whatever came in, or `null` when nothing valid did. */
export function normalizeMouseTrigger(value: unknown): string | null {
  const parsed = parseMouseTrigger(value);
  return parsed ? formatMouseTrigger(parsed) : null;
}

/**
 * Why this combination cannot be the trigger, or `null` when it can.
 *
 * The one rule is about left and right. Everything else a mouse can send is fair game — that is
 * the whole point of recording rather than choosing from a list.
 */
export function rejectMouseTrigger(trigger: MouseTrigger): string | null {
  if (!NEEDS_MODIFIER.has(trigger.button)) return null;
  if (trigger.ctrl || trigger.alt || trigger.shift || trigger.meta) return null;
  return trigger.button === 'left'
    ? 'The left button on its own is how Windows clicks everything. Hold Ctrl, Alt, Shift or Win and click again.'
    : 'The right button on its own is every context menu in Windows. Hold Ctrl, Alt, Shift or Win and click again.';
}

/**
 * Whether this binding can be held as well as clicked.
 *
 * Left and right cannot. Hold means the wheel is up for as long as the button is down and the
 * release runs whatever you were pointing at — which for the primary or secondary button is a drag
 * as far as the rest of Windows is concerned, and a press the hook has to hand back to the window
 * underneath the moment it turns out not to have been a gesture. Both of those fight the one thing
 * left and right are already used for everywhere, so those bindings are click-only and the gesture
 * row goes away rather than offering a mode that cannot work.
 */
export function mouseTriggerAllowsHold(value: unknown): boolean {
  const trigger = parseMouseTrigger(value) ?? parseMouseTrigger(DEFAULT_MOUSE_TRIGGER)!;
  return !NEEDS_MODIFIER.has(trigger.button);
}

/** What the recorder saw, whether or not it is allowed — the refusal names the button. */
export function mouseTriggerFromEvent(event: {
  button: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): MouseTrigger | null {
  const button = BUTTON_BY_EVENT_CODE[event.button];
  if (!button) return null;
  return {
    button,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/** The chips the row draws: one per modifier, then the button. */
export function mouseTriggerChips(value: unknown): string[] {
  const trigger = parseMouseTrigger(value) ?? parseMouseTrigger(DEFAULT_MOUSE_TRIGGER)!;
  const chips: string[] = [];
  if (trigger.ctrl) chips.push('Ctrl');
  if (trigger.alt) chips.push('Alt');
  if (trigger.shift) chips.push('Shift');
  if (trigger.meta) chips.push('Win');
  chips.push(MOUSE_BUTTON_LABELS[trigger.button]);
  return chips;
}

/** The same binding inside a sentence: "hold the back side-button", "hold Ctrl and the left button". */
export function mouseTriggerPhrase(value: unknown): string {
  const trigger = parseMouseTrigger(value) ?? parseMouseTrigger(DEFAULT_MOUSE_TRIGGER)!;
  const name = MOUSE_BUTTON_NAMES[trigger.button];
  const chips = mouseTriggerChips(value);
  /** The last chip is the button, whose long name is already in `name`. */
  const modifiers = chips.slice(0, -1);
  return modifiers.length ? `${modifiers.join('+')} and ${name}` : name;
}
