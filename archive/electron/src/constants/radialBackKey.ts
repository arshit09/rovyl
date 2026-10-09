/**
 * The key that leaves a folder, shared by the wheel and by the settings.
 *
 * Same reason as `radialDwell`: the settings panel is a separate lazy chunk, and a second copy of
 * "what counts as a valid key" in it would drift from the one the wheel actually tests against —
 * the recorder would accept a key the wheel ignores, which reads as the setting not saving.
 */

/**
 * Q. It is next to Tab and Escape, so the hand that reaches for "get out of here" is already
 * there, and unlike W/E/R it is not next to anything that launches.
 */
export const DEFAULT_BACK_KEY = 'Q';

/** No key. A saved empty string is a deliberate choice and must survive hydration as one. */
export const BACK_KEY_OFF = '';

/**
 * Keys the wheel already answers to. Binding one of them would not "override" it — the earlier
 * branch in the keydown handler wins and the new binding would simply never fire, which is the
 * worst outcome available: a setting that saves and does nothing.
 */
export const RESERVED_BACK_KEYS = [
  'Escape', 'Enter', 'Tab', 'Backspace', ' ',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
] as const;

/**
 * Why a KeyboardEvent cannot be trusted to give a letter.
 *
 * `e.key` carries the CHARACTER the layout produced, so the physical Q is `q` on QWERTY, `a` on
 * AZERTY and `й` on ЙЦУКЕН. Storing the character is still the right choice — someone on AZERTY
 * who records their Q key means the key that prints `a`, and that is what they will press again —
 * but it means the comparison has to be case-insensitive and cannot assume ASCII.
 *
 * Returns the stored form (upper case, one character) or `BACK_KEY_OFF`. Anything else — a
 * multi-character key name, a modifier, a digit, whitespace, junk from a hand-edited config — is
 * no key at all rather than a guess.
 */
export function normalizeBackKey(value: unknown): string {
  if (typeof value !== 'string') return BACK_KEY_OFF;
  const trimmed = value.trim();
  if (trimmed === '') return BACK_KEY_OFF;
  /** `Array.from` and not `.length`: an accented or non-Latin key can be more than one UTF-16 unit. */
  const chars = Array.from(trimmed);
  if (chars.length !== 1) return BACK_KEY_OFF;
  const char = chars[0];
  /**
   * Digits are refused outright, at every layer, because `radialNumberLaunch` can claim 1-9 at any
   * time afterwards. A binding that works until an unrelated switch is flipped, then silently
   * stops, is not worth the one key it buys.
   */
  if (char >= '0' && char <= '9') return BACK_KEY_OFF;
  return char.toUpperCase();
}

/**
 * Does this keydown mean "go back"?
 *
 * Modifiers disqualify it: Ctrl+Q is the host application's, and Alt+Q is somebody's shortcut for
 * reopening the wheel. Only the bare key counts.
 */
export function isBackKeyEvent(
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  backKey: string,
): boolean {
  if (!backKey) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (Array.from(event.key).length !== 1) return false;
  return event.key.toUpperCase() === backKey;
}

/** Why a recorded key was refused, or `null` when it is fine. `key` is the raw `e.key`. */
export function rejectBackKey(key: string, ctrl: boolean, alt: boolean, meta: boolean): string | null {
  if (ctrl || alt || meta) return 'Hold nothing — the back key is a single key on its own.';
  if ((RESERVED_BACK_KEYS as readonly string[]).includes(key)) {
    const shown = key === ' ' ? 'Space' : key;
    return `${shown} already does something on the wheel, so it would never reach the hub.`;
  }
  if (Array.from(key).length !== 1) return 'That is not a single key. Press a letter or a symbol.';
  if (key >= '0' && key <= '9') return 'Digits are reserved for launching by number.';
  return null;
}
