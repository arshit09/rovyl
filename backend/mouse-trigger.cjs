/**
 * The mouse button that opens the wheel, as main and the native hook need it.
 *
 * The grammar lives in `src/constants/mouseTrigger.ts` — a binding is a button plus the modifiers
 * held with it, written `Ctrl+left` / `x1` / `Alt+Shift+x2`. This is the CommonJS half, because the
 * renderer's module is TypeScript and main cannot load it. `scripts/mouse-trigger-smoke.mjs` pins
 * the two together: a rule that drifts is a binding that records in Settings and never fires.
 *
 * The VKs are what the helper's `TRIGGER` command takes, and the modifier bits are the mask its
 * `GetCurrentModifierMask` builds — Ctrl 1, Alt 2, Shift 4, Win 8.
 */

const MOUSE_TRIGGER_VK = { middle: 0x04, x1: 0x05, x2: 0x06, left: 0x01, right: 0x02 };

const DEFAULT_MOUSE_TRIGGER = "middle";

/**
 * Left and right are the primary click and the context menu of the whole system, so they are only
 * a trigger when a modifier is held with them. Everything else a mouse reports is free.
 */
const NEEDS_MODIFIER = new Set(["left", "right"]);

const MODIFIER_BITS = {
  ctrl: 1,
  control: 1,
  alt: 2,
  option: 2,
  shift: 4,
  super: 8,
  win: 8,
  windows: 8,
  meta: 8,
  cmd: 8,
};

/** Spellings a hand-edited or pre-1.16 config may carry. The renderer only ever writes canonical. */
const BUTTON_ALIASES = {
  middle: "middle",
  wheel: "middle",
  mouse3: "middle",
  x1: "x1",
  mouse4: "x1",
  xbutton1: "x1",
  back: "x1",
  x2: "x2",
  mouse5: "x2",
  xbutton2: "x2",
  forward: "x2",
  left: "left",
  mouse1: "left",
  leftclick: "left",
  right: "right",
  mouse2: "right",
  rightclick: "right",
};

/**
 * A stored value into `{ token, button, vk, modMask }`, or `null` when it is not a binding the
 * hook can arm. Callers that need a value regardless fall back to `DEFAULT_MOUSE_TRIGGER`.
 */
function parseMouseTrigger(value) {
  if (typeof value !== "string") return null;
  const parts = value
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let modMask = 0;
  let button = null;

  for (const part of parts) {
    const bit = MODIFIER_BITS[part];
    if (bit) {
      modMask |= bit;
      continue;
    }
    const named = BUTTON_ALIASES[part];
    /** Two buttons in one binding is not a binding: the hook watches exactly one. */
    if (!named || button) return null;
    button = named;
  }

  if (!button) return null;
  if (modMask === 0 && NEEDS_MODIFIER.has(button)) return null;

  const names = [];
  if (modMask & 1) names.push("Ctrl");
  if (modMask & 2) names.push("Alt");
  if (modMask & 4) names.push("Shift");
  if (modMask & 8) names.push("Super");
  names.push(button);

  return { token: names.join("+"), button, vk: MOUSE_TRIGGER_VK[button], modMask };
}

/** The stored form of whatever came in, or `null` when nothing valid did. */
function normalizeMouseTrigger(value) {
  const parsed = parseMouseTrigger(value);
  return parsed ? parsed.token : null;
}

/**
 * Whether this binding can be held as well as clicked.
 *
 * Left and right cannot: hold keeps the button down for the length of the gesture and hands a
 * short press back to the window underneath, and both of those fight what the primary and
 * secondary buttons already do everywhere else. Settings hides the gesture row for these bindings;
 * this is the same rule on main's side, so a hand-edited config cannot arm a mode the UI refuses
 * to offer.
 */
function mouseTriggerAllowsHold(value) {
  const parsed = parseMouseTrigger(value) || parseMouseTrigger(DEFAULT_MOUSE_TRIGGER);
  return !NEEDS_MODIFIER.has(parsed.button);
}

module.exports = {
  MOUSE_TRIGGER_VK,
  DEFAULT_MOUSE_TRIGGER,
  parseMouseTrigger,
  normalizeMouseTrigger,
  mouseTriggerAllowsHold,
};
